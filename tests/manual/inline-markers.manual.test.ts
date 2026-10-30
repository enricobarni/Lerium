import { afterAll, describe, expect, it } from 'vitest';
import {
  countMarkerSyntax,
  decodeMarkers,
  encodeMarkers,
  validateInlineLayout,
} from '../../src/core/inline-markers';
import { createOllamaTranslationProvider } from '../../src/core/ollama-translation-provider';
import type { TranslationErrorKind } from '../../src/core/translation-provider';
import type { LanguageCode } from '../../src/core/types';
import { loadInlineMarkupFixtures } from '../fixtures/inline-markup-fixtures';

/**
 * Experimento manual opt-in da ADR-003 (marcadores inline) com o modelo real.
 * Só roda com `LERIUM_MANUAL_OLLAMA=1`; sem a variável fica `skipped`.
 *
 * Para cada (fixture, execução): codifica o layout no formato `<g1>…</g1>`,
 * traduz o texto codificado com o prompt v1 sem mudanças e decodifica a
 * saída. É um experimento: decode inválido é resultado, não falha. O teste
 * só falha por erro de infraestrutura (Ollama fora do ar, modelo ausente,
 * configuração).
 *
 * Variáveis (as mesmas de `real-model.manual.test.ts`):
 * - `LERIUM_OLLAMA_ENDPOINT` (padrão `http://127.0.0.1:11434`);
 * - `LERIUM_OLLAMA_MODEL` (padrão `translategemma:4b`);
 * - `LERIUM_MANUAL_RUNS` execuções por fixture (padrão 1);
 * - `LERIUM_MANUAL_SHOW_OUTPUT=1` imprime a saída do modelo e os textos
 *   decodificados (as fixtures são autorais; por padrão só metadados).
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

// Mesmo critério de preâmbulo de `real-model.manual.test.ts`.
const PREAMBLE = /^\s*(here is|here's|sure|translation:|tradução:|aqui está|claro[,!])/i;

/** Falhas atribuídas ao modelo (resultado do experimento), não à infraestrutura. */
const MODEL_ERRORS: ReadonlySet<TranslationErrorKind> = new Set(['truncated', 'empty_response']);

type Outcome = 'encode_null' | 'provider_error' | 'decode_ok' | `decode_${string}`;

const tally = new Map<Outcome, number>();
const record = (outcome: Outcome): void => {
  tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
};

describe.skipIf(!ENABLED)(`marcadores inline com modelo real (${MODEL})`, () => {
  const provider = createOllamaTranslationProvider({
    endpoint: ENDPOINT,
    model: MODEL,
    fetchFn: (input, init) => fetch(input, init),
  });

  const cases = loadInlineMarkupFixtures().flatMap((fixture) =>
    Array.from({ length: RUNS }, (_, index) => ({ fixture, run: index + 1 })),
  );

  afterAll(() => {
    // Resumo agregado: taxa de decode válido entre as execuções que chegaram
    // ao modelo com sucesso.
    const counts = Object.fromEntries(tally);
    const decoded = Object.entries(counts)
      .filter(([outcome]) => outcome.startsWith('decode_'))
      .reduce((sum, [, count]) => sum + count, 0);
    const valid = counts.decode_ok ?? 0;
    console.log(
      JSON.stringify({
        summary: 'xml_g',
        decodeValidRate: decoded === 0 ? null : Number((valid / decoded).toFixed(2)),
        decoded,
        outcomes: counts,
      }),
    );
  });

  // Um `it` por (fixture, execução): o `testTimeout` vale por chamada.
  for (const { fixture, run } of cases) {
    it(`${fixture.id} #${run}`, async () => {
      const base = { id: fixture.id, run };
      const validation = validateInlineLayout(fixture.layout);
      const markers = validation.ok ? validation.wrappers : 0;
      const encoded = encodeMarkers(fixture.layout);
      if (encoded === null) {
        record('encode_null');
        console.log(JSON.stringify({ ...base, encode: 'encode_null', markers }));
        return;
      }

      const result = await provider.translate({
        text: encoded,
        source: fixture.source as LanguageCode,
        target: fixture.target as LanguageCode,
      });

      if (!result.ok) {
        console.log(
          JSON.stringify({
            ...base,
            providerOk: false,
            providerError: result.error,
            status: result.status,
            markers,
          }),
        );
        if (!MODEL_ERRORS.has(result.error)) {
          expect.fail(`${fixture.id} #${run}: ${result.error}`);
        }
        record('provider_error');
        return;
      }

      const decoded = decodeMarkers(result.text, fixture.layout);
      record(decoded.ok ? 'decode_ok' : `decode_${decoded.error}`);
      // `leaks`: em sucesso, marcadores nos textos decodificados (deve ser 0);
      // em falha, marcadores que vazariam se a saída fosse usada sem decodificar.
      const leaks = decoded.ok
        ? countMarkerSyntax(decoded.texts.join(''))
        : countMarkerSyntax(result.text);
      console.log(
        JSON.stringify({
          ...base,
          providerOk: true,
          decodeOk: decoded.ok,
          decodeError: decoded.ok ? undefined : decoded.error,
          markers,
          outputMarkerTokens: countMarkerSyntax(result.text),
          durationMs: result.durationMs,
          leaks,
          noPreamble: !PREAMBLE.test(result.text),
        }),
      );
      if (SHOW_OUTPUT) {
        const texts = decoded.ok ? JSON.stringify(decoded.texts) : '(decode inválido)';
        console.log(`--- ${fixture.id} #${run} ---\n${result.text}\n${texts}\n---`);
      }

      // Invariante do codec, não do modelo: nada de marcador nos textos.
      if (decoded.ok) expect(leaks).toBe(0);
    });
  }
});
