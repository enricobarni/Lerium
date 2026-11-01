/**
 * Rastreia a zona (`visible`, `near` ou `out`) de cada trecho dentro de blocos
 * compartilhados por vários segmentos.
 *
 * O IntersectionObserver informa só a zona do bloco inteiro; um bloco longo pode estar
 * `visible` com a maior parte dos trechos fora da tela. Este módulo refina a zona por
 * trecho medindo os nós de texto, com três limites de custo:
 *
 * - no máximo uma passada por quadro: scroll, resize, `setBlockZone`, `invalidate` e
 *   `track` apenas agendam via `requestFrame`; nada é medido fora do callback do quadro;
 * - só blocos com zona `visible` ou `near` são medidos; para cada um, uma busca binária
 *   (pela ordem de documento) acha o primeiro trecho com `bottom > 0` e uma caminhada
 *   para frente mede até o primeiro trecho com `top >= 2 * vh`;
 * - no total, `MAX_ZONE_MEASURES_PER_FRAME` medições por quadro; ao estourar, o trabalho
 *   continua do mesmo ponto no quadro seguinte.
 *
 * Trechos fora da janela medida viram `out` sem medição. A busca binária pressupõe que
 * os trechos de um bloco seguem a ordem vertical do documento (texto em fluxo normal).
 *
 * O módulo não altera o DOM nem lê texto: só repassa os nós a `measureText`.
 */

import { hasArea, zoneOfRect, type RectZone, type ZoneRect } from './zone-rect';

export { zoneOfRect, type ZoneRect };

export type SegmentZone = RectZone;

export interface TrackedSegment {
  readonly segmentId: string;
  readonly nodes: readonly Text[];
  /** Posição na ordem de documento; define a ordem da busca binária. */
  readonly order: number;
}

export interface SegmentZoneChange {
  readonly segmentId: string;
  readonly zone: SegmentZone;
}

export interface SegmentZoneTrackerDeps {
  /** Mede os nós como estão; nós desconectados devem produzir um retângulo zerado. */
  measureText(nodes: readonly Text[]): ZoneRect;
  viewportHeight(): number;
  requestFrame(cb: () => void): number;
  cancelFrame(id: number): void;
  /** Registra scroll/resize; devolve a função de remoção. */
  listen(onScroll: () => void): () => void;
}

export interface SegmentZoneTracker {
  /** Segmentos em ordem de documento; idempotente por `segmentId`. */
  track(block: Element, segments: readonly TrackedSegment[]): void;
  /** Portão vindo do IntersectionObserver. */
  setBlockZone(block: Element, zone: SegmentZone): void;
  /** Força nova medição do bloco (ex.: após aplicar tradução, o layout pode ter mudado). */
  invalidate(block: Element): void;
  untrack(segmentId: string): void;
  disconnect(): void;
}

export const MAX_ZONE_MEASURES_PER_FRAME = 64;

interface SegmentState {
  readonly segment: TrackedSegment;
  /** `undefined` até a emissão inicial. */
  zone: SegmentZone | undefined;
}

/** Progresso de uma passada sobre um bloco, retomável no quadro seguinte. */
interface BlockProgress {
  phase: 'search' | 'walk';
  lo: number;
  hi: number;
  /** Primeiro índice da janela medida (válido na fase `walk`). */
  start: number;
  /** Próximo índice a medir na caminhada. */
  next: number;
  /** Retângulos já medidos nesta passada do bloco, por índice. */
  readonly cache: Map<number, ZoneRect>;
}

interface BlockState {
  gate: SegmentZone;
  /** Ordenados por `order`. */
  segments: SegmentState[];
}

function freshProgress(length: number): BlockProgress {
  return { phase: 'search', lo: 0, hi: length, start: 0, next: 0, cache: new Map() };
}

export function createSegmentZoneTracker(
  deps: SegmentZoneTrackerDeps,
  onChange: (changes: readonly SegmentZoneChange[]) => void,
): SegmentZoneTracker {
  const blocks = new Map<Element, BlockState>();
  const blockOfSegment = new Map<string, Element>();
  /** Blocos com passada pendente; o valor é o progresso (ou `null` se ainda não começou). */
  const pending = new Map<Element, BlockProgress | null>();
  let frameId: number | null = null;
  let disconnected = false;

  const removeListener = deps.listen(onScroll);

  function schedule(): void {
    if (disconnected || frameId !== null || pending.size === 0) return;
    frameId = deps.requestFrame(runPass);
  }

  /** Marca o bloco para uma passada do zero (descarta progresso antigo). */
  function markPending(block: Element): void {
    pending.set(block, null);
  }

  function onScroll(): void {
    if (disconnected) return;
    for (const [block, state] of blocks) {
      if (state.gate !== 'out') markPending(block);
    }
    schedule();
  }

  function emit(state: SegmentState, zone: SegmentZone, changes: SegmentZoneChange[]): void {
    if (state.zone === zone) return;
    state.zone = zone;
    changes.push({ segmentId: state.segment.segmentId, zone });
  }

  /**
   * Avança a passada de um bloco aberto (`visible`/`near`).
   * Devolve `true` se terminou; `false` se o orçamento acabou antes.
   */
  function processOpenBlock(
    state: BlockState,
    progress: BlockProgress,
    vh: number,
    budget: { left: number },
    changes: SegmentZoneChange[],
  ): boolean {
    const list = state.segments;
    const measure = (index: number): ZoneRect | null => {
      const cached = progress.cache.get(index);
      if (cached !== undefined) return cached;
      if (budget.left <= 0) return null;
      budget.left -= 1;
      const segment = list[index];
      if (segment === undefined) return null;
      const rect = deps.measureText(segment.segment.nodes);
      progress.cache.set(index, rect);
      return rect;
    };

    if (progress.phase === 'search') {
      while (progress.lo < progress.hi) {
        const mid = Math.floor((progress.lo + progress.hi) / 2);
        const rect = measure(mid);
        if (rect === null) return false;
        if (hasArea(rect)) {
          if (rect.bottom > 0) progress.hi = mid;
          else progress.lo = mid + 1;
          continue;
        }
        // Sem área (ex.: nó desconectado) não diz de que lado está: decide pelo
        // próximo trecho com área. O cache torna essa varredura retomável.
        let decided = false;
        for (let j = mid + 1; j < progress.hi; j++) {
          const next = measure(j);
          if (next === null) return false;
          if (!hasArea(next)) continue;
          if (next.bottom > 0) progress.hi = mid;
          else progress.lo = j + 1;
          decided = true;
          break;
        }
        if (!decided) progress.hi = mid;
      }
      progress.phase = 'walk';
      progress.start = progress.lo;
      progress.next = progress.lo;
      // Acima da janela: `out` já, sem medir. Sob rolagem contínua a passada pode
      // nunca chegar ao fim, e esses trechos não podem esperar por ela.
      for (let index = 0; index < progress.start; index++) {
        const segment = list[index];
        if (segment !== undefined) emit(segment, 'out', changes);
      }
    }

    const limit = 2 * vh;
    while (progress.next < list.length) {
      const rect = measure(progress.next);
      if (rect === null) return false;
      const segment = list[progress.next];
      progress.next += 1;
      if (segment !== undefined) emit(segment, zoneOfRect(rect, vh), changes);
      if (rect.top >= limit) break;
    }

    // Abaixo da janela: `out` sem medir (os de cima já saíram ao fim da busca).
    for (let index = progress.next; index < list.length; index++) {
      const segment = list[index];
      if (segment !== undefined) emit(segment, 'out', changes);
    }
    return true;
  }

  function runPass(): void {
    frameId = null;
    if (disconnected) return;
    const vh = deps.viewportHeight();
    const budget = { left: MAX_ZONE_MEASURES_PER_FRAME };
    const changes: SegmentZoneChange[] = [];

    for (const [block, saved] of pending) {
      const state = blocks.get(block);
      if (state === undefined) {
        pending.delete(block);
        continue;
      }
      if (state.gate === 'out') {
        for (const segment of state.segments) emit(segment, 'out', changes);
        pending.delete(block);
        continue;
      }
      const progress = saved ?? freshProgress(state.segments.length);
      if (processOpenBlock(state, progress, vh, budget, changes)) {
        pending.delete(block);
      } else {
        pending.set(block, progress);
        break;
      }
    }

    schedule();
    if (changes.length > 0) onChange(changes);
  }

  return {
    track(block, segments) {
      if (disconnected) return;
      let state = blocks.get(block);
      let added = false;
      for (const segment of segments) {
        if (blockOfSegment.has(segment.segmentId)) continue;
        if (state === undefined) {
          state = { gate: 'out', segments: [] };
          blocks.set(block, state);
        }
        state.segments.push({ segment, zone: undefined });
        blockOfSegment.set(segment.segmentId, block);
        added = true;
      }
      if (!added || state === undefined) return;
      state.segments.sort((a, b) => a.segment.order - b.segment.order);
      markPending(block);
      schedule();
    },

    setBlockZone(block, zone) {
      if (disconnected) return;
      const state = blocks.get(block);
      if (state === undefined) return;
      state.gate = zone;
      markPending(block);
      schedule();
    },

    invalidate(block) {
      if (disconnected || !blocks.has(block)) return;
      markPending(block);
      schedule();
    },

    untrack(segmentId) {
      if (disconnected) return;
      const block = blockOfSegment.get(segmentId);
      if (block === undefined) return;
      blockOfSegment.delete(segmentId);
      const state = blocks.get(block);
      if (state === undefined) return;
      state.segments = state.segments.filter((s) => s.segment.segmentId !== segmentId);
      if (state.segments.length === 0) {
        blocks.delete(block);
        pending.delete(block);
        return;
      }
      // Os índices mudaram: um progresso salvo não vale mais.
      if (pending.has(block)) markPending(block);
    },

    disconnect() {
      if (disconnected) return;
      disconnected = true;
      removeListener();
      if (frameId !== null) deps.cancelFrame(frameId);
      frameId = null;
      blocks.clear();
      blockOfSegment.clear();
      pending.clear();
    },
  };
}
