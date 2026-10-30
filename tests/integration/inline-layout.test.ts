import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeMarkers, encodeMarkers, validateInlineLayout } from '../../src/core/inline-markers';
import { collectTextNodes } from '../../src/content/dom-collector';
import { inlineLayoutOf, type SegmentInlineLayout } from '../../src/content/inline-layout';
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

function layoutOf(html: string): SegmentInlineLayout {
  const result = inlineLayoutOf(onlySegment(html));
  if (result === null) throw new Error('layout inesperadamente nulo');
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
    if (result === null) throw new Error('layout nulo');
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
    if (result === null) throw new Error('layout nulo');
    expect(runTexts(result)).toEqual(['a ', 'b']);
    expect(runPaths(result)).toEqual([[], [1]]);
    expectAligned(segment, result);
  });

  it('wrapper que não cobre os nós só de espaço de fora conta como wrapper', () => {
    // Comportamento atual: o critério é conter todos os nós, inclusive os só
    // de espaço; aqui o span fica com id 1 e o layout passa de um nível.
    const result = layoutOf('<p>\n<span>a <em>b</em></span>\n</p>');
    expect(runTexts(result)).toEqual(['\n', 'a ', 'b', '\n']);
    expect(runPaths(result)).toEqual([[], [1], [1, 2], []]);
    expect(encodeMarkers(result.layout)).toBeNull();
  });

  it('aninhamento gera path de profundidade 2 e encodeMarkers recusa', () => {
    const result = layoutOf('<p><a href="#n"><strong>x</strong></a> y</p>');
    expect(runTexts(result)).toEqual(['x', ' y']);
    expect(runPaths(result)).toEqual([[1, 2], []]);
    expect(validateInlineLayout(result.layout)).toEqual({ ok: false, error: 'too_deep' });
    expect(encodeMarkers(result.layout)).toBeNull();
  });

  it('dá ids distintos a elementos distintos, na ordem de aparição', () => {
    const result = layoutOf('<p><em>one</em> and <em>two</em></p>');
    expect(runTexts(result)).toEqual(['one', ' and ', 'two']);
    expect(runPaths(result)).toEqual([[1], [], [2]]);
  });

  it('junta num run os nós do mesmo elemento separados por comentário', () => {
    const segment = onlySegment('<p>a <em>b<!-- note -->c</em> d</p>');
    const result = inlineLayoutOf(segment);
    if (result === null) throw new Error('layout nulo');
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
    if (result === null) throw new Error('layout nulo');
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
    expect(results.map((result) => (result === null ? null : runPaths(result)))).toEqual([
      [[], [1]],
      null,
      [[1], []],
    ]);
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
