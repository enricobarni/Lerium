/**
 * Extração do layout inline de um segmento (Fase 4, ADR-003).
 *
 * Converte os nós `Text` de um `TranslationSegment` na descrição em runs que
 * o codec puro de `../core/inline-markers` entende. Só lê o DOM: não altera
 * nós, não loga e não guarda estado entre chamadas.
 */

import {
  MAX_INLINE_DEPTH,
  MAX_INLINE_WRAPPERS,
  type InlineLayout,
  type InlineRun,
} from '../core/inline-markers';
import type { TranslationSegment } from './segmenter';

export interface SegmentInlineLayout {
  readonly layout: InlineLayout;
  /**
   * `runNodes[i]` são os nós `Text` do run `layout.runs[i]`, em ordem de
   * documento. A aplicação distribui o texto traduzido do run entre eles.
   */
  readonly runNodes: readonly (readonly Text[])[];
}

/**
 * Sinal de que o segmento passa de `MAX_INLINE_DEPTH` níveis ou de
 * `MAX_INLINE_WRAPPERS` wrappers: `encodeMarkers` recusaria o layout, então
 * ele nem é montado e quem chama vai direto à tradução nó a nó.
 */
export const INLINE_LIMITS_EXCEEDED = 'inline_limits_exceeded';
export type InlineLimitsExceeded = typeof INLINE_LIMITS_EXCEEDED;

/** Espaço ASCII, o mesmo que o segmentador colapsa; U+00A0 conta como conteúdo. */
const HAS_CONTENT = /[^ \t\n\r\f]/;

function samePath(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Descreve o markup inline de `segment` como runs com `path` de wrappers.
 *
 * Para cada nó, o `path` são os elementos ancestrais entre o nó e
 * `segment.block` (exclusive), do mais externo ao mais interno. Todo elemento
 * nesse trecho é inline, porque `block` é o bloco ancestral mais próximo. Um
 * wrapper que contém todos os nós do segmento é ignorado: envolve o bloco
 * inteiro, não marca fronteira e continua intacto quando os nós mudam. Nós só
 * de espaço não contam nessa cobertura: em HTML formatado, as quebras de
 * linha ao redor de `<span>…</span>` ficam fora dele e o transformariam em
 * marcador à toa. Como os nós são contíguos em ordem de documento, basta
 * testar o primeiro e o último nó com conteúdo. Cada elemento restante
 * recebe um id 1..N na ordem de primeira aparição (ids canônicos de
 * `validateInlineLayout`). Nós consecutivos com o mesmo `path` formam um run
 * (ex.: dois nós do mesmo `<em>` separados por um comentário).
 *
 * Texto: o run é a concatenação dos `nodeValue` crus, sem normalizar. O
 * caminho de texto puro usa `segment.text` (normalizado pelo segmentador); o
 * caminho com marcadores usa os nós crus, e `decodeMarkers` preserva o
 * interior de cada intervalo, então o espaço entre runs sobrevive à volta.
 *
 * Devolve `null` quando nenhum wrapper sobra: o segmento vai como texto puro.
 * Devolve `INLINE_LIMITS_EXCEEDED` assim que um `path` passa de
 * `MAX_INLINE_DEPTH` ou os wrappers distintos passam de `MAX_INLINE_WRAPPERS`,
 * sem montar o resto: quem chama traduz nó a nó. Um layout devolvido ainda
 * pode ser recusado por `encodeMarkers` (colisão de marcadores no texto).
 *
 * Custo: a subida de cada nó para no primeiro wrapper que cobre tudo (os
 * ancestrais dele também cobrem) ou no `MAX_INLINE_DEPTH + 1`-ésimo que não
 * cobre, então visita no máximo `MAX_INLINE_DEPTH + 2` elementos por nó,
 * mesmo com milhares de `<span>` aninhados.
 */
export function inlineLayoutOf(
  segment: TranslationSegment,
): SegmentInlineLayout | InlineLimitsExceeded | null {
  const { block, nodes } = segment;
  const content = nodes.filter((node) => HAS_CONTENT.test(node.data));
  const first = content[0];
  const last = content[content.length - 1];
  if (first === undefined || last === undefined) return null;

  const ids = new Map<Element, number>();
  const covering = new Map<Element, boolean>();
  const paths: number[][] = [];
  const texts: string[] = [];
  const groups: Text[][] = [];
  const coversAll = (element: Element): boolean => {
    let result = covering.get(element);
    if (result === undefined) {
      result = element.contains(first) && element.contains(last);
      covering.set(element, result);
    }
    return result;
  };

  for (const node of nodes) {
    // Do mais interno ao mais externo; só os wrappers que não cobrem tudo.
    const wrappers: Element[] = [];
    for (let element = node.parentElement; element !== null && element !== block;) {
      if (coversAll(element)) break;
      if (wrappers.length === MAX_INLINE_DEPTH) return INLINE_LIMITS_EXCEEDED;
      wrappers.push(element);
      element = element.parentElement;
    }

    const path: number[] = [];
    for (let index = wrappers.length - 1; index >= 0; index -= 1) {
      const element = wrappers[index] as Element;
      let id = ids.get(element);
      if (id === undefined) {
        if (ids.size === MAX_INLINE_WRAPPERS) return INLINE_LIMITS_EXCEEDED;
        id = ids.size + 1;
        ids.set(element, id);
      }
      path.push(id);
    }

    const index = paths.length - 1;
    const previous = paths[index];
    if (previous !== undefined && samePath(previous, path)) {
      texts[index] += node.data;
      groups[index]?.push(node);
    } else {
      paths.push(path);
      texts.push(node.data);
      groups.push([node]);
    }
  }

  if (ids.size === 0) return null;
  const runs: InlineRun[] = paths.map((path, index) => ({
    text: texts[index] as string,
    path,
  }));
  return { layout: { runs }, runNodes: groups };
}
