import { describe, expect, it } from 'vitest';
import { createTranslationGate, type Release } from '../../src/background/translation-gate';

/** Acompanha o estado de uma promessa sem bloqueá-la. */
function track<T>(promise: Promise<T>): { settled: boolean; value: T | undefined } {
  const state: { settled: boolean; value: T | undefined } = { settled: false, value: undefined };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

/** Esvazia a fila de microtarefas. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** Sinal falso que conta listeners de `abort` ativos. */
function fakeSignal(): { signal: AbortSignal; abort: () => void; listeners: () => number } {
  type Listener = (event: Event) => void;
  const active = new Set<Listener>();
  let aborted = false;
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener(type: string, listener: Listener) {
      if (type === 'abort') active.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      if (type === 'abort') active.delete(listener);
    },
  } as unknown as AbortSignal;
  return {
    signal,
    abort: () => {
      aborted = true;
      for (const listener of [...active]) {
        active.delete(listener);
        listener(new Event('abort'));
      }
    },
    listeners: () => active.size,
  };
}

describe('createTranslationGate', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'lança na criação com capacidade inválida (%s)',
    (capacity) => {
      expect(() => createTranslationGate(capacity)).toThrow(RangeError);
    },
  );

  it('capacidade 1: o segundo pedido espera até o primeiro liberar', async () => {
    const gate = createTranslationGate(1);
    const first = await gate.acquire();
    expect(first).toBeTypeOf('function');
    expect(gate.inUse).toBe(1);

    const second = track(gate.acquire());
    await flush();
    expect(second.settled).toBe(false);
    expect(gate.waiting).toBe(1);

    first?.();
    await flush();
    expect(second.settled).toBe(true);
    expect(second.value).toBeTypeOf('function');
    expect(gate.inUse).toBe(1);
    expect(gate.waiting).toBe(0);

    second.value?.();
    expect(gate.inUse).toBe(0);
  });

  it('capacidade 2: dois pedidos entram juntos e o terceiro espera', async () => {
    const gate = createTranslationGate(2);
    const a = await gate.acquire();
    const b = await gate.acquire();
    expect(gate.inUse).toBe(2);

    const c = track(gate.acquire());
    await flush();
    expect(c.settled).toBe(false);
    expect(gate.waiting).toBe(1);

    b?.();
    await flush();
    expect(c.settled).toBe(true);
    expect(gate.inUse).toBe(2);
    expect(gate.waiting).toBe(0);

    a?.();
    c.value?.();
    expect(gate.inUse).toBe(0);
  });

  it('atende a fila em FIFO estrito com três esperando', async () => {
    const gate = createTranslationGate(1);
    const order: string[] = [];
    const holder = await gate.acquire();

    const waiters = ['w1', 'w2', 'w3'].map((name) =>
      gate.acquire().then((release) => {
        order.push(name);
        return release;
      }),
    );
    expect(gate.waiting).toBe(3);

    let release = holder;
    for (const waiter of waiters) {
      release?.();
      release = await waiter;
    }
    release?.();

    expect(order).toEqual(['w1', 'w2', 'w3']);
    expect(gate.inUse).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it('sinal já abortado resolve null sem consumir vaga nem entrar na fila', async () => {
    const gate = createTranslationGate(1);
    const controller = new AbortController();
    controller.abort();

    await expect(gate.acquire(controller.signal)).resolves.toBeNull();
    expect(gate.inUse).toBe(0);
    expect(gate.waiting).toBe(0);

    const holder = await gate.acquire();
    await expect(gate.acquire(controller.signal)).resolves.toBeNull();
    expect(gate.inUse).toBe(1);
    expect(gate.waiting).toBe(0);
    holder?.();
  });

  it('abort durante a espera resolve null e sai da fila sem consumir vaga', async () => {
    const gate = createTranslationGate(1);
    const holder = await gate.acquire();
    const controller = new AbortController();
    const aborted = track(gate.acquire(controller.signal));
    const next = track(gate.acquire());
    expect(gate.waiting).toBe(2);

    controller.abort();
    await flush();
    expect(aborted.settled).toBe(true);
    expect(aborted.value).toBeNull();
    expect(gate.waiting).toBe(1);
    expect(gate.inUse).toBe(1);

    holder?.();
    await flush();
    expect(next.settled).toBe(true);
    expect(next.value).toBeTypeOf('function');
    next.value?.();
    expect(gate.inUse).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it('abort depois de adquirir não muda nada', async () => {
    const gate = createTranslationGate(1);
    const controller = new AbortController();
    const release = await gate.acquire(controller.signal);
    const waiting = track(gate.acquire());

    controller.abort();
    await flush();
    expect(gate.inUse).toBe(1);
    expect(gate.waiting).toBe(1);
    expect(waiting.settled).toBe(false);

    release?.();
    await flush();
    expect(waiting.value).toBeTypeOf('function');
    waiting.value?.();
    expect(gate.inUse).toBe(0);
  });

  it('abort depois de sair da fila por vaga não muda nada', async () => {
    const gate = createTranslationGate(1);
    const holder = await gate.acquire();
    const controller = new AbortController();
    const granted = track(gate.acquire(controller.signal));
    holder?.();
    await flush();
    expect(granted.value).toBeTypeOf('function');

    controller.abort();
    expect(gate.inUse).toBe(1);
    granted.value?.();
    expect(gate.inUse).toBe(0);
  });

  it('release é idempotente e não libera duas vagas', async () => {
    const gate = createTranslationGate(1);
    const first = await gate.acquire();
    const second = track(gate.acquire());
    const third = track(gate.acquire());

    first?.();
    first?.();
    await flush();
    expect(second.settled).toBe(true);
    expect(third.settled).toBe(false);
    expect(gate.inUse).toBe(1);
    expect(gate.waiting).toBe(1);

    second.value?.();
    await flush();
    third.value?.();
    third.value?.();
    second.value?.();
    expect(gate.inUse).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it('duas Ports alternando são atendidas em FIFO justo', async () => {
    const gate = createTranslationGate(1);
    const order: string[] = [];
    const releases: Promise<Release | null>[] = [];
    const holder = await gate.acquire();

    // Cada Port enfileira dois segmentos de forma intercalada.
    for (const id of ['A1', 'B1', 'A2', 'B2']) {
      releases.push(
        gate.acquire().then((release) => {
          order.push(id);
          return release;
        }),
      );
    }

    let current = holder;
    for (const pending of releases) {
      current?.();
      current = await pending;
    }
    current?.();

    expect(order).toEqual(['A1', 'B1', 'A2', 'B2']);
    expect(gate.inUse).toBe(0);
  });

  it('não deixa listeners de abort pendentes após vaga, abort ou aquisição imediata', async () => {
    const gate = createTranslationGate(1);

    const immediate = fakeSignal();
    const holder = await gate.acquire(immediate.signal);
    expect(immediate.listeners()).toBe(0);

    const granted = fakeSignal();
    const grantedPromise = track(gate.acquire(granted.signal));
    const cancelled = fakeSignal();
    const cancelledPromise = track(gate.acquire(cancelled.signal));
    expect(granted.listeners()).toBe(1);
    expect(cancelled.listeners()).toBe(1);

    cancelled.abort();
    await flush();
    expect(cancelledPromise.value).toBeNull();
    expect(cancelled.listeners()).toBe(0);

    holder?.();
    await flush();
    expect(grantedPromise.value).toBeTypeOf('function');
    expect(granted.listeners()).toBe(0);

    grantedPromise.value?.();
    expect(gate.inUse).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it('nenhuma promessa fica pendente após release e abort', async () => {
    const gate = createTranslationGate(1);
    const holder = await gate.acquire();
    const controller = new AbortController();
    const states = [
      track(gate.acquire()),
      track(gate.acquire(controller.signal)),
      track(gate.acquire()),
    ];

    controller.abort();
    holder?.();
    await flush();
    states[0]?.value?.();
    await flush();
    states[2]?.value?.();
    await flush();

    expect(states.every((state) => state.settled)).toBe(true);
    expect(states.map((state) => state.value === null)).toEqual([false, true, false]);
    expect(gate.inUse).toBe(0);
    expect(gate.waiting).toBe(0);
  });
});
