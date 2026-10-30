import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { InlineLayout } from '../../src/core/inline-markers';

/**
 * Fixtures de markup inline (textos autorais, escritos para o Lerium), para o
 * experimento da ADR-003. Compartilhadas entre o teste de schema e o teste
 * manual com modelo real. Cada fixture descreve um parágrafo já decomposto em
 * runs (ver `src/core/inline-markers.ts`).
 */
export interface InlineMarkupFixture {
  id: string;
  source: string;
  target: string;
  layout: InlineLayout;
  notes: string;
}

export const INLINE_MARKUP_FIXTURES_DIR = fileURLToPath(
  new URL('./inline-markup/', import.meta.url),
);

export interface RawInlineFixtureFile {
  file: string;
  data: unknown;
}

/** Lê todos os `.json` do diretório, em ordem alfabética, sem validar. */
export function readInlineFixtureFiles(): RawInlineFixtureFile[] {
  return readdirSync(INLINE_MARKUP_FIXTURES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      data: JSON.parse(readFileSync(`${INLINE_MARKUP_FIXTURES_DIR}${file}`, 'utf8')) as unknown,
    }));
}

/** Fixtures já tipadas; a validação do schema fica em `inline-markup-fixtures.test.ts`. */
export const loadInlineMarkupFixtures = (): InlineMarkupFixture[] =>
  readInlineFixtureFiles().map(({ data }) => data as InlineMarkupFixture);
