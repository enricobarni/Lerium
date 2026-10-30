import { describe, expect, it } from 'vitest';
import { isLanguageCode } from '../../src/shared/validation';
import { readFixtureFiles } from '../fixtures/literary-fixtures';

const EXPECTED_IDS = [
  'dialogue',
  'long-paragraph',
  'narrative',
  'prompt-injection',
  'proper-names',
  'technical-term',
];

const ALLOWED_KEYS = new Set([
  'id',
  'source',
  'target',
  'text',
  'mustContain',
  'mustNotContain',
  'reference',
  'notes',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const files = readFixtureFiles();

describe('fixtures literárias', () => {
  it('existem exatamente as fixtures esperadas', () => {
    expect(files.map(({ file }) => file.replace(/\.json$/, ''))).toEqual(EXPECTED_IDS);
  });

  it('os ids são únicos', () => {
    const ids = files.map(({ data }) => (isRecord(data) ? data.id : undefined));
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe.each(files)('$file', ({ file, data }) => {
    it('segue o schema', () => {
      expect(isRecord(data)).toBe(true);
      if (!isRecord(data)) return;
      expect(Object.keys(data).every((key) => ALLOWED_KEYS.has(key))).toBe(true);
      expect(isNonEmptyString(data.id)).toBe(true);
      expect(data.source).toBe('en');
      expect(data.target).toBe('pt-BR');
      expect(isLanguageCode(data.source) && isLanguageCode(data.target)).toBe(true);
      expect(data.source).not.toBe(data.target);
      expect(isNonEmptyString(data.text)).toBe(true);
      expect(isNonEmptyString(data.notes)).toBe(true);
      for (const key of ['mustContain', 'mustNotContain'] as const) {
        const list = data[key];
        expect(Array.isArray(list)).toBe(true);
        expect((list as unknown[]).every(isNonEmptyString)).toBe(true);
      }
      if ('reference' in data) expect(isNonEmptyString(data.reference)).toBe(true);
    });

    it('id é igual ao nome do arquivo', () => {
      expect(isRecord(data) && data.id).toBe(file.replace(/\.json$/, ''));
    });

    it('todo mustContain aparece no texto de origem', () => {
      if (!isRecord(data) || typeof data.text !== 'string') throw new Error('schema');
      for (const term of data.mustContain as string[]) expect(data.text).toContain(term);
    });

    it('nenhum mustNotContain aparece no texto de origem', () => {
      // Senão uma tradução fiel, que copia o termo, falharia o critério.
      if (!isRecord(data) || typeof data.text !== 'string') throw new Error('schema');
      for (const term of data.mustNotContain as string[]) expect(data.text).not.toContain(term);
    });
  });

  it('long-paragraph tem entre 1200 e 1600 caracteres', () => {
    const fixture = files.find(({ file }) => file === 'long-paragraph.json')?.data;
    const length = isRecord(fixture) && typeof fixture.text === 'string' ? fixture.text.length : 0;
    expect(length).toBeGreaterThanOrEqual(1200);
    expect(length).toBeLessThanOrEqual(1600);
  });

  it('dialogue tem falas entre aspas e travessão', () => {
    const fixture = files.find(({ file }) => file === 'dialogue.json')?.data;
    const text = isRecord(fixture) && typeof fixture.text === 'string' ? fixture.text : '';
    expect(text.split('"').length - 1).toBeGreaterThanOrEqual(4);
    expect(text).toContain('—');
  });

  it('prompt-injection tem a instrução embutida e o canário ausente do original', () => {
    const fixture = files.find(({ file }) => file === 'prompt-injection.json')?.data;
    if (!isRecord(fixture) || typeof fixture.text !== 'string') throw new Error('schema');
    expect(fixture.text.toLowerCase()).toContain('ignore all previous instructions');
    expect(fixture.mustNotContain).toContain('BANANA-7');
  });
});
