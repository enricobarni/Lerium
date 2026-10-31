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
 * Sem `chrome`: a porta, o UUID, a geometria, os timers e o relógio são
 * injetados. Sem logs e sem texto no estado emitido (só contagens, tempos e
 * códigos de erro).
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
 * - A janela (`InFlightWindow<SegmentTask>`) é o único registro do que está
 *   em voo. Unidade cujo `unitId` já está em voo vira resultado `null` sem
 *   envio (a resposta do primeiro seria a única). Se `tryAcquire` recusar
 *   mesmo com vaga e id novo, é erro de programação: o job falha com
 *   `interrupted` (não lança dentro de um ouvinte da porta).
 *
 * Tempos (`deps.clock`, em ms, relativos ao início de `start`): o executor
 * só lê o relógio e guarda os tempos no próprio estado. Não usa
 * `performance.mark`/`measure`: a linha do tempo de User Timing é
 * compartilhada com a página, e marcas com nome fixo denunciariam a
 * extensão (fingerprinting).
 * - `firstVisibleMs`: até o primeiro segmento de prioridade 0 aplicado com
 *   sucesso; ausente se nenhum foi.
 * - `durationMs`: até o fim do job, qualquer que seja o término
 *   (`translated`, `cancelled` ou `error`); ausente durante `translating`.
 * Ambos somem a cada `start`. Leitura não finita, negativa ou que lança é
 * descartada (o campo fica ausente); o relógio nunca derruba o job.
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
  type InFlightWindow,
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
  /** Ms do início ao primeiro segmento visível aplicado; ausente até acontecer. */
  firstVisibleMs?: number;
  /** Ms do início ao fim do job; ausente até o job terminar. */
  durationMs?: number;
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
   * Relógio monotônico em ms (no content real: `performance.now`). Só é
   * lido: ler não cria entrada visível à página.
   */
  clock(): number;
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
  /** Única fonte do que está em voo: `unitId` → plano a que pertence. */
  readonly window: InFlightWindow<SegmentTask>;
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

  /** `clock()` no início do `start` atual; `undefined` se a leitura falhou. */
  let startedAt: number | undefined;

  const readClock = (): number | undefined => {
    try {
      const value = deps.clock();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      // Relógio é diagnóstico: nunca derruba o job.
      return undefined;
    }
  };

  /** Ms desde o início do `start` atual, ou `undefined` se não dá para medir. */
  const elapsed = (): number | undefined => {
    if (startedAt === undefined) return undefined;
    const now = readClock();
    if (now === undefined) return undefined;
    const value = now - startedAt;
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };

  /** `next` com o `durationMs` do job que termina agora (se medível). */
  const finished = (next: JobState): JobState => {
    const durationMs = elapsed();
    return durationMs === undefined ? next : { ...next, durationMs };
  };

  /** Encerra o job: fila, janela, timer, ouvintes e porta. Nada do job é aplicado depois. */
  const teardown = (job: ActiveJob): void => {
    if (active === job) active = null;
    job.queue.clear();
    job.window.clear();
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
    emit(finished({ ...state, status: 'error', error }));
  };

  /** Aplica o plano completo; fallback volta à frente da própria classe. */
  const applyTask = (job: ActiveJob, task: SegmentTask): void => {
    const result = applier.apply(task.plan.segmentId, task.results);
    if (result.ok) {
      const next: JobState = { ...state, done: state.done + 1 };
      if (task.priority === PRIORITY_VISIBLE_MAIN && state.firstVisibleMs === undefined) {
        const firstVisibleMs = elapsed();
        if (firstVisibleMs !== undefined) next.firstVisibleMs = firstVisibleMs;
      }
      emit(next);
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
          emit(finished({ ...state, status: 'translated' }));
        }
        return;
      }
      const { task, unit } = item;
      if (unit === null) {
        applyTask(job, task);
        continue;
      }
      if (!isSendableUnit(unit)) {
        // O service worker descartaria em silêncio e não haveria resposta.
        settle(job, task, unit.unitId, null);
        continue;
      }
      if (job.window.has(unit.unitId)) {
        // Id repetido em voo nunca teria resposta própria: a resposta do
        // primeiro seria a única. Vira `null` sem envio.
        settle(job, task, unit.unitId, null);
        continue;
      }
      if (!job.window.tryAcquire(unit.unitId, task)) {
        // Inalcançável: há vaga (checado acima) e o id não está em voo. Se
        // acontecer, é erro de programação; falhar o job como `interrupted`
        // encerra tudo (porta, timer) em vez de lançar dentro de um ouvinte
        // da porta e deixar o job preso em `translating`.
        fail(job, INTERRUPTED);
        return;
      }
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
    const task = job.window.get(message.unitId);
    if (task === undefined) return;
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
    if (stopActive()) emit(finished({ ...state, status: 'cancelled' }));
  };

  return {
    start() {
      if (disposed) return;
      stopActive();
      startedAt = readClock();
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
        emit(finished({ ...base, status: 'translated' }));
        return;
      }

      let port: PortLike;
      try {
        port = deps.connect();
      } catch {
        emit(finished({ ...base, status: 'error', error: INTERRUPTED }));
        return;
      }

      const job: ActiveJob = {
        jobId: deps.randomUUID(),
        port,
        queue,
        window: createInFlightWindow<SegmentTask>(maxInFlight),
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
      const next: JobState = { ...state, view: 'original' };
      emit(wasActive ? finished({ ...next, status: 'cancelled' }) : next);
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
      if (stopActive()) state = finished({ ...state, status: 'cancelled' });
      applier.clear();
    },
  };
}
