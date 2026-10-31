import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_ID_CHARS,
  PAGE_COMMAND_MESSAGE_TYPE,
  PAGE_INJECT_MESSAGE_TYPE,
  isDocumentId,
  parsePageCommand,
  parsePageCommandResponse,
  parsePageInjectRequest,
  parsePageInjectResponse,
} from '../../src/shared/page-control';

const DOC_ID = '8F3C2B1A9E7D6C5B4A3F2E1D0C9B8A7F';

const INJECT_ERRORS = [
  'permission_required',
  'page_unsupported',
  'settings_unavailable',
  'injection_failed',
  'invalid_request',
] as const;

const COMMANDS = ['get-state', 'start', 'cancel', 'show-original', 'show-translation'] as const;
const STATUSES = ['idle', 'translating', 'translated', 'cancelled', 'error'] as const;
const VIEWS = ['original', 'translation'] as const;
const STATE_ERRORS = [
  'invalid_config',
  'model_missing',
  'forbidden',
  'network',
  'settings_unavailable',
  'interrupted',
] as const;

const NOT_RECORDS: unknown[] = [null, undefined, 0, 'x', true, [], [1]];
const PROTO_KEYS = ['toString', 'constructor', '__proto__', 'hasOwnProperty'];

const STATE = {
  status: 'translating',
  view: 'translation',
  total: 10,
  done: 3,
  failed: 1,
  skipped: 2,
} as const;

/** Objeto com `__proto__` como chave própria, como o JSON.parse produz. */
const withProto = (base: Record<string, unknown>): Record<string, unknown> =>
  ({ ...base, ...(JSON.parse('{"__proto__": {"polluted": true}}') as object) }) as Record<
    string,
    unknown
  >;

describe('tipos de mensagem', () => {
  it('usa os tipos esperados', () => {
    expect(PAGE_INJECT_MESSAGE_TYPE).toBe('page:inject');
    expect(PAGE_COMMAND_MESSAGE_TYPE).toBe('page:command');
    expect(MAX_DOCUMENT_ID_CHARS).toBe(128);
  });
});

describe('parsePageInjectRequest', () => {
  it('aceita tabId inteiro não negativo', () => {
    for (const tabId of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
      expect(parsePageInjectRequest({ type: 'page:inject', tabId })).toEqual({
        type: 'page:inject',
        tabId,
      });
    }
  });

  it('recusa não objetos e tipo errado', () => {
    for (const input of NOT_RECORDS) expect(parsePageInjectRequest(input)).toBeNull();
    for (const type of ['page:command', 'PAGE:INJECT', 'page:inject ', undefined, 1]) {
      expect(parsePageInjectRequest({ type, tabId: 1 })).toBeNull();
    }
  });

  it('recusa tabId inválido', () => {
    for (const tabId of [
      -1,
      0.5,
      1.5,
      Number.NaN,
      Infinity,
      -Infinity,
      2 ** 53,
      '1',
      null,
      undefined,
      true,
      [1],
    ]) {
      expect(parsePageInjectRequest({ type: 'page:inject', tabId })).toBeNull();
    }
  });

  it('descarta campos extras e __proto__, devolvendo objeto novo', () => {
    const input = withProto({ type: 'page:inject', tabId: 7, url: 'https://x', extra: 1 });
    const parsed = parsePageInjectRequest(input);
    expect(parsed).toEqual({ type: 'page:inject', tabId: 7 });
    expect(Object.keys(parsed ?? {})).toEqual(['type', 'tabId']);
    expect(parsed).not.toBe(input);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('parsePageInjectResponse', () => {
  it('aceita sucesso com documentId válido', () => {
    for (const documentId of [DOC_ID, 'a', 'x'.repeat(MAX_DOCUMENT_ID_CHARS), 'A-b_c.~!']) {
      expect(parsePageInjectResponse({ ok: true, documentId })).toEqual({ ok: true, documentId });
    }
  });

  it('aceita todo código de erro conhecido', () => {
    for (const error of INJECT_ERRORS) {
      expect(parsePageInjectResponse({ ok: false, error })).toEqual({ ok: false, error });
    }
  });

  it('recusa documentId vazio, longo, com espaço ou fora do ASCII imprimível', () => {
    for (const documentId of [
      '',
      'x'.repeat(MAX_DOCUMENT_ID_CHARS + 1),
      'abc def',
      ` ${DOC_ID}`,
      `${DOC_ID}\n`,
      'a\tb',
      'docé',
      'a\u0000b',
      'a\u007fb',
      42,
      null,
      undefined,
    ]) {
      expect(parsePageInjectResponse({ ok: true, documentId })).toBeNull();
      expect(isDocumentId(documentId)).toBe(false);
    }
  });

  it('recusa ok inválido, não objetos e erro desconhecido', () => {
    for (const input of NOT_RECORDS) expect(parsePageInjectResponse(input)).toBeNull();
    for (const ok of ['true', 1, 0, null, undefined]) {
      expect(parsePageInjectResponse({ ok, documentId: DOC_ID })).toBeNull();
    }
    for (const error of ['network', 'unknown', 'INVALID_REQUEST', ...PROTO_KEYS, 1, undefined]) {
      expect(parsePageInjectResponse({ ok: false, error })).toBeNull();
    }
  });

  it('descarta campos extras e __proto__, devolvendo objeto novo', () => {
    const okInput = withProto({ ok: true, documentId: DOC_ID, error: 'invalid_request', x: 1 });
    const okParsed = parsePageInjectResponse(okInput);
    expect(Object.keys(okParsed ?? {})).toEqual(['ok', 'documentId']);
    expect(okParsed).not.toBe(okInput);

    const errInput = withProto({ ok: false, error: 'page_unsupported', documentId: DOC_ID });
    const errParsed = parsePageInjectResponse(errInput);
    expect(errParsed).toEqual({ ok: false, error: 'page_unsupported' });
    expect(Object.keys(errParsed ?? {})).toEqual(['ok', 'error']);
    expect(Object.getPrototypeOf(errParsed)).toBe(Object.prototype);
  });
});

describe('parsePageCommand', () => {
  it('aceita todo comando conhecido', () => {
    for (const command of COMMANDS) {
      expect(parsePageCommand({ type: 'page:command', command })).toEqual({
        type: 'page:command',
        command,
      });
    }
  });

  it('recusa não objetos, tipo errado e comando desconhecido', () => {
    for (const input of NOT_RECORDS) expect(parsePageCommand(input)).toBeNull();
    for (const type of ['page:inject', 'page:Command', undefined]) {
      expect(parsePageCommand({ type, command: 'start' })).toBeNull();
    }
    for (const command of [
      'stop',
      'START',
      'start ',
      'show_original',
      '',
      ...PROTO_KEYS,
      1,
      null,
      undefined,
    ]) {
      expect(parsePageCommand({ type: 'page:command', command })).toBeNull();
    }
  });

  it('descarta campos extras e __proto__, devolvendo objeto novo', () => {
    const input = withProto({ type: 'page:command', command: 'cancel', jobId: 'x', text: 'y' });
    const parsed = parsePageCommand(input);
    expect(parsed).toEqual({ type: 'page:command', command: 'cancel' });
    expect(Object.keys(parsed ?? {})).toEqual(['type', 'command']);
    expect(parsed).not.toBe(input);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});

describe('parsePageCommandResponse', () => {
  it('aceita todo status e view, com e sem erro', () => {
    for (const status of STATUSES) {
      for (const view of VIEWS) {
        const state = { ...STATE, status, view };
        expect(parsePageCommandResponse({ ok: true, state })).toEqual({ ok: true, state });
      }
    }
    for (const error of STATE_ERRORS) {
      const state = { ...STATE, status: 'error', error };
      expect(parsePageCommandResponse({ ok: true, state })).toEqual({ ok: true, state });
    }
  });

  it('aceita contagens nos limites', () => {
    const state = {
      ...STATE,
      total: 0,
      done: 0,
      failed: 0,
      skipped: Number.MAX_SAFE_INTEGER,
    };
    expect(parsePageCommandResponse({ ok: true, state })).toEqual({ ok: true, state });
  });

  it('aceita a falha invalid_request', () => {
    expect(parsePageCommandResponse({ ok: false, error: 'invalid_request' })).toEqual({
      ok: false,
      error: 'invalid_request',
    });
  });

  it('recusa não objetos, ok inválido e state ausente', () => {
    for (const input of NOT_RECORDS) expect(parsePageCommandResponse(input)).toBeNull();
    for (const ok of ['true', 1, null, undefined]) {
      expect(parsePageCommandResponse({ ok, state: STATE })).toBeNull();
    }
    for (const state of NOT_RECORDS) {
      expect(parsePageCommandResponse({ ok: true, state })).toBeNull();
    }
  });

  it('recusa status, view ou erro desconhecidos', () => {
    for (const status of ['running', 'IDLE', '', ...PROTO_KEYS, 1, undefined]) {
      expect(parsePageCommandResponse({ ok: true, state: { ...STATE, status } })).toBeNull();
    }
    for (const view of ['both', 'Original', '', ...PROTO_KEYS, 1, undefined]) {
      expect(parsePageCommandResponse({ ok: true, state: { ...STATE, view } })).toBeNull();
    }
    for (const error of ['busy', 'timeout', 'unknown', ...PROTO_KEYS, 1, null]) {
      expect(parsePageCommandResponse({ ok: true, state: { ...STATE, error } })).toBeNull();
    }
  });

  it('recusa contagens inválidas', () => {
    for (const key of ['total', 'done', 'failed', 'skipped']) {
      for (const value of [-1, 0.5, Number.NaN, Infinity, 2 ** 53, '1', null, undefined]) {
        expect(
          parsePageCommandResponse({ ok: true, state: { ...STATE, [key]: value } }),
        ).toBeNull();
      }
    }
  });

  it('recusa falha com erro diferente de invalid_request', () => {
    for (const error of ['network', 'interrupted', 'permission_required', ...PROTO_KEYS, 1]) {
      expect(parsePageCommandResponse({ ok: false, error })).toBeNull();
    }
    expect(parsePageCommandResponse({ ok: false })).toBeNull();
  });

  it('descarta campos extras e __proto__, devolvendo objetos novos', () => {
    const stateInput = withProto({ ...STATE, error: 'network', text: 'página', url: 'x' });
    const input = withProto({ ok: true, state: stateInput, extra: 1 });
    const parsed = parsePageCommandResponse(input);
    expect(parsed).toEqual({ ok: true, state: { ...STATE, error: 'network' } });
    expect(Object.keys(parsed ?? {})).toEqual(['ok', 'state']);
    expect(parsed).not.toBe(input);
    if (parsed?.ok !== true) throw new Error('esperava sucesso');
    expect(parsed.state).not.toBe(stateInput);
    expect(Object.keys(parsed.state).sort()).toEqual(
      ['done', 'error', 'failed', 'skipped', 'status', 'total', 'view'].sort(),
    );
    expect(Object.getPrototypeOf(parsed.state)).toBe(Object.prototype);

    const errParsed = parsePageCommandResponse(
      withProto({ ok: false, error: 'invalid_request', state: STATE }),
    );
    expect(Object.keys(errParsed ?? {})).toEqual(['ok', 'error']);
  });

  it('omite error quando ausente', () => {
    const parsed = parsePageCommandResponse({ ok: true, state: STATE });
    if (parsed?.ok !== true) throw new Error('esperava sucesso');
    expect(Object.hasOwn(parsed.state, 'error')).toBe(false);
  });

  it('aceita firstVisibleMs e durationMs finitos >= 0, juntos ou separados', () => {
    for (const value of [0, 0.25, 12.5, 1234, Number.MAX_VALUE]) {
      for (const state of [
        { ...STATE, firstVisibleMs: value },
        { ...STATE, durationMs: value },
        { ...STATE, status: 'translated', firstVisibleMs: value, durationMs: value },
      ]) {
        expect(parsePageCommandResponse({ ok: true, state })).toEqual({ ok: true, state });
      }
    }
    const withError = { ...STATE, status: 'error', error: 'network', durationMs: 7 };
    expect(parsePageCommandResponse({ ok: true, state: withError })).toEqual({
      ok: true,
      state: withError,
    });
  });

  it('omite firstVisibleMs e durationMs quando ausentes', () => {
    const parsed = parsePageCommandResponse({ ok: true, state: STATE });
    if (parsed?.ok !== true) throw new Error('esperava sucesso');
    expect(Object.hasOwn(parsed.state, 'firstVisibleMs')).toBe(false);
    expect(Object.hasOwn(parsed.state, 'durationMs')).toBe(false);
  });

  it('recusa tempos NaN, infinitos, negativos ou não numéricos', () => {
    for (const key of ['firstVisibleMs', 'durationMs']) {
      for (const value of [Number.NaN, Infinity, -Infinity, -1, -0.5, '1', '', null, true, {}]) {
        expect(
          parsePageCommandResponse({ ok: true, state: { ...STATE, [key]: value } }),
        ).toBeNull();
      }
    }
  });
});
