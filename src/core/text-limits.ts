/**
 * Limites de tamanho de texto compartilhados entre o content script (que
 * segmenta e aplica), o protocolo do job de página e o service worker. Módulo
 * puro, sem `chrome` nem DOM.
 */

/**
 * Referência de tamanho para quem aplica a tradução (`segment_too_long`). O
 * segmentador não corta nem descarta segmentos maiores que isto.
 */
export const MAX_SEGMENT_CHARS = 6000;

/**
 * Maior texto de uma unidade enviada ao modelo: um segmento de até
 * `MAX_SEGMENT_CHARS` mais folga para os marcadores inline (`<g1>…</g1>`).
 */
export const MAX_UNIT_CHARS = MAX_SEGMENT_CHARS + 2048;

/**
 * Maior saída do modelo aceita por unidade: 4× o maior segmento (a razão
 * máxima de letras) mais folga para marcadores e espaço. Acima disso a saída
 * é `implausible_output` antes de qualquer processamento (trim, razão de
 * letras ou decode), para que uma resposta degenerada não seja varrida inteira.
 */
export const MAX_OUTPUT_CHARS = 4 * MAX_SEGMENT_CHARS + 1024;
