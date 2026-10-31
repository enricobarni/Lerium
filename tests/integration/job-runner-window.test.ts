import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobRunner } from '../../src/content/job-runner';
import { PAGE_JOB_PORT_NAME } from '../../src/shared/page-messages';
import type { PortLike } from '../../src/shared/port-like';

/**
 * Erro de programação na janela em voo: `tryAcquire` recusa mesmo com vaga e
 * id novo. Inalcançável com a janela real; aqui ela é adulterada para provar
 * que o executor falha o job como `interrupted` em vez de lançar ou travar.
 */
const windowHook = vi.hoisted(() => ({ refuse: false }));

vi.mock('../../src/core/translation-scheduler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/translation-scheduler')>();
  return {
    ...actual,
    createInFlightWindow: <T>(limit: number) => {
      const real = actual.createInFlightWindow<T>(limit);
      return {
        ...real,
        get size() {
          return real.size;
        },
        get available() {
          return real.available;
        },
        tryAcquire: (id: string, value: T) =>
          windowHook.refuse ? false : real.tryAcquire(id, value),
      };
    },
  };
});

function parse(body: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body>${body}</body></html>`,
    'text/html',
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  windowHook.refuse = false;
  vi.useRealTimers();
});

describe('createJobRunner — tryAcquire recusado (erro de programação)', () => {
  it('falha o job com interrupted, sem enviar, sem timer e com a porta fechada', () => {
    windowHook.refuse = true;
    const sent: unknown[] = [];
    let disconnected = false;
    const listeners = { message: 0, disconnect: 0 };
    const port: PortLike = {
      name: PAGE_JOB_PORT_NAME,
      postMessage: (message) => sent.push(message),
      disconnect: () => {
        disconnected = true;
      },
      onMessage: {
        addListener: () => (listeners.message += 1),
        removeListener: () => (listeners.message -= 1),
      },
      onDisconnect: {
        addListener: () => (listeners.disconnect += 1),
        removeListener: () => (listeners.disconnect -= 1),
      },
    };
    const document = parse('<p>Only line.</p>');
    const before = new XMLSerializer().serializeToString(document);
    const runner = createJobRunner({
      root: document,
      connect: () => port,
      randomUUID: () => '00000000-0000-4000-8000-000000000001',
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id as Parameters<typeof clearInterval>[0]),
      measure: () => ({ top: 0, bottom: 20, width: 100, height: 20 }),
      viewportHeight: () => 600,
      clock: () => Number.NaN,
    });

    expect(() => runner.start()).not.toThrow();
    expect(runner.getState()).toMatchObject({ status: 'error', error: 'interrupted' });
    expect(sent).toEqual([]);
    expect(disconnected).toBe(true);
    expect(listeners).toEqual({ message: 0, disconnect: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(new XMLSerializer().serializeToString(document)).toBe(before);
  });
});
