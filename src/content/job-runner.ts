/**
 * Executor do job de tradução da página, no content script (Fases 4 e 5,
 * ADR-004).
 *
 * Coleta → segmenta → classifica por prioridade (`classifySegments`, uma vez
 * por job) → planeja (ADR-013, ADR-014). Cada unidade entra numa fila com a
 * classe do seu segmento (unidades de um segmento em ordem) e sai para o
 * service worker por uma `PortLike`, com no máximo `maxInFlight` unidades em
 * voo (padrão `MAX_UNITS_IN_FLIGHT`). Cada `job:result` libera uma vaga; quando
 * todas as unidades de um plano chegaram (em qualquer ordem), o segmento é
 * aplicado. Um `markers_invalid` com fallback põe as unidades nó a nó do
 * segmento no início da sua classe, em ordem.
 *
 * Sem `chrome`: a porta, o UUID, a geometria, os timers e as marcas de
 * desempenho são injetados. Sem logs e sem texto no estado emitido nem nas
 * marcas (só nomes fixos, contagens e códigos de erro).
 *
 * Regras:
 * - Toda mensagem recebida passa por `parseWorkerToContent`; é descartada se
 *   o `jobId` não é o do job atual ou se o `unitId` não está em voo.
 * - Unidade que o service worker recusaria (texto acima de `MAX_UNIT_CHARS`
 *   ou `unitId` inválido) não é enviada: vira resultado `null` quando sai da
 *   fila.
 * - `ok: false` vira resultado `null` para a unidade; o applier decide
 *   (`translation_failed`, o segmento fica no original). `busy` segue a
 *   mesma regra: a janela daqui nunca passa do limite combinado com o service
 *   worker; se acontecer, é falha, e reenviar só esconderia o erro.
 * - `job:fatal` → `error` com o código; desconecta; segmentos ainda não
 *   aplicados ficam no original.
 * - Desconexão não pedida com trabalho pendente → `error` `interrupted`; o
 *   que já foi aplicado continua restaurável.
 * - `job:ping` a cada `PING_INTERVAL_MS` enquanto houver unidade em voo; o
 *   timer é limpo em todo caminho de término.
 * - Cancelamento, fatal, interrupção e `dispose` esvaziam fila e janela;
 *   nada do job é aplicado depois.
 *
 * Marcas (`deps.mark`, só o nome): `lerium:job-start` no início de `start`;
 * `lerium:first-visible-applied` no primeiro segmento de prioridade 0
 * aplicado com sucesso; `lerium:job-done` quando o job termina em
 * `translated`. Cancelamento e erro não marcam `job-done`.
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
  createInFlightWindow,
  createPriorityQueue,
  type PriorityQueue,
} from '../core/translation-scheduler';
import {
  isUnitId,
  MAX_UNIT_CHARS,
  MAX_UNITS_IN_FLIGHT,
  parseWorkerToContent,
  type JobFatalErrorKind,
} from '../shared/page-messages';
import type { PortLike } from '../shared/port-like';
import { collectTextNodes } from './dom-collector';
import { createPageApplier, type SegmentPlan, type TranslationUnit } from './page-applier';
import {
  classifySegments,
  PRIORITY_CLASSES,
  PRIORITY_VISIBLE_MAIN,
  type BlockRect,
  type SegmentPriority,
} from './segment-priority';
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
  /** Geometria do bloco (no content real: `getBoundingClientRect`). */
  measure(block: Element): BlockRect;
  /** Altura da viewport (no content real: `window.innerHeight`). */
  viewportHeight(): number;
  /**
   * Relógio monotônico (no content real: `performance.now`). Reservado para
   * medições de duração; as marcas atuais levam o próprio carimbo de tempo.
   */
  now?: () => number;
  /** Marca de desempenho (no content real: `performance.mark`); só nomes fixos. */
  mark?: (name: string) => void;
  /** Limite da janela; só para teste. Padrão `MAX_UNITS_IN_FLIGHT`. */
  maxInFlight?: number;
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

export const MARK_JOB_START = 'lerium:job-start';
export const MARK_FIRST_VISIBLE_APPLIED = 'lerium:first-visible-applied';
export const MARK_JOB_DONE = 'lerium:job-done';

/** Um plano em andamento: resultados chegam em qualquer ordem. */
interface SegmentTask {
  readonly plan: SegmentPlan;
  readonly priority: SegmentPriority;
  readonly results: Map<string, string | null>;
  /** Unidades do plano ainda sem resultado. */
  remaining: number;
}

/** Item da fila; `unit` `null` = plano sem unidades, aplicado ao sair da fila. */
interface QueuedUnit {
  readonly task: SegmentTask;
  readonly unit: TranslationUnit | null;
}

interface ActiveJob {
  readonly jobId: string;
  readonly port: PortLike;
  readonly queue: PriorityQueue<QueuedUnit>;
  readonly window: ReturnType<typeof createInFlightWindow>;
  /** `unitId` em voo → plano a que pertence. */
  readonly inFlight: Map<string, SegmentTask>;
  firstVisibleMarked: boolean;
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

function createTask(plan: SegmentPlan, priority: SegmentPriority): SegmentTask {
  return { plan, priority, results: new Map(), remaining: plan.units.length };
}

/** Enfileira as unidades do plano no fim da classe, em ordem. */
function pushTask(queue: PriorityQueue<QueuedUnit>, task: SegmentTask): void {
  if (task.plan.units.length === 0) {
    queue.push({ task, unit: null }, task.priority);
    return;
  }
  for (const unit of task.plan.units) queue.push({ task, unit }, task.priority);
}

/**
 * Enfileira as unidades do plano no início da classe, em ordem: `pushFront`
 * é LIFO dentro da classe, então vai do último para o primeiro.
 */
function pushTaskFront(queue: PriorityQueue<QueuedUnit>, task: SegmentTask): void {
  const { units } = task.plan;
  if (units.length === 0) {
    queue.pushFront({ task, unit: null }, task.priority);
    return;
  }
  for (let index = units.length - 1; index >= 0; index -= 1) {
    queue.pushFront({ task, unit: units[index] as TranslationUnit }, task.priority);
  }
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const applier = createPageApplier();
  const maxInFlight = deps.maxInFlight ?? MAX_UNITS_IN_FLIGHT;
  let state: JobState = { ...IDLE };
  let active: ActiveJob | null = null;
  let disposed = false;

  const emit = (next: JobState): void => {
    state = next;
    if (!disposed) deps.onState?.({ ...state });
  };

  const mark = (name: string): void => {
    try {
      deps.mark?.(name);
    } catch {
      // Marca de desempenho é diagnóstico: nunca derruba o job.
    }
  };

  /** Encerra o job: fila, janela, timer, ouvintes e porta. Nada do job é aplicado depois. */
  const teardown = (job: ActiveJob): void => {
    if (active === job) active = null;
    job.queue.clear();
    for (const unitId of job.inFlight.keys()) job.window.release(unitId);
    job.inFlight.clear();
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

  /** Aplica o plano completo; fallback volta à frente da própria classe. */
  const applyTask = (job: ActiveJob, task: SegmentTask): void => {
    const result = applier.apply(task.plan.segmentId, task.results);
    if (result.ok) {
      if (task.priority === PRIORITY_VISIBLE_MAIN && !job.firstVisibleMarked) {
        job.firstVisibleMarked = true;
        mark(MARK_FIRST_VISIBLE_APPLIED);
      }
      emit({ ...state, done: state.done + 1 });
    } else if (result.fallback !== undefined) {
      pushTaskFront(job.queue, createTask(result.fallback, task.priority));
    } else {
      emit({ ...state, failed: state.failed + 1 });
    }
  };

  /** Registra o resultado de uma unidade e aplica o plano se ele completou. */
  const settle = (job: ActiveJob, task: SegmentTask, unitId: string, text: string | null): void => {
    task.results.set(unitId, text);
    task.remaining -= 1;
    if (task.remaining === 0) applyTask(job, task);
  };

  /** Envia enquanto houver vaga e fila; termina o job quando não resta nada. */
  const pump = (job: ActiveJob): void => {
    while (active === job) {
      if (job.window.available === 0) return;
      const item = job.queue.next();
      if (item === undefined) {
        if (job.window.size === 0) {
          teardown(job);
          mark(MARK_JOB_DONE);
          emit({ ...state, status: 'translated' });
        }
        return;
      }
      const { task, unit } = item;
      if (unit === null) {
        applyTask(job, task);
        continue;
      }
      if (!isSendableUnit(unit) || !job.window.tryAcquire(unit.unitId)) {
        // O service worker descartaria em silêncio e não haveria resposta;
        // id repetido em voo também nunca teria resposta própria.
        settle(job, task, unit.unitId, null);
        continue;
      }
      job.inFlight.set(unit.unitId, task);
      try {
        job.port.postMessage({
          type: 'job:unit',
          jobId: job.jobId,
          unitId: unit.unitId,
          text: unit.text,
        });
      } catch {
        if (active === job) fail(job, INTERRUPTED);
        return;
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
    const task = job.inFlight.get(message.unitId);
    if (task === undefined) return;
    job.inFlight.delete(message.unitId);
    job.window.release(message.unitId);
    settle(job, task, message.unitId, message.ok ? message.text : null);
    pump(job);
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
      mark(MARK_JOB_START);
      applier.restore();
      applier.clear();

      const segments = segmentTextNodes(collectTextNodes(deps.root));
      const classified = classifySegments(segments, {
        measure: (block) => deps.measure(block),
        viewportHeight: deps.viewportHeight(),
      });
      const queue = createPriorityQueue<QueuedUnit>(PRIORITY_CLASSES);
      let skipped = 0;
      for (const { segment, priority } of classified) {
        const plan = applier.plan(segment);
        if ('skipped' in plan) skipped += 1;
        else pushTask(queue, createTask(plan, priority));
      }
      const base: JobState = {
        status: 'translating',
        view: 'translation',
        total: segments.length,
        done: 0,
        failed: 0,
        skipped,
      };
      if (queue.size === 0) {
        mark(MARK_JOB_DONE);
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
        window: createInFlightWindow(maxInFlight),
        inFlight: new Map(),
        firstVisibleMarked: false,
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
        if (active !== job || job.window.size === 0) return;
        try {
          job.port.postMessage({ type: 'job:ping', jobId: job.jobId });
        } catch {
          if (active === job) fail(job, INTERRUPTED);
        }
      }, PING_INTERVAL_MS);
      emit(base);
      pump(job);
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
