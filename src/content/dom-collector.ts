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
  // `title` fora do head (o parser o mantém no body; também cobre SVG).
  'title',
  // Código e saída técnica, incluindo os elementos obsoletos de texto bruto.
  'code',
  'pre',
  'kbd',
  'samp',
  'xmp',
  'listing',
  'plaintext',
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

/**
 * Tamanho máximo do atributo `style` analisado. Acima disso o atributo é
 * ignorado e o elemento é tratado como visível (o texto é coletado): estilos
 * inline legítimos são curtos, e o limite fixa o custo por elemento mesmo
 * com conteúdo hostil.
 */
const MAX_INLINE_STYLE_LENGTH = 4096;

const IMPORTANT = 'important';

/**
 * Remove comentários CSS em uma passada (sem regex com backtracking). Um
 * comentário sem fechamento descarta o resto, como no tokenizador CSS.
 */
function stripCssComments(style: string): string {
  let result = '';
  let index = 0;
  for (;;) {
    const start = style.indexOf('/*', index);
    if (start === -1) return result + style.slice(index);
    result += style.slice(index, start);
    const end = style.indexOf('*/', start + 2);
    if (end === -1) return result;
    index = end + 2;
  }
}

/** Separa um `!important` final (com espaços opcionais) do valor. */
function splitImportant(raw: string): { value: string; important: boolean } {
  const trimmed = raw.trimEnd();
  if (trimmed.endsWith(IMPORTANT)) {
    const beforeKeyword = trimmed.slice(0, -IMPORTANT.length).trimEnd();
    if (beforeKeyword.endsWith('!')) {
      return { value: beforeKeyword.slice(0, -1).trim(), important: true };
    }
  }
  return { value: trimmed.trim(), important: false };
}

/**
 * Lê `display` do atributo `style` inline, sem estilo computado. Regras de
 * cascata do próprio atributo: a última declaração vence, exceto quando uma
 * anterior tem `!important` e a posterior não.
 *
 * `visibility` não poda: é herdada, mas um descendente com
 * `visibility: visible` volta a aparecer. Texto oculto só por `visibility` é
 * coletado, como o oculto por folha de estilo (custo, não risco).
 *
 * Tempo linear no tamanho do atributo; acima de `MAX_INLINE_STYLE_LENGTH`
 * caracteres o atributo não é analisado (visível).
 */
function isHiddenByInlineStyle(style: string): boolean {
  if (style.length > MAX_INLINE_STYLE_LENGTH) return false;
  let display: { value: string; important: boolean } | undefined;
  for (const declaration of stripCssComments(style).split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (property !== 'display') continue;
    const parsed = splitImportant(declaration.slice(colon + 1).toLowerCase());
    if (display?.important === true && !parsed.important) continue;
    display = parsed;
  }
  return display?.value === 'none';
}

/**
 * Indica se o elemento e toda a sua subárvore ficam fora da coleta. Não há
 * reativação: um `translate="yes"` dentro de uma área excluída continua fora.
 * Exportado para a segmentação, que trata o elemento excluído como fronteira.
 */
export function isExcludedElement(element: Element): boolean {
  if (EXCLUDED_ELEMENTS.has(element.localName.toLowerCase())) return true;
  if (element.hasAttribute('hidden')) return true;
  if (element.hasAttribute(LERIUM_UI_ATTRIBUTE)) return true;
  if (element.classList.contains('notranslate')) return true;

  const translate = element.getAttribute('translate');
  if (translate !== null && translate.trim().toLowerCase() === 'no') return true;

  const editable = element.getAttribute('contenteditable');
  if (editable !== null && EDITABLE_VALUES.has(editable.trim().toLowerCase())) return true;
  // Defesa extra: no Chromium, `isContentEditable` também cobre editáveis
  // herdados ou ativados por outro caminho. Só existe em HTMLElement e falta
  // no jsdom; o `in` cobre SVG/MathML e ambientes sem a propriedade.
  if ('isContentEditable' in element && element.isContentEditable === true) return true;

  const style = element.getAttribute('style');
  return style !== null && isHiddenByInlineStyle(style);
}

function isDocument(root: Document | Element): root is Document {
  return root.nodeType === DOCUMENT_NODE;
}

/** Documento inteiro editável (`designMode`): nada é coletado. */
function isDesignModeOn(document: Document): boolean {
  // `designMode` pode faltar fora de navegadores (jsdom); `typeof` protege.
  const mode: unknown = document.designMode;
  return typeof mode === 'string' && mode.toLowerCase() === 'on';
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
 * Devolve [] se o documento estiver em `designMode` "on" (todo editável).
 * Inclui nós só de espaço (a segmentação decide o que fazer com eles).
 * Comentários ficam fora por construção (`SHOW_TEXT`). Não entra em Shadow
 * DOM nem em iframes (ADR-012).
 */
export function collectTextNodes(root: Document | Element): Text[] {
  const document = isDocument(root) ? root : root.ownerDocument;
  if (isDesignModeOn(document)) return [];
  if (!isDocument(root) && isInsideExcludedArea(root)) return [];

  const walker = document.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, acceptNode);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    // Só nós de texto são aceitos pelo filtro; elementos são pulados ou podados.
    nodes.push(node as Text);
  }
  return nodes;
}
