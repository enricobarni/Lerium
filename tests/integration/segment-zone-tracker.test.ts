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
import { zoneOfRect as priorityZoneOfRect } from '../../src/content/segment-priority';

const ZERO: ZoneRect = { top: 0, bottom: 0, width: 0, height: 0 };

/** Página falsa: cada nó tem posição absoluta (ou retângulo zerado) e a rolagem desloca tudo. */
function setup(viewportHeight = 100) {
  const layout = new Map<Text, { top: number; height: number } | 'zero'>();
  let scrollY = 0;
  let nextFrame = 1;
  const frames = new Map<number, () => void>();
  const listeners = new Set<(target: EventTarget | null) => void>();
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
    /** Rola e avisa os listeners; `target` é o alvo do evento (padrão: o documento). */
    scrollTo(y: number, target: EventTarget | null = document) {
      scrollY = y;
      for (const listener of listeners) listener(target);
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

  it('é a mesma regra da classificação inicial', () => {
    expect(zoneOfRect).toBe(priorityZoneOfRect);
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

  it('reveza blocos: um bloco que estoura o orçamento não deixa outro sem medir', () => {
    const t = setup(800);
    const a = t.makeBlock(200, 0); // janela de 80 trechos + busca: estoura o orçamento
    const b = t.makeBlock(200, 1000);
    t.tracker.track(a.block, a.segments);
    t.tracker.track(b.block, b.segments);
    t.tracker.setBlockZone(a.block, 'visible');
    t.tracker.setBlockZone(b.block, 'near');

    const bIds = new Set(b.segments.map((s) => s.segmentId));
    for (let frame = 1; frame <= 50; frame++) {
      if (frame === 25) t.tracker.setBlockZone(b.block, 'visible');
      t.scrollTo(frame * 5);
      t.flush();
    }

    const bChanges = t.batches.flat().filter((c) => bIds.has(c.segmentId));
    expect(bChanges.length).toBeGreaterThan(0);
    // B começa em 1000 - 250 = 750 px: o primeiro trecho está na tela.
    expect(t.zones().get(b.segments[0]?.segmentId ?? '')).toBe('visible');
  });

  it('rolagem de um contêiner que não contém o bloco não agenda nem mede', () => {
    const t = setup();
    const container = document.createElement('div');
    const inside = t.makeBlock(5, 0);
    const outside = t.makeBlock(5, 0);
    container.append(inside.block);
    document.body.append(container, outside.block);
    try {
      t.tracker.track(outside.block, outside.segments);
      t.tracker.setBlockZone(outside.block, 'visible');
      t.flush();
      t.measureText.mockClear();

      t.scrollTo(0, container);
      expect(t.pendingFrames()).toBe(0);
      t.flush();
      expect(t.measureText).not.toHaveBeenCalled();

      // O contêiner que contém o bloco o remede.
      t.tracker.track(inside.block, inside.segments);
      t.tracker.setBlockZone(inside.block, 'visible');
      t.flush();
      t.measureText.mockClear();
      t.scrollTo(0, container);
      expect(t.pendingFrames()).toBe(1);
      t.flush();
      const measured = new Set(t.measureText.mock.calls.map(([nodes]) => nodes[0]));
      expect(measured.has(inside.segments[0]?.nodes[0] as Text)).toBe(true);
      expect(measured.has(outside.segments[0]?.nodes[0] as Text)).toBe(false);

      // Documento, elemento de rolagem raiz e janela (scroll da página e resize) remedem todos.
      for (const target of [document, document.scrollingElement, window, null]) {
        t.measureText.mockClear();
        t.scrollTo(0, target);
        expect(t.pendingFrames(), String(target)).toBe(1);
        t.flush();
        const all = new Set(t.measureText.mock.calls.map(([nodes]) => nodes[0]));
        expect(all.has(inside.segments[0]?.nodes[0] as Text), String(target)).toBe(true);
        expect(all.has(outside.segments[0]?.nodes[0] as Text), String(target)).toBe(true);
      }
    } finally {
      container.remove();
      outside.block.remove();
    }
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

  it('rolagem contínua: trechos acima da tela viram out mesmo sem a passada terminar', () => {
    // Janela de 1600 px = 80 trechos + busca > 64 medidas: a passada não cabe num quadro.
    const vh = 800;
    const t = setup(vh);
    const { block, segments } = t.makeBlock(100, 0);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    while (t.pendingFrames() > 0) t.flush();

    for (let frame = 1; frame <= 100; frame++) {
      const scrollY = frame * 10;
      t.scrollTo(scrollY);
      t.flush();
      const zones = t.zones();
      // Trecho i tem bottom = (i + 1) * 20 - scrollY; bottom <= 0 → acima da tela.
      const firstOnScreen = Math.floor(scrollY / 20);
      for (let i = 0; i < firstOnScreen; i++) {
        expect(zones.get(`s${i}`), `quadro ${frame}, s${i}`).toBe('out');
      }
      expect(zones.get(`s${firstOnScreen}`), `quadro ${frame}`).toBe('visible');
    }

    // Ao fim (rolagem 1000): 0..49 acima, 50..89 visíveis, 90..99 perto.
    const zones = t.zones();
    for (let i = 0; i < 100; i++) {
      const expected = i < 50 ? 'out' : i < 90 ? 'visible' : 'near';
      expect(zones.get(`s${i}`), `s${i}`).toBe(expected);
    }
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

  it('rolagem durante a continuação recomeça a passada com a nova posição', () => {
    const t = setup(2000); // janela de 4000 px: 200 trechos de 20 px
    const { block, segments } = t.makeBlock(300, 0);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    t.flush(); // passada parcial: orçamento estourado
    expect(t.pendingFrames()).toBe(1);
    expect(t.zones().get('s0')).toBe('visible');

    t.scrollTo(1000); // primeiro trecho na tela: s50
    let frames = 0;
    while (t.pendingFrames() > 0 && frames < 20) {
      t.measureText.mockClear();
      t.flush();
      expect(t.measureText.mock.calls.length).toBeLessThanOrEqual(MAX_ZONE_MEASURES_PER_FRAME);
      frames++;
    }
    expect(t.pendingFrames()).toBe(0);
    const zones = t.zones();
    expect(zones.size).toBe(300);
    for (let i = 0; i < 300; i++) {
      const expected = i < 50 ? 'out' : i < 150 ? 'visible' : i < 250 ? 'near' : 'out';
      expect(zones.get(`s${i}`), `s${i}`).toBe(expected);
    }
  });

  describe('retângulos zerados no meio da busca', () => {
    /** 20 trechos; a busca começa em mid = 10; s10 e s11 zerados, s12 é o vizinho com área. */
    function zeroedAtMid(scrollY: number) {
      const t = setup();
      const { block, segments } = t.makeBlock(20, 0);
      for (const index of [10, 11]) {
        const node = segments[index]?.nodes[0];
        if (node === undefined) throw new Error('sem nó');
        t.layout.set(node, 'zero');
      }
      t.tracker.track(block, segments);
      t.tracker.setBlockZone(block, 'visible');
      t.scrollTo(scrollY);
      t.flush();
      const neighbor = segments[12]?.nodes[0] as Text;
      expect(t.measureText).toHaveBeenCalledWith([neighbor]);
      expect(t.pendingFrames()).toBe(0);
      return t.zones();
    }

    it('vizinho com bottom <= 0 manda a busca para depois dele', () => {
      const zones = zeroedAtMid(280); // s12: bottom = 260 - 280 < 0; primeiro na tela: s14
      for (let i = 0; i < 14; i++) expect(zones.get(`s${i}`), `s${i}`).toBe('out');
      expect(zones.get('s14')).toBe('visible');
      expect(zones.get('s18')).toBe('visible');
      expect(zones.get('s19')).toBe('near');
    });

    it('vizinho com bottom > 0 manda a busca para antes do mid', () => {
      const zones = zeroedAtMid(100); // s12: bottom = 160 > 0; primeiro na tela: s5
      for (let i = 0; i < 5; i++) expect(zones.get(`s${i}`), `s${i}`).toBe('out');
      for (let i = 5; i < 10; i++) expect(zones.get(`s${i}`), `s${i}`).toBe('visible');
      expect(zones.get('s10')).toBe('out');
      expect(zones.get('s11')).toBe('out');
      expect(zones.get('s12')).toBe('near');
      expect(zones.get('s14')).toBe('near');
      expect(zones.get('s15')).toBe('out');
      expect(zones.size).toBe(20);
    });
  });

  it('todos os trechos acima da tela: janela vazia, todos out', () => {
    const t = setup();
    const { block, segments } = t.makeBlock(10, 0);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'visible');
    t.scrollTo(1000);
    t.flush();
    expect(t.pendingFrames()).toBe(0);
    expect(t.measureText.mock.calls.length).toBeLessThanOrEqual(Math.ceil(Math.log2(10)));
    const zones = t.zones();
    expect(zones.size).toBe(10);
    expect([...zones.values()].every((z) => z === 'out')).toBe(true);
  });

  it('todos os trechos abaixo de 2 * vh: mede só a busca e o primeiro, todos out', () => {
    const t = setup(); // limite da caminhada: top >= 200
    const { block, segments } = t.makeBlock(10, 500);
    t.tracker.track(block, segments);
    t.tracker.setBlockZone(block, 'near');
    t.flush();
    expect(t.pendingFrames()).toBe(0);
    expect(t.measureText.mock.calls.length).toBeLessThanOrEqual(Math.ceil(Math.log2(10)) + 1);
    const zones = t.zones();
    expect(zones.size).toBe(10);
    expect([...zones.values()].every((z) => z === 'out')).toBe(true);
  });

  it('três blocos disputando o orçamento sob rolagem: todos são medidos', () => {
    const t = setup(800);
    const blocks = [t.makeBlock(200, 0), t.makeBlock(200, 400), t.makeBlock(200, 900)];
    for (const { block, segments } of blocks) {
      t.tracker.track(block, segments);
      t.tracker.setBlockZone(block, 'visible');
    }
    t.measureText.mockClear();
    for (let frame = 1; frame <= 30; frame++) {
      t.scrollTo(frame * 10);
      t.measureText.mockClear();
      t.flush();
      expect(t.measureText.mock.calls.length).toBeLessThanOrEqual(MAX_ZONE_MEASURES_PER_FRAME);
    }
    const zones = t.zones();
    // Rolagem final 300: o primeiro trecho de cada bloco na tela.
    expect(zones.get(blocks[0]?.segments[15]?.segmentId ?? '')).toBe('visible');
    expect(zones.get(blocks[1]?.segments[0]?.segmentId ?? '')).toBe('visible');
    expect(zones.get(blocks[2]?.segments[0]?.segmentId ?? '')).toBe('visible');
    expect(zones.get(blocks[0]?.segments[0]?.segmentId ?? '')).toBe('out');
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
