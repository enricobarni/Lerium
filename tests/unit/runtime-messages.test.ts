import { describe, expect, it } from 'vitest';
import {
  TEST_CONNECTION_MESSAGE_TYPE,
  parseTestConnectionRequest,
  parseTestConnectionResponse,
} from '../../src/shared/runtime-messages';

describe('parseTestConnectionRequest', () => {
  it('aceita a forma esperada', () => {
    expect(TEST_CONNECTION_MESSAGE_TYPE).toBe('ollama:test-connection');
    expect(
      parseTestConnectionRequest({
        type: 'ollama:test-connection',
        endpoint: 'http://localhost:11434',
        model: 'qwen3:8b',
      }),
    ).toEqual({
      type: 'ollama:test-connection',
      endpoint: 'http://localhost:11434',
      model: 'qwen3:8b',
    });
  });

  it('ignora campos extras e devolve objeto novo só com os campos conhecidos', () => {
    const input = {
      type: 'ollama:test-connection',
      endpoint: 'http://localhost:11434',
      model: 'qwen3:8b',
      extra: 'x',
      __proto__: { polluted: true },
    };

    const parsed = parseTestConnectionRequest(input);

    expect(parsed).toEqual({
      type: 'ollama:test-connection',
      endpoint: 'http://localhost:11434',
      model: 'qwen3:8b',
    });
    expect(parsed).not.toBe(input);
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['endpoint', 'model', 'type']);
  });

  it.each([
    ['nulo', null],
    ['string', 'ollama:test-connection'],
    ['lista', [{ type: 'ollama:test-connection', endpoint: 'a', model: 'b' }]],
    ['tipo diferente', { type: 'ollama:chat', endpoint: 'a', model: 'b' }],
    ['sem tipo', { endpoint: 'a', model: 'b' }],
    ['endpoint não string', { type: 'ollama:test-connection', endpoint: 1, model: 'b' }],
    ['modelo ausente', { type: 'ollama:test-connection', endpoint: 'a' }],
    ['modelo não string', { type: 'ollama:test-connection', endpoint: 'a', model: ['b'] }],
  ])('rejeita %s', (_label, input) => {
    expect(parseTestConnectionRequest(input)).toBeNull();
  });
});

describe('parseTestConnectionResponse', () => {
  it('aceita sucesso com lista de strings e modelInstalled', () => {
    expect(
      parseTestConnectionResponse({ ok: true, models: ['a', 'b'], modelInstalled: false, x: 1 }),
    ).toEqual({ ok: true, models: ['a', 'b'], modelInstalled: false });
    expect(parseTestConnectionResponse({ ok: true, models: [], modelInstalled: true })).toEqual({
      ok: true,
      models: [],
      modelInstalled: true,
    });
  });

  it.each([
    'invalid_endpoint',
    'invalid_model',
    'network',
    'timeout',
    'forbidden',
    'not_found',
    'http_error',
    'invalid_response',
    'permission_required',
    'invalid_request',
  ])('aceita o erro %s', (error) => {
    expect(parseTestConnectionResponse({ ok: false, error })).toEqual({ ok: false, error });
  });

  it('preserva status inteiro e ignora campos extras', () => {
    expect(
      parseTestConnectionResponse({ ok: false, error: 'http_error', status: 500, detail: 'x' }),
    ).toEqual({ ok: false, error: 'http_error', status: 500 });
  });

  it.each([
    ['indefinido', undefined],
    ['nulo', null],
    ['lista', [true]],
    ['ok não booleano', { ok: 'true', models: [], modelInstalled: true }],
    ['models ausente', { ok: true, modelInstalled: true }],
    ['models não lista', { ok: true, models: 'a', modelInstalled: true }],
    ['models com item não string', { ok: true, models: ['a', 1], modelInstalled: true }],
    ['modelInstalled ausente', { ok: true, models: [] }],
    ['modelInstalled não booleano', { ok: true, models: [], modelInstalled: 'yes' }],
    ['erro desconhecido', { ok: false, error: 'boom' }],
    ['erro herdado do protótipo', { ok: false, error: 'toString' }],
    ['erro ausente', { ok: false }],
    ['status não inteiro', { ok: false, error: 'http_error', status: 1.5 }],
    ['status string', { ok: false, error: 'http_error', status: '500' }],
  ])('rejeita %s', (_label, input) => {
    expect(parseTestConnectionResponse(input)).toBeNull();
  });
});
