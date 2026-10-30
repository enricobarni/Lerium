import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Fixtures literárias próprias (textos autorais, escritos para o Lerium).
 * Compartilhadas entre o teste de schema e o teste manual com modelo real.
 */

/**
 * Termo que deve ser renderizado de forma consistente. `occurrences` é o
 * número de vezes que `source` aparece no texto de origem; `accepted` lista as
 * renderizações aprovadas (inclui o próprio `source`, para quem o preserva).
 */
export interface ConsistentTerm {
  source: string;
  occurrences: number;
  accepted: string[];
}

export interface LiteraryFixture {
  id: string;
  source: string;
  target: string;
  text: string;
  mustContain: string[];
  mustNotContain: string[];
  /** Razão mínima `saída/original` em caracteres; padrão `DEFAULT_MIN_LENGTH_RATIO`. */
  minLengthRatio?: number;
  consistentTerms?: ConsistentTerm[];
  reference?: string;
  notes: string;
}

/** Razão mínima de comprimento quando a fixture não define `minLengthRatio`. */
export const DEFAULT_MIN_LENGTH_RATIO = 0.6;
/** Razão máxima de comprimento, comum a todas as fixtures. */
export const MAX_LENGTH_RATIO = 2.0;

export const LITERARY_FIXTURES_DIR = fileURLToPath(new URL('./literary/', import.meta.url));

export interface RawFixtureFile {
  file: string;
  data: unknown;
}

/** Lê todos os `.json` do diretório, em ordem alfabética, sem validar. */
export function readFixtureFiles(): RawFixtureFile[] {
  return readdirSync(LITERARY_FIXTURES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      data: JSON.parse(readFileSync(`${LITERARY_FIXTURES_DIR}${file}`, 'utf8')) as unknown,
    }));
}

/** Fixtures já tipadas; a validação do schema fica em `literary-fixtures.test.ts`. */
export const loadLiteraryFixtures = (): LiteraryFixture[] =>
  readFixtureFiles().map(({ data }) => data as LiteraryFixture);

/** Razão mínima efetiva da fixture. */
export const minLengthRatioOf = (fixture: LiteraryFixture): number =>
  fixture.minLengthRatio ?? DEFAULT_MIN_LENGTH_RATIO;

/** Ocorrências não sobrepostas de `needle` em `haystack`, case-sensitive. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    count += 1;
  }
  return count;
}

/**
 * Normaliza para comparar canários: maiúsculas e só `A-Z0-9`. Assim
 * `BANANA-7`, `banana 7` e `BANANA‑7` (hífen não ASCII) coincidem.
 */
export const normalizeCanary = (value: string): string =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Canários de `mustNotContain` presentes na saída, comparados normalizados. */
export const findForbidden = (fixture: LiteraryFixture, output: string): string[] => {
  const normalized = normalizeCanary(output);
  return fixture.mustNotContain.filter((term) => normalized.includes(normalizeCanary(term)));
};

export interface TermCount {
  source: string;
  /** Contagem de cada renderização aceita na saída, na ordem de `accepted`. */
  counts: Record<string, number>;
}

/**
 * Termos inconsistentes na saída. Um termo passa se exatamente uma das
 * renderizações `accepted` aparece exatamente `occurrences` vezes e nenhuma
 * outra aparece (contagem case-sensitive). Renderização nova, fora da lista,
 * falha e exige revisão humana.
 */
export function findInconsistentTerms(fixture: LiteraryFixture, output: string): TermCount[] {
  const failures: TermCount[] = [];
  for (const term of fixture.consistentTerms ?? []) {
    const counts: Record<string, number> = {};
    for (const rendering of term.accepted) counts[rendering] = countOccurrences(output, rendering);
    const used = Object.values(counts).filter((count) => count > 0);
    const consistent = used.length === 1 && used[0] === term.occurrences;
    if (!consistent) failures.push({ source: term.source, counts });
  }
  return failures;
}
