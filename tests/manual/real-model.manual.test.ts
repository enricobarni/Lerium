import { describe, expect, it } from 'vitest';
import { createOllamaTranslationProvider } from '../../src/core/ollama-translation-provider';
import type { LanguageCode } from '../../src/core/types';
import {
  findForbidden,
  findInconsistentTerms,
  loadLiteraryFixtures,
  MAX_LENGTH_RATIO,
  minLengthRatioOf,
  type LiteraryFixture,
  type TermCount,
} from '../fixtures/literary-fixtures';

/**
 * Teste manual opt-in com o modelo real (Fase 3). Só roda com
 * `LERIUM_MANUAL_OLLAMA=1`; sem a variável fica `skipped`.
 *
 * Variáveis:
 * - `LERIUM_OLLAMA_ENDPOINT` (padrão `http://127.0.0.1:11434`);
 * - `LERIUM_OLLAMA_MODEL` (padrão `translategemma:4b`);
 * - `LERIUM_MANUAL_RUNS` execuções por fixture (padrão 1); cada execução é
 *   um `it` próprio, para que o `testTimeout` valha por execução;
 * - `LERIUM_MANUAL_SHOW_OUTPUT=1` imprime a tradução (as fixtures são
 *   autorais; por padrão só metadados são impressos).
 */

const ENABLED = process.env.LERIUM_MANUAL_OLLAMA === '1';
const ENDPOINT = process.env.LERIUM_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434';
const MODEL = process.env.LERIUM_OLLAMA_MODEL ?? 'translategemma:4b';
const SHOW_OUTPUT = process.env.LERIUM_MANUAL_SHOW_OUTPUT === '1';

const parseRuns = (value: string | undefined): number => {
  const runs = Number(value);
  return Number.isInteger(runs) && runs >= 1 ? runs : 1;
};
const RUNS = parseRuns(process.env.LERIUM_MANUAL_RUNS);

const PREAMBLE = /^\s*(here is|here's|sure|translation:|tradução:|aqui está|claro[,!])/i;
const PT_STOPWORDS = new Set(['que', 'não', 'de', 'uma', 'com', 'para', 'o', 'a']);
const EN_STOPWORDS = new Set(['the', 'and', 'of', 'to', 'was']);

const countStopwords = (text: string, stopwords: ReadonlySet<string>): number =>
  (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter((word) => stopwords.has(word)).length;

interface Criteria {
  noPreamble: boolean;
  missing: string[];
  forbidden: string[];
  inconsistent: TermCount[];
  lengthRatio: number;
  minLengthRatio: number;
  ptStopwords: number;
  enStopwords: number;
}

function evaluate(fixture: LiteraryFixture, output: string): Criteria {
  return {
    noPreamble: !PREAMBLE.test(output),
    missing: fixture.mustContain.filter((term) => !output.includes(term)),
    // Canários comparados normalizados (maiúsculas, só A-Z0-9).
    forbidden: findForbidden(fixture, output),
    inconsistent: findInconsistentTerms(fixture, output),
    lengthRatio: Number((output.length / fixture.text.length).toFixed(2)),
    minLengthRatio: minLengthRatioOf(fixture),
    ptStopwords: countStopwords(output, PT_STOPWORDS),
    enStopwords: countStopwords(output, EN_STOPWORDS),
  };
}

describe.skipIf(!ENABLED)(`modelo real (${MODEL})`, () => {
  const provider = createOllamaTranslationProvider({
    endpoint: ENDPOINT,
    model: MODEL,
    fetchFn: (input, init) => fetch(input, init),
  });

  const cases = loadLiteraryFixtures().flatMap((fixture) =>
    Array.from({ length: RUNS }, (_, index) => ({ fixture, run: index + 1 })),
  );

  // Um `it` por (fixture, execução): o `testTimeout` vale por chamada ao modelo.
  for (const { fixture, run } of cases) {
    it(`${fixture.id} #${run}`, async () => {
      const result = await provider.translate({
        text: fixture.text,
        source: fixture.source as LanguageCode,
        target: fixture.target as LanguageCode,
      });

      if (!result.ok) {
        console.log(
          JSON.stringify({
            id: fixture.id,
            run,
            ok: false,
            error: result.error,
            status: result.status,
          }),
        );
        expect.fail(`${fixture.id} #${run}: ${result.error}`);
      }

      const criteria = evaluate(fixture, result.text);
      console.log(
        JSON.stringify({
          id: fixture.id,
          run,
          ok: true,
          durationMs: result.durationMs,
          outputTokens: result.outputTokens,
          ...criteria,
        }),
      );
      if (SHOW_OUTPUT) console.log(`--- ${fixture.id} #${run} ---\n${result.text}\n---`);

      expect(result.text.trim()).not.toBe('');
      expect(criteria.noPreamble).toBe(true);
      expect(criteria.missing).toEqual([]);
      expect(criteria.forbidden).toEqual([]);
      expect(criteria.inconsistent).toEqual([]);
      expect(criteria.lengthRatio).toBeGreaterThanOrEqual(criteria.minLengthRatio);
      expect(criteria.lengthRatio).toBeLessThanOrEqual(MAX_LENGTH_RATIO);
      expect(criteria.ptStopwords).toBeGreaterThan(criteria.enStopwords);
    });
  }
});
