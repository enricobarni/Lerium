import { describe, expect, it } from 'vitest';
import { createOllamaTranslationProvider } from '../../src/core/ollama-translation-provider';
import type { TranslationErrorKind, TranslationInput } from '../../src/core/translation-provider';
import type { LanguageCode } from '../../src/core/types';
import { normalizeEndpoint } from '../../src/shared/validation';
import { loadLiteraryFixtures, type LiteraryFixture } from '../fixtures/literary-fixtures';

/**
 * Experimento manual opt-in: concorrência de traduções no Ollama em CPU.
 * Só roda com `LERIUM_MANUAL_OLLAMA=1`; sem a variável fica `skipped`.
 *
 * Objetivo: escolher o limite L de traduções simultâneas da extensão. Para
 * cada concorrência c, um pool mantém até c chamadas ao provedor real
 * (`createOllamaTranslationProvider` com o `fetch` global e os prazos padrão
 * da extensão) sobre uma carga fixa de 8 unidades. Falhas (prazo, rede) são
 * resultado do experimento; o teste só falha por erro de infraestrutura
 * (configuração, modelo ausente, endpoint recusado).
 *
 * Privacidade: só metadados são impressos (tempos, contagens, códigos de
 * erro). Nunca o texto das fixtures nem a saída do modelo.
 *
 * Variáveis:
 * - `LERIUM_OLLAMA_ENDPOINT` (padrão `http://127.0.0.1:11434`; só loopback);
 * - `LERIUM_OLLAMA_MODEL` (padrão `translategemma:4b`);
 * - `LERIUM_BENCH_CONCURRENCY` lista de c separada por vírgula (padrão `1,2,4`);
 * - `LERIUM_BENCH_REPEATS` rodadas medidas por c (padrão 3);
 * - `LERIUM_BENCH_SERVER_PARALLEL` só rótulo da configuração do servidor
 *   (`unset`, `1`, `2`, `4`...); padrão `unset`. Não altera nada no Ollama.
 *
 * Como subir um Ollama isolado (porta 11998) só para o experimento. As
 * variáveis valem apenas no processo filho; a sessão atual e o Ollama da
 * porta 11434 não são alterados. O diretório de modelos é o padrão, então o
 * modelo já baixado é reaproveitado.
 *
 * PowerShell (configuração "unset": sem `OLLAMA_NUM_PARALLEL`):
 *   pwsh -NoProfile -Command { Remove-Item Env:OLLAMA_NUM_PARALLEL -ErrorAction SilentlyContinue; $env:OLLAMA_HOST = '127.0.0.1:11998'; ollama serve }
 * PowerShell (com `OLLAMA_NUM_PARALLEL=<n>`, ex.: 2):
 *   pwsh -NoProfile -Command { $env:OLLAMA_HOST = '127.0.0.1:11998'; $env:OLLAMA_NUM_PARALLEL = '2'; ollama serve }
 * Em outro terminal PowerShell, rode só este arquivo:
 *   pwsh -NoProfile -Command { $env:LERIUM_MANUAL_OLLAMA = '1'; $env:LERIUM_OLLAMA_ENDPOINT = 'http://127.0.0.1:11998'; $env:LERIUM_BENCH_SERVER_PARALLEL = 'unset'; npx vitest run --config vitest.manual.config.ts tests/manual/concurrency.manual.test.ts }
 *
 * bash (configuração "unset"):
 *   env -u OLLAMA_NUM_PARALLEL OLLAMA_HOST=127.0.0.1:11998 ollama serve
 * bash (com `OLLAMA_NUM_PARALLEL=<n>`, ex.: 2):
 *   OLLAMA_HOST=127.0.0.1:11998 OLLAMA_NUM_PARALLEL=2 ollama serve
 * Em outro terminal bash:
 *   LERIUM_MANUAL_OLLAMA=1 LERIUM_OLLAMA_ENDPOINT=http://127.0.0.1:11998 LERIUM_BENCH_SERVER_PARALLEL=unset npx vitest run --config vitest.manual.config.ts tests/manual/concurrency.manual.test.ts
 *
 * Saída: uma linha JSON por rodada (`round`) e uma de resumo por c
 * (`summary`) com as MEDIANAS das rodadas; `failures` do resumo é a SOMA das
 * falhas de todas as rodadas daquele c (critério conservador).
 *
 * Critério de decisão (na configuração "unset", a que o usuário terá por
 * padrão): L é o MENOR c > 1 tal que, nas medianas,
 *   - `totalMs` é pelo menos 15% menor que o de c=1 (total <= 0,85 x c1);
 *   - `firstMs` é no máximo 25% maior que o de c=1 (first <= 1,25 x c1);
 *   - `failures` é 0.
 * Se nenhum c atender, L = 1.
 */

const ENABLED = process.env.LERIUM_MANUAL_OLLAMA === '1';
// Mesmo validador da extensão: só loopback (RF01/RF07). Falha cedo, antes de
// qualquer requisição, se o endpoint não for aceito.
const ENDPOINT_CHECK = normalizeEndpoint(
  process.env.LERIUM_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434',
);
if (ENABLED && !ENDPOINT_CHECK.ok) {
  throw new Error(`LERIUM_OLLAMA_ENDPOINT recusado (${ENDPOINT_CHECK.reason}): use loopback`);
}
const ENDPOINT = ENDPOINT_CHECK.ok ? ENDPOINT_CHECK.value : '';
const MODEL = process.env.LERIUM_OLLAMA_MODEL ?? 'translategemma:4b';
const SERVER_PARALLEL = process.env.LERIUM_BENCH_SERVER_PARALLEL ?? 'unset';

const isPositiveInt = (value: number): boolean => Number.isInteger(value) && value >= 1;

/** Lista de concorrências; valor inválido falha cedo (só com o teste ativo). */
function parseConcurrency(value: string | undefined): number[] {
  const raw = value === undefined || value.trim() === '' ? '1,2,4' : value;
  const list = raw.split(',').map((item) => Number(item.trim()));
  if (ENABLED && !list.every(isPositiveInt)) {
    throw new Error('LERIUM_BENCH_CONCURRENCY inválido: use inteiros >= 1 separados por vírgula');
  }
  return [...new Set(list.filter(isPositiveInt))];
}

function parseRepeats(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 3;
  const repeats = Number(value);
  if (ENABLED && !isPositiveInt(repeats)) {
    throw new Error('LERIUM_BENCH_REPEATS inválido: use um inteiro >= 1');
  }
  return isPositiveInt(repeats) ? repeats : 3;
}

const CONCURRENCY = parseConcurrency(process.env.LERIUM_BENCH_CONCURRENCY);
const REPEATS = parseRepeats(process.env.LERIUM_BENCH_REPEATS);

/** Até 30 min por c (aquecimento + todas as rodadas). */
const TIMEOUT_PER_CONCURRENCY_MS = 30 * 60_000;

/** As 6 fixtures (ordem alfabética) + 2 repetidas, sempre na mesma ordem. */
const REPEATED_IDS = ['long-paragraph', 'narrative'] as const;

/** Erros de infraestrutura: invalidam o experimento em vez de medi-lo. */
const INFRA_ERRORS: ReadonlySet<TranslationErrorKind> = new Set([
  'invalid_config',
  'invalid_input',
  'model_missing',
  'forbidden',
  'internal_error',
  'consumer_error',
]);

function buildWorkload(fixtures: readonly LiteraryFixture[]): TranslationInput[] {
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const repeated = REPEATED_IDS.map((id) => {
    const fixture = byId.get(id);
    if (fixture === undefined) throw new Error(`fixture ausente na carga: ${id}`);
    return fixture;
  });
  return [...fixtures, ...repeated].map((fixture) => ({
    text: fixture.text,
    source: fixture.source as LanguageCode,
    target: fixture.target as LanguageCode,
  }));
}

/** Mediana; para tamanho par, média dos dois centrais. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface UnitOutcome {
  ok: boolean;
  error?: TranslationErrorKind;
  chars: number;
  latencyMs: number;
  finishedAtMs: number;
}

interface RoundMetrics {
  firstMs: number;
  totalMs: number;
  charsPerSec: number;
  p50Ms: number;
  maxMs: number;
  failures: number;
  failureCodes: Record<string, number>;
}

type Translate = (
  input: TranslationInput,
) => Promise<{ ok: boolean; error?: TranslationErrorKind }>;

/** Pool simples: até `concurrency` traduções simultâneas, na ordem da carga. */
async function runRound(
  translate: Translate,
  workload: readonly TranslationInput[],
  concurrency: number,
): Promise<{ metrics: RoundMetrics; outcomes: UnitOutcome[] }> {
  const outcomes: UnitOutcome[] = [];
  const roundStart = performance.now();
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < workload.length) {
      const unit = workload[next]!;
      next += 1;
      const unitStart = performance.now();
      const result = await translate(unit);
      const end = performance.now();
      outcomes.push({
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
        chars: unit.text.length,
        latencyMs: end - unitStart,
        finishedAtMs: end - roundStart,
      });
    }
  };

  const workers = Math.min(concurrency, workload.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  const totalMs = performance.now() - roundStart;

  const failureCodes: Record<string, number> = {};
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      const code = outcome.error ?? 'unknown';
      failureCodes[code] = (failureCodes[code] ?? 0) + 1;
    }
  }
  const okChars = outcomes.filter((o) => o.ok).reduce((sum, o) => sum + o.chars, 0);
  const latencies = outcomes.map((o) => o.latencyMs);

  return {
    outcomes,
    metrics: {
      firstMs: Math.round(Math.min(...outcomes.map((o) => o.finishedAtMs))),
      totalMs: Math.round(totalMs),
      // Só caracteres de unidades traduzidas com sucesso contam como vazão.
      charsPerSec: Number((okChars / (totalMs / 1000)).toFixed(1)),
      p50Ms: Math.round(median(latencies)),
      maxMs: Math.round(Math.max(...latencies)),
      failures: outcomes.filter((o) => !o.ok).length,
      failureCodes,
    },
  };
}

describe.skipIf(!ENABLED)(`concorrência no Ollama (${MODEL}, servidor ${SERVER_PARALLEL})`, () => {
  const provider = createOllamaTranslationProvider({
    endpoint: ENDPOINT,
    model: MODEL,
    fetchFn: (input, init) => fetch(input, init),
  });
  const translate: Translate = (input) => provider.translate(input);
  const workload = buildWorkload(loadLiteraryFixtures());

  for (const concurrency of CONCURRENCY) {
    it(
      `c=${concurrency} (${REPEATS} rodadas, ${workload.length} unidades)`,
      async () => {
        // Aquecimento descartado: carrega o modelo e estabiliza caches.
        const warmup = await translate(workload[0]!);
        console.log(
          JSON.stringify({
            warmup: true,
            serverParallel: SERVER_PARALLEL,
            concurrency,
            ok: warmup.ok,
            ...(warmup.ok ? {} : { error: warmup.error }),
          }),
        );
        if (!warmup.ok && warmup.error !== undefined && INFRA_ERRORS.has(warmup.error)) {
          expect.fail(`aquecimento c=${concurrency}: ${warmup.error}`);
        }

        const rounds: RoundMetrics[] = [];
        for (let round = 1; round <= REPEATS; round += 1) {
          const { metrics, outcomes } = await runRound(translate, workload, concurrency);
          rounds.push(metrics);
          console.log(
            JSON.stringify({ round, serverParallel: SERVER_PARALLEL, concurrency, ...metrics }),
          );
          const infra = outcomes.find((o) => o.error !== undefined && INFRA_ERRORS.has(o.error));
          if (infra !== undefined) {
            expect.fail(`c=${concurrency} rodada ${round}: ${infra.error}`);
          }
        }

        console.log(
          JSON.stringify({
            summary: true,
            serverParallel: SERVER_PARALLEL,
            concurrency,
            firstMs: Math.round(median(rounds.map((r) => r.firstMs))),
            totalMs: Math.round(median(rounds.map((r) => r.totalMs))),
            charsPerSec: Number(median(rounds.map((r) => r.charsPerSec)).toFixed(1)),
            p50Ms: Math.round(median(rounds.map((r) => r.p50Ms))),
            maxMs: Math.round(median(rounds.map((r) => r.maxMs))),
            failures: rounds.reduce((sum, r) => sum + r.failures, 0),
          }),
        );
        expect(rounds).toHaveLength(REPEATS);
      },
      TIMEOUT_PER_CONCURRENCY_MS,
    );
  }
});
