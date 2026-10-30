/**
 * Extração do layout inline de um segmento (Fase 4, ADR-003).
 *
 * Converte os nós `Text` de um `TranslationSegment` na descrição em runs que
 * o codec puro de `../core/inline-markers` entende. Só lê o DOM: não altera
 * nós, não loga e não guarda estado entre chamadas.
 */

import type { InlineLayout, InlineRun } from '../core/inline-markers';
import type { TranslationSegment } from './segmenter';

export interface SegmentInlineLayout {
  readonly layout: InlineLayout;
  /**
   * `runNodes[i]` são os nós `Text` do run `layout.runs[i]`, em ordem de
   * documento. A aplicação distribui o texto traduzido do run entre eles.
   */
  readonly runNodes: readonly (readonly Text[])[];
}

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
 * inteiro, não marca fronteira e continua intacto quando os nós mudam. Como
 * os nós são contíguos em ordem de documento, basta testar o primeiro e o
 * último. Cada elemento restante recebe um id 1..N na ordem de primeira
 * aparição (ids canônicos de `validateInlineLayout`). Nós consecutivos com o
 * mesmo `path` formam um run (ex.: dois nós do mesmo `<em>` separados por um
 * comentário).
 *
 * Texto: o run é a concatenação dos `nodeValue` crus, sem normalizar. O
 * caminho de texto puro usa `segment.text` (normalizado pelo segmentador); o
 * caminho com marcadores usa os nós crus, e `decodeMarkers` preserva o
 * interior de cada intervalo, então o espaço entre runs sobrevive à volta.
 *
 * Devolve `null` quando nenhum wrapper sobra: o segmento vai como texto puro.
 * Fora isso, devolve o layout mesmo que exceda `MAX_INLINE_DEPTH` ou
 * `MAX_INLINE_WRAPPERS`; quem chama passa por `encodeMarkers`, que devolve
 * `null` nesses casos (e em colisão), e então traduz nó a nó.
 */
export function inlineLayoutOf(segment: TranslationSegment): SegmentInlineLayout | null {
  const { block, nodes } = segment;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first === undefined || last === undefined) return null;

  const ids = new Map<Element, number>();
  const covering = new Map<Element, boolean>();
  const paths: number[][] = [];
  const texts: string[] = [];
  const groups: Text[][] = [];

  for (const node of nodes) {
    const ancestors: Element[] = [];
    for (let element = node.parentElement; element !== null && element !== block;) {
      ancestors.push(element);
      element = element.parentElement;
    }
    ancestors.reverse();

    const path: number[] = [];
    for (const element of ancestors) {
      let coversAll = covering.get(element);
      if (coversAll === undefined) {
        coversAll = element.contains(first) && element.contains(last);
        covering.set(element, coversAll);
      }
      if (coversAll) continue;
      let id = ids.get(element);
      if (id === undefined) {
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
