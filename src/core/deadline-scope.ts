/**
 * Escopo de prazos com fases independentes (ex.: total, primeiro token,
 * ociosidade) sobre um único `AbortController`. Módulo puro: sem DOM e sem
 * `chrome`.
 */

/**
 * Motivo que encerrou um escopo de prazo. O primeiro registrado vence.
 * `consumer_error` é usado pelo chat em streaming quando o consumidor dos
 * tokens (`onToken`) lança.
 */
export type DeadlineReason<P extends string> =
  { kind: 'timeout'; phase: P } | { kind: 'cancelled' } | { kind: 'consumer_error' };

export interface DeadlineScope<P extends string> {
  /** Sinal a repassar ao `fetch`; aborta no primeiro motivo registrado. */
  readonly signal: AbortSignal;
  /**
   * Arma (ou rearma, do zero) o prazo de `phase`, substituindo o timer
   * anterior da mesma fase. Ignorado após o abort ou após `dispose`.
   */
  arm(phase: P, ms: number): void;
  disarm(phase: P): void;
  /**
   * Registra o motivo (só o primeiro vale) e aborta o controller interno.
   * Ignorado após `dispose`.
   */
  fail(reason: DeadlineReason<P>): void;
  reason(): DeadlineReason<P> | undefined;
  /** Resolve quando o escopo aborta; para usar em `Promise.race`. */
  readonly aborted: Promise<void>;
  /** Limpa todos os timers e o listener do sinal externo. Idempotente. */
  dispose(): void;
}

/**
 * Cria um escopo de prazos. Um sinal externo abortado, antes ou durante o
 * escopo, vira o motivo `cancelled`.
 */
export function createDeadlineScope<P extends string>(external?: AbortSignal): DeadlineScope<P> {
  const controller = new AbortController();
  const timers = new Map<P, ReturnType<typeof setTimeout>>();
  let current: DeadlineReason<P> | undefined;
  let disposed = false;
  let resolveAborted: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });

  const clearTimers = (): void => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
  const fail = (reason: DeadlineReason<P>): void => {
    if (disposed || current !== undefined) return;
    current = reason;
    clearTimers();
    controller.abort();
    resolveAborted();
  };
  const onExternalAbort = (): void => fail({ kind: 'cancelled' });

  if (external?.aborted) fail({ kind: 'cancelled' });
  else external?.addEventListener('abort', onExternalAbort, { once: true });

  return {
    signal: controller.signal,
    arm(phase, ms) {
      if (disposed || current !== undefined) return;
      const previous = timers.get(phase);
      if (previous !== undefined) clearTimeout(previous);
      timers.set(
        phase,
        setTimeout(() => fail({ kind: 'timeout', phase }), ms),
      );
    },
    disarm(phase) {
      const timer = timers.get(phase);
      if (timer === undefined) return;
      clearTimeout(timer);
      timers.delete(phase);
    },
    fail,
    reason: () => current,
    aborted,
    dispose() {
      disposed = true;
      clearTimers();
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}
