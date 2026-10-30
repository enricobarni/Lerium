import { describe, expect, it } from 'vitest';
import {
  encodeMarkers,
  MARKER_FORMATS,
  validateInlineLayout,
  type InlineLayout,
} from '../../src/core/inline-markers';
import { readInlineFixtureFiles } from '../fixtures/inline-markup-fixtures';

const EXPECTED_IDS = [
  'adjacent-spans',
  'dialogue',
  'footnote-collision',
  'link-with-nested-strong',
  'long-paragraph',
  'marker-at-end',
  'marker-at-start',
  'moving-adjective',
  'single-em',
  'strong-and-link',
];

/** Fixtures cujo texto colide de propósito com algum formato. */
const EXPECTED_COLLISIONS: Readonly<Record<string, readonly string[]>> = {
  'footnote-collision': ['square'],
};

const ALLOWED_KEYS = new Set(['id', 'source', 'target', 'layout', 'notes']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const files = readInlineFixtureFiles();

describe('fixtures de markup inline', () => {
  it('existem exatamente as fixtures esperadas', () => {
    expect(files.map(({ file }) => file.replace(/\.json$/, ''))).toEqual(EXPECTED_IDS);
  });

  it('os ids são únicos', () => {
    const ids = files.map(({ data }) => (isRecord(data) ? data.id : undefined));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('há um parágrafo longo de 600 a 900 caracteres', () => {
    const long = files.find(({ file }) => file === 'long-paragraph.json')?.data as {
      layout: InlineLayout;
    };
    const length = long.layout.runs.map((run) => run.text).join('').length;
    expect(length).toBeGreaterThanOrEqual(600);
    expect(length).toBeLessThanOrEqual(900);
  });

  describe.each(files)('$file', ({ file, data }) => {
    it('segue o schema', () => {
      expect(isRecord(data)).toBe(true);
      if (!isRecord(data)) return;
      expect(Object.keys(data).every((key) => ALLOWED_KEYS.has(key))).toBe(true);
      expect(data.id).toBe(file.replace(/\.json$/, ''));
      expect(data.source).toBe('en');
      expect(data.target).toBe('pt-BR');
      expect(typeof data.notes === 'string' && data.notes.trim() !== '').toBe(true);
      expect(isRecord(data.layout)).toBe(true);
      const layout = data.layout as Record<string, unknown>;
      expect(Object.keys(layout)).toEqual(['runs']);
      expect(Array.isArray(layout.runs)).toBe(true);
      for (const run of layout.runs as unknown[]) {
        expect(isRecord(run)).toBe(true);
        if (!isRecord(run)) continue;
        expect(Object.keys(run).sort()).toEqual(['path', 'text']);
        expect(typeof run.text).toBe('string');
        // Todo run tem letra: um run marcado vazio é o erro que o codec procura.
        expect(/\p{L}/u.test(run.text as string)).toBe(true);
      }
    });

    it('tem paths consistentes dentro dos limites', () => {
      const validation = validateInlineLayout((data as { layout: InlineLayout }).layout);
      expect(validation.ok).toBe(true);
    });

    it('colide só com os formatos esperados', () => {
      const { id, layout } = data as { id: string; layout: InlineLayout };
      const colliding = MARKER_FORMATS.filter((format) => encodeMarkers(layout, format) === null);
      expect(colliding).toEqual(EXPECTED_COLLISIONS[id] ?? []);
    });
  });
});
