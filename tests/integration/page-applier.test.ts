import { describe, expect, it } from 'vitest';
import { collectTextNodes } from '../../src/content/dom-collector';
import {
  createPageApplier,
  type PageApplier,
  type SegmentPlan,
} from '../../src/content/page-applier';
import {
  MAX_SEGMENT_CHARS,
  segmentTextNodes,
  type TranslationSegment,
} from '../../src/content/segmenter';
import { MAX_INLINE_WRAPPERS } from '../../src/core/inline-markers';

/** Documento novo a cada chamada; nunca `innerHTML` nem `document.write`. */
function parse(body: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${body}</body>`, 'text/html');
}

function segmentsOf(document: Document): TranslationSegment[] {
  return segmentTextNodes(collectTextNodes(document));
}

function onlySegment(document: Document): TranslationSegment {
  const segments = segmentsOf(document);
  expect(segments).toHaveLength(1);
  return segments[0] as TranslationSegment;
}

/** Ler `innerHTML` só para comparar; nunca para montar. */
const htmlOf = (document: Document): string => document.body.innerHTML;

function planOf(applier: PageApplier, segment: TranslationSegment): SegmentPlan {
  const plan = applier.plan(segment);
  if ('skipped' in plan) throw new Error(`segmento pulado: ${plan.skipped}`);
  return plan;
}

/** Resultados com `translate` aplicado a cada unidade. */
function resultsFor(
  plan: SegmentPlan,
  translate: (text: string, index: number) => string | null,
): Map<string, string | null> {
  return new Map(plan.units.map((unit, index) => [unit.unitId, translate(unit.text, index)]));
}

function textNodesOf(element: Element): Text[] {
  return [...element.childNodes].filter((node): node is Text => node.nodeType === 3);
}

function byId(document: Document, id: string): Element {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`#${id} ausente`);
  return element;
}

/** Tradutor falso: maiúsculas fora dos marcadores `<gN>`/`</gN>`. */
const upperCase = (text: string): string =>
  text.replace(/<\/?g\d+>|\p{L}+/gu, (match) =>
    match.startsWith('<') ? match : match.toUpperCase(),
  );

const LONG_SOURCE = 'Kael held the veilstone against his palm until its glow steadied in the cold.';

describe('caminho de texto puro', () => {
  it('aplica a tradução no único nó com conteúdo, com as bordas originais', () => {
    const document = parse('<p>\n   Hello there, traveler.  \n</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    expect(plan.kind).toBe('plain');
    expect(plan.units).toEqual([{ unitId: 'seg-0#text', text: 'Hello there, traveler.' }]);

    const result = applier.apply(
      'seg-0',
      resultsFor(plan, () => '\n  Olá, viajante. \n\n'),
    );
    expect(result).toEqual({ ok: true });
    expect(htmlOf(document)).toBe('<p>\n   Olá, viajante.  \n</p>');
  });

  it('deixa intocados os nós só de espaço e os comentários', () => {
    const document = parse('<p>\n<!--a-->Hello there<!--b-->\n  </p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    expect(plan.kind).toBe('plain');
    expect(
      applier.apply(
        'seg-0',
        resultsFor(plan, () => 'Olá'),
      ),
    ).toEqual({ ok: true });
    expect(htmlOf(document)).toBe('<p>\n<!--a-->Olá<!--b-->\n  </p>');
  });

  it('insere a saída do modelo como texto, nunca como HTML', () => {
    const document = parse('<p>Hello</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    const hostile = '<img src=x onerror="alert(1)">Olá';
    expect(
      applier.apply(
        'seg-0',
        resultsFor(plan, () => hostile),
      ),
    ).toEqual({ ok: true });
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('p')?.textContent).toBe(hostile);
  });

  it('com mais de um nó com conteúdo, traduz nó a nó (nunca tudo no primeiro)', () => {
    const document = parse('<p>Hello<!--x--> world</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    expect(plan.kind).toBe('per_node');
    expect(plan.units.map((unit) => unit.text)).toEqual(['Hello', 'world']);

    const results = resultsFor(plan, (text) => (text === 'Hello' ? 'Olá' : 'mundo'));
    expect(applier.apply('seg-0', results)).toEqual({ ok: true });
    expect(htmlOf(document)).toBe('<p>Olá<!--x--> mundo</p>');
  });

  it('tradução implausível mantém o original', () => {
    const document = parse(`<p>${LONG_SOURCE}</p>`);
    const before = htmlOf(document);
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    expect(
      applier.apply(
        'seg-0',
        resultsFor(plan, () => 'Ok.'),
      ),
    ).toEqual({
      ok: false,
      reason: 'implausible_output',
    });
    expect(htmlOf(document)).toBe(before);
  });

  it('tradução vazia ou só de espaço é implausível', () => {
    const document = parse('<p>Hi.</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    expect(
      applier.apply(
        'seg-0',
        resultsFor(plan, () => ' \n '),
      ),
    ).toEqual({
      ok: false,
      reason: 'implausible_output',
    });
    expect(htmlOf(document)).toBe('<p>Hi.</p>');
  });

  it('resultado ausente ou null é translation_failed', () => {
    const document = parse('<p>Hello</p><p>World</p>');
    const applier = createPageApplier();
    const [first, second] = segmentsOf(document) as [TranslationSegment, TranslationSegment];
    planOf(applier, first);
    const plan = planOf(applier, second);
    expect(applier.apply('seg-0', new Map())).toEqual({ ok: false, reason: 'translation_failed' });
    expect(
      applier.apply(
        'seg-1',
        resultsFor(plan, () => null),
      ),
    ).toEqual({
      ok: false,
      reason: 'translation_failed',
    });
    expect(htmlOf(document)).toBe('<p>Hello</p><p>World</p>');
  });
});

describe('caminho com marcadores', () => {
  it('distribui os runs pelos nós e preserva o elemento inline', () => {
    const document = parse('<p>The <em class="x">red</em> stone.</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    expect(plan.kind).toBe('markers');
    expect(plan.units).toEqual([{ unitId: 'seg-0#markers', text: 'The <g1>red</g1> stone.' }]);

    const results = resultsFor(plan, () => 'A pedra <g1>vermelha</g1>.');
    expect(applier.apply('seg-0', results)).toEqual({ ok: true });
    expect(htmlOf(document)).toBe('<p>A pedra <em class="x">vermelha</em>.</p>');
  });

  it('mantém href e atributos dos links', () => {
    const document = parse(
      '<p>See <a href="/map?a=1&amp;b=2" title="Old map" rel="next">the map</a> now.</p>',
    );
    const link = document.querySelector('a') as HTMLAnchorElement;
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    expect(plan.kind).toBe('markers');
    const results = resultsFor(plan, () => 'Veja <g1>o mapa</g1> agora.');
    expect(applier.apply('seg-0', results)).toEqual({ ok: true });
    expect(document.querySelector('a')).toBe(link);
    expect(link.getAttribute('href')).toBe('/map?a=1&b=2');
    expect(link.getAttribute('title')).toBe('Old map');
    expect(link.getAttribute('rel')).toBe('next');
    expect(link.textContent).toBe('o mapa');
    expect(htmlOf(document)).toBe(
      '<p>Veja <a href="/map?a=1&amp;b=2" title="Old map" rel="next">o mapa</a> agora.</p>',
    );
  });

  it('marcadores inválidos devolvem fallback nó a nó e não escrevem nada', () => {
    const document = parse('<p>The <em>red</em> stone and <strong>blue</strong> sky.</p>');
    const before = htmlOf(document);
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    expect(plan.kind).toBe('markers');

    // Ordem dos marcadores trocada.
    const swapped = resultsFor(plan, () => 'O <g2>azul</g2> e a <g1>vermelha</g1>.');
    const result = applier.apply('seg-0', swapped);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('markers_invalid');
    expect(htmlOf(document)).toBe(before);

    const fallback = result.fallback as SegmentPlan;
    expect(fallback.kind).toBe('per_node');
    expect(fallback.units.map((unit) => unit.text)).toEqual([
      'The',
      'red',
      'stone and',
      'blue',
      'sky.',
    ]);
    const words = ['A', 'vermelha', 'pedra e o', 'azul', 'céu.'];
    expect(
      applier.apply(
        'seg-0',
        resultsFor(fallback, (_text, index) => words[index] ?? null),
      ),
    ).toEqual({ ok: true });
    expect(htmlOf(document)).toBe(
      '<p>A <em>vermelha</em> pedra e o <strong>azul</strong> céu.</p>',
    );
  });

  it('resultado null nos marcadores é translation_failed, sem fallback', () => {
    const document = parse('<p>The <em>red</em> stone.</p>');
    const applier = createPageApplier();
    planOf(applier, onlySegment(document));
    expect(applier.apply('seg-0', new Map([['seg-0#markers', null]]))).toEqual({
      ok: false,
      reason: 'translation_failed',
    });
  });

  it('run com mais de um nó com conteúdo vai nó a nó desde o plano', () => {
    const document = parse('<p>The <em>red<!--x-->dish</em> stone.</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    expect(plan.kind).toBe('per_node');
    expect(plan.units.map((unit) => unit.text)).toEqual(['The', 'red', 'dish', 'stone.']);
  });

  it('aninhamento acima do limite vai nó a nó', () => {
    const document = parse('<p>She <a href="#x">took <strong>the blade</strong></a> back.</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    expect(plan.kind).toBe('per_node');
    const words = ['Ela', 'pegou', 'a lâmina', 'de volta.'];
    expect(
      applier.apply(
        'seg-0',
        resultsFor(plan, (_text, index) => words[index] ?? null),
      ),
    ).toEqual({ ok: true });
    expect(htmlOf(document)).toBe(
      '<p>Ela <a href="#x">pegou <strong>a lâmina</strong></a> de volta.</p>',
    );
  });

  it('wrappers acima do limite vão nó a nó', () => {
    const spans = Array.from({ length: MAX_INLINE_WRAPPERS + 1 }, (_v, i) => `<b>w${i}</b>`);
    const document = parse(`<p>${spans.join(' ')}</p>`);
    const applier = createPageApplier();
    expect(planOf(applier, onlySegment(document)).kind).toBe('per_node');
  });

  it('texto com sintaxe de marcador vai nó a nó', () => {
    const document = parse('<p>Type <em>&lt;g1&gt;</em> to open.</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    expect(plan.kind).toBe('per_node');
    // O "g" é letra, então o nó "<g1>" também vira unidade.
    expect(plan.units.map((unit) => unit.text)).toEqual(['Type', '<g1>', 'to open.']);
  });
});

describe('nó a nó', () => {
  it('ignora nós sem letra e preserva as bordas de cada nó', () => {
    const document = parse('<p>\n  Hello <!--a-->| <!--b--> world!\n</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    expect(plan.kind).toBe('per_node');
    expect(plan.units).toEqual([
      { unitId: 'seg-0#node-0', text: 'Hello' },
      { unitId: 'seg-0#node-2', text: 'world!' },
    ]);
    const results = resultsFor(plan, (text) => (text === 'Hello' ? ' Olá ' : 'mundo!'));
    expect(applier.apply('seg-0', results)).toEqual({ ok: true });
    expect(htmlOf(document)).toBe('<p>\n  Olá <!--a-->| <!--b--> mundo!\n</p>');
  });

  it('uma unidade sem resultado deixa o segmento inteiro no original', () => {
    const document = parse('<p>Hello<!--x--> world</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    const results = resultsFor(plan, (_text, index) => (index === 0 ? 'Olá' : null));
    expect(applier.apply('seg-0', results)).toEqual({ ok: false, reason: 'translation_failed' });
    expect(htmlOf(document)).toBe('<p>Hello<!--x--> world</p>');
  });

  it('uma unidade implausível deixa o segmento inteiro no original', () => {
    const document = parse(`<p>Hi<!--x--> ${LONG_SOURCE}</p>`);
    const before = htmlOf(document);
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    const results = resultsFor(plan, (_text, index) => (index === 0 ? 'Oi' : 'Curto.'));
    expect(applier.apply('seg-0', results)).toEqual({ ok: false, reason: 'implausible_output' });
    expect(htmlOf(document)).toBe(before);
  });
});

describe('atomicidade entre plan e apply', () => {
  it('nó removido: node_changed e nada é escrito', () => {
    const document = parse('<p>The <em>red</em> stone.</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    document.querySelector('em')?.remove();
    const before = htmlOf(document);
    const results = resultsFor(plan, () => 'A pedra <g1>vermelha</g1>.');
    expect(applier.apply('seg-0', results)).toEqual({ ok: false, reason: 'node_changed' });
    expect(htmlOf(document)).toBe(before);
  });

  it('nó alterado pelo site: node_changed e nada é escrito', () => {
    const document = parse('<p>Hello<!--x--> world</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    const second = textNodesOf(document.querySelector('p') as Element)[1] as Text;
    second.data = ' planet';
    const results = resultsFor(plan, () => 'Olá');
    expect(applier.apply('seg-0', results)).toEqual({ ok: false, reason: 'node_changed' });
    expect(htmlOf(document)).toBe('<p>Hello<!--x--> planet</p>');
  });

  it('nó só de espaço removido também invalida o segmento', () => {
    const document = parse('<p>\n<!--a-->Hello\n</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    textNodesOf(document.querySelector('p') as Element)[0]?.remove();
    expect(
      applier.apply(
        'seg-0',
        resultsFor(plan, () => 'Olá'),
      ),
    ).toEqual({
      ok: false,
      reason: 'node_changed',
    });
    expect(htmlOf(document)).toBe('<p><!--a-->Hello\n</p>');
  });

  it('fallback usa o snapshot do plano original', () => {
    const document = parse('<p>The <em>red</em> stone.</p>');
    const applier = createPageApplier();
    const plan = planOf(applier, onlySegment(document));
    const result = applier.apply(
      'seg-0',
      resultsFor(plan, () => 'sem marcadores'),
    );
    if (result.ok || result.fallback === undefined) throw new Error('esperava fallback');
    (document.querySelector('em')?.firstChild as Text).data = 'blue';
    expect(
      applier.apply(
        'seg-0',
        resultsFor(result.fallback, () => 'x'),
      ),
    ).toEqual({
      ok: false,
      reason: 'node_changed',
    });
    expect(htmlOf(document)).toBe('<p>The <em>blue</em> stone.</p>');
  });
});

describe('ciclo de vida dos planos', () => {
  it('segmento acima de MAX_SEGMENT_CHARS é pulado, sem unidades', () => {
    const words = 'word '.repeat(Math.ceil((MAX_SEGMENT_CHARS + 1) / 5));
    const document = parse(`<p>${words}</p>`);
    const before = htmlOf(document);
    const applier = createPageApplier();
    const segment = onlySegment(document);
    expect(segment.text.length).toBeGreaterThan(MAX_SEGMENT_CHARS);
    expect(applier.plan(segment)).toEqual({ segmentId: 'seg-0', skipped: 'segment_too_long' });
    expect(applier.apply('seg-0', new Map([['seg-0#text', 'x']]))).toEqual({
      ok: false,
      reason: 'segment_too_long',
    });
    expect(htmlOf(document)).toBe(before);
  });

  it('segmento com exatamente MAX_SEGMENT_CHARS é planejado', () => {
    const document = parse(`<p>${'a'.repeat(MAX_SEGMENT_CHARS)}</p>`);
    const applier = createPageApplier();
    expect(planOf(applier, onlySegment(document)).kind).toBe('plain');
  });

  it('apply sem plano pendente é unknown_segment; o plano é consumido', () => {
    const document = parse('<p>Hello</p>');
    const applier = createPageApplier();
    expect(applier.apply('seg-0', new Map())).toEqual({ ok: false, reason: 'unknown_segment' });
    const plan = planOf(applier, onlySegment(document));
    expect(
      applier.apply(
        'seg-0',
        resultsFor(plan, () => 'Olá'),
      ),
    ).toEqual({ ok: true });
    expect(
      applier.apply(
        'seg-0',
        resultsFor(plan, () => 'Oi'),
      ),
    ).toEqual({
      ok: false,
      reason: 'unknown_segment',
    });
    expect(htmlOf(document)).toBe('<p>Olá</p>');
  });
});

describe('restore e reapply', () => {
  function translatedDocument(): { document: Document; applier: PageApplier } {
    const document = parse(
      '<p id="a">Hello there.</p><p id="b">The <em>red</em> stone.</p><p id="c">Good night.</p>',
    );
    const applier = createPageApplier();
    for (const segment of segmentsOf(document)) {
      const plan = planOf(applier, segment);
      const results = resultsFor(plan, upperCase);
      expect(applier.apply(segment.id, results)).toEqual({ ok: true });
    }
    return { document, applier };
  }

  const ORIGINAL =
    '<p id="a">Hello there.</p><p id="b">The <em>red</em> stone.</p><p id="c">Good night.</p>';
  const TRANSLATED =
    '<p id="a">HELLO THERE.</p><p id="b">THE <em>RED</em> STONE.</p><p id="c">GOOD NIGHT.</p>';

  it('restaura o original exato e reaplica a tradução', () => {
    const { document, applier } = translatedDocument();
    expect(htmlOf(document)).toBe(TRANSLATED);
    expect(applier.restore()).toEqual({ restored: 5, skipped: 0 });
    expect(htmlOf(document)).toBe(ORIGINAL);
    expect(applier.reapply()).toEqual({ reapplied: 5, skipped: 0 });
    expect(htmlOf(document)).toBe(TRANSLATED);
    expect(applier.restore()).toEqual({ restored: 5, skipped: 0 });
    expect(htmlOf(document)).toBe(ORIGINAL);
  });

  it('não toca no nó que o site alterou depois da tradução', () => {
    const { document, applier } = translatedDocument();
    (byId(document, 'a').firstChild as Text).data = 'Edited by site';
    expect(applier.restore()).toEqual({ restored: 4, skipped: 1 });
    expect(htmlOf(document)).toBe(
      '<p id="a">Edited by site</p><p id="b">The <em>red</em> stone.</p><p id="c">Good night.</p>',
    );
  });

  it('não toca em nós desconectados e restaura o resto', () => {
    const { document, applier } = translatedDocument();
    const removed = byId(document, 'b');
    removed.remove();
    expect(applier.restore()).toEqual({ restored: 2, skipped: 3 });
    expect(htmlOf(document)).toBe('<p id="a">Hello there.</p><p id="c">Good night.</p>');
    expect(removed.textContent).toBe('THE RED STONE.');
  });

  it('reapply não toca no nó alterado depois do restore', () => {
    const { document, applier } = translatedDocument();
    applier.restore();
    (byId(document, 'c').firstChild as Text).data = 'Changed again';
    expect(applier.reapply()).toEqual({ reapplied: 4, skipped: 1 });
    expect(htmlOf(document)).toBe(
      '<p id="a">HELLO THERE.</p><p id="b">THE <em>RED</em> STONE.</p><p id="c">Changed again</p>',
    );
  });

  it('o original é gravado só na primeira escrita', () => {
    const { document, applier } = translatedDocument();
    const segment = segmentsOf(document)[0] as TranslationSegment;
    const plan = planOf(applier, segment);
    expect(
      applier.apply(
        segment.id,
        resultsFor(plan, () => 'Olá de novo.'),
      ),
    ).toEqual({
      ok: true,
    });
    applier.restore();
    expect(htmlOf(document)).toBe(ORIGINAL);
  });

  it('clear esquece o registro sem escrever no DOM', () => {
    const { document, applier } = translatedDocument();
    applier.clear();
    expect(htmlOf(document)).toBe(TRANSLATED);
    expect(applier.restore()).toEqual({ restored: 0, skipped: 0 });
    expect(applier.reapply()).toEqual({ reapplied: 0, skipped: 0 });
    expect(htmlOf(document)).toBe(TRANSLATED);
  });

  it('registros de appliers diferentes são independentes', () => {
    const { document } = translatedDocument();
    expect(createPageApplier().restore()).toEqual({ restored: 0, skipped: 0 });
    expect(htmlOf(document)).toBe(TRANSLATED);
  });
});
