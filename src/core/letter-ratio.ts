/**
 * Checagem de tamanho plausível por contagem de letras (ADR-003). Módulo
 * puro: não referencia DOM, `chrome` nem `console`.
 *
 * Uma tradução que omite frases (ou repete texto) muda muito o número de
 * letras (`\p{L}`). Com pelo menos `RATIO_MIN_LETTERS` letras na entrada, a
 * saída precisa ter entre `MIN_LETTER_RATIO` e `MAX_LETTER_RATIO` vezes as
 * letras da entrada. Texto curto fica fora da checagem: poucas letras não dão
 * uma razão confiável. Os limites são os do codec de marcadores
 * (`decodeMarkers`, erro `lost_text`) e valem também para o caminho de texto
 * puro e para a tradução nó a nó.
 *
 * O limite inferior de 0,25 cabe a maior parte das traduções para destinos
 * CJK (um ideograma ≈ uma palavra), mas não todas: uma frase concisa em zh-CN
 * chegou a 0,17 e é recusada (o original permanece).
 */

/** Letras mínimas na entrada para aplicar a razão. */
export const RATIO_MIN_LETTERS = 40;
/** Razão mínima letras da saída / letras da entrada (cabe CJK: ver o cabeçalho). */
export const MIN_LETTER_RATIO = 0.25;
/** Razão máxima letras da saída / letras da entrada. */
export const MAX_LETTER_RATIO = 4;

const LETTERS = /\p{L}/gu;

/** Nº de letras (`\p{L}`); linear, uma classe sem quantificador. */
export const countLetters = (text: string): number => text.match(LETTERS)?.length ?? 0;

/**
 * A razão entre as contagens de letras é plausível? Forma por contagem, para
 * quem já somou as letras (o codec soma por run).
 */
export function isLetterRatioPlausible(lettersIn: number, lettersOut: number): boolean {
  if (lettersIn < RATIO_MIN_LETTERS) return true;
  return lettersOut >= MIN_LETTER_RATIO * lettersIn && lettersOut <= MAX_LETTER_RATIO * lettersIn;
}

/** `output` tem um número de letras plausível como tradução de `source`? */
export function checkLetterRatio(source: string, output: string): boolean {
  return isLetterRatioPlausible(countLetters(source), countLetters(output));
}
