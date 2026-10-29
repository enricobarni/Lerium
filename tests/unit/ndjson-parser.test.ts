import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_LINE_LENGTH,
  createNdjsonParser,
  type ParsedLine,
} from '../../src/core/ndjson-parser';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

/** PRNG determinístico (mulberry32) para partições reprodutíveis. */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const parseChunks = (chunks: Uint8Array[]): ParsedLine[] => {
  const parser = createNdjsonParser();
  const out: ParsedLine[] = [];
  for (const chunk of chunks) out.push(...parser.push(chunk));
  out.push(...parser.end());
  return out;
};

const splitAt = (data: Uint8Array, cuts: number[]): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const cut of cuts) {
    chunks.push(data.subarray(start, cut));
    start = cut;
  }
  chunks.push(data.subarray(start));
  return chunks;
};

const FIXTURE_OBJECTS: unknown[] = [
  { message: { role: 'assistant', content: 'Ação, coração, pão e maçã.' }, done: false },
  { message: { content: 'Emoji de 4 bytes: 😀🐉 e 👨‍👩‍👧' }, done: false },
  { message: { content: '日本語の小説、中文小说、한국어' }, done: false },
  { message: { content: 'linha um\nlinha dois\r\n"aspas" e \\ barra' }, done: false },
  { done: true, total_duration: 123, eval_count: 42 },
];

const FIXTURE_TEXT = FIXTURE_OBJECTS.map((o) => JSON.stringify(o)).join('\n') + '\n';
const FIXTURE_BYTES = bytes(FIXTURE_TEXT);
const EXPECTED: ParsedLine[] = FIXTURE_OBJECTS.map((value) => ({ ok: true, value }));

describe('createNdjsonParser', () => {
  it('parseia a fixture sem fragmentação', () => {
    expect(parseChunks([FIXTURE_BYTES])).toEqual(EXPECTED);
  });

  it('a fixture contém sequências multibyte de 2, 3 e 4 bytes', () => {
    expect(FIXTURE_TEXT).toMatch(/ç/u);
    expect(FIXTURE_TEXT).toMatch(/日/u);
    expect(FIXTURE_TEXT).toMatch(/\u{1F600}/u);
    // O \n dentro das strings é escapado no JSON, não um separador.
    expect(FIXTURE_TEXT.split('\n')).toHaveLength(FIXTURE_OBJECTS.length + 1);
  });

  it('produz o mesmo resultado para todo corte de bytes em 2 partes', () => {
    for (let cut = 0; cut <= FIXTURE_BYTES.length; cut++) {
      expect(parseChunks(splitAt(FIXTURE_BYTES, [cut])), `corte em ${cut}`).toEqual(EXPECTED);
    }
  });

  it('produz o mesmo resultado para 200 partições aleatórias em N partes', () => {
    const random = mulberry32(0x1e51a);
    for (let run = 0; run < 200; run++) {
      const parts = 2 + Math.floor(random() * 40);
      const cuts = Array.from({ length: parts - 1 }, () =>
        Math.floor(random() * (FIXTURE_BYTES.length + 1)),
      ).sort((a, b) => a - b);
      expect(parseChunks(splitAt(FIXTURE_BYTES, cuts)), `execução ${run}`).toEqual(EXPECTED);
    }
  });

  it('parseia byte a byte', () => {
    const chunks = Array.from(FIXTURE_BYTES, (b) => Uint8Array.of(b));
    expect(parseChunks(chunks)).toEqual(EXPECTED);
  });

  it('devolve vários objetos de um mesmo chunk, em ordem', () => {
    const parser = createNdjsonParser();
    expect(parser.push(bytes('{"a":1}\n{"b":2}\n{"c":3}\n'))).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } },
      { ok: true, value: { c: 3 } },
    ]);
    expect(parser.end()).toEqual([]);
  });

  it('só emite a linha quando o \\n chega', () => {
    const parser = createNdjsonParser();
    expect(parser.push(bytes('{"a":'))).toEqual([]);
    expect(parser.push(bytes('1}'))).toEqual([]);
    expect(parser.push(bytes('\n'))).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it('aceita CRLF, inclusive com \\r e \\n em chunks separados', () => {
    expect(parseChunks([bytes('{"a":1}\r\n{"b":2}\r'), bytes('\n')])).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } },
    ]);
  });

  it('ignora linhas vazias e só com espaços', () => {
    expect(parseChunks([bytes('\n\r\n   \n{"a":1}\n\t \n\n{"b":2}\n\n')])).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } },
    ]);
  });

  it('processa a última linha sem newline em end()', () => {
    const parser = createNdjsonParser();
    expect(parser.push(bytes('{"a":1}\n{"done":true}'))).toEqual([{ ok: true, value: { a: 1 } }]);
    expect(parser.end()).toEqual([{ ok: true, value: { done: true } }]);
  });

  it('faz flush do decoder em end() quando o último byte multibyte chega no fim', () => {
    const data = bytes('{"t":"é"}');
    expect(parseChunks(splitAt(data, [data.length - 3]))).toEqual([
      { ok: true, value: { t: 'é' } },
    ]);
  });

  it('marca JSON inválido e continua parseando as linhas seguintes', () => {
    expect(parseChunks([bytes('{"a":1}\n{quebrado\n{"b":2}\n')])).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: false, error: 'invalid_json' },
      { ok: true, value: { b: 2 } },
    ]);
  });

  it('marca JSON inválido na última linha sem newline', () => {
    expect(parseChunks([bytes('{"a":1}\n{"b":')])).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: false, error: 'invalid_json' },
    ]);
  });

  it('aceita chunk vazio sem efeito', () => {
    const parser = createNdjsonParser();
    expect(parser.push(new Uint8Array(0))).toEqual([]);
    expect(parser.push(bytes('{"a":1}'))).toEqual([]);
    expect(parser.push(new Uint8Array(0))).toEqual([]);
    expect(parser.end()).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it('end() sem dados devolve lista vazia', () => {
    expect(createNdjsonParser().end()).toEqual([]);
  });

  it('lança erro de uso em push ou end após end()', () => {
    const parser = createNdjsonParser();
    parser.end();
    expect(() => parser.push(bytes('{}\n'))).toThrow(/end/u);
    expect(() => parser.end()).toThrow(/end/u);
  });

  it('não interpreta o domínio: objetos de erro do Ollama são valores comuns', () => {
    expect(parseChunks([bytes('{"error":"model not found"}\n')])).toEqual([
      { ok: true, value: { error: 'model not found' } },
    ]);
  });

  describe('limite de tamanho de linha', () => {
    it('usa 1 MiB por padrão', () => {
      expect(DEFAULT_MAX_LINE_LENGTH).toBe(1024 * 1024);
    });

    it('rejeita linha longa e retoma no próximo \\n', () => {
      const parser = createNdjsonParser({ maxLineLength: 16 });
      const long = `{"x":"${'a'.repeat(40)}"}`;
      expect(parser.push(bytes(`{"a":1}\n${long}\n{"b":2}\n`))).toEqual([
        { ok: true, value: { a: 1 } },
        { ok: false, error: 'line_too_long' },
        { ok: true, value: { b: 2 } },
      ]);
      expect(parser.end()).toEqual([]);
    });

    it('descarta linha longa em vários chunks sem acumular e emite um único erro', () => {
      const parser = createNdjsonParser({ maxLineLength: 16 });
      const out: ParsedLine[] = [];
      for (let i = 0; i < 100; i++) out.push(...parser.push(bytes('a'.repeat(10))));
      out.push(...parser.push(bytes('zzz\n{"b":2}\n')));
      out.push(...parser.end());
      expect(out).toEqual([
        { ok: false, error: 'line_too_long' },
        { ok: true, value: { b: 2 } },
      ]);
    });

    it('rejeita a última linha longa sem newline', () => {
      const parser = createNdjsonParser({ maxLineLength: 6 });
      expect(parser.push(bytes('{"a":1}'))).toEqual([]);
      expect(parser.end()).toEqual([{ ok: false, error: 'line_too_long' }]);
    });

    it('aceita linha com exatamente o limite, mesmo seguida de CRLF', () => {
      const line = '{"a":12}';
      const parser = createNdjsonParser({ maxLineLength: line.length });
      expect(parser.push(bytes(`${line}\r`))).toEqual([]);
      expect(parser.push(bytes('\n'))).toEqual([{ ok: true, value: { a: 12 } }]);
    });

    it('rejeita maxLineLength inválido', () => {
      expect(() => createNdjsonParser({ maxLineLength: 0 })).toThrow(RangeError);
      expect(() => createNdjsonParser({ maxLineLength: 1.5 })).toThrow(RangeError);
    });
  });
});
