/**
 * Peças puras do escalonador de tradução (Fase 5): fila com classes de
 * prioridade e janela de unidades em voo com limite.
 *
 * Sem timers, sem DOM, sem `chrome` e sem logs: só estruturas em memória. O
 * executor do job de página (`src/content/job-runner.ts`) as usa para
 * ordenar os segmentos por prioridade e limitar as unidades em voo.
 *
 * Entradas inválidas (classe ou limite fora do domínio) lançam `RangeError`:
 * são erro de programação, não dado da página.
 */

export interface PriorityQueue<T> {
  /** Põe `item` no fim da classe `priority` (FIFO dentro da classe). */
  push(item: T, priority: number): void;
  /**
   * Põe `item` no início da classe `priority`, à frente dos que já estão
   * nela (ex.: o fallback nó a nó de um segmento não perde a vez). Vários
   * `pushFront` seguidos na mesma classe saem do último para o primeiro;
   * para manter a ordem de uma lista, chame do último item para o primeiro.
   */
  pushFront(item: T, priority: number): void;
  /** Remove e devolve o primeiro item da menor classe não vazia. */
  next(): T | undefined;
  /** Esvazia todas as classes. */
  clear(): void;
  readonly size: number;
}

/**
 * Janela de ids em voo. Cada id pode levar um valor `T` (ex.: o plano a que a
 * unidade pertence), para que quem usa a janela não precise de um segundo
 * mapa sincronizado com ela. Sem valor, `T` é `void` e o argumento some.
 */
export interface InFlightWindow<T = void> {
  /**
   * Marca `id` como em voo com `value`. `false` se a janela está cheia ou se
   * `id` já está em voo (sem duplicar nem trocar o valor).
   */
  tryAcquire(id: string, value: T): boolean;
  /** Libera `id`; `false` se ele não estava em voo. */
  release(id: string): boolean;
  has(id: string): boolean;
  /** Valor de `id` em voo; `undefined` se ele não está em voo. */
  get(id: string): T | undefined;
  /** Libera todos os ids. */
  clear(): void;
  /** Ids em voo. */
  readonly size: number;
  /** Vagas livres: `limit - size`. */
  readonly available: number;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} deve ser um inteiro >= 1`);
  }
}

/**
 * Uma classe da fila: `front` é uma pilha (topo = próximo a sair) para os
 * `pushFront`; `back` é uma fila com índice de cabeça para os `push`, assim
 * `next` e `push` são O(1) amortizado sem `Array.prototype.shift`.
 */
interface QueueClass<T> {
  front: T[];
  back: T[];
  head: number;
}

/** Compacta `back` quando a parte já consumida passa deste tamanho e da metade. */
const COMPACT_THRESHOLD = 64;

/**
 * Fila com `classCount` classes de prioridade (0 é a mais urgente). A
 * prioridade precisa ser inteira em `[0, classCount)`.
 */
export function createPriorityQueue<T>(classCount: number): PriorityQueue<T> {
  assertPositiveInteger(classCount, 'classCount');
  const classes: QueueClass<T>[] = Array.from({ length: classCount }, () => ({
    front: [],
    back: [],
    head: 0,
  }));
  let size = 0;

  const classOf = (priority: number): QueueClass<T> => {
    if (!Number.isInteger(priority) || priority < 0 || priority >= classCount) {
      throw new RangeError(`prioridade deve ser um inteiro em [0, ${String(classCount)})`);
    }
    // O índice foi validado acima.
    return classes[priority] as QueueClass<T>;
  };

  return {
    push(item, priority) {
      classOf(priority).back.push(item);
      size += 1;
    },
    pushFront(item, priority) {
      classOf(priority).front.push(item);
      size += 1;
    },
    next() {
      for (const entry of classes) {
        if (entry.front.length > 0) {
          size -= 1;
          return entry.front.pop();
        }
        if (entry.head < entry.back.length) {
          const item = entry.back[entry.head] as T;
          entry.head += 1;
          size -= 1;
          if (entry.head === entry.back.length) {
            entry.back = [];
            entry.head = 0;
          } else if (entry.head > COMPACT_THRESHOLD && entry.head * 2 > entry.back.length) {
            entry.back = entry.back.slice(entry.head);
            entry.head = 0;
          }
          return item;
        }
      }
      return undefined;
    },
    clear() {
      for (const entry of classes) {
        entry.front = [];
        entry.back = [];
        entry.head = 0;
      }
      size = 0;
    },
    get size() {
      return size;
    },
  };
}

/** Janela de ids em voo com no máximo `limit` ao mesmo tempo (`limit` inteiro >= 1). */
export function createInFlightWindow<T = void>(limit: number): InFlightWindow<T> {
  assertPositiveInteger(limit, 'limit');
  const inFlight = new Map<string, T>();
  return {
    tryAcquire(id, value) {
      if (inFlight.size >= limit || inFlight.has(id)) return false;
      inFlight.set(id, value);
      return true;
    },
    release(id) {
      return inFlight.delete(id);
    },
    has(id) {
      return inFlight.has(id);
    },
    get(id) {
      return inFlight.get(id);
    },
    clear() {
      inFlight.clear();
    },
    get size() {
      return inFlight.size;
    },
    get available() {
      return limit - inFlight.size;
    },
  };
}
