/**
 * Classificação dos segmentos em classes de prioridade para a fila de
 * tradução (Fase 5).
 *
 * Classes (menor sai primeiro):
 * - `PRIORITY_VISIBLE_MAIN` (0): conteúdo principal visível na viewport.
 * - `PRIORITY_NEAR` (1): conteúdo principal logo abaixo da viewport. Nunca
 *   sai de `classifySegments`; só o executor usa, quando a rolagem aproxima
 *   (ou afasta) um bloco da tela.
 * - `PRIORITY_MAIN` (2): conteúdo principal fora da viewport.
 * - `PRIORITY_PERIPHERAL` (3): navegação, barras laterais, cabeçalho e rodapé
 *   da página.
 *
 * Só lê o DOM por `localName`/`getAttribute`, sem estilo computado (ADR-012).
 * A geometria vem de `deps.measure`, injetada (no content real, a partir de
 * `getBoundingClientRect`), chamada no máximo uma vez por bloco distinto e
 * nunca para blocos periféricos (a classe deles não depende da posição).
 * Bloco compartilhado (dois ou mais segmentos não periféricos com o mesmo
 * `segment.block`) é medido por trecho com `deps.measureSegment`, quando
 * houver, sem cache: cada segmento recebe a classe da própria posição.
 * Não altera o DOM, não loga e não guarda estado entre chamadas.
 */

import type { TranslationSegment } from './segmenter';

export const PRIORITY_VISIBLE_MAIN = 0;
export const PRIORITY_NEAR = 1;
export const PRIORITY_MAIN = 2;
export const PRIORITY_PERIPHERAL = 3;
/** Número de classes, para `createGroupedPriorityQueue(PRIORITY_CLASSES)`. */
export const PRIORITY_CLASSES = 4;

export type SegmentPriority =
  | typeof PRIORITY_VISIBLE_MAIN
  | typeof PRIORITY_NEAR
  | typeof PRIORITY_MAIN
  | typeof PRIORITY_PERIPHERAL;

/** O que `classifySegments` produz: a classe `PRIORITY_NEAR` fica de fora. */
export type InitialPriority = Exclude<SegmentPriority, typeof PRIORITY_NEAR>;

/** Retângulo em coordenadas da viewport (como `DOMRect`). */
export interface BlockRect {
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface SegmentPriorityDeps {
  measure(block: Element): BlockRect;
  /**
   * Opcional: retângulo do próprio trecho (no content real, de um `Range`
   * sobre os nós do segmento). Só é chamado para segmentos de bloco
   * compartilhado; ausente, todo segmento usa `measure(block)`.
   */
  measureSegment?(segment: TranslationSegment): BlockRect;
  viewportHeight: number;
}

/** Zona de um retângulo em relação à viewport. */
export type RectZone = 'visible' | 'near' | 'out';

export interface ClassifiedSegment {
  readonly segment: TranslationSegment;
  readonly priority: InitialPriority;
  /** Índice do segmento na entrada (ordem de documento). */
  readonly order: number;
}

/** Elementos sempre periféricos, como o próprio bloco ou ancestral. */
const PERIPHERAL_ELEMENTS: ReadonlySet<string> = new Set(['nav', 'aside', 'search']);

/** Papéis ARIA periféricos (primeiro token de `role`). */
const PERIPHERAL_ROLES: ReadonlySet<string> = new Set([
  'navigation',
  'complementary',
  'banner',
  'contentinfo',
  'search',
]);

/**
 * `header`/`footer` só são `banner`/`contentinfo` (periféricos) quando não
 * estão dentro de um destes elementos (regra de mapeamento ARIA do HTML)...
 */
const SECTIONING_SCOPES: ReadonlySet<string> = new Set([
  'article',
  'main',
  'section',
  'aside',
  'nav',
]);

/**
 * ...nem dentro de um ancestral com um destes papéis (primeiro token de
 * `role`), equivalentes aos elementos acima pelo HTML-AAM.
 */
const SECTIONING_ROLES: ReadonlySet<string> = new Set([
  'main',
  'article',
  'region',
  'complementary',
  'navigation',
]);

const ASCII_WHITESPACE = /[ \t\n\r\f]+/;

function nameOf(element: Element): string {
  return element.localName.toLowerCase();
}

function firstRole(element: Element): string {
  const role = element.getAttribute('role');
  if (role === null) return '';
  const trimmed = role.trim();
  if (trimmed === '') return '';
  return (trimmed.split(ASCII_WHITESPACE)[0] ?? '').toLowerCase();
}

function isInsideSectioningScope(element: Element): boolean {
  for (let current = element.parentElement; current !== null; current = current.parentElement) {
    if (SECTIONING_SCOPES.has(nameOf(current))) return true;
    if (SECTIONING_ROLES.has(firstRole(current))) return true;
  }
  return false;
}

/** O bloco ou algum ancestral dele é periférico? */
function isPeripheral(block: Element): boolean {
  for (let current: Element | null = block; current !== null; current = current.parentElement) {
    const name = nameOf(current);
    if (PERIPHERAL_ELEMENTS.has(name)) return true;
    if (PERIPHERAL_ROLES.has(firstRole(current))) return true;
    if ((name === 'header' || name === 'footer') && !isInsideSectioningScope(current)) return true;
  }
  return false;
}

/** Tem área (largura e altura positivas; `NaN` não tem). */
function hasArea(rect: BlockRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

/**
 * Zona do retângulo, função pura:
 * - `visible`: tem área e cruza a faixa vertical `(0, viewportHeight)`;
 * - `near`: tem área e começa na primeira viewport abaixo da tela
 *   (`viewportHeight <= top < 2 * viewportHeight`);
 * - `out`: o resto (sem área, acima, mais abaixo ou com `NaN`).
 */
export function zoneOfRect(rect: BlockRect, viewportHeight: number): RectZone {
  if (!hasArea(rect)) return 'out';
  if (rect.top < viewportHeight && rect.bottom > 0) return 'visible';
  if (rect.top >= viewportHeight && rect.top < 2 * viewportHeight) return 'near';
  return 'out';
}

/** Cruza a faixa vertical `(0, viewportHeight)` e tem área. */
function isVisible(rect: BlockRect, viewportHeight: number): boolean {
  return zoneOfRect(rect, viewportHeight) === 'visible';
}

/** Segmento principal acima da viewport, com a borda inferior do bloco. */
interface AboveViewport {
  readonly item: ClassifiedSegment;
  readonly bottom: number;
}

/**
 * Classifica e ordena os segmentos para entrada na fila.
 *
 * Pré-condição: `segments` em ordem de documento, como devolve
 * `segmentTextNodes`. A saída tem os mesmos segmentos, ordenados assim:
 * 1. Classe 0 (visível), em ordem de documento.
 * 2. Classe 2 (principal fora da viewport): primeiro o grupo "abaixo", em
 *    ordem de documento: blocos sem área (largura ou altura 0, onde quer que
 *    estejam) e blocos que não estão acima da viewport (`bottom > 0`);
 *    depois o que está acima (`bottom <= 0`, com área), do mais próximo da
 *    viewport para o mais distante (`bottom` decrescente; empate pela ordem
 *    de documento).
 * 3. Classe 3 (periférico), em ordem de documento.
 *
 * A classe 1 (`PRIORITY_NEAR`) não é produzida aqui.
 *
 * "Bloco" acima é o retângulo usado para o segmento: o do bloco, ou o do
 * próprio trecho quando o bloco é compartilhado e `deps.measureSegment`
 * existe (aí sem cache, uma chamada por segmento).
 *
 * Medida com valor não finito (`NaN`) não é visível e conta como "não acima".
 */
export function classifySegments(
  segments: readonly TranslationSegment[],
  deps: SegmentPriorityDeps,
): ClassifiedSegment[] {
  const peripheralCache = new Map<Element, boolean>();
  const rectCache = new Map<Element, BlockRect>();
  const visible: ClassifiedSegment[] = [];
  const below: ClassifiedSegment[] = [];
  const above: AboveViewport[] = [];
  const peripheral: ClassifiedSegment[] = [];

  const peripheralOf = (block: Element): boolean => {
    let blockIsPeripheral = peripheralCache.get(block);
    if (blockIsPeripheral === undefined) {
      blockIsPeripheral = isPeripheral(block);
      peripheralCache.set(block, blockIsPeripheral);
    }
    return blockIsPeripheral;
  };

  // Pré-contagem de segmentos não periféricos por bloco; só importa com a
  // medida por trecho, então sem ela nem é feita.
  const mainCount = new Map<Element, number>();
  if (deps.measureSegment !== undefined) {
    for (const { block } of segments) {
      if (!peripheralOf(block)) mainCount.set(block, (mainCount.get(block) ?? 0) + 1);
    }
  }

  segments.forEach((segment, order) => {
    const { block } = segment;
    if (peripheralOf(block)) {
      peripheral.push({ segment, priority: PRIORITY_PERIPHERAL, order });
      return;
    }

    let rect: BlockRect | undefined;
    if (deps.measureSegment !== undefined && (mainCount.get(block) ?? 0) >= 2) {
      rect = deps.measureSegment(segment);
    } else {
      rect = rectCache.get(block);
      if (rect === undefined) {
        rect = deps.measure(block);
        rectCache.set(block, rect);
      }
    }
    if (isVisible(rect, deps.viewportHeight)) {
      visible.push({ segment, priority: PRIORITY_VISIBLE_MAIN, order });
      return;
    }
    const item: ClassifiedSegment = { segment, priority: PRIORITY_MAIN, order };
    if (hasArea(rect) && rect.bottom <= 0) {
      above.push({ item, bottom: rect.bottom });
    } else {
      below.push(item);
    }
  });

  above.sort((a, b) => b.bottom - a.bottom || a.item.order - b.item.order);
  return [...visible, ...below, ...above.map((entry) => entry.item), ...peripheral];
}
