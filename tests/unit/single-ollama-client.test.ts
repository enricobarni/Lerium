import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guarda de arquitetura (ADR-009): o service worker é o único cliente HTTP do
 * Ollama e o provider de tradução é o único consumidor de `chatStream`.
 * Varredura textual simples de `src/`, sem comentários.
 */

const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));

const CHAT_STREAM_DEFINITION = 'src/core/ollama-client.ts';
const CHAT_STREAM_CONSUMER = 'src/core/ollama-translation-provider.ts';
const FETCH_CALLER = 'src/background/index.ts';

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Remove comentários de bloco e de linha. O `//` precedido de `:` é mantido
 * para não cortar URLs (`http://`). Suficiente para o código do projeto.
 */
const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const sources = listSourceFiles(SRC_DIR).map((path) => ({
  file: `src/${relative(SRC_DIR, path).split(sep).join('/')}`,
  code: stripComments(readFileSync(path, 'utf8')),
}));

const IMPORTS_CHAT_STREAM = /import\s*(?:type\s*)?\{[^}]*\bchatStream\b[^}]*\}\s*from/;
const MENTIONS_CHAT_STREAM = /\bchatStream\b/;
const CALLS_FETCH = /\bfetch\s*\(/;

describe('cliente único do Ollama em src/', () => {
  it('encontra os arquivos de src/', () => {
    const files = sources.map(({ file }) => file);
    expect(files).toContain(CHAT_STREAM_DEFINITION);
    expect(files).toContain(CHAT_STREAM_CONSUMER);
    expect(files).toContain(FETCH_CALLER);
  });

  it('só o provider de tradução importa chatStream', () => {
    const importers = sources
      .filter(({ code }) => IMPORTS_CHAT_STREAM.test(code))
      .map(({ file }) => file);
    expect(importers).toEqual([CHAT_STREAM_CONSUMER]);
  });

  it('chatStream não é referenciado fora da definição e do provider', () => {
    const mentions = sources
      .filter(({ code }) => MENTIONS_CHAT_STREAM.test(code))
      .map(({ file }) => file)
      .sort();
    expect(mentions).toEqual([CHAT_STREAM_DEFINITION, CHAT_STREAM_CONSUMER].sort());
  });

  it('fetch( só é chamado no service worker', () => {
    const callers = sources.filter(({ code }) => CALLS_FETCH.test(code)).map(({ file }) => file);
    expect(callers).toEqual([FETCH_CALLER]);
  });

  it('a remoção de comentários preserva URLs e ignora menções em comentário', () => {
    const code = stripComments(
      "// fetch(url)\n/* chatStream() */\nconst u = 'http://localhost';\nconst a = 1; // fetch(x)",
    );
    expect(code).toContain('http://localhost');
    expect(CALLS_FETCH.test(code)).toBe(false);
    expect(MENTIONS_CHAT_STREAM.test(code)).toBe(false);
  });
});
