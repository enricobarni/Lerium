/**
 * Parser incremental de NDJSON (JSON delimitado por `\n`), usado na resposta
 * em streaming do Ollama. Módulo puro: sem DOM e sem `chrome`.
 *
 * - Os bytes são decodificados com `TextDecoder` em modo `stream`, então uma
 *   sequência UTF-8 dividida entre chunks é remontada corretamente.
 * - Separador `\n`; um `\r` final (CRLF) é removido; linhas vazias ou só com
 *   espaços são ignoradas.
 * - Não interpreta o domínio: `done`, `error` etc. do Ollama ficam a cargo do
 *   cliente. Cada linha vira `{ ok: true, value }` ou um código de erro.
 * - Proteção de memória: uma linha acima de `maxLineLength` gera um único
 *   `line_too_long` e o restante dela é descartado até o próximo `\n`.
 *
 * Uso: chame `push` para cada chunk e `end` uma vez ao fim do corpo, para
 * processar a última linha sem `\n`. Depois de `end`, `push` e `end` lançam
 * `Error` (erro de programação, não de dados).
 */
export type NdjsonErrorKind = 'invalid_json' | 'line_too_long';

export type ParsedLine = { ok: true; value: unknown } | { ok: false; error: NdjsonErrorKind };

export interface NdjsonParser {
  push(chunk: Uint8Array): ParsedLine[];
  end(): ParsedLine[];
}

export interface NdjsonParserOptions {
  /** Tamanho máximo de uma linha, em unidades UTF-16, sem o `\r\n`. */
  maxLineLength?: number;
}

/** 1 MiB de unidades UTF-16 por linha; respostas do Ollama ficam muito abaixo. */
export const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024;

const parseLine = (line: string): ParsedLine => {
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
};

export const createNdjsonParser = (options: NdjsonParserOptions = {}): NdjsonParser => {
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  if (!Number.isInteger(maxLineLength) || maxLineLength < 1) {
    throw new RangeError('maxLineLength deve ser um inteiro positivo');
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  // Verdadeiro enquanto o resto de uma linha longa é descartado até o `\n`.
  let discarding = false;
  let ended = false;

  const emitLine = (raw: string, out: ParsedLine[]): void => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') return;
    if (line.length > maxLineLength) {
      out.push({ ok: false, error: 'line_too_long' });
      return;
    }
    out.push(parseLine(line));
  };

  const consume = (text: string, out: ParsedLine[]): void => {
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline === -1) break;
      if (discarding) {
        discarding = false;
      } else {
        emitLine(buffer + text.slice(start, newline), out);
      }
      buffer = '';
      start = newline + 1;
    }
    if (discarding) return;
    buffer += text.slice(start);
    // +1 deixa espaço para um `\r` final ainda sem o `\n` correspondente.
    if (buffer.length > maxLineLength + 1) {
      out.push({ ok: false, error: 'line_too_long' });
      buffer = '';
      discarding = true;
    }
  };

  const assertOpen = (): void => {
    if (ended) throw new Error('NdjsonParser já finalizado com end()');
  };

  return {
    push(chunk) {
      assertOpen();
      const out: ParsedLine[] = [];
      if (chunk.byteLength > 0) consume(decoder.decode(chunk, { stream: true }), out);
      return out;
    },
    end() {
      assertOpen();
      ended = true;
      const out: ParsedLine[] = [];
      consume(decoder.decode(), out);
      if (!discarding) emitLine(buffer, out);
      buffer = '';
      discarding = false;
      return out;
    },
  };
};
