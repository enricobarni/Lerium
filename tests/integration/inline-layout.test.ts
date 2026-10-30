import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_INLINE_WRAPPERS,
  decodeMarkers,
  encodeMarkers,
  validateInlineLayout,
} from '../../src/core/inline-markers';
import { collectTextNodes } from '../../src/content/dom-collector';
import {
  INLINE_LIMITS_EXCEEDED,
  inlineLayoutOf,
  type SegmentInlineLayout,
} from '../../src/content/inline-layout';
import { segmentTextNodes, type TranslationSegment } from '../../src/content/segmenter';

/** Documento novo a cada chamada; nunca `innerHTML` nem `document.write`. */
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function segmentsOf(document: Document): TranslationSegment[] {
  return segmentTextNodes(collectTextNodes(document));
}

function onlySegment(html: string): TranslationSegment {
  const segments = segmentsOf(parse(`<body>${html}</body>`));
  expect(segments).toHaveLength(1);
  return segments[0] as TranslationSegment;
}

function byId(document: Document, id: string): Element {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`#${id} ausente`);
  return element;
}

/**
 * Aninha `count` spans em `host`; o de índice `i` começa com `textAt(i)` (se
 * não for null). No jsdom, montar a árvore já custa O(count²) (cada inserção
 * valida os ancestrais; o parser e a montagem de dentro para fora são piores),
 * por isso os testes usam profundidades na casa dos milhares, não dezenas de
 * milhares.
 */
function appendNestedSpans(
  host: Element,
  count: number,
  textAt: (index: number) => string | null,
): void {
  let parent = host;
  for (let index = 0; index < count; index += 1) {
    const span = host.ownerDocument.createElement('span');
    const text = textAt(index);
    if (text !== null) span.append(text);
    parent.append(span);
    parent = span;
  }
}

/** Conta leituras de `parentElement` (a subida pelos ancestrais) durante `run`. */
function countParentReads<T>(run: () => T): { result: T; reads: number } {
  const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement');
  const getter = descriptor?.get;
  if (getter === undefined) throw new Error('parentElement sem getter');
  let reads = 0;
  vi.spyOn(Node.prototype, 'parentElement', 'get').mockImplementation(function (this: Node) {
    reads += 1;
    return getter.call(this) as HTMLElement | null;
  });
  try {
    return { result: run(), reads };
  } finally {
    vi.restoreAllMocks();
  }
}

/** Profundidade dos testes de aninhamento extremo (ver `appendNestedSpans`). */
const NESTED_DEPTH = 2000;

function layoutOf(html: string): SegmentInlineLayout {
  const result = inlineLayoutOf(onlySegment(html));
  if (result === null || result === INLINE_LIMITS_EXCEEDED) {
    throw new Error(`layout inesperado: ${String(result)}`);
  }
  return result;
}

function runTexts(result: SegmentInlineLayout): string[] {
  return result.layout.runs.map((run) => run.text);
}

function runPaths(result: SegmentInlineLayout): number[][] {
  return result.layout.runs.map((run) => [...run.path]);
}

/** Cada run tem exatamente o texto cru dos seus nós, e os nós cobrem o segmento. */
function expectAligned(segment: TranslationSegment, result: SegmentInlineLayout): void {
  expect(result.runNodes).toHaveLength(result.layout.runs.length);
  expect(result.runNodes.map((nodes) => nodes.map((node) => node.nodeValue).join(''))).toEqual(
    runTexts(result),
  );
  expect(result.runNodes.flat()).toEqual(segment.nodes);
}

describe('inlineLayoutOf', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('descreve um wrapper no meio do bloco', () => {
    const segment = onlySegment('<p>The <em>red</em> stone</p>');
    const result = inlineLayoutOf(segment);
    if (result === null || result === INLINE_LIMITS_EXCEEDED) throw new Error('sem layout');
    expect(runTexts(result)).toEqual(['The ', 'red', ' stone']);
    expect(runPaths(result)).toEqual([[], [1], []]);
    expect(result.runNodes.map((nodes) => nodes.length)).toEqual([1, 1, 1]);
    expect(result.runNodes[1]?.[0]?.parentElement?.localName).toBe('em');
    expectAligned(segment, result);
  });

  it('devolve null quando um wrapper cobre o segmento inteiro', () => {
    expect(inlineLayoutOf(onlySegment('<p><span>tudo aqui</span></p>'))).toBeNull();
  });

  it('ignora o wrapper que cobre tudo e numera o interno a partir de 1', () => {
    const segment = onlySegment('<p><span>a <em>b</em></span></p>');
    const result = inlineLayoutOf(segment);
    if (result === null || result === INLINE_LIMITS_EXCEEDED) throw new Error('sem layout');
    expect(runTexts(result)).toEqual(['a ', 'b']);
    expect(runPaths(result)).toEqual([[], [1]]);
    expectAligned(segment, result);
  });

  it('ignora nós só de espaço ao decidir se o wrapper cobre o segmento', () => {
    // HTML formatado: as quebras de linha ficam fora do span, que mesmo assim
    // envolve todo o conteúdo; só o em vira marcador e o layout tem um nível.
    const result = layoutOf('<p>\n<span>a <em>b</em></span>\n</p>');
    expect(runTexts(result)).toEqual(['\na ', 'b', '\n']);
    expect(runPaths(result)).toEqual([[], [1], []]);
    expect(encodeMarkers(result.layout)).not.toBeNull();
  });

  it('devolve null quando o único wrapper cobre todo o conteúdo entre quebras', () => {
    expect(inlineLayoutOf(onlySegment('<p>\n  <span>tudo aqui</span>\n</p>'))).toBeNull();
  });

  it('trata NBSP como conteúdo na cobertura', () => {
    // O NBSP fica fora do span, que então não cobre tudo e vira marcador.
    const result = layoutOf('<p>\u00a0<span>a b</span></p>');
    expect(runPaths(result)).toEqual([[], [1]]);
    expect(inlineLayoutOf(onlySegment('<p>\u00a0<span>a <em>b</em></span></p>'))).toBe(
      INLINE_LIMITS_EXCEEDED,
    );
  });

  it('aninhamento de dois níveis excede MAX_INLINE_DEPTH sem montar o layout', () => {
    // Antes devolvia o layout com path [1, 2] e deixava a recusa para
    // encodeMarkers; agora a subida para no segundo nível e sinaliza direto.
    expect(inlineLayoutOf(onlySegment('<p><a href="#n"><strong>x</strong></a> y</p>'))).toBe(
      INLINE_LIMITS_EXCEEDED,
    );
  });

  it('o mesmo aninhamento passa quando o externo cobre tudo', () => {
    const result = layoutOf('<p><a href="#n"><strong>x</strong> y</a></p>');
    expect(runPaths(result)).toEqual([[1], []]);
    expect(validateInlineLayout(result.layout)).toMatchObject({ ok: true, depth: 1 });
  });

  it(`aceita até MAX_INLINE_WRAPPERS (${MAX_INLINE_WRAPPERS}) wrappers e sinaliza acima`, () => {
    const markup = (count: number): string =>
      `<p>${Array.from({ length: count }, (_, index) => `<em>w${index}</em>`).join(' ')}</p>`;
    const result = layoutOf(markup(MAX_INLINE_WRAPPERS));
    expect(encodeMarkers(result.layout)).not.toBeNull();
    expect(inlineLayoutOf(onlySegment(markup(MAX_INLINE_WRAPPERS + 1)))).toBe(
      INLINE_LIMITS_EXCEEDED,
    );
  });

  it(`para cedo com ${NESTED_DEPTH} span aninhados com texto`, () => {
    // Sem o corte, cada um dos N nós subiria até o p: O(N²) leituras de
    // parentElement. Com ele, a subida para no segundo wrapper que não cobre
    // tudo. A contagem é o critério principal; os 500 ms são só um teto
    // generoso para CI lenta (o esperado é poucos milissegundos).
    const TIME_LIMIT_MS = 500;
    const document = parse('<body><p id="p"></p></body>');
    appendNestedSpans(byId(document, 'p'), NESTED_DEPTH, (index) => `t${index} `);
    const [only] = segmentsOf(document);
    if (only === undefined) throw new Error('sem segmento');
    expect(only.nodes).toHaveLength(NESTED_DEPTH);
    const start = performance.now();
    const { result, reads } = countParentReads(() => inlineLayoutOf(only));
    const elapsed = performance.now() - start;
    expect(result).toBe(INLINE_LIMITS_EXCEEDED);
    expect(reads).toBeLessThanOrEqual(10);
    expect(elapsed).toBeLessThan(TIME_LIMIT_MS);
  });

  it(`${NESTED_DEPTH} span aninhados que cobrem tudo viram texto puro sem subir até o p`, () => {
    const document = parse('<body><p id="p"></p></body>');
    appendNestedSpans(byId(document, 'p'), NESTED_DEPTH, (index) =>
      index === NESTED_DEPTH - 1 ? 'deep text' : null,
    );
    const [only] = segmentsOf(document);
    if (only === undefined) throw new Error('sem segmento');
    const { result, reads } = countParentReads(() => inlineLayoutOf(only));
    expect(result).toBeNull();
    // O primeiro ancestral já cobre tudo, e os de cima também cobrem.
    expect(reads).toBeLessThanOrEqual(2);
  });

  it('dá ids distintos a elementos distintos, na ordem de aparição', () => {
    const result = layoutOf('<p><em>one</em> and <em>two</em></p>');
    expect(runTexts(result)).toEqual(['one', ' and ', 'two']);
    expect(runPaths(result)).toEqual([[1], [], [2]]);
  });

  it('junta num run os nós do mesmo elemento separados por comentário', () => {
    const segment = onlySegment('<p>a <em>b<!-- note -->c</em> d</p>');
    const result = inlineLayoutOf(segment);
    if (result === null || result === INLINE_LIMITS_EXCEEDED) throw new Error('sem layout');
    expect(runTexts(result)).toEqual(['a ', 'bc', ' d']);
    expect(runPaths(result)).toEqual([[], [1], []]);
    expect(result.runNodes.map((nodes) => nodes.map((node) => node.nodeValue))).toEqual([
      ['a '],
      ['b', 'c'],
      [' d'],
    ]);
    expectAligned(segment, result);
  });

  it('devolve null sem wrapper', () => {
    expect(inlineLayoutOf(onlySegment('<p>plain text only</p>'))).toBeNull();
    expect(inlineLayoutOf(onlySegment('<p>one <!-- note --> two</p>'))).toBeNull();
  });

  it('usa os nodeValue crus, sem normalizar espaço', () => {
    const segment = onlySegment('<p>\n  The  <em>red</em>\tstone\n</p>');
    const result = inlineLayoutOf(segment);
    if (result === null || result === INLINE_LIMITS_EXCEEDED) throw new Error('sem layout');
    expect(segment.text).toBe('The red stone');
    expect(runTexts(result)).toEqual(['\n  The  ', 'red', '\tstone\n']);
  });

  it('faz ida e volta com encodeMarkers e decodeMarkers', () => {
    const result = layoutOf('<p>The <em>red</em> stone</p>');
    expect(encodeMarkers(result.layout)).toBe('The <g1>red</g1> stone');
    const decoded = decodeMarkers('A pedra <g1>vermelha</g1>', result.layout);
    expect(decoded).toEqual({ ok: true, texts: ['A pedra ', 'vermelha', ''] });
    if (decoded.ok) expect(decoded.texts).toHaveLength(result.runNodes.length);
  });

  it('a volta preserva as bordas cruas do bloco', () => {
    const result = layoutOf('<p>\n  The <em>red</em> stone\n</p>');
    expect(encodeMarkers(result.layout)).toBe('\n  The <g1>red</g1> stone\n');
    expect(decodeMarkers('A pedra <g1>vermelha</g1>\n\n', result.layout)).toEqual({
      ok: true,
      texts: ['\n  A pedra ', 'vermelha', '\n'],
    });
  });

  it('produz layouts canônicos para markup de um nível', () => {
    const markups = [
      '<p>The <em>red</em> stone</p>',
      '<p><em>a</em> <strong>b</strong>\n<a href="#x">c</a></p>',
      '<p><span>a <em>b</em> c <i>d</i></span></p>',
      '<p><b>Start</b> middle <i>end</i></p>',
      '<p>x <em>y<!-- c -->z</em></p>',
    ];
    for (const markup of markups) {
      const result = layoutOf(markup);
      expect(validateInlineLayout(result.layout)).toMatchObject({ ok: true, depth: 1 });
      expect(encodeMarkers(result.layout)).not.toBeNull();
    }
  });

  it('processa cada segmento de um documento de forma independente', () => {
    const document = parse('<body><p>a <em>b</em></p><p>plain</p><p><i>c</i> d</p></body>');
    const results = segmentsOf(document).map(inlineLayoutOf);
    expect(
      results.map((result) =>
        result === null || result === INLINE_LIMITS_EXCEEDED ? result : runPaths(result),
      ),
    ).toEqual([[[], [1]], null, [[1], []]]);
  });

  it('não altera o DOM e não chama console', () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const document = parse(
      '<body><p>The <em>red</em> stone</p><p><a href="#n"><strong>x</strong></a> y</p>' +
        '<p><span>a <em>b<!-- c -->c</em></span></p><p>plain</p></body>',
    );
    const before = document.documentElement.outerHTML;
    for (const segment of segmentsOf(document)) inlineLayoutOf(segment);
    expect(document.documentElement.outerHTML).toBe(before);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
