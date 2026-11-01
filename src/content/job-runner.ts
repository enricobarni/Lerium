/**
 * Executor do job de tradução da página, no content script (Fases 4 e 5,
 * ADR-004).
 *
 * Coleta → segmenta → classifica por prioridade (`classifySegments`, uma vez
 * por job) → planeja (ADR-013, ADR-014). As unidades de cada segmento formam
 * um grupo (chave `segmentId`, em ordem) na fila, na classe do segmento, e
 * saem para o service worker por uma `PortLike`, com no máximo `maxInFlight`
 * unidades em voo (padrão `MAX_UNITS_IN_FLIGHT`). Cada `job:result` libera uma
 * vaga; quando todas as unidades de um plano chegaram (em qualquer ordem), o
 * segmento é aplicado. Um `markers_invalid` com fallback põe as unidades nó a
 * nó do segmento no início da classe atual dele, em ordem.
 *
 * Rolagem (`deps.createVisibilityWatcher`, opcional): os blocos dos segmentos
 * não periféricos em fila são observados e a fila acompanha a leitura
 * (`placementFor`):
 * - entrar em `visible` (de qualquer classe que não a 0) → fim da classe 0;
 * - entrar em `near` estando na classe 2 → fim da classe 1 (FIFO: rolando
 *   para baixo, a ordem de entrada é a ordem de documento);
 * - sair de `visible` para `near` (rolou para cima) → frente da classe 1;
 * - sair de `visible` para `out` (passou pelo topo) → fim da classe 2;
 * - sair de `near` para `out` estando na classe 1 → frente da classe 2 (a
 *   faixa perto fica abaixo da viewport: sair dela sem passar por `visible`
 *   é sair por baixo, e o bloco é o mais perto da tela dos de fora abaixo).
 * Segmento que começou na classe 0 pela medição do `start`: se a primeira
 * zona que o observador informa para ele não é `visible` (a página rolou
 * entre a medição e o primeiro callback), ela conta como saída de `visible`
 * (`near` → frente da classe 1; `out` → fim da classe 2), para que ele não
 * fique na classe 0 à frente dos que estão de fato na tela.
 * Dentro de um lote, os movimentos são feitos em ordem de documento; os que
 * vão para a frente de uma classe (1 ou 2), do último para o primeiro, para
 * que a frente fique em ordem de documento. O callback só reordena: nunca envia
 * nem chama `pump`; a ordem nova vale na próxima vaga. O bloco deixa de ser
 * observado quando o grupo sai da fila (última unidade enviada) ou é
 * aplicado, e o observador é
 * desconectado em todo término; eventos depois disso são ignorados. Sem a
 * dependência, a ordem é a da classificação inicial. Periféricos nunca são
 * observados e a fila é finita, então eles sempre saem (sem aging).
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
 * - `visibleLatency`: ver o JSDoc de `JobState.visibleLatency`.
 * Os três somem a cada `start`. Leitura não finita, negativa ou que lança é
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
  createGroupedPriorityQueue,
  createInFlightWindow,
  type GroupedPriorityQueue,
  type InFlightWindow,
} from '../core/translation-scheduler';
import {
  isUnitId,
  MAX_UNIT_CHARS,
  MAX_UNITS_IN_FLIGHT,
  parseWorkerToContent,
  type JobFatalErrorKind,
} from '../shared/page-messages';
import type { VisibleLatencyView } from '../shared/page-control';
import type { PortLike } from '../shared/port-like';
import { collectTextNodes } from './dom-collector';
import { createPageApplier, type SegmentPlan, type TranslationUnit } from './page-applier';
import {
  classifySegments,
  PRIORITY_CLASSES,
  PRIORITY_MAIN,
  PRIORITY_NEAR,
  PRIORITY_PERIPHERAL,
  PRIORITY_VISIBLE_MAIN,
  type BlockRect,
  type SegmentPriority,
} from './segment-priority';
import { segmentTextNodes } from './segmenter';
import type { VisibilityChange, VisibilityWatcher, VisibilityZone } from './visibility-watcher';

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
  /**
   * Latência dos trechos promovidos pela rolagem. Resumo
   * `{ count, medianMs, maxMs }`; ausente enquanto não há medida.
   *
   * O que mede: do `clock()` lido no callback do observador que promoveu o
   * segmento à classe 0 até o `apply` com sucesso. O callback do
   * IntersectionObserver chega até ~1 quadro depois da entrada real na tela,
   * então a medida pode ficar até ~1 quadro abaixo da latência percebida.
   *
   * O que entra: só segmentos promovidos à classe 0 enquanto ainda estavam na
   * fila (um que já tinha saído dela não é movido nem medido). Segmentos
   * visíveis desde o `start` não entram (são o `firstVisibleMs`). Sair da
   * tela com o grupo ainda na fila, ou falhar, descarta a medida.
   *
   * Exceção: com `markers_invalid`, o fallback nó a nó não é observado de novo
   * (o bloco deixa de ser observado quando o plano original é aplicado).
   * Sair da tela com o fallback na fila NÃO descarta a medida; ela vai até o
   * fallback ser aplicado.
   */
  visibleLatency?: VisibleLatency;
}

/** Resumo das latências medidas no job (só números); formato de `VisibleLatencyView`. */
export type VisibleLatency = Readonly<VisibleLatencyView>;

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
  /**
   * Cria o observador de visibilidade de um job (no content real:
   * `createVisibilityWatcher` com `IntersectionObserver`). Opcional: sem ele
   * a ordem é a da classificação inicial (ADR-015).
   */
  createVisibilityWatcher?: (
    onChange: (changes: readonly VisibilityChange[]) => void,
  ) => VisibilityWatcher;
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
  /** Classe da classificação inicial (base do `firstVisibleMs`). */
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

/** Segmento não periférico acompanhado pelo observador de visibilidade. */
interface TrackedSegment {
  readonly block: Element;
  /** Índice na ordem de documento. */
  readonly order: number;
  /** Classe atual na fila (muda com a rolagem); o fallback herda esta. */
  priority: SegmentPriority;
  /** Última zona informada pelo observador (começa em `out`, como ele). */
  zone: VisibilityZone;
  /**
   * Começou na classe 0 pela medição e o observador ainda não informou zona
   * nenhuma: a primeira que vier é comparada com `visible`, não com `zone`.
   */
  awaitingFirstZone: boolean;
  /** Ainda observado: o grupo do segmento está na fila. */
  observed: boolean;
  /** `clock()` de quando foi promovido por entrar na tela; some se sair dela. */
  promotedAt?: number;
}

interface ActiveJob {
  readonly jobId: string;
  readonly port: PortLike;
  /** Grupos por `segmentId`: as unidades de um segmento andam juntas. */
  readonly queue: GroupedPriorityQueue<string, QueuedUnit>;
  /** `segmentId` → acompanhamento; só segmentos não periféricos. */
  readonly tracked: Map<string, TrackedSegment>;
  /** Bloco observado → segmentos dele ainda observados. */
  readonly blocks: Map<Element, Set<string>>;
  watcher: VisibilityWatcher | undefined;
  /** Latências medidas (ms), na ordem em que os segmentos foram aplicados. */
  readonly latencies: number[];
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

/** Cópia do estado, inclusive do resumo de latência (quem recebe não altera o interno). */
function copyState(state: JobState): JobState {
  const { visibleLatency } = state;
  return visibleLatency === undefined
    ? { ...state }
    : { ...state, visibleLatency: { ...visibleLatency } };
}

/** Resumo de uma lista não vazia de latências: mediana (média dos dois do meio se par) e máximo. */
function summarize(latencies: readonly number[]): VisibleLatency {
  const sorted = [...latencies].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return { count: sorted.length, medianMs, maxMs: sorted[sorted.length - 1] as number };
}

function createTask(plan: SegmentPlan, priority: SegmentPriority): SegmentTask {
  return { plan, priority, results: new Map(), remaining: plan.units.length };
}

/** Itens do grupo do plano, em ordem; plano sem unidades vira um item `null`. */
function itemsOf(task: SegmentTask): QueuedUnit[] {
  if (task.plan.units.length === 0) return [{ task, unit: null }];
  return task.plan.units.map((unit) => ({ task, unit }));
}

/** Destino de um segmento na fila depois de uma mudança de zona. */
interface Placement {
  readonly priority: SegmentPriority;
  readonly position: 'front' | 'back';
}

/**
 * Para onde vai um segmento da classe `priority` que passou da zona `from`
 * para `to`, ou `undefined` se fica onde está (regras no topo do arquivo).
 */
function placementFor(
  priority: SegmentPriority,
  from: VisibilityZone,
  to: VisibilityZone,
): Placement | undefined {
  if (to === 'visible') {
    return priority === PRIORITY_VISIBLE_MAIN
      ? undefined
      : { priority: PRIORITY_VISIBLE_MAIN, position: 'back' };
  }
  if (from === 'visible' && priority === PRIORITY_VISIBLE_MAIN) {
    return to === 'near'
      ? { priority: PRIORITY_NEAR, position: 'front' }
      : { priority: PRIORITY_MAIN, position: 'back' };
  }
  if (to === 'near' && priority === PRIORITY_MAIN) {
    return { priority: PRIORITY_NEAR, position: 'back' };
  }
  if (to === 'out' && from === 'near' && priority === PRIORITY_NEAR) {
    // A faixa perto fica abaixo da viewport: sair dela sem passar por
    // `visible` é sair por baixo (deslocamento de layout ou rolagem para
    // cima), e o bloco é o mais perto da tela entre os de fora abaixo dela.
    return { priority: PRIORITY_MAIN, position: 'front' };
  }
  return undefined;
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const applier = createPageApplier();
  const maxInFlight = deps.maxInFlight ?? MAX_UNITS_IN_FLIGHT;
  let state: JobState = { ...IDLE };
  let active: ActiveJob | null = null;
  let disposed = false;

  const emit = (next: JobState): void => {
    state = next;
    if (!disposed) deps.onState?.(copyState(state));
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

  /** Para de observar o segmento; o bloco sai quando não resta segmento dele. */
  const unobserve = (job: ActiveJob, segmentId: string): void => {
    const segment = job.tracked.get(segmentId);
    if (segment === undefined || !segment.observed) return;
    segment.observed = false;
    const ids = job.blocks.get(segment.block);
    if (ids === undefined) return;
    ids.delete(segmentId);
    if (ids.size > 0) return;
    job.blocks.delete(segment.block);
    job.watcher?.unobserve(segment.block);
  };

  /**
   * Reordena a fila conforme as zonas novas. Só mexe na fila: não envia, não
   * aplica e não chama `pump` (a próxima vaga que abrir já pega a ordem nova).
   */
  const handleVisibility = (job: ActiveJob, changes: readonly VisibilityChange[]): void => {
    if (active !== job) return;
    const touched: { segmentId: string; segment: TrackedSegment; zone: VisibilityZone }[] = [];
    for (const { block, zone } of changes) {
      const ids = job.blocks.get(block);
      if (ids === undefined) continue;
      for (const segmentId of ids) {
        const segment = job.tracked.get(segmentId);
        if (segment?.observed === true) touched.push({ segmentId, segment, zone });
      }
    }
    touched.sort((a, b) => a.segment.order - b.segment.order);

    const toBack: { segmentId: string; segment: TrackedSegment; placement: Placement }[] = [];
    const toFront: typeof toBack = [];
    for (const { segmentId, segment, zone } of touched) {
      // Antes da primeira zona do observador, vale o que a medição viu.
      const from = segment.awaitingFirstZone ? 'visible' : segment.zone;
      segment.awaitingFirstZone = false;
      const placement = job.queue.has(segmentId)
        ? placementFor(segment.priority, from, zone)
        : undefined;
      // Saiu da tela antes de ser aplicado: a medida de latência não vale.
      if (from === 'visible' && zone !== 'visible') delete segment.promotedAt;
      segment.zone = zone;
      if (placement === undefined) continue;
      (placement.position === 'back' ? toBack : toFront).push({ segmentId, segment, placement });
    }
    // Fins em ordem de documento (FIFO entre lotes). As frentes (classes 1 e
    // 2) são preenchidas do último para o primeiro do lote, para ficar em
    // ordem de documento; entre lotes elas são LIFO de propósito: o bloco que
    // saiu da zona por último é o mais perto dela.
    const moves = [...toBack];
    for (let index = toFront.length - 1; index >= 0; index -= 1) {
      moves.push(toFront[index] as (typeof toFront)[number]);
    }
    for (const { segmentId, segment, placement } of moves) {
      job.queue.move(segmentId, placement.priority, placement.position);
      segment.priority = placement.priority;
      if (placement.priority === PRIORITY_VISIBLE_MAIN) {
        const now = readClock();
        if (now === undefined) delete segment.promotedAt;
        else segment.promotedAt = now;
      }
    }
  };

  /**
   * Fecha a medida do segmento aplicado com sucesso: `clock() - promotedAt`
   * entra no resumo; leitura inválida ou negativa é descartada.
   */
  const measureLatency = (job: ActiveJob, segmentId: string): VisibleLatency | undefined => {
    const segment = job.tracked.get(segmentId);
    const promotedAt = segment?.promotedAt;
    if (segment === undefined || promotedAt === undefined) return undefined;
    delete segment.promotedAt;
    const now = readClock();
    if (now === undefined) return undefined;
    const value = now - promotedAt;
    if (!Number.isFinite(value) || value < 0) return undefined;
    job.latencies.push(value);
    return summarize(job.latencies);
  };

  /** Encerra o job: fila, janela, timer, ouvintes e porta. Nada do job é aplicado depois. */
  const teardown = (job: ActiveJob): void => {
    if (active === job) active = null;
    job.watcher?.disconnect();
    job.watcher = undefined;
    job.blocks.clear();
    job.tracked.clear();
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

  /** Aplica o plano completo; fallback volta à frente da classe atual do segmento. */
  const applyTask = (job: ActiveJob, task: SegmentTask): void => {
    const { segmentId } = task.plan;
    unobserve(job, segmentId);
    const result = applier.apply(segmentId, task.results);
    if (result.ok) {
      const next: JobState = { ...state, done: state.done + 1 };
      if (task.priority === PRIORITY_VISIBLE_MAIN && state.firstVisibleMs === undefined) {
        const firstVisibleMs = elapsed();
        if (firstVisibleMs !== undefined) next.firstVisibleMs = firstVisibleMs;
      }
      const visibleLatency = measureLatency(job, segmentId);
      if (visibleLatency !== undefined) next.visibleLatency = visibleLatency;
      emit(next);
    } else if (result.fallback !== undefined) {
      // O fallback não é observado de novo: já sai à frente da classe atual.
      // A medida de latência continua aberta até ele ser aplicado.
      const priority = job.tracked.get(segmentId)?.priority ?? task.priority;
      job.queue.pushFront(segmentId, itemsOf(createTask(result.fallback, task.priority)), priority);
    } else {
      const segment = job.tracked.get(segmentId);
      if (segment !== undefined) delete segment.promotedAt;
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
      // Grupo esvaziado: a posição dele não muda mais, então para de observar.
      if (!job.queue.has(task.plan.segmentId)) unobserve(job, task.plan.segmentId);
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
      const queue = createGroupedPriorityQueue<string, QueuedUnit>(PRIORITY_CLASSES);
      const tracked = new Map<string, TrackedSegment>();
      const blocks = new Map<Element, Set<string>>();
      let skipped = 0;
      for (const { segment, priority, order } of classified) {
        const plan = applier.plan(segment);
        if ('skipped' in plan) {
          skipped += 1;
          continue;
        }
        queue.push(plan.segmentId, itemsOf(createTask(plan, priority)), priority);
        // Periférico não é observado: a classe dele não depende da posição.
        if (priority === PRIORITY_PERIPHERAL) continue;
        tracked.set(plan.segmentId, {
          block: segment.block,
          order,
          priority,
          zone: 'out',
          awaitingFirstZone: priority === PRIORITY_VISIBLE_MAIN,
          observed: true,
        });
        const ids = blocks.get(segment.block);
        if (ids === undefined) blocks.set(segment.block, new Set([plan.segmentId]));
        else ids.add(plan.segmentId);
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
        tracked,
        blocks,
        watcher: undefined,
        latencies: [],
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
      if (deps.createVisibilityWatcher !== undefined && blocks.size > 0) {
        const watcher = deps.createVisibilityWatcher((changes) => handleVisibility(job, changes));
        job.watcher = watcher;
        for (const block of blocks.keys()) watcher.observe(block);
      }
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
      return copyState(state);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (stopActive()) state = finished({ ...state, status: 'cancelled' });
      applier.clear();
    },
  };
}
