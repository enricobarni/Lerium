import { describe, expect, it } from 'vitest';
import {
  createGroupedPriorityQueue,
  createInFlightWindow,
  createPriorityQueue,
} from '../../src/core/translation-scheduler';

function drain<T>(queue: { next(): T | undefined; readonly size: number }): T[] {
  const items: T[] = [];
  for (let item = queue.next(); item !== undefined; item = queue.next()) items.push(item);
  return items;
}

describe('createPriorityQueue', () => {
  it('começa vazia', () => {
    const queue = createPriorityQueue<string>(3);
    expect(queue.size).toBe(0);
    expect(queue.next()).toBeUndefined();
  });

  it('devolve primeiro a menor classe', () => {
    const queue = createPriorityQueue<string>(3);
    queue.push('c2', 2);
    queue.push('c1', 1);
    queue.push('c0', 0);
    expect(drain(queue)).toEqual(['c0', 'c1', 'c2']);
  });

  it('é FIFO dentro da classe', () => {
    const queue = createPriorityQueue<string>(2);
    queue.push('a', 1);
    queue.push('x', 0);
    queue.push('b', 1);
    queue.push('y', 0);
    queue.push('c', 1);
    expect(drain(queue)).toEqual(['x', 'y', 'a', 'b', 'c']);
  });

  it('item novo de classe menor passa à frente dos que já estão na fila', () => {
    const queue = createPriorityQueue<string>(3);
    queue.push('a', 1);
    queue.push('b', 1);
    expect(queue.next()).toBe('a');
    queue.push('urgent', 0);
    expect(drain(queue)).toEqual(['urgent', 'b']);
  });

  it('pushFront põe o item à frente da própria classe, não das menores', () => {
    const queue = createPriorityQueue<string>(3);
    queue.push('v', 0);
    queue.push('m1', 1);
    queue.push('m2', 1);
    queue.pushFront('fallback', 1);
    expect(drain(queue)).toEqual(['v', 'fallback', 'm1', 'm2']);
  });

  it('pushFront seguidos saem do último para o primeiro', () => {
    const queue = createPriorityQueue<string>(1);
    queue.push('tail', 0);
    const units = ['u0', 'u1', 'u2'];
    for (let index = units.length - 1; index >= 0; index -= 1) {
      queue.pushFront(units[index] as string, 0);
    }
    expect(drain(queue)).toEqual(['u0', 'u1', 'u2', 'tail']);
  });

  it('pushFront numa classe vazia funciona', () => {
    const queue = createPriorityQueue<string>(2);
    queue.pushFront('only', 1);
    expect(queue.size).toBe(1);
    expect(queue.next()).toBe('only');
    expect(queue.size).toBe(0);
  });

  it('size acompanha push, pushFront e next', () => {
    const queue = createPriorityQueue<number>(2);
    queue.push(1, 0);
    queue.pushFront(2, 1);
    queue.push(3, 1);
    expect(queue.size).toBe(3);
    queue.next();
    expect(queue.size).toBe(2);
    drain(queue);
    expect(queue.size).toBe(0);
    expect(queue.next()).toBeUndefined();
    expect(queue.size).toBe(0);
  });

  it('clear esvazia todas as classes e a fila continua utilizável', () => {
    const queue = createPriorityQueue<string>(3);
    queue.push('a', 0);
    queue.pushFront('b', 1);
    queue.push('c', 2);
    queue.next();
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.next()).toBeUndefined();
    queue.push('d', 2);
    queue.push('e', 0);
    expect(drain(queue)).toEqual(['e', 'd']);
  });

  it('aceita itens falsy que não sejam undefined', () => {
    const queue = createPriorityQueue<number | string | null>(1);
    queue.push(0, 0);
    queue.push('', 0);
    queue.push(null, 0);
    expect(queue.next()).toBe(0);
    expect(queue.next()).toBe('');
    expect(queue.next()).toBeNull();
    expect(queue.next()).toBeUndefined();
  });

  it('mantém FIFO com muitos itens intercalados (compactação interna)', () => {
    const queue = createPriorityQueue<number>(1);
    const out: number[] = [];
    let pushed = 0;
    for (let round = 0; round < 50; round += 1) {
      for (let index = 0; index < 10; index += 1) queue.push(pushed++, 0);
      for (let index = 0; index < 7; index += 1) out.push(queue.next() as number);
    }
    out.push(...drain(queue));
    expect(out).toEqual(Array.from({ length: pushed }, (_, index) => index));
  });

  it('a primeira e a última classe são válidas', () => {
    const queue = createPriorityQueue<string>(3);
    queue.push('last', 2);
    queue.pushFront('first', 0);
    expect(drain(queue)).toEqual(['first', 'last']);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'recusa classCount %s',
    (classCount) => {
      expect(() => createPriorityQueue<string>(classCount)).toThrow(RangeError);
    },
  );

  it.each([-1, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'recusa prioridade %s sem alterar a fila',
    (priority) => {
      const queue = createPriorityQueue<string>(3);
      queue.push('a', 0);
      expect(() => queue.push('x', priority)).toThrow(RangeError);
      expect(() => queue.pushFront('x', priority)).toThrow(RangeError);
      expect(queue.size).toBe(1);
      expect(drain(queue)).toEqual(['a']);
    },
  );
});

describe('createInFlightWindow', () => {
  it('começa vazia com todas as vagas', () => {
    const flight = createInFlightWindow(2);
    expect(flight.size).toBe(0);
    expect(flight.available).toBe(2);
    expect(flight.has('a')).toBe(false);
  });

  it('aceita até o limite e recusa depois', () => {
    const flight = createInFlightWindow(2);
    expect(flight.tryAcquire('a')).toBe(true);
    expect(flight.tryAcquire('b')).toBe(true);
    expect(flight.tryAcquire('c')).toBe(false);
    expect(flight.size).toBe(2);
    expect(flight.available).toBe(0);
    expect(flight.has('c')).toBe(false);
  });

  it('release libera vaga', () => {
    const flight = createInFlightWindow(1);
    expect(flight.tryAcquire('a')).toBe(true);
    expect(flight.release('a')).toBe(true);
    expect(flight.has('a')).toBe(false);
    expect(flight.available).toBe(1);
    expect(flight.tryAcquire('b')).toBe(true);
  });

  it('recusa id que já está em voo', () => {
    const flight = createInFlightWindow(3);
    expect(flight.tryAcquire('a')).toBe(true);
    expect(flight.tryAcquire('a')).toBe(false);
    expect(flight.size).toBe(1);
  });

  it('release de id desconhecido ou já liberado devolve false', () => {
    const flight = createInFlightWindow(2);
    expect(flight.release('ghost')).toBe(false);
    flight.tryAcquire('a');
    expect(flight.release('a')).toBe(true);
    expect(flight.release('a')).toBe(false);
    expect(flight.size).toBe(0);
    expect(flight.available).toBe(2);
  });

  it('id recusado por janela cheia não fica registrado', () => {
    const flight = createInFlightWindow(1);
    flight.tryAcquire('a');
    expect(flight.tryAcquire('b')).toBe(false);
    expect(flight.release('b')).toBe(false);
    expect(flight.has('a')).toBe(true);
  });

  it('guarda o valor de cada id em voo; get de id fora da janela é undefined', () => {
    const flight = createInFlightWindow<{ name: string }>(2);
    const first = { name: 'first' };
    expect(flight.get('a')).toBeUndefined();
    expect(flight.tryAcquire('a', first)).toBe(true);
    expect(flight.get('a')).toBe(first);
    // Recusa por duplicado não troca o valor.
    expect(flight.tryAcquire('a', { name: 'other' })).toBe(false);
    expect(flight.get('a')).toBe(first);
    flight.tryAcquire('b', { name: 'b' });
    // Recusa por janela cheia não registra o valor.
    expect(flight.tryAcquire('c', { name: 'c' })).toBe(false);
    expect(flight.get('c')).toBeUndefined();
    flight.release('a');
    expect(flight.get('a')).toBeUndefined();
  });

  it('clear libera todos os ids e devolve todas as vagas', () => {
    const flight = createInFlightWindow<number>(3);
    flight.tryAcquire('a', 1);
    flight.tryAcquire('b', 2);
    flight.clear();
    expect(flight.size).toBe(0);
    expect(flight.available).toBe(3);
    expect(flight.has('a')).toBe(false);
    expect(flight.get('b')).toBeUndefined();
    expect(flight.tryAcquire('a', 3)).toBe(true);
  });

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])('recusa limite %s', (limit) => {
    expect(() => createInFlightWindow(limit)).toThrow(RangeError);
  });
});

describe('createGroupedPriorityQueue', () => {
  it('começa vazia', () => {
    const queue = createGroupedPriorityQueue<string, string>(2);
    expect(queue.size).toBe(0);
    expect(queue.next()).toBeUndefined();
    expect(queue.has('a')).toBe(false);
    expect(queue.priorityOf('a')).toBeUndefined();
  });

  it('é FIFO por classe e esgota o grupo em ordem antes do próximo', () => {
    const queue = createGroupedPriorityQueue<string, string>(2);
    queue.push('b', ['b1', 'b2'], 1);
    queue.push('x', ['x1'], 0);
    queue.push('c', ['c1'], 1);
    queue.push('y', ['y1', 'y2'], 0);
    expect(queue.size).toBe(6);
    expect(drain(queue)).toEqual(['x1', 'y1', 'y2', 'b1', 'b2', 'c1']);
    expect(queue.size).toBe(0);
  });

  it('pushFront põe o grupo à frente; vários saem do último para o primeiro', () => {
    const queue = createGroupedPriorityQueue<string, string>(1);
    queue.push('a', ['a1'], 0);
    queue.pushFront('f1', ['f1'], 0);
    queue.pushFront('f2', ['f2a', 'f2b'], 0);
    expect(drain(queue)).toEqual(['f2a', 'f2b', 'f1', 'a1']);
  });

  it('copia os itens recebidos', () => {
    const queue = createGroupedPriorityQueue<string, string>(1);
    const items = ['a1', 'a2'];
    queue.push('a', items, 0);
    items.push('a3');
    expect(drain(queue)).toEqual(['a1', 'a2']);
  });

  it('move o grupo para a frente ou o fim de outra classe', () => {
    const queue = createGroupedPriorityQueue<string, string>(3);
    queue.push('a', ['a1'], 0);
    queue.push('b', ['b1'], 0);
    queue.push('m', ['m1'], 2);
    queue.push('n', ['n1'], 2);
    expect(queue.move('n', 0, 'front')).toBe(true);
    expect(queue.priorityOf('n')).toBe(0);
    expect(queue.move('a', 1, 'back')).toBe(true);
    expect(queue.priorityOf('a')).toBe(1);
    expect(queue.size).toBe(4);
    expect(drain(queue)).toEqual(['n1', 'b1', 'a1', 'm1']);
  });

  it('move o grupo dentro da mesma classe', () => {
    const queue = createGroupedPriorityQueue<string, string>(1);
    queue.push('a', ['a1'], 0);
    queue.push('b', ['b1'], 0);
    queue.push('c', ['c1'], 0);
    expect(queue.move('a', 0, 'back')).toBe(true);
    expect(queue.move('c', 0, 'front')).toBe(true);
    expect(drain(queue)).toEqual(['c1', 'b1', 'a1']);
  });

  it('não faz nada quando o grupo já está na classe e posição pedidas', () => {
    const queue = createGroupedPriorityQueue<string, string>(2);
    queue.push('a', ['a1'], 0);
    queue.push('b', ['b1'], 0);
    queue.push('c', ['c1'], 0);
    const before = queue.retainedSlots;
    expect(queue.move('a', 0, 'front')).toBe(true);
    expect(queue.move('c', 0, 'back')).toBe(true);
    // Sem slot novo: o no-op não tem custo de memória.
    expect(queue.retainedSlots).toBe(before);
    expect(drain(queue)).toEqual(['a1', 'b1', 'c1']);
  });

  it('move de chave inexistente devolve false sem alterar a fila', () => {
    const queue = createGroupedPriorityQueue<string, string>(2);
    queue.push('a', ['a1'], 1);
    expect(queue.move('zz', 0, 'front')).toBe(false);
    expect(queue.size).toBe(1);
    expect(drain(queue)).toEqual(['a1']);
  });

  it('move o restante de um grupo parcialmente consumido', () => {
    const queue = createGroupedPriorityQueue<string, string>(2);
    queue.push('a', ['a1', 'a2', 'a3'], 0);
    queue.push('b', ['b1'], 0);
    queue.push('c', ['c1'], 1);
    expect(queue.next()).toBe('a1');
    expect(queue.size).toBe(4);
    expect(queue.move('a', 1, 'back')).toBe(true);
    expect(queue.size).toBe(4);
    expect(drain(queue)).toEqual(['b1', 'c1', 'a2', 'a3']);
  });

  it('libera a chave quando o grupo esvazia e permite reusá-la', () => {
    const queue = createGroupedPriorityQueue<string, string>(2);
    queue.push('a', ['a1'], 0);
    queue.push('b', ['b1'], 1);
    // Slot velho de 'a' na classe 1 não pode ressuscitar o grupo novo.
    queue.move('a', 1, 'front');
    queue.move('a', 0, 'back');
    expect(queue.next()).toBe('a1');
    expect(queue.has('a')).toBe(false);
    expect(queue.priorityOf('a')).toBeUndefined();
    expect(queue.move('a', 0, 'front')).toBe(false);
    queue.push('a', ['a-new'], 1);
    expect(queue.priorityOf('a')).toBe(1);
    expect(queue.size).toBe(2);
    expect(drain(queue)).toEqual(['b1', 'a-new']);
    queue.pushFront('a', ['again'], 0);
    expect(drain(queue)).toEqual(['again']);
  });

  it('size conta só itens vivos, não slots velhos', () => {
    const queue = createGroupedPriorityQueue<string, string>(2);
    queue.push('a', ['a1', 'a2'], 0);
    queue.push('b', ['b1'], 1);
    queue.move('a', 1, 'back');
    queue.move('a', 0, 'front');
    queue.move('b', 0, 'back');
    expect(queue.size).toBe(3);
    queue.next();
    expect(queue.size).toBe(2);
    expect(drain(queue)).toEqual(['a2', 'b1']);
    expect(queue.size).toBe(0);
  });

  it('recusa chave duplicada, grupo vazio e prioridade inválida sem alterar a fila', () => {
    const queue = createGroupedPriorityQueue<string, string>(2);
    queue.push('a', ['a1'], 0);
    expect(() => queue.push('a', ['x'], 1)).toThrow(RangeError);
    expect(() => queue.pushFront('a', ['x'], 0)).toThrow(RangeError);
    expect(() => queue.push('b', [], 0)).toThrow(RangeError);
    expect(() => queue.pushFront('b', [], 0)).toThrow(RangeError);
    for (const priority of [-1, 2, 0.5, Number.NaN]) {
      expect(() => queue.push('b', ['b1'], priority)).toThrow(RangeError);
      expect(() => queue.pushFront('b', ['b1'], priority)).toThrow(RangeError);
      expect(() => queue.move('a', priority, 'front')).toThrow(RangeError);
    }
    expect(queue.has('b')).toBe(false);
    expect(queue.priorityOf('a')).toBe(0);
    expect(queue.size).toBe(1);
    expect(drain(queue)).toEqual(['a1']);
  });

  it.each([0, -1, 2.5, Number.NaN])('recusa classCount %s', (classCount) => {
    expect(() => createGroupedPriorityQueue(classCount)).toThrow(RangeError);
  });

  it('clear esvazia a fila e libera as chaves', () => {
    const queue = createGroupedPriorityQueue<string, string>(2);
    queue.push('a', ['a1'], 0);
    queue.pushFront('b', ['b1', 'b2'], 1);
    queue.move('a', 1, 'back');
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.retainedSlots).toBe(0);
    expect(queue.has('a')).toBe(false);
    expect(queue.next()).toBeUndefined();
    queue.push('a', ['a2'], 0);
    expect(drain(queue)).toEqual(['a2']);
  });

  it('10.000 moves alternados custam tempo linear e memória limitada', () => {
    const queue = createGroupedPriorityQueue<number, number>(2);
    const groupCount = 100;
    for (let key = 0; key < groupCount; key += 1) queue.push(key, [key], key % 2);
    let maxRetained = 0;
    const started = performance.now();
    for (let i = 0; i < 10_000; i += 1) {
      // Alterna classe e ponta para deixar slots velhos no meio das classes.
      const key = (i * 37) % groupCount;
      queue.move(key, i % 2, i % 3 === 0 ? 'front' : 'back');
      maxRetained = Math.max(maxRetained, queue.retainedSlots);
    }
    const elapsed = performance.now() - started;
    // Detector de custo super-linear (ex.: busca O(n) por move ou compactação
    // a cada passo): o caminho linear leva poucos ms; o limite é folgado.
    expect(elapsed).toBeLessThan(200);
    // Slots retidos ficam O(grupos vivos + limiar), não O(moves).
    expect(maxRetained).toBeLessThan(4 * groupCount + 4 * 64);
    expect(queue.size).toBe(groupCount);
    const drained = drain(queue);
    expect(drained).toHaveLength(groupCount);
    expect(new Set(drained).size).toBe(groupCount);
    expect(queue.retainedSlots).toBe(0);
  });

  it('o mesmo grupo movido 10.000 vezes não acumula slots', () => {
    const queue = createGroupedPriorityQueue<string, string>(2);
    queue.push('a', ['a1'], 0);
    queue.push('b', ['b1'], 1);
    for (let i = 0; i < 10_000; i += 1) queue.move('a', (i + 1) % 2, 'back');
    expect(queue.retainedSlots).toBeLessThan(4 * 64);
    expect(queue.size).toBe(2);
    // O último move (i = 9999) leva 'a' para a classe 0.
    expect(queue.priorityOf('a')).toBe(0);
    expect(drain(queue)).toEqual(['a1', 'b1']);
  });
});
