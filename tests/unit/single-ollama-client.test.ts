import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guarda de arquitetura (ADR-009): o service worker é o único cliente HTTP do
 * Ollama e o provider de tradução é o único consumidor de `chatStream`.
 *
 * Heurística textual, não análise semântica: varre `src/` sem comentários com
 * expressões regulares. Pega referências diretas (`fetch(`, `globalThis.fetch`,
 * `const f = fetch`, `'fetch'`) e as APIs de rede alternativas; não pega
 * acesso ofuscado (ex.: `self['fe' + 'tch']`). Serve de alarme para regressões
 * comuns, não de prova.
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
/**
 * Qualquer referência ao identificador `fetch` (chamada, leitura, string), não
 * a `fetchFn` nem a uma chave de objeto `fetch:`.
 */
const REFERENCES_FETCH = /\bfetch\b(?!\s*:)/;
/**
 * Allowlist de referências de tipo: `: typeof fetch` em anotação só descreve
 * a assinatura da dependência injetada e não chama nada. É removida antes da
 * varredura; não cobre `typeof fetch` em expressão (ex.: `=== 'function'`),
 * que continua contando como referência.
 */
const FETCH_TYPE_ANNOTATION = /:\s*typeof\s+fetch\b/g;
/** Arquivos que hoje usam `: typeof fetch`; um novo exige revisão consciente. */
const FETCH_TYPE_FILES = [
  'src/background/message-router.ts',
  'src/core/ollama-client.ts',
  'src/core/ollama-translation-provider.ts',
];
/** APIs de rede que contornariam o cliente único; proibidas em todo `src/`. */
const OTHER_NETWORK_APIS = /\b(XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/;

const withoutFetchTypes = (code: string): string => code.replace(FETCH_TYPE_ANNOTATION, ':');

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

  it('fetch só é referenciado no service worker', () => {
    const referrers = sources
      .filter(({ code }) => REFERENCES_FETCH.test(withoutFetchTypes(code)))
      .map(({ file }) => file);
    expect(referrers).toEqual([FETCH_CALLER]);
  });

  it('referências de tipo a fetch ficam só nos arquivos da allowlist', () => {
    const typed = sources
      .filter(({ code }) => new RegExp(FETCH_TYPE_ANNOTATION.source).test(code))
      .map(({ file }) => file)
      .sort();
    expect(typed).toEqual([...FETCH_TYPE_FILES].sort());
  });

  it('nenhuma API de rede alternativa em src/', () => {
    const offenders = sources
      .filter(({ code }) => OTHER_NETWORK_APIS.test(code))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it.each([
    'fetch(url)',
    'const f = fetch;',
    'globalThis.fetch(url)',
    "self['fetch'](url)",
    'await fetch\n(url)',
    'const t: typeof fetch = fetch;',
    'if (typeof fetch === "function") {}',
  ])('heurística detecta referência a fetch: %s', (code) => {
    expect(REFERENCES_FETCH.test(withoutFetchTypes(code))).toBe(true);
  });

  it.each([
    'fetchFn(url)',
    'const prefetch = 1;',
    'const o = { fetch: fn };',
    'type T = { fetchFn: typeof fetch };',
  ])('heurística ignora o que não é referência a fetch: %s', (code) => {
    expect(REFERENCES_FETCH.test(withoutFetchTypes(code))).toBe(false);
  });

  it.each([
    'new XMLHttpRequest()',
    'new WebSocket(u)',
    'new EventSource(u)',
    'navigator.sendBeacon(u)',
  ])('heurística detecta API de rede alternativa: %s', (code) => {
    expect(OTHER_NETWORK_APIS.test(code)).toBe(true);
  });

  it('a remoção de comentários preserva URLs e ignora menções em comentário', () => {
    const code = stripComments(
      "// fetch(url)\n/* chatStream() */\nconst u = 'http://localhost';\nconst a = 1; // fetch(x)",
    );
    expect(code).toContain('http://localhost');
    expect(REFERENCES_FETCH.test(code)).toBe(false);
    expect(MENTIONS_CHAT_STREAM.test(code)).toBe(false);
  });
});
