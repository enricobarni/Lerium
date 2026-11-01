import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  createVisibilityWatcher,
  NEAR_ROOT_MARGIN,
  type ObservedEntry,
  type ObserverFactory,
  type VisibilityChange,
  type VisibilityWatcher,
} from '../../src/content/visibility-watcher';

type Callback = Parameters<ObserverFactory>[0];
type Options = Parameters<ObserverFactory>[1];

/** Geometria opcional que a entrada real já traz pré-calculada. */
type Geometry = Pick<ObservedEntry, 'boundingClientRect' | 'rootBounds'>;
type FakeEntry = readonly [Element, boolean] | readonly [Element, boolean, Geometry];

interface FakeObserver {
  readonly callback: Callback;
  readonly options: Options;
  readonly observed: Set<Element>;
  readonly calls: { observe: number; unobserve: number; disconnect: number };
  emit(entries: readonly FakeEntry[]): void;
}

function createFakeFactory(): { factory: ObserverFactory; observers: FakeObserver[] } {
  const observers: FakeObserver[] = [];
  const factory: ObserverFactory = (callback, options) => {
    const observed = new Set<Element>();
    const calls = { observe: 0, unobserve: 0, disconnect: 0 };
    observers.push({
      callback,
      options,
      observed,
      calls,
      emit: (entries) =>
        callback(
          entries.map(([target, isIntersecting, geometry]) => ({
            target,
            isIntersecting,
            ...geometry,
          })),
        ),
    });
    return {
      observe(el) {
        calls.observe += 1;
        observed.add(el);
      },
      unobserve(el) {
        calls.unobserve += 1;
        observed.delete(el);
      },
      disconnect() {
        calls.disconnect += 1;
        observed.clear();
      },
    };
  };
  return { factory, observers };
}

const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
let consoleSpies: MockInstance[] = [];
let rectSpy: MockInstance;

let batches: VisibilityChange[][];
let watcher: VisibilityWatcher;
let visibleObs: FakeObserver;
let nearObs: FakeObserver;
let a: Element;
let b: Element;
let c: Element;

beforeEach(() => {
  consoleSpies = consoleMethods.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
  rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect');
  batches = [];
  const { factory, observers } = createFakeFactory();
  watcher = createVisibilityWatcher(factory, (changes) => batches.push([...changes]));
  expect(observers).toHaveLength(2);
  const found = (margin: string): FakeObserver => {
    const observer = observers.find((o) => o.options.rootMargin === margin);
    if (observer === undefined) throw new Error(`observador ausente: ${margin}`);
    return observer;
  };
  visibleObs = found('0px');
  nearObs = found(NEAR_ROOT_MARGIN);
  a = document.createElement('p');
  b = document.createElement('p');
  c = document.createElement('p');
});

afterEach(() => {
  expect(rectSpy).not.toHaveBeenCalled();
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

const zones = (batch: VisibilityChange[] | undefined): [Element, string][] =>
  (batch ?? []).map((change) => [change.block, change.zone]);

/** Geometria de um bloco cuja borda de baixo está em `bottom`, com o topo da raiz em `rootTop`. */
const at = (bottom: number, rootTop: number | null = 0): Geometry => ({
  boundingClientRect: { bottom },
  rootBounds: rootTop === null ? null : { top: rootTop },
});

describe('createVisibilityWatcher', () => {
  it('cria dois observadores com threshold 0 e as margens corretas', () => {
    expect(NEAR_ROOT_MARGIN).toBe('0px 0px 100% 0px');
    expect(visibleObs.options).toEqual({ rootMargin: '0px', threshold: 0 });
    expect(nearObs.options).toEqual({ rootMargin: NEAR_ROOT_MARGIN, threshold: 0 });
  });

  it('observe registra o bloco nos dois observadores', () => {
    watcher.observe(a);
    expect(visibleObs.observed.has(a)).toBe(true);
    expect(nearObs.observed.has(a)).toBe(true);
    expect(batches).toEqual([]);
  });

  describe('zona inicial', () => {
    it('só é emitida quando os dois observadores entregaram a primeira entrada', () => {
      watcher.observe(a);
      nearObs.emit([[a, true]]);
      expect(batches).toEqual([]);
      visibleObs.emit([[a, false]]);
      expect(batches.map(zones)).toEqual([[[a, 'near']]]);
    });

    it('near antes de visible emite um único visible, sem near transitório', () => {
      watcher.observe(a);
      nearObs.emit([[a, true]]);
      visibleObs.emit([[a, true]]);
      expect(batches.map(zones)).toEqual([[[a, 'visible']]]);
    });

    it('visible antes de near emite um único visible quando near chega', () => {
      watcher.observe(a);
      visibleObs.emit([[a, true]]);
      expect(batches).toEqual([]);
      nearObs.emit([[a, true]]);
      expect(batches.map(zones)).toEqual([[[a, 'visible']]]);
    });

    it('primeiras entradas sem interseção emitem out', () => {
      watcher.observe(a);
      visibleObs.emit([[a, false]]);
      nearObs.emit([[a, false]]);
      expect(batches.map(zones)).toEqual([[[a, 'out']]]);
    });

    it('unobserve seguido de observe exige as duas entradas iniciais de novo', () => {
      watcher.observe(a);
      visibleObs.emit([[a, false]]);
      nearObs.emit([[a, true]]);
      expect(batches).toHaveLength(1);
      watcher.unobserve(a);
      watcher.observe(a);
      visibleObs.emit([[a, true]]);
      expect(batches).toHaveLength(1);
      nearObs.emit([[a, true]]);
      expect(batches).toHaveLength(2);
      expect(zones(batches[1])).toEqual([[a, 'visible']]);
    });
  });

  it('entrar na viewport emite visible', () => {
    watcher.observe(a);
    visibleObs.emit([[a, false]]);
    nearObs.emit([[a, true]]);
    visibleObs.emit([[a, true]]);
    expect(batches.map(zones)).toEqual([[[a, 'near']], [[a, 'visible']]]);
  });

  it('sair da viewport por baixo ficando na faixa próxima emite near', () => {
    watcher.observe(a);
    nearObs.emit([[a, true]]);
    visibleObs.emit([[a, true]]);
    // Borda de baixo abaixo do topo da raiz: o bloco desceu, não subiu.
    visibleObs.emit([[a, false, at(900)]]);
    expect(batches).toHaveLength(2);
    expect(zones(batches[1])).toEqual([[a, 'near']]);
  });

  it('sair de tudo emite out', () => {
    watcher.observe(a);
    nearObs.emit([[a, true]]);
    visibleObs.emit([[a, true]]);
    visibleObs.emit([[a, false]]);
    nearObs.emit([[a, false]]);
    expect(batches.map(zones)).toEqual([[[a, 'visible']], [[a, 'near']], [[a, 'out']]]);
  });

  describe('bloco acima da viewport', () => {
    it('sair pelo topo vai direto para out, sem passar por near', () => {
      watcher.observe(a);
      nearObs.emit([[a, true]]);
      visibleObs.emit([[a, true]]);
      visibleObs.emit([[a, false, at(-5)]]);
      expect(batches.map(zones)).toEqual([[[a, 'visible']], [[a, 'out']]]);
      // A entrada atrasada da faixa próxima não muda nada.
      nearObs.emit([[a, false, at(-5)]]);
      expect(batches).toHaveLength(2);
    });

    it('borda de baixo exatamente no topo da raiz conta como acima', () => {
      watcher.observe(a);
      nearObs.emit([[a, true]]);
      visibleObs.emit([[a, true]]);
      visibleObs.emit([[a, false, at(40, 40)]]);
      expect(zones(batches[1])).toEqual([[a, 'out']]);
    });

    it('sem rootBounds, o topo da raiz é 0', () => {
      watcher.observe(a);
      nearObs.emit([[a, true]]);
      visibleObs.emit([[a, true]]);
      visibleObs.emit([[a, false, at(0, null)]]);
      expect(zones(batches[1])).toEqual([[a, 'out']]);
    });

    it('entrada que ainda intersecta não é tratada como acima', () => {
      watcher.observe(a);
      nearObs.emit([[a, true]]);
      visibleObs.emit([[a, true, at(-5)]]);
      expect(batches.map(zones)).toEqual([[[a, 'visible']]]);
    });
  });

  it('não emite quando a zona não muda', () => {
    watcher.observe(a);
    visibleObs.emit([[a, false]]);
    nearObs.emit([[a, false]]);
    expect(batches).toHaveLength(1); // zona inicial out
    nearObs.emit([[a, true]]);
    nearObs.emit([[a, true]]);
    expect(batches).toHaveLength(2);
    // Mudança que se desfaz dentro do mesmo lote não emite.
    nearObs.emit([
      [a, false],
      [a, true],
    ]);
    expect(batches).toHaveLength(2);
  });

  it('emite um lote com vários blocos na ordem das entradas, só com os que mudaram', () => {
    watcher.observe(a);
    watcher.observe(b);
    watcher.observe(c);
    visibleObs.emit([
      [a, false],
      [b, false],
      [c, false],
    ]);
    nearObs.emit([[b, true]]);
    nearObs.emit([
      [c, true],
      [b, true],
      [a, true],
    ]);
    expect(batches).toHaveLength(2);
    expect(zones(batches[0])).toEqual([[b, 'near']]);
    expect(zones(batches[1])).toEqual([
      [c, 'near'],
      [a, 'near'],
    ]);
  });

  it('callbacks dos dois observadores no mesmo quadro emitem lotes separados', () => {
    watcher.observe(a);
    watcher.observe(b);
    visibleObs.emit([
      [a, false],
      [b, false],
    ]);
    nearObs.emit([
      [a, false],
      [b, false],
    ]);
    nearObs.emit([
      [a, true],
      [b, true],
    ]);
    visibleObs.emit([[a, true]]);
    expect(batches.map(zones)).toEqual([
      [
        [a, 'out'],
        [b, 'out'],
      ],
      [
        [a, 'near'],
        [b, 'near'],
      ],
      [[a, 'visible']],
    ]);
  });

  it('ignora entradas de blocos não observados', () => {
    nearObs.emit([[a, true]]);
    visibleObs.emit([[a, true]]);
    expect(batches).toEqual([]);
  });

  it('observe é idempotente e não reinicia o estado', () => {
    watcher.observe(a);
    visibleObs.emit([[a, false]]);
    nearObs.emit([[a, true]]);
    watcher.observe(a);
    expect(visibleObs.calls.observe).toBe(1);
    expect(nearObs.calls.observe).toBe(1);
    nearObs.emit([[a, true]]);
    expect(batches).toHaveLength(1);
  });

  it('unobserve remove dos dois observadores e esquece o estado', () => {
    watcher.observe(a);
    visibleObs.emit([[a, false]]);
    nearObs.emit([[a, true]]);
    watcher.unobserve(a);
    expect(visibleObs.observed.has(a)).toBe(false);
    expect(nearObs.observed.has(a)).toBe(false);
    // Entrada atrasada do bloco removido é ignorada.
    visibleObs.emit([[a, true]]);
    expect(batches).toHaveLength(1);
    // Observar de novo recomeça sem zona: só emite com as duas entradas iniciais.
    watcher.observe(a);
    nearObs.emit([[a, true]]);
    expect(batches).toHaveLength(1);
    visibleObs.emit([[a, false]]);
    expect(batches).toHaveLength(2);
    expect(zones(batches[1])).toEqual([[a, 'near']]);
    // unobserve de bloco desconhecido não toca nos observadores.
    watcher.unobserve(b);
    expect(visibleObs.calls.unobserve).toBe(1);
    expect(nearObs.calls.unobserve).toBe(1);
  });

  it('disconnect desliga os dois e ignora eventos e chamadas posteriores', () => {
    watcher.observe(a);
    watcher.disconnect();
    expect(visibleObs.calls.disconnect).toBe(1);
    expect(nearObs.calls.disconnect).toBe(1);
    visibleObs.emit([[a, true]]);
    nearObs.emit([[a, true]]);
    watcher.observe(b);
    watcher.disconnect();
    expect(batches).toEqual([]);
    expect(visibleObs.calls.observe).toBe(1);
    expect(visibleObs.calls.disconnect).toBe(1);
    expect(nearObs.calls.disconnect).toBe(1);
  });
});
