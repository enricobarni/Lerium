import { describe, expect, it, vi } from 'vitest';
import { collectTextNodes } from '../../src/content/dom-collector';
import {
  classifySegments,
  PRIORITY_CLASSES,
  PRIORITY_MAIN,
  PRIORITY_PERIPHERAL,
  PRIORITY_VISIBLE_MAIN,
  type BlockRect,
  type SegmentPriorityDeps,
} from '../../src/content/segment-priority';
import { segmentTextNodes, type TranslationSegment } from '../../src/content/segmenter';

const VIEWPORT = 800;

/** Documento novo a cada chamada; nunca `innerHTML` nem `document.write`. */
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function segmentsOf(document: Document): TranslationSegment[] {
  return segmentTextNodes(collectTextNodes(document));
}

/** Bloco com área dentro da viewport. */
const IN_VIEW: BlockRect = { top: 100, bottom: 140, width: 600, height: 40 };

function rect(top: number, height = 40, width = 600): BlockRect {
  return { top, bottom: top + height, width, height };
}

/**
 * `measure` falso: o retângulo vem de `rects[id do bloco]`; bloco sem id ou
 * sem entrada usa `fallback`.
 */
function fakeDeps(
  rects: Readonly<Record<string, BlockRect>> = {},
  fallback: BlockRect = IN_VIEW,
): SegmentPriorityDeps & { measure: ReturnType<typeof vi.fn<(block: Element) => BlockRect>> } {
  return {
    measure: vi.fn((block: Element) => rects[block.id] ?? fallback),
    viewportHeight: VIEWPORT,
  };
}

/** `[texto, prioridade]` na ordem devolvida. */
function classify(html: string, deps: SegmentPriorityDeps = fakeDeps()): [string, number][] {
  return classifySegments(segmentsOf(parse(html)), deps).map((item) => [
    item.segment.text,
    item.priority,
  ]);
}

function priorityOf(html: string, text: string): number {
  const found = classify(html).find(([candidate]) => candidate === text);
  if (found === undefined) throw new Error(`sem segmento "${text}"`);
  return found[1];
}

describe('constantes de prioridade', () => {
  it('são 0, 1, 2 e três classes', () => {
    expect([PRIORITY_VISIBLE_MAIN, PRIORITY_MAIN, PRIORITY_PERIPHERAL]).toEqual([0, 1, 2]);
    expect(PRIORITY_CLASSES).toBe(3);
  });
});

describe('classifySegments: periferia', () => {
  it('nav e aside são periféricos, inclusive em descendentes', () => {
    const html =
      '<body><nav><ul><li>Home link</li></ul></nav>' +
      '<aside><p>Side note</p></aside><main><p>Story text</p></main></body>';
    expect(priorityOf(html, 'Home link')).toBe(PRIORITY_PERIPHERAL);
    expect(priorityOf(html, 'Side note')).toBe(PRIORITY_PERIPHERAL);
    expect(priorityOf(html, 'Story text')).toBe(PRIORITY_VISIBLE_MAIN);
  });

  it('o próprio bloco periférico conta (ancestral inclusive)', () => {
    expect(priorityOf('<body><nav>Menu text</nav></body>', 'Menu text')).toBe(PRIORITY_PERIPHERAL);
    expect(priorityOf('<body><aside>Aside text</aside></body>', 'Aside text')).toBe(
      PRIORITY_PERIPHERAL,
    );
  });

  it('header de página é periférico; header de article não', () => {
    const html =
      '<body><header><p>Site title</p></header>' +
      '<article><header><h1>Chapter title</h1></header><p>Body</p></article></body>';
    expect(priorityOf(html, 'Site title')).toBe(PRIORITY_PERIPHERAL);
    expect(priorityOf(html, 'Chapter title')).toBe(PRIORITY_VISIBLE_MAIN);
  });

  it('footer de página é periférico; footer de section não', () => {
    const html =
      '<body><section><p>Text</p><footer><p>Section end</p></footer></section>' +
      '<footer><p>Copyright line</p></footer></body>';
    expect(priorityOf(html, 'Section end')).toBe(PRIORITY_VISIBLE_MAIN);
    expect(priorityOf(html, 'Copyright line')).toBe(PRIORITY_PERIPHERAL);
  });

  it('header dentro de main não é periférico, mesmo com div no caminho', () => {
    const html = '<body><main><div><header><p>Inner heading</p></header></div></main></body>';
    expect(priorityOf(html, 'Inner heading')).toBe(PRIORITY_VISIBLE_MAIN);
  });

  it('header dentro de div solta continua periférico', () => {
    const html = '<body><div id="wrap"><header><p>Page banner</p></header></div></body>';
    expect(priorityOf(html, 'Page banner')).toBe(PRIORITY_PERIPHERAL);
  });

  it('header dentro de aside ou nav é periférico pelo aside/nav', () => {
    const html =
      '<body><aside><header><p>Aside head</p></header></aside>' +
      '<nav><footer><p>Nav foot</p></footer></nav></body>';
    expect(priorityOf(html, 'Aside head')).toBe(PRIORITY_PERIPHERAL);
    expect(priorityOf(html, 'Nav foot')).toBe(PRIORITY_PERIPHERAL);
  });

  it.each(['navigation', 'complementary', 'banner', 'contentinfo', 'search'])(
    'role=%s é periférico',
    (role) => {
      const html = `<body><div role="${role}"><p>Role text</p></div><p>Main text</p></body>`;
      expect(priorityOf(html, 'Role text')).toBe(PRIORITY_PERIPHERAL);
      expect(priorityOf(html, 'Main text')).toBe(PRIORITY_VISIBLE_MAIN);
    },
  );

  it('role é comparado sem caixa e pelo primeiro token', () => {
    expect(
      priorityOf('<body><div role=" Navigation main"><p>Upper role</p></div></body>', 'Upper role'),
    ).toBe(PRIORITY_PERIPHERAL);
    expect(
      priorityOf('<body><div role="main navigation"><p>Main first</p></div></body>', 'Main first'),
    ).toBe(PRIORITY_VISIBLE_MAIN);
  });

  it('role não periférico ou vazio não muda a classe', () => {
    const html =
      '<body><div role="main"><p>Role main</p></div><div role=""><p>Empty role</p></div></body>';
    expect(priorityOf(html, 'Role main')).toBe(PRIORITY_VISIBLE_MAIN);
    expect(priorityOf(html, 'Empty role')).toBe(PRIORITY_VISIBLE_MAIN);
  });

  it('elemento search é periférico', () => {
    expect(priorityOf('<body><search><p>Find here</p></search></body>', 'Find here')).toBe(
      PRIORITY_PERIPHERAL,
    );
  });

  it('periférico não é medido', () => {
    const document = parse('<body><nav><p>Menu</p></nav><footer><p>Foot</p></footer></body>');
    const deps = fakeDeps();
    const result = classifySegments(segmentsOf(document), deps);
    expect(result.map((item) => item.priority)).toEqual([PRIORITY_PERIPHERAL, PRIORITY_PERIPHERAL]);
    expect(deps.measure).not.toHaveBeenCalled();
  });
});

describe('classifySegments: visibilidade', () => {
  function single(blockRect: BlockRect): number {
    const result = classify('<body><p id="b">Text</p></body>', fakeDeps({ b: blockRect }));
    return result[0]?.[1] ?? -1;
  }

  it('dentro da viewport é visível', () => {
    expect(single(rect(100))).toBe(PRIORITY_VISIBLE_MAIN);
  });

  it('cortado pela borda superior ou inferior é visível', () => {
    expect(single(rect(-20))).toBe(PRIORITY_VISIBLE_MAIN);
    expect(single(rect(VIEWPORT - 10))).toBe(PRIORITY_VISIBLE_MAIN);
  });

  it('maior que a viewport é visível', () => {
    expect(single(rect(-500, 3000))).toBe(PRIORITY_VISIBLE_MAIN);
  });

  it('abaixo ou acima da viewport não é visível', () => {
    expect(single(rect(VIEWPORT + 1))).toBe(PRIORITY_MAIN);
    expect(single(rect(-100))).toBe(PRIORITY_MAIN);
  });

  it('só encostando na borda não é visível', () => {
    expect(single(rect(VIEWPORT))).toBe(PRIORITY_MAIN);
    expect(single(rect(-40))).toBe(PRIORITY_MAIN);
  });

  it('0x0, largura 0 ou altura 0 não é visível, mesmo dentro da faixa', () => {
    expect(single({ top: 100, bottom: 100, width: 0, height: 0 })).toBe(PRIORITY_MAIN);
    expect(single({ top: 100, bottom: 140, width: 0, height: 40 })).toBe(PRIORITY_MAIN);
    expect(single({ top: 100, bottom: 100, width: 600, height: 0 })).toBe(PRIORITY_MAIN);
  });

  it('medida NaN não é visível', () => {
    expect(single({ top: Number.NaN, bottom: Number.NaN, width: 10, height: 10 })).toBe(
      PRIORITY_MAIN,
    );
  });
});

describe('classifySegments: ordem', () => {
  it('ordena classe 0, classe 1 (abaixo, depois acima do mais próximo) e classe 2', () => {
    const html =
      '<body>' +
      '<header><p>Site head</p></header>' +
      '<main>' +
      '<p id="far-above">Far above</p>' +
      '<p id="near-above">Near above</p>' +
      '<p id="mid-above">Mid above</p>' +
      '<p id="seen-1">Seen one</p>' +
      '<p id="below-1">Below one</p>' +
      '<p id="seen-2">Seen two</p>' +
      '<p id="hidden">Zero size</p>' +
      '<p id="below-2">Below two</p>' +
      '</main>' +
      '<nav><p>Nav link</p></nav>' +
      '<footer><p>Site foot</p></footer>' +
      '</body>';
    const deps = fakeDeps({
      'far-above': rect(-3000),
      'near-above': rect(-100),
      'mid-above': rect(-900),
      'seen-1': rect(0),
      'below-1': rect(VIEWPORT + 50),
      'seen-2': rect(400),
      hidden: { top: 300, bottom: 300, width: 0, height: 0 },
      'below-2': rect(VIEWPORT + 2000),
    });

    expect(classify(html, deps)).toEqual([
      ['Seen one', PRIORITY_VISIBLE_MAIN],
      ['Seen two', PRIORITY_VISIBLE_MAIN],
      ['Below one', PRIORITY_MAIN],
      ['Zero size', PRIORITY_MAIN],
      ['Below two', PRIORITY_MAIN],
      ['Near above', PRIORITY_MAIN],
      ['Mid above', PRIORITY_MAIN],
      ['Far above', PRIORITY_MAIN],
      ['Site head', PRIORITY_PERIPHERAL],
      ['Nav link', PRIORITY_PERIPHERAL],
      ['Site foot', PRIORITY_PERIPHERAL],
    ]);
  });

  it('acima da viewport com o mesmo bottom mantém a ordem de documento', () => {
    const html = '<body><p id="a">First</p><p id="b">Second</p></body>';
    const deps = fakeDeps({ a: rect(-200), b: rect(-200) });
    expect(classify(html, deps).map(([text]) => text)).toEqual(['First', 'Second']);
  });

  it('order é o índice na entrada e os segmentos são os mesmos objetos', () => {
    const document = parse(
      '<body><nav><p>Menu</p></nav><p id="low">Low</p><p id="top">Top</p></body>',
    );
    const segments = segmentsOf(document);
    const result = classifySegments(segments, fakeDeps({ low: rect(VIEWPORT + 10) }));
    expect(result.map((item) => item.order)).toEqual([2, 1, 0]);
    for (const item of result) expect(item.segment).toBe(segments[item.order]);
    expect(result).toHaveLength(segments.length);
  });

  it('entrada vazia devolve []', () => {
    const deps = fakeDeps();
    expect(classifySegments([], deps)).toEqual([]);
    expect(deps.measure).not.toHaveBeenCalled();
  });
});

describe('classifySegments: medição e efeitos', () => {
  it('mede uma vez por bloco distinto', () => {
    // `<br>` divide o mesmo `<p>` em três segmentos de um bloco só.
    const document = parse(
      '<body><p id="one">a<br>b<br>c</p><p id="two">d<br>e</p><p id="three">f</p></body>',
    );
    const segments = segmentsOf(document);
    expect(segments).toHaveLength(6);
    const deps = fakeDeps();
    classifySegments(segments, deps);
    expect(deps.measure).toHaveBeenCalledTimes(3);
    const measured = deps.measure.mock.calls.map(([block]) => block.id);
    expect(measured).toEqual(['one', 'two', 'three']);
  });

  it('o mesmo bloco dá a mesma classe a todos os seus segmentos', () => {
    const html = '<body><p id="split">a<br>b</p></body>';
    expect(classify(html, fakeDeps({ split: rect(VIEWPORT + 5) }))).toEqual([
      ['a', PRIORITY_MAIN],
      ['b', PRIORITY_MAIN],
    ]);
  });

  it('não altera o DOM', () => {
    const document = parse(
      '<body><header role="banner"><p>H</p></header><main><p id="x">Text</p></main>' +
        '<aside><p>S</p></aside></body>',
    );
    const before = document.documentElement.outerHTML;
    classifySegments(segmentsOf(document), fakeDeps({ x: rect(-500) }));
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it('não chama console', () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      classify(
        '<body><nav><p>N</p></nav><main><p id="a">A</p><p id="b">B</p></main></body>',
        fakeDeps({ a: rect(-100), b: rect(VIEWPORT + 1) }),
      );
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
