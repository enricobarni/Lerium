/**
 * Executor do job de tradução da página, no content script (Fase 4, ADR-004).
 *
 * Coleta → segmenta → planeja (ADR-013, ADR-014) e manda as unidades ao
 * service worker por uma `PortLike`, **uma por vez**: a próxima só sai
 * depois do `job:result` da anterior. Quando todas as unidades de um plano
 * chegaram, o segmento é aplicado; um `markers_invalid` com fallback põe as
 * unidades nó a nó do mesmo segmento logo em seguida na fila.
 *
 * Sem `chrome`: a porta, o UUID e os timers são injetados. Sem logs e sem
 * texto no estado emitido (só contagens e códigos de erro).
 *
 * Regras:
 * - Toda mensagem recebida passa por `parseWorkerToContent`; é descartada se
 *   o `jobId` não é o do job atual ou se o `unitId` não é o da unidade em voo.
 * - Unidade que o service worker recusaria (texto acima de `MAX_UNIT_CHARS`
 *   ou `unitId` inválido) não é enviada: vira resultado `null` na hora.
 * - `ok: false` vira resultado `null` para a unidade; o applier decide
 *   (`translation_failed`, o segmento fica no original). `busy` segue a
 *   mesma regra: a concorrência no service worker é por porta, e `busy` só
 *   ocorre se a mesma porta enviar duas unidades ao mesmo tempo — o que este
 *   runner não faz; se acontecer, é falha, e reenviar só esconderia o erro.
 * - `job:fatal` → `error` com o código; desconecta; segmentos ainda não
 *   aplicados ficam no original.
 * - Desconexão não pedida com trabalho pendente → `error` `interrupted`; o
 *   que já foi aplicado continua restaurável.
 * - `job:ping` a cada `PING_INTERVAL_MS` enquanto houver unidade em voo; o
 *   timer é limpo em todo caminho de término.
 *
 * Contagens: `total` é o número de segmentos; `skipped` os acima de
 * `MAX_SEGMENT_CHARS`; `done` os aplicados; `failed` os que o applier
 * recusou (depois do fallback, se houve). Um segmento com fallback conta uma
 * vez só, pelo resultado final.
 *
 * Visualização (`view`): o que o DOM mostra. Começa em `original` (nada foi
 * aplicado); `start` passa a `translation`; `showOriginal` cancela o job em
 * andamento, restaura e passa a `original`; `showTranslation` reaplica e passa
 * a `translation`, exceto em `idle` (não há tradução a mostrar: no-op). Durante
 * `translating` a visualização é sempre `translation`. Mudança de `view` emite
 * estado; comando que não muda nada não emite.
 *
 * `dispose()`: encerra o job sem emitir, esquece o registro do applier (o DOM
 * fica como está) e transforma todo comando seguinte em no-op. `getState`
 * continua respondendo o último estado.
 */

import {
  isUnitId,
  MAX_UNIT_CHARS,
  parseWorkerToContent,
  type JobFatalErrorKind,
} from '../shared/page-messages';
import type { PortLike } from '../shared/port-like';
import { collectTextNodes } from './dom-collector';
import { createPageApplier, type SegmentPlan, type TranslationUnit } from './page-applier';
import { segmentTextNodes } from './segmenter';

export type JobStatus = 'idle' | 'translating' | 'translated' | 'cancelled' | 'error';

export type JobView = 'original' | 'translation';

export interface JobState {
  status: JobStatus;
  view: JobView;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  /** Código do erro (`JobFatalErrorKind` ou `interrupted`); nunca texto da página. */
  error?: JobErrorKind;
}

export interface JobRunnerDeps {
  root: Document;
  /** Abre a porta (no content real: `chrome.runtime.connect`). */
  connect(): PortLike;
  randomUUID(): string;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  onState?(state: JobState): void;
}

export interface JobRunner {
  start(): void;
  cancel(): void;
  showOriginal(): void;
  showTranslation(): void;
  getState(): JobState;
  /** Encerra de vez: cancela sem emitir, limpa o registro; comandos viram no-op. */
  dispose(): void;
}

export const PING_INTERVAL_MS = 20_000;

/** Porta caiu ou não abriu com trabalho pendente. */
export const INTERRUPTED = 'interrupted' as const;

/** Código de erro do job: falha fatal do service worker ou porta perdida. */
export type JobErrorKind = JobFatalErrorKind | typeof INTERRUPTED;

interface CurrentPlan {
  readonly plan: SegmentPlan;
  index: number;
  readonly results: Map<string, string | null>;
}

interface ActiveJob {
  readonly jobId: string;
  readonly port: PortLike;
  readonly queue: SegmentPlan[];
  current: CurrentPlan | null;
  /** `unitId` da unidade em voo; `null` entre unidades. */
  pendingUnitId: string | null;
  timer: unknown;
  readonly onMessage: (message: unknown) => void;
  readonly onDisconnect: () => void;
}

/**
 * A unidade passa no `parseContentToWorker` do service worker? Uma que não
 * passa vira resultado `null` sem ser enviada (o segmento cai em
 * `translation_failed`), em vez de deixar o job esperando uma resposta que
 * nunca vem.
 */
export function isSendableUnit(unit: TranslationUnit): boolean {
  return unit.text.length <= MAX_UNIT_CHARS && isUnitId(unit.unitId);
}

const IDLE: JobState = {
  status: 'idle',
  view: 'original',
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
};

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const applier = createPageApplier();
  let state: JobState = { ...IDLE };
  let active: ActiveJob | null = null;
  let disposed = false;

  const emit = (next: JobState): void => {
    state = next;
    if (!disposed) deps.onState?.({ ...state });
  };

  /** Encerra o job: timer, ouvintes e porta. Nada do job é aplicado depois. */
  const teardown = (job: ActiveJob): void => {
    if (active === job) active = null;
    job.pendingUnitId = null;
    if (job.timer !== undefined) deps.clearInterval(job.timer);
    job.timer = undefined;
    job.port.onMessage.removeListener(job.onMessage);
    job.port.onDisconnect.removeListener(job.onDisconnect);
    try {
      job.port.disconnect();
    } catch {
      // Porta já desconectada: nada a fazer.
    }
  };

  const fail = (job: ActiveJob, error: JobErrorKind): void => {
    teardown(job);
    emit({ ...state, status: 'error', error });
  };

  /** Envia a próxima unidade ou aplica o plano completo, até esperar resposta. */
  const advance = (job: ActiveJob): void => {
    while (active === job) {
      if (job.current === null) {
        const plan = job.queue.shift();
        if (plan === undefined) {
          teardown(job);
          emit({ ...state, status: 'translated' });
          return;
        }
        job.current = { plan, index: 0, results: new Map() };
      }
      const current = job.current;
      const unit = current.plan.units[current.index];
      if (unit !== undefined) {
        if (!isSendableUnit(unit)) {
          // O service worker descartaria em silêncio e não haveria resposta.
          current.results.set(unit.unitId, null);
          current.index += 1;
          continue;
        }
        job.pendingUnitId = unit.unitId;
        try {
          job.port.postMessage({
            type: 'job:unit',
            jobId: job.jobId,
            unitId: unit.unitId,
            text: unit.text,
          });
        } catch {
          if (active === job) fail(job, INTERRUPTED);
        }
        return;
      }
      job.current = null;
      const result = applier.apply(current.plan.segmentId, current.results);
      if (result.ok) {
        emit({ ...state, done: state.done + 1 });
      } else if (result.fallback !== undefined) {
        job.queue.unshift(result.fallback);
      } else {
        emit({ ...state, failed: state.failed + 1 });
      }
    }
  };

  const handleMessage = (job: ActiveJob, raw: unknown): void => {
    if (active !== job) return;
    const message = parseWorkerToContent(raw);
    if (message === null || message.jobId !== job.jobId) return;
    if (message.type === 'job:fatal') {
      fail(job, message.error);
      return;
    }
    if (message.type !== 'job:result') return;
    const current = job.current;
    if (current === null || job.pendingUnitId === null || message.unitId !== job.pendingUnitId) {
      return;
    }
    job.pendingUnitId = null;
    current.results.set(message.unitId, message.ok ? message.text : null);
    current.index += 1;
    advance(job);
  };

  const stopActive = (): boolean => {
    if (active === null) return false;
    teardown(active);
    return true;
  };

  const cancel = (): void => {
    if (disposed) return;
    if (stopActive()) emit({ ...state, status: 'cancelled' });
  };

  return {
    start() {
      if (disposed) return;
      stopActive();
      applier.restore();
      applier.clear();

      const segments = segmentTextNodes(collectTextNodes(deps.root));
      const queue: SegmentPlan[] = [];
      let skipped = 0;
      for (const segment of segments) {
        const plan = applier.plan(segment);
        if ('skipped' in plan) skipped += 1;
        else queue.push(plan);
      }
      const base: JobState = {
        status: 'translating',
        view: 'translation',
        total: segments.length,
        done: 0,
        failed: 0,
        skipped,
      };
      if (queue.length === 0) {
        emit({ ...base, status: 'translated' });
        return;
      }

      let port: PortLike;
      try {
        port = deps.connect();
      } catch {
        emit({ ...base, status: 'error', error: INTERRUPTED });
        return;
      }

      const job: ActiveJob = {
        jobId: deps.randomUUID(),
        port,
        queue,
        current: null,
        pendingUnitId: null,
        timer: undefined,
        onMessage: (message) => handleMessage(job, message),
        onDisconnect: () => {
          if (active === job) fail(job, INTERRUPTED);
        },
      };
      active = job;
      port.onMessage.addListener(job.onMessage);
      port.onDisconnect.addListener(job.onDisconnect);
      job.timer = deps.setInterval(() => {
        if (active !== job || job.pendingUnitId === null) return;
        try {
          job.port.postMessage({ type: 'job:ping', jobId: job.jobId });
        } catch {
          if (active === job) fail(job, INTERRUPTED);
        }
      }, PING_INTERVAL_MS);
      emit(base);
      advance(job);
    },

    cancel,

    showOriginal() {
      if (disposed) return;
      const wasActive = stopActive();
      applier.restore();
      if (!wasActive && state.view === 'original') return;
      emit({ ...state, status: wasActive ? 'cancelled' : state.status, view: 'original' });
    },

    showTranslation() {
      if (disposed || state.status === 'idle') return;
      applier.reapply();
      if (state.view !== 'translation') emit({ ...state, view: 'translation' });
    },

    getState() {
      return { ...state };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (stopActive()) state = { ...state, status: 'cancelled' };
      applier.clear();
    },
  };
}
