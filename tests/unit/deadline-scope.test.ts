import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeadlineScope } from '../../src/core/deadline-scope';

type Phase = 'a' | 'b';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  try {
    // Todo caso termina sem timers pendentes.
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

describe('createDeadlineScope', () => {
  it('o primeiro motivo vence', () => {
    const scope = createDeadlineScope<Phase>();
    scope.arm('a', 100);

    scope.fail({ kind: 'consumer_error' });
    scope.fail({ kind: 'cancelled' });
    vi.advanceTimersByTime(100);

    expect(scope.reason()).toEqual({ kind: 'consumer_error' });
    expect(scope.signal.aborted).toBe(true);
    scope.dispose();
  });

  it('o prazo vira timeout da fase e aborta o sinal', () => {
    const scope = createDeadlineScope<Phase>();
    scope.arm('a', 100);

    vi.advanceTimersByTime(99);
    expect(scope.reason()).toBeUndefined();
    vi.advanceTimersByTime(1);

    expect(scope.reason()).toEqual({ kind: 'timeout', phase: 'a' });
    expect(scope.signal.aborted).toBe(true);
    scope.dispose();
  });

  it('arm rearma do zero, substituindo o timer da mesma fase', () => {
    const scope = createDeadlineScope<Phase>();
    scope.arm('a', 100);
    vi.advanceTimersByTime(80);
    scope.arm('a', 100);

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(99);
    expect(scope.reason()).toBeUndefined();
    vi.advanceTimersByTime(1);

    expect(scope.reason()).toEqual({ kind: 'timeout', phase: 'a' });
    scope.dispose();
  });

  it('fases são independentes', () => {
    const scope = createDeadlineScope<Phase>();
    scope.arm('a', 200);
    scope.arm('b', 100);

    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(100);

    expect(scope.reason()).toEqual({ kind: 'timeout', phase: 'b' });
    expect(vi.getTimerCount()).toBe(0);
    scope.dispose();
  });

  it('disarm cancela só o prazo da fase', () => {
    const scope = createDeadlineScope<Phase>();
    scope.arm('a', 100);
    scope.arm('b', 300);

    scope.disarm('a');
    scope.disarm('a');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(299);

    expect(scope.reason()).toBeUndefined();
    scope.dispose();
  });

  it('arm após o abort não cria timer', () => {
    const scope = createDeadlineScope<Phase>();
    scope.fail({ kind: 'cancelled' });

    scope.arm('a', 100);

    expect(vi.getTimerCount()).toBe(0);
    scope.dispose();
  });

  it('dispose limpa os timers e o listener do sinal externo', () => {
    const external = new AbortController();
    const remove = vi.spyOn(external.signal, 'removeEventListener');
    const scope = createDeadlineScope<Phase>(external.signal);
    scope.arm('a', 100);
    scope.arm('b', 200);

    scope.dispose();
    scope.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    external.abort();
    expect(scope.reason()).toBeUndefined();
    expect(scope.signal.aborted).toBe(false);
  });

  it('arm e fail após dispose são no-op', () => {
    const scope = createDeadlineScope<Phase>();
    scope.dispose();

    scope.arm('a', 100);
    scope.fail({ kind: 'cancelled' });

    expect(vi.getTimerCount()).toBe(0);
    expect(scope.reason()).toBeUndefined();
    expect(scope.signal.aborted).toBe(false);
  });

  it('sinal externo já abortado vira cancelled de imediato', () => {
    const external = new AbortController();
    external.abort();

    const scope = createDeadlineScope<Phase>(external.signal);
    scope.arm('a', 100);

    expect(scope.reason()).toEqual({ kind: 'cancelled' });
    expect(scope.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    scope.dispose();
  });

  it('abort externo durante o escopo vira cancelled e limpa os timers', () => {
    const external = new AbortController();
    const scope = createDeadlineScope<Phase>(external.signal);
    scope.arm('a', 100);

    external.abort();

    expect(scope.reason()).toEqual({ kind: 'cancelled' });
    expect(scope.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    scope.dispose();
  });

  it('aborted resolve quando o escopo falha', async () => {
    const scope = createDeadlineScope<Phase>();
    const settled = vi.fn();
    void scope.aborted.then(settled);

    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    scope.fail({ kind: 'cancelled' });
    await Promise.resolve();

    expect(settled).toHaveBeenCalledTimes(1);
    scope.dispose();
  });
});
