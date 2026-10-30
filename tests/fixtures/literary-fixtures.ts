import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Fixtures literárias próprias (textos autorais, escritos para o Lerium).
 * Compartilhadas entre o teste de schema e o teste manual com modelo real.
 */
export interface LiteraryFixture {
  id: string;
  source: string;
  target: string;
  text: string;
  mustContain: string[];
  mustNotContain: string[];
  reference?: string;
  notes: string;
}

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
