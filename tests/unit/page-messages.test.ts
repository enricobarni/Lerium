import { describe, expect, it } from 'vitest';
import { MAX_SEGMENT_CHARS } from '../../src/core/text-limits';
import {
  MAX_OUTPUT_CHARS,
  MAX_UNIT_CHARS,
  MAX_UNIT_ID_CHARS,
  PAGE_JOB_PORT_NAME,
  parseContentToWorker,
  parseWorkerToContent,
} from '../../src/shared/page-messages';

const JOB = '3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b';
const UNIT = 'seg-0#text@7';

const UNIT_ERRORS = [
  'invalid_config',
  'network',
  'timeout',
  'forbidden',
  'model_missing',
  'http_error',
  'provider_error',
  'invalid_response',
  'truncated',
  'empty_response',
  'cancelled',
  'invalid_input',
  'consumer_error',
  'internal_error',
  'busy',
] as const;

const FATAL_ERRORS = [
  'invalid_config',
  'model_missing',
  'forbidden',
  'network',
  'settings_unavailable',
];

const INVALID_JOB_IDS: unknown[] = [
  '3F2B8C1E-9A4D-4E7F-8B21-0C5D6E7F8A9B', // maiúsculas
  '3f2b8c1e9a4d4e7f8b210c5d6e7f8a9b', // sem hífens
  '3f2b8c1e-9a4d-1e7f-8b21-0c5d6e7f8a9b', // versão 1
  '3f2b8c1e-9a4d-4e7f-cb21-0c5d6e7f8a9b', // variante fora de 8/9/a/b
  '{3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b}', // com chaves
  ` ${JOB}`,
  `${JOB}\n`,
  'job-1',
  '',
  42,
  null,
  undefined,
];

const INVALID_UNIT_IDS: unknown[] = [
  '',
  'seg 0#text@7',
  'seg-0#text@7\n',
  'seg-0/text@7',
  'seg-0#téxt@7',
  '<script>',
  'a'.repeat(MAX_UNIT_ID_CHARS + 1),
  7,
  null,
];

describe('limites e porta', () => {
  it('expõe o nome da porta e os limites compartilhados', () => {
    expect(PAGE_JOB_PORT_NAME).toBe('lerium:page-job');
    expect(MAX_UNIT_CHARS).toBe(MAX_SEGMENT_CHARS + 2048);
    expect(MAX_OUTPUT_CHARS).toBe(4 * MAX_SEGMENT_CHARS + 1024);
    expect(MAX_UNIT_ID_CHARS).toBe(64);
  });
});

describe('parseContentToWorker', () => {
  it('aceita job:unit', () => {
    expect(
      parseContentToWorker({ type: 'job:unit', jobId: JOB, unitId: UNIT, text: 'Hi' }),
    ).toEqual({ type: 'job:unit', jobId: JOB, unitId: UNIT, text: 'Hi' });
  });

  it('aceita job:ping', () => {
    expect(parseContentToWorker({ type: 'job:ping', jobId: JOB })).toEqual({
      type: 'job:ping',
      jobId: JOB,
    });
  });

  it('aceita os formatos de unitId do page-applier e o limite exato', () => {
    for (const unitId of [
      'seg-0#text@1',
      'seg-12#markers@3',
      'seg-3#node-41@9',
      'a:b_c',
      'a'.repeat(MAX_UNIT_ID_CHARS),
    ]) {
      expect(
        parseContentToWorker({ type: 'job:unit', jobId: JOB, unitId, text: 'x' }),
      ).not.toBeNull();
    }
  });

  it('aceita text no limite e recusa acima', () => {
    const at = 'a'.repeat(MAX_UNIT_CHARS);
    expect(parseContentToWorker({ type: 'job:unit', jobId: JOB, unitId: UNIT, text: at })).toEqual({
      type: 'job:unit',
      jobId: JOB,
      unitId: UNIT,
      text: at,
    });
    expect(
      parseContentToWorker({ type: 'job:unit', jobId: JOB, unitId: UNIT, text: `${at}a` }),
    ).toBeNull();
  });

  it('recusa entradas que não são objeto', () => {
    for (const input of [
      null,
      undefined,
      'job:ping',
      1,
      true,
      [],
      [{ type: 'job:ping', jobId: JOB }],
    ]) {
      expect(parseContentToWorker(input)).toBeNull();
    }
  });

  it('recusa tipos desconhecidos, inclusive os do sentido oposto', () => {
    for (const type of [
      'job:result',
      'job:progress',
      'job:fatal',
      'job:Unit',
      'unit',
      undefined,
      1,
    ]) {
      expect(parseContentToWorker({ type, jobId: JOB, unitId: UNIT, text: 'x' })).toBeNull();
    }
  });

  it('recusa jobId inválido', () => {
    for (const jobId of INVALID_JOB_IDS) {
      expect(parseContentToWorker({ type: 'job:ping', jobId })).toBeNull();
      expect(parseContentToWorker({ type: 'job:unit', jobId, unitId: UNIT, text: 'x' })).toBeNull();
    }
  });

  it('recusa unitId inválido', () => {
    for (const unitId of INVALID_UNIT_IDS) {
      expect(parseContentToWorker({ type: 'job:unit', jobId: JOB, unitId, text: 'x' })).toBeNull();
    }
  });

  it('recusa campos ausentes ou de tipo errado', () => {
    expect(parseContentToWorker({ type: 'job:ping' })).toBeNull();
    expect(parseContentToWorker({ type: 'job:unit', jobId: JOB, unitId: UNIT })).toBeNull();
    expect(parseContentToWorker({ type: 'job:unit', jobId: JOB, text: 'x' })).toBeNull();
    for (const text of [null, 1, ['x'], { length: 1 }]) {
      expect(parseContentToWorker({ type: 'job:unit', jobId: JOB, unitId: UNIT, text })).toBeNull();
    }
  });

  it('descarta campos extras e __proto__, devolvendo objeto novo', () => {
    const input = {
      type: 'job:unit',
      jobId: JOB,
      unitId: UNIT,
      text: 'x',
      source: 'ja',
      target: 'en',
      __proto__: { polluted: true },
    };
    const parsed = parseContentToWorker(input);
    expect(parsed).toEqual({ type: 'job:unit', jobId: JOB, unitId: UNIT, text: 'x' });
    expect(parsed).not.toBe(input);
    expect(Object.keys(parsed ?? {})).toEqual(['type', 'jobId', 'unitId', 'text']);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect((parsed as unknown as Record<string, unknown>).polluted).toBeUndefined();

    const ping = { type: 'job:ping', jobId: JOB, unitId: UNIT };
    const parsedPing = parseContentToWorker(ping);
    expect(parsedPing).toEqual({ type: 'job:ping', jobId: JOB });
    expect(parsedPing).not.toBe(ping);
  });
});

describe('parseWorkerToContent', () => {
  it('aceita job:result de sucesso', () => {
    expect(
      parseWorkerToContent({ type: 'job:result', jobId: JOB, unitId: UNIT, ok: true, text: 'Oi' }),
    ).toEqual({ type: 'job:result', jobId: JOB, unitId: UNIT, ok: true, text: 'Oi' });
  });

  it('aceita job:result de falha com cada código de erro', () => {
    for (const error of UNIT_ERRORS) {
      for (const retryable of [true, false]) {
        expect(
          parseWorkerToContent({
            type: 'job:result',
            jobId: JOB,
            unitId: UNIT,
            ok: false,
            error,
            retryable,
          }),
        ).toEqual({ type: 'job:result', jobId: JOB, unitId: UNIT, ok: false, error, retryable });
      }
    }
  });

  it('aceita job:progress com chars inteiro >= 0', () => {
    for (const chars of [0, 1, 12345]) {
      expect(
        parseWorkerToContent({ type: 'job:progress', jobId: JOB, unitId: UNIT, chars }),
      ).toEqual({
        type: 'job:progress',
        jobId: JOB,
        unitId: UNIT,
        chars,
      });
    }
  });

  it('aceita job:fatal com cada código', () => {
    for (const error of FATAL_ERRORS) {
      expect(parseWorkerToContent({ type: 'job:fatal', jobId: JOB, error })).toEqual({
        type: 'job:fatal',
        jobId: JOB,
        error,
      });
    }
  });

  it('aceita text no limite de saída e recusa acima', () => {
    const at = 'a'.repeat(MAX_OUTPUT_CHARS);
    const base = { type: 'job:result', jobId: JOB, unitId: UNIT, ok: true };
    expect(parseWorkerToContent({ ...base, text: at })).not.toBeNull();
    expect(parseWorkerToContent({ ...base, text: `${at}a` })).toBeNull();
  });

  it('recusa entradas que não são objeto', () => {
    for (const input of [
      null,
      undefined,
      'job:fatal',
      0,
      [],
      [{ type: 'job:fatal', jobId: JOB }],
    ]) {
      expect(parseWorkerToContent(input)).toBeNull();
    }
  });

  it('recusa tipos desconhecidos, inclusive os do sentido oposto', () => {
    for (const type of ['job:unit', 'job:ping', 'job:Result', 'result', undefined]) {
      expect(
        parseWorkerToContent({ type, jobId: JOB, unitId: UNIT, ok: true, text: 'x', chars: 0 }),
      ).toBeNull();
    }
  });

  it('recusa jobId inválido em todas as formas', () => {
    for (const jobId of INVALID_JOB_IDS) {
      expect(
        parseWorkerToContent({ type: 'job:result', jobId, unitId: UNIT, ok: true, text: 'x' }),
      ).toBeNull();
      expect(
        parseWorkerToContent({ type: 'job:progress', jobId, unitId: UNIT, chars: 0 }),
      ).toBeNull();
      expect(parseWorkerToContent({ type: 'job:fatal', jobId, error: 'forbidden' })).toBeNull();
    }
  });

  it('recusa unitId inválido em result e progress', () => {
    for (const unitId of INVALID_UNIT_IDS) {
      expect(
        parseWorkerToContent({ type: 'job:result', jobId: JOB, unitId, ok: true, text: 'x' }),
      ).toBeNull();
      expect(
        parseWorkerToContent({ type: 'job:progress', jobId: JOB, unitId, chars: 0 }),
      ).toBeNull();
    }
  });

  it('recusa result com ok, text, error ou retryable inválidos', () => {
    const base = { type: 'job:result', jobId: JOB, unitId: UNIT };
    for (const ok of ['true', 1, undefined, null]) {
      expect(parseWorkerToContent({ ...base, ok, text: 'x' })).toBeNull();
    }
    expect(parseWorkerToContent({ ...base, ok: true })).toBeNull();
    expect(parseWorkerToContent({ ...base, ok: true, text: 1 })).toBeNull();
    expect(parseWorkerToContent({ ...base, ok: false, retryable: true })).toBeNull();
    expect(parseWorkerToContent({ ...base, ok: false, error: 'network' })).toBeNull();
    expect(
      parseWorkerToContent({ ...base, ok: false, error: 'network', retryable: 'yes' }),
    ).toBeNull();
    for (const error of [
      'settings_unavailable',
      'unknown',
      'NETWORK',
      'toString',
      '__proto__',
      1,
    ]) {
      expect(parseWorkerToContent({ ...base, ok: false, error, retryable: false })).toBeNull();
    }
  });

  it('recusa progress com chars negativo, fracionário ou não numérico', () => {
    for (const chars of [-1, 0.5, 1.5, Number.NaN, Infinity, 2 ** 53, '3', null, undefined]) {
      expect(
        parseWorkerToContent({ type: 'job:progress', jobId: JOB, unitId: UNIT, chars }),
      ).toBeNull();
    }
  });

  it('recusa fatal com error desconhecido ou de unidade', () => {
    for (const error of ['busy', 'timeout', 'truncated', 'unknown', 'constructor', undefined]) {
      expect(parseWorkerToContent({ type: 'job:fatal', jobId: JOB, error })).toBeNull();
    }
  });

  it('descarta campos extras e __proto__, devolvendo objeto novo', () => {
    const cases: { input: Record<string, unknown>; expected: Record<string, unknown> }[] = [
      {
        input: {
          type: 'job:result',
          jobId: JOB,
          unitId: UNIT,
          ok: true,
          text: 'x',
          error: 'network',
        },
        expected: { type: 'job:result', jobId: JOB, unitId: UNIT, ok: true, text: 'x' },
      },
      {
        input: {
          type: 'job:result',
          jobId: JOB,
          unitId: UNIT,
          ok: false,
          error: 'busy',
          retryable: true,
          text: 'leak',
          status: 500,
        },
        expected: {
          type: 'job:result',
          jobId: JOB,
          unitId: UNIT,
          ok: false,
          error: 'busy',
          retryable: true,
        },
      },
      {
        input: { type: 'job:progress', jobId: JOB, unitId: UNIT, chars: 3, text: 'leak' },
        expected: { type: 'job:progress', jobId: JOB, unitId: UNIT, chars: 3 },
      },
      {
        input: { type: 'job:fatal', jobId: JOB, error: 'forbidden', unitId: UNIT, detail: 'x' },
        expected: { type: 'job:fatal', jobId: JOB, error: 'forbidden' },
      },
    ];
    for (const { input, expected } of cases) {
      const withProto = { ...input, __proto__: { polluted: true } };
      const parsed = parseWorkerToContent(withProto);
      expect(parsed).toEqual(expected);
      expect(parsed).not.toBe(withProto);
      expect(Object.keys(parsed ?? {})).toEqual(Object.keys(expected));
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
      expect((parsed as unknown as Record<string, unknown>).polluted).toBeUndefined();
    }
  });
});
