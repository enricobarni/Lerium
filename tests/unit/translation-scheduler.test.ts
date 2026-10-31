import { describe, expect, it } from 'vitest';
import { createInFlightWindow, createPriorityQueue } from '../../src/core/translation-scheduler';

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

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])('recusa limite %s', (limit) => {
    expect(() => createInFlightWindow(limit)).toThrow(RangeError);
  });
});
