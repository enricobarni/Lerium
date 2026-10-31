/**
 * Semáforo global de traduções: limita quantas traduções rodam ao mesmo
 * tempo, independentemente de quantas abas ou Ports as disparem. Módulo puro:
 * sem DOM e sem `chrome`.
 */

/** Libera a vaga adquirida. Idempotente: só a primeira chamada tem efeito. */
export type Release = () => void;

export interface TranslationGate {
  /**
   * Adquire uma vaga. Resolve imediatamente se houver vaga livre; senão
   * aguarda numa fila FIFO. Resolve `null` (sem consumir vaga) se `signal`
   * estiver abortado antes ou durante a espera. Nunca rejeita.
   */
  acquire(signal?: AbortSignal): Promise<Release | null>;
  /** Vagas atualmente ocupadas. */
  readonly inUse: number;
  /** Pedidos aguardando na fila. */
  readonly waiting: number;
}

interface Waiter {
  readonly grant: (release: Release) => void;
  readonly dispose: () => void;
}

/**
 * Cria um semáforo com `capacity` vagas. Capacidade não inteira ou menor que
 * 1 é erro de programação e lança na criação.
 */
export function createTranslationGate(capacity: number): TranslationGate {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`capacidade inválida do semáforo: ${String(capacity)}`);
  }

  let inUse = 0;
  const queue: Waiter[] = [];

  const makeRelease = (): Release => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next) {
        // A vaga passa direto ao próximo da fila; `inUse` não muda.
        next.dispose();
        next.grant(makeRelease());
      } else {
        inUse -= 1;
      }
    };
  };

  const acquire = (signal?: AbortSignal): Promise<Release | null> => {
    if (signal?.aborted) return Promise.resolve(null);
    if (inUse < capacity) {
      inUse += 1;
      return Promise.resolve(makeRelease());
    }

    return new Promise<Release | null>((resolve) => {
      const onAbort = (): void => {
        const index = queue.indexOf(waiter);
        if (index !== -1) queue.splice(index, 1);
        waiter.dispose();
        resolve(null);
      };
      const waiter: Waiter = {
        grant: resolve,
        dispose: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(waiter);
    });
  };

  return {
    acquire,
    get inUse() {
      return inUse;
    },
    get waiting() {
      return queue.length;
    },
  };
}
