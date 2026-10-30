/**
 * Segmentação por bloco dos nós de texto coletados (Fase 4, depois da ADR-012).
 *
 * Recebe os nós `Text` de `collectTextNodes` e os agrupa em segmentos: cada
 * segmento é uma sequência contígua de nós do mesmo bloco, sem fronteira
 * entre eles. Só lê o DOM: não altera nós, não loga e não guarda estado entre
 * chamadas. O texto normalizado fica só em memória, para o modelo.
 */

import { isExcludedElement } from './dom-collector';

/**
 * Referência de tamanho para quem aplica a tradução (`segment_too_long`). O
 * segmentador não corta nem descarta segmentos maiores que isto.
 */
export const MAX_SEGMENT_CHARS = 6000;

export interface TranslationSegment {
  /** `seg-0`, `seg-1`…: ordinal dos segmentos devolvidos, por chamada. */
  readonly id: string;
  /** Bloco ancestral mais próximo dos nós do segmento. */
  readonly block: Element;
  /** Nós em ordem de documento, inclusive os só de espaço. */
  readonly nodes: readonly Text[];
  /** Texto normalizado para o modelo; nunca persistido nem logado. */
  readonly text: string;
}

const ELEMENT_NODE = 1;

/** Elementos de bloco (por `localName` em minúsculas); o resto é inline. */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'dt',
  'dd',
  'blockquote',
  'td',
  'th',
  'caption',
  'figcaption',
  'figure',
  'div',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'nav',
  'main',
  'address',
  'details',
  'summary',
  'legend',
  'fieldset',
  'ul',
  'ol',
  'dl',
  'table',
  'tr',
  'body',
  'html',
  'hr',
]);

/** Espaço ASCII do HTML; U+00A0 (NBSP) fica de fora de propósito. */
const ASCII_WHITESPACE_RUN = /[ \t\n\r\f]+/g;
const LETTER = /\p{L}/u;

function isBlockElement(element: Element): boolean {
  return BLOCK_ELEMENTS.has(element.localName.toLowerCase());
}

/** Elemento que, entre dois nós, encerra o segmento. */
function isBoundaryElement(element: Element): boolean {
  return (
    isBlockElement(element) ||
    element.localName.toLowerCase() === 'br' ||
    isExcludedElement(element)
  );
}

/**
 * Bloco ancestral mais próximo do nó. Sem ancestral de bloco (árvore solta),
 * vale o ancestral mais externo; sem elemento pai, `null`.
 *
 * O cache guarda o bloco de cada elemento visitado; a subida para no primeiro
 * elemento já resolvido, então cada elemento é visitado uma vez por chamada.
 */
function blockOf(node: Text, cache: Map<Element, Element>): Element | null {
  const path: Element[] = [];
  let found: Element | undefined;
  let outermost: Element | null = null;
  for (let element = node.parentElement; element !== null; element = element.parentElement) {
    const cached = cache.get(element);
    if (cached !== undefined) {
      found = cached;
      break;
    }
    path.push(element);
    outermost = element;
    if (isBlockElement(element)) {
      found = element;
      break;
    }
  }
  const block = found ?? outermost;
  if (block === null) return null;
  for (const element of path) cache.set(element, block);
  return block;
}

/** Próximo nó em ordem de documento sem entrar nos filhos de `node`. */
function following(node: Node): Node | null {
  for (let current: Node | null = node; current !== null; current = current.parentNode) {
    if (current.nextSibling !== null) return current.nextSibling;
  }
  return null;
}

/**
 * Há fronteira (bloco, `<br>` ou elemento excluído) entre `previous` e
 * `next`? Percorre só os nós estritamente entre os dois, em ordem de
 * documento, e para na primeira fronteira (sem entrar nela). Se `next` não
 * vier depois de `previous`, o percurso chega ao fim do documento e conta
 * como fronteira.
 */
function hasBoundaryBetween(previous: Text, next: Text): boolean {
  let node = following(previous);
  while (node !== null && node !== next) {
    if (node.nodeType === ELEMENT_NODE) {
      if (isBoundaryElement(node as Element)) return true;
      node = node.firstChild ?? following(node);
    } else {
      node = following(node);
    }
  }
  return node === null;
}

/** Colapsa espaço ASCII em um espaço e apara as pontas; NBSP é mantido. */
function normalizeText(nodes: readonly Text[]): string {
  let raw = '';
  for (const node of nodes) raw += node.data;
  const collapsed = raw.replace(ASCII_WHITESPACE_RUN, ' ');
  // `trim()` também removeria NBSP; aqui só o espaço ASCII já colapsado.
  const start = collapsed.startsWith(' ') ? 1 : 0;
  const end = collapsed.endsWith(' ') ? collapsed.length - 1 : collapsed.length;
  return start >= end ? '' : collapsed.slice(start, end);
}

/**
 * Agrupa os nós em segmentos por bloco, com ids estáveis por chamada.
 *
 * Pré-condição: `nodes` em ordem de documento e sem repetição, como devolve
 * `collectTextNodes`. Um novo segmento começa quando muda o bloco ancestral
 * mais próximo ou quando há, entre dois nós consecutivos, um elemento de
 * bloco, um `<br>` ou um elemento excluído pela coleta (ex.: `<code>` dentro
 * de `<p>`). Nós só de espaço ficam em `nodes`. Segmentos sem nenhuma letra
 * (`\p{L}`), como "|" ou "* * *", são descartados; os ids numeram só os
 * segmentos devolvidos. Segmentos maiores que `MAX_SEGMENT_CHARS` são
 * devolvidos inteiros. Nós sem elemento pai são ignorados.
 *
 * Complexidade O(N), com N o número de nós do trecho do documento entre o
 * primeiro e o último nó de entrada: o cache de blocos visita cada elemento
 * uma vez, e os percursos entre nós consecutivos cobrem intervalos disjuntos
 * da ordem de documento. Com entrada fora de ordem ou repetida, o resultado
 * continua determinístico, mas o custo pode crescer até quadrático.
 */
export function segmentTextNodes(nodes: readonly Text[]): TranslationSegment[] {
  const cache = new Map<Element, Element>();
  const segments: TranslationSegment[] = [];
  let currentBlock: Element | null = null;
  let currentNodes: Text[] = [];
  let previous: Text | null = null;

  const flush = (): void => {
    if (currentBlock === null || currentNodes.length === 0) return;
    const text = normalizeText(currentNodes);
    if (LETTER.test(text)) {
      segments.push({
        id: `seg-${segments.length}`,
        block: currentBlock,
        nodes: currentNodes,
        text,
      });
    }
    currentBlock = null;
    currentNodes = [];
  };

  for (const node of nodes) {
    const block = blockOf(node, cache);
    if (block === null) {
      flush();
      previous = null;
      continue;
    }
    if (block !== currentBlock || previous === null || hasBoundaryBetween(previous, node)) {
      flush();
      currentBlock = block;
    }
    currentNodes.push(node);
    previous = node;
  }
  flush();
  return segments;
}
