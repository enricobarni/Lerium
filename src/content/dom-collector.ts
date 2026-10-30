/**
 * Coleta dos nós de texto traduzíveis de uma página (RF03, ADR-012).
 *
 * Só lê o DOM: não altera nós, não loga, não guarda referências entre
 * chamadas e não usa estilo computado. A segmentação (o que fazer com nós só
 * de espaço, como agrupar por bloco) fica para a próxima etapa da Fase 4.
 */

/** Atributo que marca a interface do próprio Lerium na página (overlay, balões). */
export const LERIUM_UI_ATTRIBUTE = 'data-lerium-ui';

// Valores numéricos fixados pelo DOM Standard. Usá-los evita depender dos
// globais `Node`/`NodeFilter` de um realm específico (documentos de
// DOMParser, iframes, jsdom).
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;
const SHOW_ELEMENT = 0x1;
const SHOW_TEXT = 0x4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;

/**
 * Elementos cuja subárvore inteira nunca é traduzida (comparação por
 * `localName` em minúsculas, o que cobre HTML, SVG e MathML).
 */
const EXCLUDED_ELEMENTS: ReadonlySet<string> = new Set([
  // Metadados e conteúdo que não é texto de leitura.
  'head',
  'script',
  'style',
  'noscript',
  'template',
  // Código e saída técnica.
  'code',
  'pre',
  'kbd',
  'samp',
  // Campos de formulário: o valor pertence ao usuário ou ao site.
  'textarea',
  'input',
  'select',
  'option',
  'optgroup',
  'datalist',
  // Gráficos e fórmulas: texto posicionado ou semântico.
  'svg',
  'math',
  // Conteúdo embutido ou de outro documento.
  'iframe',
  'object',
  'embed',
  'canvas',
  'video',
  'audio',
]);

/** Valores de `contenteditable` que tornam o próprio elemento editável. */
const EDITABLE_VALUES: ReadonlySet<string> = new Set(['', 'true', 'plaintext-only']);

const IMPORTANT_SUFFIX = /\s*!\s*important\s*$/;
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * Lê `display` do atributo `style` inline, sem estilo computado. Regras de
 * cascata do próprio atributo: a última declaração vence, exceto quando uma
 * anterior tem `!important` e a posterior não.
 *
 * `visibility` não poda: é herdada, mas um descendente com
 * `visibility: visible` volta a aparecer. Texto oculto só por `visibility` é
 * coletado, como o oculto por folha de estilo (custo, não risco).
 */
function isHiddenByInlineStyle(style: string): boolean {
  let display: { value: string; important: boolean } | undefined;
  for (const declaration of style.replace(CSS_COMMENT, '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (property !== 'display') continue;
    const raw = declaration
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    const important = IMPORTANT_SUFFIX.test(raw);
    const value = raw.replace(IMPORTANT_SUFFIX, '').trim();
    if (display?.important === true && !important) continue;
    display = { value, important };
  }
  return display?.value === 'none';
}

/**
 * Indica se o elemento e toda a sua subárvore ficam fora da coleta. Não há
 * reativação: um `translate="yes"` dentro de uma área excluída continua fora.
 */
function isExcludedElement(element: Element): boolean {
  if (EXCLUDED_ELEMENTS.has(element.localName.toLowerCase())) return true;
  if (element.hasAttribute('hidden')) return true;
  if (element.hasAttribute(LERIUM_UI_ATTRIBUTE)) return true;
  if (element.classList.contains('notranslate')) return true;

  const translate = element.getAttribute('translate');
  if (translate !== null && translate.trim().toLowerCase() === 'no') return true;

  const editable = element.getAttribute('contenteditable');
  if (editable !== null && EDITABLE_VALUES.has(editable.trim().toLowerCase())) return true;

  const style = element.getAttribute('style');
  return style !== null && isHiddenByInlineStyle(style);
}

function isDocument(root: Document | Element): root is Document {
  return root.nodeType === DOCUMENT_NODE;
}

/** A raiz (ou um ancestral dela) já está numa área excluída? */
function isInsideExcludedArea(root: Element): boolean {
  for (let element: Element | null = root; element !== null; element = element.parentElement) {
    if (isExcludedElement(element)) return true;
  }
  return false;
}

function acceptNode(node: Node): number {
  if (node.nodeType === TEXT_NODE) return FILTER_ACCEPT;
  if (node.nodeType === ELEMENT_NODE && isExcludedElement(node as Element)) return FILTER_REJECT;
  return FILTER_SKIP;
}

/**
 * Nós Text elegíveis sob `root`, em ordem de documento. Não altera o DOM, não
 * loga e não guarda referências.
 *
 * Inclui nós só de espaço (a segmentação decide o que fazer com eles).
 * Comentários ficam fora por construção (`SHOW_TEXT`). Não entra em Shadow
 * DOM nem em iframes (ADR-012).
 */
export function collectTextNodes(root: Document | Element): Text[] {
  if (!isDocument(root) && isInsideExcludedArea(root)) return [];

  const document = isDocument(root) ? root : root.ownerDocument;
  const walker = document.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, acceptNode);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    // Só nós de texto são aceitos pelo filtro; elementos são pulados ou podados.
    nodes.push(node as Text);
  }
  return nodes;
}
