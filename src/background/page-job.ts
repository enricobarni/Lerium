import type { TranslationProvider, TranslationResult } from '../core/translation-provider';
import type { TranslationSettings } from '../core/types';
import {
  MAX_OUTPUT_CHARS,
  PAGE_JOB_PORT_NAME,
  parseContentToWorker,
  type JobFatalErrorKind,
  type JobUnitMessage,
  type WorkerToContentMessage,
} from '../shared/page-messages';
import type { PortLike, PortSenderLike } from '../shared/port-like';

/**
 * Lado do service worker do job de página (ADR-009, ADR-014). Módulo puro:
 * `chrome` entra por injeção, e só `index.ts` toca a API. Cada port é um job:
 * configurações e provedor são lidos uma única vez (snapshot), há no máximo
 * uma unidade em voo e nada é enviado depois do desligamento. Nenhum texto
 * da página ou do modelo é registrado; só o resultado final volta pela port.
 */

export interface PageJobDeps {
  /** `chrome.runtime.id`. */
  runtimeId: string;
  /** Lê as configurações; `null` (ou rejeição) = indisponíveis. */
  loadSettings(): Promise<TranslationSettings | null>;
  createProvider(settings: TranslationSettings): TranslationProvider;
  /** Relógio em milissegundos; padrão `Date.now`. */
  now?: () => number;
}

/** Intervalo mínimo entre dois `job:progress` da mesma unidade. */
export const PROGRESS_INTERVAL_MS = 5_000;

/** Erros de tradução que tornam inútil continuar o job. */
const FATAL_TRANSLATION_ERRORS: ReadonlySet<string> = new Set<JobFatalErrorKind>([
  'invalid_config',
  'model_missing',
  'forbidden',
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
 * barram páginas da extensão, iframes e esquemas não web.
 */
function isTrustedPort(port: PortLike, runtimeId: string): boolean {
  if (port.name !== PAGE_JOB_PORT_NAME) return false;
  const sender: PortSenderLike | undefined = port.sender;
  if (!sender || sender.id !== runtimeId) return false;
  if (typeof sender.tab?.id !== 'number') return false;
  if (sender.frameId !== 0) return false;
  return isHttpUrl(sender.url);
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

  return (port) => {
    if (!isTrustedPort(port, deps.runtimeId)) {
      safeDisconnect(port);
      return;
    }

    let disconnected = false;
    let jobId: string | null = null;
    let ready: Promise<Ready> | null = null;
    let inFlight: AbortController | null = null;

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
      inFlight?.abort();
      inFlight = null;
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
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

    const runUnit = async (id: string, unit: JobUnitMessage, controller: AbortController) => {
      const state = await prepare(id);
      if (!state.ok || disconnected || controller.signal.aborted) return;

      let chars = 0;
      let lastProgressAt = now();
      const onToken = (delta: string): void => {
        chars += delta.length;
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

      if (inFlight === controller) inFlight = null;
      if (disconnected) return;

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
      if (isFatalTranslationError(result.error)) fatal(id, result.error);
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

      if (inFlight !== null) {
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
      inFlight = controller;
      runUnit(id, message, controller).catch(() => {
        if (inFlight === controller) inFlight = null;
      });
    }

    function onDisconnect(): void {
      teardown();
    }

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
  };
}
