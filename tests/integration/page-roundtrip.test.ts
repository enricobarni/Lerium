import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectTextNodes } from '../../src/content/dom-collector';
import {
  createPageApplier,
  type PageApplier,
  type SegmentPlan,
  type UnitKind,
} from '../../src/content/page-applier';
import { segmentTextNodes } from '../../src/content/segmenter';

// No ambiente jsdom o `URL` global é o do jsdom, que `fileURLToPath` recusa;
// por isso o caminho parte da string `import.meta.url`.
const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/novel-chapter.html',
);
const FIXTURE_HTML = readFileSync(FIXTURE_PATH, 'utf8');

/** Documento novo a cada chamada; nunca `innerHTML` nem `document.write`. */
function loadFixture(): Document {
  return new DOMParser().parseFromString(FIXTURE_HTML, 'text/html');
}

const MARKER = /<\/?g\d+>/gu;

/** Tradutor falso determinístico: maiúsculas, preservando marcadores e espaço. */
const upperCase = (text: string): string =>
  text.replace(/<\/?g\d+>|\p{L}+/gu, (match) =>
    match.startsWith('<') ? match : match.toUpperCase(),
  );

/** Variante que perde os marcadores, para forçar o fallback nó a nó. */
const dropMarkers = (text: string): string => upperCase(text.replace(MARKER, ''));

type Translator = (text: string, kind: UnitKind) => string;

interface PageRun {
  readonly kinds: UnitKind[];
  readonly fallbacks: number;
  readonly failures: number;
}

/** Pipeline completo: coleta → segmentação → plan → tradutor → apply. */
function translatePage(document: Document, applier: PageApplier, translate: Translator): PageRun {
  const kinds: UnitKind[] = [];
  let fallbacks = 0;
  let failures = 0;
  const run = (plan: SegmentPlan): ReturnType<PageApplier['apply']> =>
    applier.apply(
      plan.segmentId,
      new Map(plan.units.map((unit) => [unit.unitId, translate(unit.text, plan.kind)])),
    );

  for (const segment of segmentTextNodes(collectTextNodes(document))) {
    const plan = applier.plan(segment);
    if ('skipped' in plan) {
      failures += 1;
      continue;
    }
    kinds.push(plan.kind);
    let result = run(plan);
    if (!result.ok && result.fallback !== undefined) {
      fallbacks += 1;
      result = run(result.fallback);
    }
    if (!result.ok) failures += 1;
  }
  return { kinds, fallbacks, failures };
}

const segmentTexts = (document: Document): string[] =>
  segmentTextNodes(collectTextNodes(document)).map((segment) => segment.text);

/**
 * Esqueleto da árvore: elementos com atributos, comentários e texto não
 * traduzível literal; os nós traduzíveis (`translatable`) viram `#text`.
 */
function skeleton(node: Node, translatable: ReadonlySet<Node>): string {
  if (node.nodeType === 3) return translatable.has(node) ? '#text' : `"${(node as Text).data}"`;
  if (node.nodeType === 8) return `<!--${(node as Comment).data}-->`;
  if (node.nodeType !== 1) return `?${node.nodeType}`;
  const element = node as Element;
  const attributes = [...element.attributes].map((item) => `${item.name}="${item.value}"`);
  const children = [...element.childNodes].map((child) => skeleton(child, translatable));
  return `<${element.localName} ${attributes.join(' ')}>[${children.join(',')}]`;
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

describe('ida e volta na fixture do capítulo', () => {
  let spies: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    spies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method));
  });

  afterEach(() => {
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('traduz, preserva a estrutura, restaura byte a byte e reaplica', () => {
    const document = loadFixture();
    const originalBody = document.body.innerHTML;
    const originalPage = document.documentElement.innerHTML;
    const originalTexts = segmentTexts(document);
    const translatable = new Set<Node>(collectTextNodes(document));
    const originalSkeleton = skeleton(document.documentElement, translatable);
    const link = document.querySelector('a[href="#notes"]');

    const applier = createPageApplier();
    const run = translatePage(document, applier, upperCase);
    expect(run).toMatchObject({ fallbacks: 0, failures: 0 });
    expect(run.kinds).toContain('plain');
    expect(run.kinds).toContain('markers');

    // Texto traduzido presente, segmento a segmento.
    expect(segmentTexts(document)).toEqual(originalTexts.map(upperCase));
    expect(document.body.textContent).toContain('KAEL HELD THE VEILSTONE AGAINST HIS PALM');
    expect(document.querySelector('em')?.textContent).toBe('VEILSTONE');
    expect(document.querySelector('strong')?.textContent).toBe('COLDER');

    // Estrutura intacta: tags, atributos, comentários e áreas excluídas.
    expect(skeleton(document.documentElement, translatable)).toBe(originalSkeleton);
    expect(document.querySelector('a[href="#notes"]')).toBe(link);
    expect(document.querySelector('pre code')?.textContent).toBe(
      'ward.seal("veilstone", { depth: 3 });',
    );
    expect(document.querySelector('textarea')?.value).toBe('Reader comment draft about Kael');
    const input = document.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('Search the archive');
    expect(input.getAttribute('placeholder')).toBe('Type a name');
    expect(document.querySelector('p[hidden]')?.textContent).toBe(
      "Draft note: Mirena's brother returns in chapter nine.",
    );
    expect(document.title).toBe('Lerium fixture: The Lantern Under the Hill');
    const translatedBody = document.body.innerHTML;
    expect(translatedBody).not.toBe(originalBody);

    const restored = applier.restore();
    expect(restored.skipped).toBe(0);
    expect(restored.restored).toBeGreaterThan(0);
    expect(document.body.innerHTML).toBe(originalBody);
    expect(document.documentElement.innerHTML).toBe(originalPage);

    expect(applier.reapply()).toEqual({ reapplied: restored.restored, skipped: 0 });
    expect(document.body.innerHTML).toBe(translatedBody);
  });

  it('com marcadores perdidos, cai no nó a nó e chega ao mesmo resultado', () => {
    const reference = loadFixture();
    translatePage(reference, createPageApplier(), upperCase);

    const document = loadFixture();
    const originalBody = document.body.innerHTML;
    const applier = createPageApplier();
    const run = translatePage(document, applier, (text, kind) =>
      kind === 'markers' ? dropMarkers(text) : upperCase(text),
    );
    expect(run.fallbacks).toBe(run.kinds.filter((kind) => kind === 'markers').length);
    expect(run.fallbacks).toBeGreaterThan(0);
    expect(run.failures).toBe(0);
    expect(document.body.innerHTML).toBe(reference.body.innerHTML);

    applier.restore();
    expect(document.body.innerHTML).toBe(originalBody);
  });

  it('o site remove um parágrafo no meio e o restore funciona no resto', () => {
    const document = loadFixture();
    const applier = createPageApplier();
    translatePage(document, applier, upperCase);

    const isTarget = (paragraph: Element): boolean =>
      paragraph.textContent?.includes('UNFOLDED THE') === true;
    const removed = [...document.querySelectorAll('p')].find(isTarget);
    if (removed === undefined) throw new Error('parágrafo ausente');
    const removedText = removed.textContent;
    removed.remove();

    const result = applier.restore();
    // O parágrafo tinha três nós escritos: antes, dentro e depois do link.
    expect(result.skipped).toBe(3);
    expect(result.restored).toBeGreaterThan(0);

    const expected = loadFixture();
    const original = [...expected.querySelectorAll('p')].find((paragraph) =>
      paragraph.textContent?.includes('unfolded the'),
    );
    original?.remove();
    expect(document.body.innerHTML).toBe(expected.body.innerHTML);
    // O nó removido fica como estava: não é tocado fora do documento.
    expect(removed.textContent).toBe(removedText);
  });
});
