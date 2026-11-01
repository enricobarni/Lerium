import { describe, expect, it, vi } from 'vitest';
import {
  createSegmentZoneTracker,
  MAX_ZONE_MEASURES_PER_FRAME,
  zoneOfRect,
  type SegmentZoneChange,
  type SegmentZoneTrackerDeps,
  type TrackedSegment,
  type ZoneRect,
} from '../../src/content/segment-zone-tracker';

const ZERO: ZoneRect = { top: 0, bottom: 0, width: 0, height: 0 };

/** Página falsa: cada nó tem posição absoluta (ou retângulo zerado) e a rolagem desloca tudo. */
function setup(viewportHeight = 100) {
  const layout = new Map<Text, { top: number; height: number } | 'zero'>();
  let scrollY = 0;
  let nextFrame = 1;
  const frames = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  const removeListener = vi.fn();
  const cancelFrame = vi.fn((id: number) => {
    frames.delete(id);
  });

  const measureText = vi.fn((nodes: readonly Text[]): ZoneRect => {
    const node = nodes[0];
    const entry = node === undefined ? undefined : layout.get(node);
    if (entry === undefined || entry === 'zero') return ZERO;
    const top = entry.top - scrollY;
    return { top, bottom: top + entry.height, width: 300, height: entry.height };
  });

  const deps: SegmentZoneTrackerDeps = {
    measureText,
    viewportHeight: () => viewportHeight,
    requestFrame: (cb) => {
      const id = nextFrame++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame,
    listen: (onScroll) => {
      listeners.add(onScroll);
      return () => {
        removeListener();
        listeners.delete(onScroll);
      };
    },
  };

  const batches: SegmentZoneChange[][] = [];
  const tracker = createSegmentZoneTracker(deps, (changes) => batches.push([...changes]));

  let counter = 0;
  /** Cria um bloco com `count` trechos de `height` px a partir de `offset` (absoluto). */
  function makeBlock(count: number, offset: number, height = 20) {
    const block = document.createElement('p');
    const segments: TrackedSegment[] = [];
    for (let i = 0; i < count; i++) {
      const node = document.createTextNode('');
      layout.set(node, { top: offset + i * height, height });
      segments.push({ segmentId: `s${counter++}`, nodes: [node], order: i });
    }
    return { block, segments };
  }

  return {
    tracker,
    measureText,
    cancelFrame,
    removeListener,
    batches,
    layout,
    makeBlock,
    frames,
    pendingFrames: () => frames.size,
    scrollTo(y: number) {
      scrollY = y;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
    flush() {
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb();
    },
    zones() {
      const result = new Map<string, string>();
      for (const batch of batches) for (const c of batch) result.set(c.segmentId, c.zone);
      return result;
    },
  };
}

describe('zoneOfRect', () => {
  it('classifica visible, near e out', () => {
    expect(zoneOfRect({ top: 10, bottom: 30, width: 1, height: 20 }, 100)).toBe('visible');
    expect(zoneOfRect({ top: 100, bottom: 120, width: 1, height: 20 }, 100)).toBe('near');
    expect(zoneOfRect({ top: 200, bottom: 220, width: 1, height: 20 }, 100)).toBe('out');
    expect(zoneOfRect({ top: -40, bottom: 0, width: 1, height: 40 }, 100)).toBe('out');
    expect(zoneOfRect(ZERO, 100)).toBe('out');
  });
});

describe('createSegmentZoneTracker', () => {
  it('emite a zona inicial de cada trecho, inclusive out, num único lote', () => {
    const t = setup();
    const { block, segments } = t.makeBlock(15, 0);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    t.flush();

    expect(t.batches).toHaveLength(1);
    const zones = t.zones();
    expect(zones.size).toBe(15);
    expect(zones.get('s0')).toBe('visible');
    expect(zones.get('s4')).toBe('visible');
    expect(zones.get('s5')).toBe('near');
    expect(zones.get('s9')).toBe('near');
    expect(zones.get('s10')).toBe('out');
    expect(zones.get('s14')).toBe('out');
  });

  it('só agenda: nada é medido fora do callback do quadro', () => {
    const t = setup();
    const { block, segments } = t.makeBlock(5, 0);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    t.tracker.invalidate(block);
    t.scrollTo(10);
    expect(t.measureText).not.toHaveBeenCalled();
    expect(t.pendingFrames()).toBe(1);
  });

  it('depois da inicial, emite só mudanças', () => {
    const t = setup();
    const { block, segments } = t.makeBlock(15, 0);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    t.flush();
    t.batches.length = 0;

    t.scrollTo(0);
    t.flush();
    expect(t.batches).toHaveLength(0);

    t.scrollTo(100);
    t.flush();
    expect(t.batches).toHaveLength(1);
    const changed = new Map(t.batches[0]?.map((c) => [c.segmentId, c.zone]));
    expect(changed.get('s0')).toBe('out');
    expect(changed.get('s5')).toBe('visible');
    expect(changed.get('s10')).toBe('near');
    expect(changed.get('s14')).toBe('near');
    expect(changed.has('s4')).toBe(true);
    expect(changed.has('s7')).toBe(true);
  });

  it('bloco com zona out não mede e emite out para todos', () => {
    const t = setup();
    const { block, segments } = t.makeBlock(10, 0);
    t.tracker.track(block, segments);
    t.flush(); // portão inicial: out
    expect(t.measureText).not.toHaveBeenCalled();
    expect([...t.zones().values()].every((z) => z === 'out')).toBe(true);

    t.tracker.setBlockZone(block, 'visible');
    t.flush();
    expect(t.zones().get('s0')).toBe('visible');
    t.measureText.mockClear();
    t.batches.length = 0;

    t.tracker.setBlockZone(block, 'out');
    t.flush();
    expect(t.measureText).not.toHaveBeenCalled();
    const changed = t.batches.flat();
    expect(changed.every((c) => c.zone === 'out')).toBe(true);
    expect(changed.map((c) => c.segmentId)).toEqual([
      's0',
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
      's7',
      's8',
      's9',
    ]);

    // Bloco out não é remedido na rolagem.
    t.scrollTo(50);
    t.flush();
    expect(t.measureText).not.toHaveBeenCalled();
  });

  it('busca binária: mede ~log2(n) + a janela', () => {
    const t = setup();
    const n = 1000;
    const { block, segments } = t.makeBlock(n, 0);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    t.scrollTo(10_000); // primeiro trecho com bottom > 0: índice 500
    t.flush();

    // Janela: índices 500..510 (o 510 tem top = 200 = 2 * vh e encerra a caminhada).
    const window = 11;
    expect(t.measureText.mock.calls.length).toBeLessThanOrEqual(Math.ceil(Math.log2(n)) + window);
    const zones = t.zones();
    expect(zones.get('s499')).toBe('out');
    expect(zones.get('s500')).toBe('visible');
    expect(zones.get('s505')).toBe('near');
    expect(zones.get('s510')).toBe('out');
    expect(zones.size).toBe(n);
  });

  it('respeita o teto por quadro e continua no quadro seguinte', () => {
    const t = setup(2000); // janela de 4000 px: 200 trechos de 20 px
    const { block, segments } = t.makeBlock(300, 0);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');

    t.flush();
    expect(t.measureText).toHaveBeenCalledTimes(MAX_ZONE_MEASURES_PER_FRAME);
    expect(t.pendingFrames()).toBe(1);
    expect(t.zones().has('s299')).toBe(false); // fora da janela só ao terminar o bloco

    let frames = 1;
    while (t.pendingFrames() > 0 && frames < 20) {
      t.measureText.mockClear();
      t.flush();
      expect(t.measureText.mock.calls.length).toBeLessThanOrEqual(MAX_ZONE_MEASURES_PER_FRAME);
      frames++;
    }
    expect(t.pendingFrames()).toBe(0);
    const zones = t.zones();
    expect(zones.size).toBe(300);
    expect(zones.get('s0')).toBe('visible');
    expect(zones.get('s150')).toBe('near');
    expect(zones.get('s250')).toBe('out');
  });

  it('o teto vale para o total de blocos do quadro', () => {
    const t = setup(2000);
    const a = t.makeBlock(50, 0);
    const b = t.makeBlock(50, 1000);
    t.tracker.track(a.block, a.segments);
    t.tracker.track(b.block, b.segments);
    t.tracker.setBlockZone(a.block, 'visible');
    t.tracker.setBlockZone(b.block, 'visible');
    t.flush();
    expect(t.measureText).toHaveBeenCalledTimes(MAX_ZONE_MEASURES_PER_FRAME);
    t.flush();
    expect(t.pendingFrames()).toBe(0);
    expect(t.zones().size).toBe(100);
  });

  it('rolagem coalescida: vários onScroll geram uma única passada', () => {
    const t = setup();
    const { block, segments } = t.makeBlock(15, 0);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    t.flush();
    t.measureText.mockClear();
    t.batches.length = 0;

    t.scrollTo(20);
    t.scrollTo(40);
    t.scrollTo(60);
    expect(t.pendingFrames()).toBe(1);
    t.flush();
    expect(t.batches.length).toBeLessThanOrEqual(1);
    const calls = t.measureText.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(15);
    expect(t.zones().get('s2')).toBe('out');
  });

  it('invalidate reagenda e remede o bloco', () => {
    const t = setup();
    const { block, segments } = t.makeBlock(10, 0);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    t.flush();
    t.batches.length = 0;

    const first = segments[0]?.nodes[0];
    if (first === undefined) throw new Error('sem nó');
    t.layout.set(first, { top: 150, height: 20 }); // o layout mudou após aplicar tradução
    t.tracker.invalidate(block);
    expect(t.pendingFrames()).toBe(1);
    t.flush();
    expect(t.batches.flat()).toContainEqual({ segmentId: 's0', zone: 'near' });
  });

  it('trecho que sai da janela medida vira out sem ser medido', () => {
    const t = setup();
    const { block, segments } = t.makeBlock(30, 0);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    t.flush();
    expect(t.zones().get('s0')).toBe('visible');
    t.measureText.mockClear();

    t.scrollTo(300); // janela: índices 15..25
    t.flush();
    const measured = new Set(t.measureText.mock.calls.map(([nodes]) => nodes[0]));
    expect(measured.has(segments[0]?.nodes[0] as Text)).toBe(false);
    expect(measured.has(segments[2]?.nodes[0] as Text)).toBe(false);
    const zones = t.zones();
    expect(zones.get('s0')).toBe('out');
    expect(zones.get('s2')).toBe('out');
    expect(zones.get('s15')).toBe('visible');
  });

  it('nó com retângulo zerado (desconectado) é out', () => {
    const t = setup();
    const { block, segments } = t.makeBlock(5, 0);
    const second = segments[1]?.nodes[0];
    if (second === undefined) throw new Error('sem nó');
    t.layout.set(second, 'zero');
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    t.flush();
    expect(t.measureText).toHaveBeenCalledWith([second]);
    const zones = t.zones();
    expect(zones.get('s1')).toBe('out');
    expect(zones.get('s0')).toBe('visible');
    expect(zones.get('s2')).toBe('visible');
  });

  it('track é idempotente por segmentId', () => {
    const t = setup();
    const { block, segments } = t.makeBlock(3, 0);
    t.tracker.track(block, segments);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    t.flush();
    expect(t.batches.flat()).toHaveLength(3);
    expect(t.measureText.mock.calls.length).toBeLessThanOrEqual(3 + 2);
  });

  it('untrack deixa de medir e de emitir o trecho', () => {
    const t = setup();
    const { block, segments } = t.makeBlock(5, 0);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    t.flush();
    t.batches.length = 0;
    t.measureText.mockClear();

    t.tracker.untrack('s0');
    t.scrollTo(200);
    t.flush();
    const ids = t.batches.flat().map((c) => c.segmentId);
    expect(ids).not.toContain('s0');
    expect(ids).toContain('s1');
    const removed = segments[0]?.nodes[0] as Text;
    expect(t.measureText.mock.calls.some(([nodes]) => nodes[0] === removed)).toBe(false);

    // Último trecho removido: o bloco some e não agenda nada.
    for (const id of ['s1', 's2', 's3', 's4']) t.tracker.untrack(id);
    t.scrollTo(0);
    expect(t.pendingFrames()).toBe(0);
  });

  it('disconnect remove o listener, cancela o quadro e não emite depois', () => {
    const t = setup();
    const { block, segments } = t.makeBlock(5, 0);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    expect(t.pendingFrames()).toBe(1);
    const due = [...t.frames.values()];

    t.tracker.disconnect();
    expect(t.removeListener).toHaveBeenCalledTimes(1);
    expect(t.cancelFrame).toHaveBeenCalledTimes(1);
    expect(t.listenerCount()).toBe(0);
    expect(t.pendingFrames()).toBe(0);

    // Mesmo um callback que escapou do cancelamento não mede nem emite.
    for (const cb of due) cb();
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    t.tracker.invalidate(block);
    t.flush();
    expect(t.measureText).not.toHaveBeenCalled();
    expect(t.batches).toHaveLength(0);
  });
});
