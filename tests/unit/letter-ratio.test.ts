import { describe, expect, it } from 'vitest';
import * as codec from '../../src/core/inline-markers';
import {
  checkLetterRatio,
  countLetters,
  isLetterRatioPlausible,
  MAX_LETTER_RATIO,
  MIN_LETTER_RATIO,
  RATIO_MIN_LETTERS,
} from '../../src/core/letter-ratio';

const letters = (count: number): string => 'a'.repeat(count);

describe('countLetters', () => {
  it('conta letras Unicode e ignora dígitos, pontuação e espaço', () => {
    expect(countLetters('Olá, 42 mundo!')).toBe(8);
    expect(countLetters('灯笼 — 山')).toBe(3);
    expect(countLetters('')).toBe(0);
    expect(countLetters('123 ...  ')).toBe(0);
  });
});

describe('isLetterRatioPlausible', () => {
  it('não julga entradas abaixo do mínimo de letras', () => {
    expect(isLetterRatioPlausible(RATIO_MIN_LETTERS - 1, 0)).toBe(true);
    expect(isLetterRatioPlausible(RATIO_MIN_LETTERS - 1, 10_000)).toBe(true);
  });

  it('aceita os limites exatos e recusa o que passa deles', () => {
    const inL = 100;
    expect(isLetterRatioPlausible(inL, MIN_LETTER_RATIO * inL)).toBe(true);
    expect(isLetterRatioPlausible(inL, MIN_LETTER_RATIO * inL - 1)).toBe(false);
    expect(isLetterRatioPlausible(inL, MAX_LETTER_RATIO * inL)).toBe(true);
    expect(isLetterRatioPlausible(inL, MAX_LETTER_RATIO * inL + 1)).toBe(false);
  });

  it('a partir do mínimo de letras, saída sem letras é recusada', () => {
    expect(isLetterRatioPlausible(RATIO_MIN_LETTERS, 0)).toBe(false);
  });
});

describe('checkLetterRatio', () => {
  it('aceita tradução de tamanho comparável', () => {
    expect(
      checkLetterRatio(
        'Kael held the veilstone against his palm until its glow steadied.',
        'Kael segurou a pedra-véu contra a palma até o brilho se firmar.',
      ),
    ).toBe(true);
  });

  it('recusa saída que omitiu quase todo o texto', () => {
    expect(checkLetterRatio(letters(100), letters(24))).toBe(false);
    expect(checkLetterRatio(letters(100), letters(25))).toBe(true);
  });

  it('recusa saída que repetiu o texto muitas vezes', () => {
    expect(checkLetterRatio(letters(50), letters(201))).toBe(false);
    expect(checkLetterRatio(letters(50), letters(200))).toBe(true);
  });

  it('não julga texto curto', () => {
    expect(checkLetterRatio('Hi.', '')).toBe(true);
  });

  it('conta só letras, não pontuação nem espaço', () => {
    const source = `${letters(40)}!!!`;
    expect(checkLetterRatio(source, `${'. '.repeat(500)}${letters(9)}`)).toBe(false);
  });
});

describe('constantes reexportadas pelo codec', () => {
  it('são as mesmas do módulo de razão', () => {
    expect(codec.RATIO_MIN_LETTERS).toBe(RATIO_MIN_LETTERS);
    expect(codec.MIN_LETTER_RATIO).toBe(MIN_LETTER_RATIO);
    expect(codec.MAX_LETTER_RATIO).toBe(MAX_LETTER_RATIO);
  });
});
