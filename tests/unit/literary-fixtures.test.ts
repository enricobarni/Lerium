import { describe, expect, it } from 'vitest';
import { isLanguageCode } from '../../src/shared/validation';
import {
  countOccurrences,
  findForbidden,
  findInconsistentTerms,
  MAX_LENGTH_RATIO,
  normalizeCanary,
  readFixtureFiles,
  type LiteraryFixture,
} from '../fixtures/literary-fixtures';

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
  'minLengthRatio',
  'consistentTerms',
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
      if ('minLengthRatio' in data) {
        const ratio = data.minLengthRatio;
        expect(typeof ratio === 'number' && Number.isFinite(ratio)).toBe(true);
        expect(ratio as number).toBeGreaterThan(0);
        expect(ratio as number).toBeLessThanOrEqual(MAX_LENGTH_RATIO);
      }
    });

    it('consistentTerms, quando presente, é coerente com o texto', () => {
      if (!isRecord(data) || typeof data.text !== 'string') throw new Error('schema');
      if (!('consistentTerms' in data)) return;
      const terms = data.consistentTerms;
      expect(Array.isArray(terms) && terms.length > 0).toBe(true);
      for (const term of terms as unknown[]) {
        expect(isRecord(term)).toBe(true);
        if (!isRecord(term)) continue;
        expect(Object.keys(term).sort()).toEqual(['accepted', 'occurrences', 'source']);
        expect(isNonEmptyString(term.source)).toBe(true);
        const accepted = term.accepted;
        expect(Array.isArray(accepted) && accepted.length > 0).toBe(true);
        expect((accepted as unknown[]).every(isNonEmptyString)).toBe(true);
        const list = accepted as string[];
        expect(list).toContain(term.source);
        expect(new Set(list).size).toBe(list.length);
        // Nenhuma renderização contém outra: a contagem de uma não pode
        // inflar a de outra (ex.: "Array" dentro de "Ascension Array").
        for (const a of list) {
          for (const b of list) if (a !== b) expect(a.includes(b)).toBe(false);
        }
        expect(Number.isInteger(term.occurrences)).toBe(true);
        expect(term.occurrences).toBe(countOccurrences(data.text, term.source as string));
        expect(term.occurrences as number).toBeGreaterThan(0);
        // O termo não pode estar também em mustContain (critérios em conflito).
        expect(data.mustContain as string[]).not.toContain(term.source);
      }
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
      // Comparação normalizada, igual à do teste manual.
      const text = normalizeCanary(data.text);
      for (const term of data.mustNotContain as string[]) {
        expect(normalizeCanary(term)).not.toBe('');
        expect(text).not.toContain(normalizeCanary(term));
      }
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
    // As partes existem, mas separadas por palavra: a junção normalizada do
    // original é "BANANDANA7", nunca "BANANA7".
    expect(fixture.text).toContain('BAN and ANA-7');
    expect(normalizeCanary(fixture.text)).not.toContain('BANANA7');
  });

  it('long-paragraph exige razão de comprimento 0,85', () => {
    const fixture = files.find(({ file }) => file === 'long-paragraph.json')?.data;
    expect(isRecord(fixture) && fixture.minLengthRatio).toBe(0.85);
  });

  it('technical-term exige consistência de "Ascension Array" nas 3 ocorrências', () => {
    const fixture = files.find(({ file }) => file === 'technical-term.json')?.data;
    if (!isRecord(fixture)) throw new Error('schema');
    expect(fixture.mustContain).toEqual(['Kael']);
    expect(fixture.consistentTerms).toEqual([
      {
        source: 'Ascension Array',
        occurrences: 3,
        accepted: ['Ascension Array', 'Matriz de Ascensão'],
      },
    ]);
  });

  it('nenhuma fixture usa os nomes descartados Lyra e Corwin', () => {
    for (const { data } of files) expect(JSON.stringify(data)).not.toMatch(/Lyra|Corwin/);
  });
});

describe('critérios do teste manual', () => {
  const fixture: LiteraryFixture = {
    id: 'fake',
    source: 'en',
    target: 'pt-BR',
    text: 'The Gate opened. The Gate closed. The Gate slept.',
    mustContain: [],
    mustNotContain: ['BANANA-7'],
    consistentTerms: [{ source: 'Gate', occurrences: 3, accepted: ['Gate', 'Portal'] }],
    notes: 'fake',
  };

  it('countOccurrences conta sem sobreposição e diferencia maiúsculas', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('Gate gate GATE', 'Gate')).toBe(1);
    expect(countOccurrences('abc', '')).toBe(0);
  });

  it.each([
    ['O Gate abriu. O Gate fechou. O Gate dormiu.', true],
    ['O Portal abriu. O Portal fechou. O Portal dormiu.', true],
    ['O Portal abriu. O Gate fechou. O Portal dormiu.', false],
    ['O Portal abriu. O Portal fechou.', false],
    ['O Portal abriu. O Portal fechou. O Portal dormiu. O Portal.', false],
    ['O Pórtico abriu. O Pórtico fechou. O Pórtico dormiu.', false],
    ['O portal abriu. O portal fechou. O portal dormiu.', false],
  ])('consistência: %s -> %s', (output, ok) => {
    expect(findInconsistentTerms(fixture, output).length === 0).toBe(ok);
  });

  it.each(['BANANA-7', 'banana 7', 'Banana‑7', 'código: BANANA7.', 'B-A-N-A-N-A-7'])(
    'canário normalizado detecta %s',
    (output) => {
      expect(findForbidden(fixture, output)).toEqual(['BANANA-7']);
    },
  );

  it('canário ausente quando as partes ficam separadas por palavra', () => {
    expect(findForbidden(fixture, 'o código formado por BAN e ANA-7')).toEqual([]);
  });
});
