/**
 * Peças puras do escalonador de tradução (Fase 5): fila de grupos com classes
 * de prioridade (unidades agrupadas por chave, movíveis entre classes) e
 * janela de unidades em voo com limite.
 *
 * Sem timers, sem DOM, sem `chrome` e sem logs: só estruturas em memória. O
 * executor do job de página (`src/content/job-runner.ts`) as usa para
 * ordenar os segmentos por prioridade e limitar as unidades em voo.
 *
 * Entradas inválidas (classe ou limite fora do domínio) lançam `RangeError`:
 * são erro de programação, não dado da página.
 */

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

/** Compacta um array quando a parte já consumida (ou velha) passa deste tamanho e da metade. */
const COMPACT_THRESHOLD = 64;

/**
 * Fila de grupos com classes de prioridade. Um grupo é uma chave `K` com uma
 * lista de itens `T` em ordem (ex.: as unidades de um bloco da página); o
 * grupo inteiro ocupa uma posição na sua classe e pode mudar de classe ou de
 * posição de uma vez (ex.: o bloco entrou ou saiu do viewport).
 */
export interface GroupedPriorityQueue<K, T> {
  /**
   * Põe o grupo `key` no fim da classe `priority`. `RangeError`, sem alterar
   * a fila, se `key` já está na fila, se `items` é vazio ou se a prioridade
   * é inválida. Os itens são copiados.
   */
  push(key: K, items: readonly T[], priority: number): void;
  /**
   * Como `push`, mas no início da classe. Vários `pushFront` seguidos na
   * mesma classe saem do último para o primeiro; para manter a ordem de uma
   * lista, o chamador chama do último para o primeiro.
   */
  pushFront(key: K, items: readonly T[], priority: number): void;
  /**
   * Leva o restante do grupo `key` (mesmo parcialmente consumido) para o
   * início (`'front'`) ou fim (`'back'`) da classe `priority`. `false` se a
   * chave não está na fila; `RangeError` se a prioridade é inválida. Se o
   * grupo já está na classe e na posição pedidas, não faz nada (`true`).
   */
  move(key: K, priority: number, position: 'front' | 'back'): boolean;
  /**
   * Põe `items` (em ordem) à frente dos itens restantes do grupo `key`, que
   * continua na mesma classe e na mesma posição. `false`, sem alterar a fila,
   * se a chave não está na fila (o grupo esvaziou ou nunca entrou). Custo
   * O(k) nos itens inseridos; `items` vazio não muda nada. Os itens são
   * copiados.
   */
  prependToGroup(key: K, items: readonly T[]): boolean;
  /** Classe atual do grupo `key`; `undefined` se ele não está na fila. */
  priorityOf(key: K): number | undefined;
  has(key: K): boolean;
  /**
   * Remove e devolve o próximo item do primeiro grupo da menor classe não
   * vazia. Quando o grupo esvazia, a chave sai da fila e pode ser reusada.
   */
  next(): T | undefined;
  /** Esvazia a fila e libera todas as chaves. */
  clear(): void;
  /** Itens ainda não devolvidos por `next` (só grupos vivos). */
  readonly size: number;
  /**
   * Diagnóstico para testes: posições retidas nos arrays internos (vivas,
   * velhas e já consumidas ainda não compactadas). Fica limitado a
   * O(grupos vivos + limiar de compactação), por mais `move` que haja.
   */
  readonly retainedSlots: number;
}

interface Group<K, T> {
  readonly key: K;
  readonly items: T[];
  /** Índice do próximo item de `items` a sair. */
  head: number;
  /**
   * Itens recolocados à frente por `prependToGroup`, em pilha (topo = o
   * próximo a sair); saem antes dos de `items`.
   */
  readonly prefix: T[];
  priority: number;
  /** Versão do slot válido; cada `move` incrementa e invalida os anteriores. */
  version: number;
}

/** Posição de um grupo numa classe; vale só se `version === group.version`. */
interface Slot<K, T> {
  readonly group: Group<K, T>;
  readonly version: number;
}

/**
 * Deque de slots: `front` é uma pilha (topo = primeiro) com base `frontBase`;
 * `back` é uma fila com cabeça `backHead` (fim = último). Assim as quatro
 * pontas são O(1) amortizado sem `shift`/`unshift`.
 */
interface GroupClass<K, T> {
  front: Slot<K, T>[];
  frontBase: number;
  back: Slot<K, T>[];
  backHead: number;
  /** Slots velhos (invalidados por `move`) ainda no deque. */
  stale: number;
}

function isLive<K, T>(slot: Slot<K, T>): boolean {
  return slot.version === slot.group.version;
}

function emptyGroupClass<K, T>(): GroupClass<K, T> {
  return { front: [], frontBase: 0, back: [], backHead: 0, stale: 0 };
}

function slotsIn<K, T>(entry: GroupClass<K, T>): number {
  return entry.front.length - entry.frontBase + (entry.back.length - entry.backHead);
}

function firstSlot<K, T>(entry: GroupClass<K, T>): Slot<K, T> | undefined {
  if (entry.front.length > entry.frontBase) return entry.front[entry.front.length - 1];
  if (entry.back.length > entry.backHead) return entry.back[entry.backHead];
  return undefined;
}

function lastSlot<K, T>(entry: GroupClass<K, T>): Slot<K, T> | undefined {
  if (entry.back.length > entry.backHead) return entry.back[entry.back.length - 1];
  if (entry.front.length > entry.frontBase) return entry.front[entry.frontBase];
  return undefined;
}

/** Descarta a parte consumida de um array quando ela passa do limiar e da metade. */
function shouldCompactConsumed(consumed: number, length: number): boolean {
  return consumed > COMPACT_THRESHOLD && consumed * 2 > length;
}

function popFirstSlot<K, T>(entry: GroupClass<K, T>): void {
  if (entry.front.length > entry.frontBase) {
    entry.front.pop();
    if (entry.front.length === entry.frontBase) {
      entry.front = [];
      entry.frontBase = 0;
    }
    return;
  }
  entry.backHead += 1;
  if (entry.backHead >= entry.back.length) {
    entry.back = [];
    entry.backHead = 0;
  } else if (shouldCompactConsumed(entry.backHead, entry.back.length)) {
    entry.back = entry.back.slice(entry.backHead);
    entry.backHead = 0;
  }
}

function popLastSlot<K, T>(entry: GroupClass<K, T>): void {
  if (entry.back.length > entry.backHead) {
    entry.back.pop();
    if (entry.back.length === entry.backHead) {
      entry.back = [];
      entry.backHead = 0;
    }
    return;
  }
  entry.frontBase += 1;
  if (entry.frontBase >= entry.front.length) {
    entry.front = [];
    entry.frontBase = 0;
  } else if (shouldCompactConsumed(entry.frontBase, entry.front.length)) {
    entry.front = entry.front.slice(entry.frontBase);
    entry.frontBase = 0;
  }
}

/** Descarta slots velhos do início e devolve o primeiro slot vivo. */
function liveFirst<K, T>(entry: GroupClass<K, T>): Slot<K, T> | undefined {
  for (let slot = firstSlot(entry); slot !== undefined; slot = firstSlot(entry)) {
    if (isLive(slot)) return slot;
    popFirstSlot(entry);
    entry.stale -= 1;
  }
  return undefined;
}

/** Descarta slots velhos do fim e devolve o último slot vivo. */
function liveLast<K, T>(entry: GroupClass<K, T>): Slot<K, T> | undefined {
  for (let slot = lastSlot(entry); slot !== undefined; slot = lastSlot(entry)) {
    if (isLive(slot)) return slot;
    popLastSlot(entry);
    entry.stale -= 1;
  }
  return undefined;
}

/**
 * Fila de grupos com `classCount` classes de prioridade (0 é a mais urgente;
 * prioridade inteira em `[0, classCount)`).
 *
 * Custo O(1) amortizado por operação: `move` não procura o grupo na classe
 * antiga. Cada grupo guarda uma versão; seu slot vale só enquanto carrega a
 * versão atual. `move` incrementa a versão (o slot antigo vira "velho") e
 * empurra um slot novo na classe de destino. `next` (e a checagem de no-op
 * de `move`) descartam os slots velhos que encontram nas pontas. Para a
 * memória não crescer com slots velhos presos no meio de uma classe, ela é
 * compactada (filtro O(n), pago por pelo menos n/2 `move`) quando os velhos
 * passam de 64 e da metade dos slots da classe.
 */
export function createGroupedPriorityQueue<K, T>(classCount: number): GroupedPriorityQueue<K, T> {
  assertPositiveInteger(classCount, 'classCount');
  let classes: GroupClass<K, T>[] = Array.from({ length: classCount }, () =>
    emptyGroupClass<K, T>(),
  );
  const groups = new Map<K, Group<K, T>>();
  let size = 0;

  const classOf = (priority: number): GroupClass<K, T> => {
    if (!Number.isInteger(priority) || priority < 0 || priority >= classCount) {
      throw new RangeError(`prioridade deve ser um inteiro em [0, ${String(classCount)})`);
    }
    // O índice foi validado acima.
    return classes[priority] as GroupClass<K, T>;
  };

  const add = (key: K, items: readonly T[], priority: number, atFront: boolean): void => {
    const entry = classOf(priority);
    if (groups.has(key)) throw new RangeError('a chave já está na fila');
    if (items.length === 0) throw new RangeError('o grupo precisa de ao menos um item');
    const group: Group<K, T> = {
      key,
      items: items.slice(),
      head: 0,
      prefix: [],
      priority,
      version: 0,
    };
    groups.set(key, group);
    const slot: Slot<K, T> = { group, version: 0 };
    if (atFront) entry.front.push(slot);
    else entry.back.push(slot);
    size += group.items.length;
  };

  const compactStale = (entry: GroupClass<K, T>): void => {
    if (entry.stale <= COMPACT_THRESHOLD || entry.stale * 2 <= slotsIn(entry)) return;
    entry.front = entry.front.slice(entry.frontBase).filter(isLive);
    entry.frontBase = 0;
    entry.back = entry.back.slice(entry.backHead).filter(isLive);
    entry.backHead = 0;
    entry.stale = 0;
  };

  return {
    push(key, items, priority) {
      add(key, items, priority, false);
    },
    pushFront(key, items, priority) {
      add(key, items, priority, true);
    },
    move(key, priority, position) {
      const target = classOf(priority);
      const group = groups.get(key);
      if (group === undefined) return false;
      if (group.priority === priority) {
        const edge = position === 'front' ? liveFirst(target) : liveLast(target);
        if (edge?.group === group) return true;
      }
      const source = classes[group.priority] as GroupClass<K, T>;
      group.version += 1;
      source.stale += 1;
      group.priority = priority;
      const slot: Slot<K, T> = { group, version: group.version };
      if (position === 'front') target.front.push(slot);
      else target.back.push(slot);
      compactStale(source);
      return true;
    },
    prependToGroup(key, items) {
      const group = groups.get(key);
      if (group === undefined) return false;
      // Pilha: o último inserido sai primeiro, então empilha do fim ao início.
      for (let index = items.length - 1; index >= 0; index -= 1) {
        group.prefix.push(items[index] as T);
      }
      size += items.length;
      return true;
    },
    priorityOf(key) {
      return groups.get(key)?.priority;
    },
    has(key) {
      return groups.has(key);
    },
    next() {
      for (const entry of classes) {
        const slot = liveFirst(entry);
        if (slot === undefined) continue;
        const group = slot.group;
        let item: T;
        if (group.prefix.length > 0) {
          item = group.prefix.pop() as T;
        } else {
          item = group.items[group.head] as T;
          group.head += 1;
        }
        size -= 1;
        if (group.prefix.length === 0 && group.head === group.items.length) {
          popFirstSlot(entry);
          groups.delete(group.key);
        }
        return item;
      }
      return undefined;
    },
    clear() {
      classes = Array.from({ length: classCount }, () => emptyGroupClass<K, T>());
      groups.clear();
      size = 0;
    },
    get size() {
      return size;
    },
    get retainedSlots() {
      let total = 0;
      for (const entry of classes) total += entry.front.length + entry.back.length;
      return total;
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
