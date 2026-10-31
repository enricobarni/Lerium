import type { TranslationProvider, TranslationResult } from '../core/translation-provider';
import type { TranslationSettings } from '../core/types';
import {
  MAX_OUTPUT_CHARS,
  MAX_UNITS_IN_FLIGHT,
  PAGE_JOB_PORT_NAME,
  parseContentToWorker,
  type JobFatalErrorKind,
  type JobUnitMessage,
  type WorkerToContentMessage,
} from '../shared/page-messages';
import type { PortLike, PortSenderLike } from '../shared/port-like';
import type { TranslationGate } from './translation-gate';

/**
 * Lado do service worker do job de página (ADR-009, ADR-014, ADR-015). Módulo
 * puro: `chrome` entra por injeção, e só `index.ts` toca a API. Cada port é
 * um job: configurações e provedor são lidos uma única vez (snapshot), há no
 * máximo `maxUnitsPerPort` unidades aceitas ao mesmo tempo e nada é enviado
 * depois do desligamento. Nenhum texto da página ou do modelo é registrado;
 * só o resultado final volta pela port.
 *
 * O limite global de traduções simultâneas entre abas é o semáforo `gate`,
 * um só para todo o worker: cada unidade aceita espera uma vaga antes de
 * chamar o provedor, então a espera não conta no prazo do primeiro token.
 *
 * Há no máximo um job por aba: uma nova port válida da mesma aba (recarga,
 * novo clique) derruba a anterior, que aborta as unidades (em voo ou na fila
 * do semáforo) e não posta mais nada.
 */

export interface PageJobDeps {
  /** `chrome.runtime.id`. */
  runtimeId: string;
  /** O Lerium injetou o content script neste documento da aba? */
  isInjectedDocument(tabId: number, documentId: string): boolean;
  /** Lê as configurações; `null` (ou rejeição) = indisponíveis. */
  loadSettings(): Promise<TranslationSettings | null>;
  createProvider(settings: TranslationSettings): TranslationProvider;
  /** Semáforo global de traduções, compartilhado por todas as ports. */
  gate: TranslationGate;
  /** Unidades aceitas ao mesmo tempo por port; padrão `MAX_UNITS_IN_FLIGHT`. */
  maxUnitsPerPort?: number;
  /** Relógio em milissegundos; padrão `Date.now`. */
  now?: () => number;
}

/** Intervalo mínimo entre dois `job:progress` da mesma unidade. */
export const PROGRESS_INTERVAL_MS = 5_000;

/**
 * Erros de tradução que tornam inútil continuar o job. `network` (Ollama
 * desligado ou porta fechada) entra aqui: as próximas unidades falhariam do
 * mesmo jeito, e o usuário precisa agir. `timeout` fica de fora de propósito:
 * pode ser só um modelo lento num segmento longo, e as demais unidades ainda
 * podem passar.
 */
const FATAL_TRANSLATION_ERRORS: ReadonlySet<string> = new Set<JobFatalErrorKind>([
  'invalid_config',
  'model_missing',
  'forbidden',
  'network',
]);

const isFatalTranslationError = (error: string): error is JobFatalErrorKind =>
  FATAL_TRANSLATION_ERRORS.has(error);

function isHttpUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Só o frame principal de uma aba web, vindo do próprio content script do
 * Lerium, abre um job: o `id` barra outras extensões; `tab`/`frameId`/`url`
 * barram páginas da extensão, iframes e esquemas não web. O `documentId` tem
 * de ser o do documento em que o worker injetou o script naquela aba, o que
 * barra documentos antigos e de outra aba. `documentLifecycle` é obrigatório
 * e tem de ser `'active'` (o Chrome 114+, mínimo do Lerium, sempre o envia):
 * prerender e bfcache são recusados. Devolve o id da aba, ou `null` se a port
 * não é confiável.
 */
function trustedTabId(port: PortLike, deps: PageJobDeps): number | null {
  if (port.name !== PAGE_JOB_PORT_NAME) return null;
  const sender: PortSenderLike | undefined = port.sender;
  if (!sender || sender.id !== deps.runtimeId) return null;
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return null;
  if (sender.frameId !== 0) return null;
  if (sender.documentLifecycle !== 'active') return null;
  if (!isHttpUrl(sender.url)) return null;
  const { documentId } = sender;
  if (typeof documentId !== 'string') return null;
  return deps.isInjectedDocument(tabId, documentId) ? tabId : null;
}

function safeDisconnect(port: PortLike): void {
  try {
    port.disconnect();
  } catch {
    // Port já desligada: nada a fazer.
  }
}

type Ready =
  { ok: true; provider: TranslationProvider; settings: TranslationSettings } | { ok: false };

export function createPageJobHandler(deps: PageJobDeps): (port: PortLike) => void {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const maxUnits = deps.maxUnitsPerPort ?? MAX_UNITS_IN_FLIGHT;
  if (!Number.isInteger(maxUnits) || maxUnits < 1) {
    throw new RangeError(`limite inválido de unidades por port: ${String(maxUnits)}`);
  }
  const { gate } = deps;
  /** Job ativo de cada aba; `stop` encerra sem postar mais nada. */
  const jobsByTab = new Map<number, { port: PortLike; stop: () => void }>();

  return (port) => {
    const tabId = trustedTabId(port, deps);
    if (tabId === null) {
      safeDisconnect(port);
      return;
    }

    const previous = jobsByTab.get(tabId);
    if (previous !== undefined) {
      // `disconnect()` não dispara o onDisconnect local: encerra à mão.
      previous.stop();
      safeDisconnect(previous.port);
    }

    let disconnected = false;
    let jobId: string | null = null;
    let ready: Promise<Ready> | null = null;
    /** Unidades aceitas desta port (em voo ou na fila do semáforo). */
    const units = new Map<string, { controller: AbortController }>();

    /** Libera a vaga da port, se ainda for desta unidade (unitId reenviado). */
    const forget = (unitId: string, controller: AbortController): void => {
      if (units.get(unitId)?.controller === controller) units.delete(unitId);
    };

    const post = (message: WorkerToContentMessage): void => {
      if (disconnected) return;
      try {
        port.postMessage(message);
      } catch {
        // Postar numa port desligada lança no Chrome; trata como desligada.
        teardown();
      }
    };

    const teardown = (): void => {
      if (disconnected) return;
      disconnected = true;
      // Aborta tudo: as em voo cortam a geração; as na fila saem do semáforo.
      for (const { controller } of units.values()) controller.abort();
      units.clear();
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      // Só remove o registro se ainda for desta port (pode ter sido trocada).
      if (jobsByTab.get(tabId)?.port === port) jobsByTab.delete(tabId);
    };

    const fatal = (id: string, error: JobFatalErrorKind): void => {
      post({ type: 'job:fatal', jobId: id, error });
      teardown();
      safeDisconnect(port);
    };

    /** Lê as configurações e cria o provedor uma única vez por port. */
    const prepare = (id: string): Promise<Ready> => {
      ready ??= (async (): Promise<Ready> => {
        let settings: TranslationSettings | null;
        try {
          settings = await deps.loadSettings();
        } catch {
          settings = null;
        }
        if (settings === null) {
          fatal(id, 'settings_unavailable');
          return { ok: false };
        }
        try {
          return { ok: true, provider: deps.createProvider(settings), settings };
        } catch {
          fatal(id, 'invalid_config');
          return { ok: false };
        }
      })();
      return ready;
    };

    /** Traduz uma unidade já com a vaga do semáforo global. */
    const translateUnit = async (
      id: string,
      state: Extract<Ready, { ok: true }>,
      unit: JobUnitMessage,
      controller: AbortController,
    ): Promise<void> => {
      let chars = 0;
      let overflowed = false;
      let lastProgressAt = now();
      const onToken = (delta: string): void => {
        if (overflowed || controller.signal.aborted) return;
        chars += delta.length;
        if (chars > MAX_OUTPUT_CHARS) {
          // Saída grande demais: corta a geração já, sem esperar o fim. A
          // vaga da port é liberada aqui; a do semáforo, quando o provedor
          // retornar. O que o provedor devolver depois é ignorado.
          overflowed = true;
          controller.abort();
          forget(unit.unitId, controller);
          post({
            type: 'job:result',
            jobId: id,
            unitId: unit.unitId,
            ok: false,
            error: 'invalid_response',
            retryable: false,
          });
          return;
        }
        const at = now();
        if (at - lastProgressAt >= PROGRESS_INTERVAL_MS) {
          lastProgressAt = at;
          post({ type: 'job:progress', jobId: id, unitId: unit.unitId, chars });
        }
      };

      let result: TranslationResult;
      try {
        result = await state.provider.translate(
          {
            text: unit.text,
            source: state.settings.sourceLanguage,
            target: state.settings.targetLanguage,
          },
          { signal: controller.signal, onToken },
        );
      } catch {
        result = { ok: false, error: 'internal_error', retryable: false };
      }

      forget(unit.unitId, controller);
      if (disconnected || overflowed || controller.signal.aborted) return;

      if (result.ok) {
        if (result.text.length > MAX_OUTPUT_CHARS) {
          post({
            type: 'job:result',
            jobId: id,
            unitId: unit.unitId,
            ok: false,
            error: 'invalid_response',
            retryable: false,
          });
          return;
        }
        post({ type: 'job:result', jobId: id, unitId: unit.unitId, ok: true, text: result.text });
        return;
      }

      post({
        type: 'job:result',
        jobId: id,
        unitId: unit.unitId,
        ok: false,
        error: result.error,
        retryable: result.retryable,
      });
      // `fatal` derruba a port e, com ela, aborta as demais unidades.
      if (isFatalTranslationError(result.error)) fatal(id, result.error);
    };

    const runUnit = async (
      id: string,
      unit: JobUnitMessage,
      controller: AbortController,
    ): Promise<void> => {
      const state = await prepare(id);
      if (!state.ok || disconnected || controller.signal.aborted) return;

      // A espera pela vaga vem antes do provedor: não consome o prazo do
      // primeiro token. `null` = abortada na fila; nada a enviar.
      const release = await gate.acquire(controller.signal);
      if (release === null) return;
      try {
        if (disconnected || controller.signal.aborted) return;
        await translateUnit(id, state, unit, controller);
      } finally {
        release();
      }
    };

    function onMessage(raw: unknown): void {
      if (disconnected) return;
      const message = parseContentToWorker(raw);
      if (message === null) return;
      if (jobId === null) jobId = message.jobId;
      else if (message.jobId !== jobId) return;
      const id = jobId;

      if (message.type === 'job:ping') {
        // Só mantém o worker vivo; aproveita para preparar o job.
        void prepare(id);
        return;
      }

      // Mesma unidade já aceita: não traduz duas vezes nem responde de novo.
      if (units.has(message.unitId)) return;

      if (units.size >= maxUnits) {
        post({
          type: 'job:result',
          jobId: id,
          unitId: message.unitId,
          ok: false,
          error: 'busy',
          retryable: true,
        });
        return;
      }
      const controller = new AbortController();
      units.set(message.unitId, { controller });
      void runUnit(id, message, controller)
        .catch(() => {
          // Erro inesperado: só libera a vaga da port (a do semáforo já saiu
          // no `finally` de `runUnit`).
        })
        .finally(() => forget(message.unitId, controller));
    }

    function onDisconnect(): void {
      teardown();
    }

    jobsByTab.set(tabId, { port, stop: teardown });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
  };
}
