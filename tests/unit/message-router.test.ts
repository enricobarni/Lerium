import { describe, expect, it, vi } from 'vitest';
import { createMessageHandler, isHandledMessage } from '../../src/background/message-router';

const RUNTIME_ID = 'mjkoppimccgajnabfeheglepjapkchlk';
const SENDER = { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/options/index.html` };
const MESSAGE = {
  type: 'ollama:test-connection',
  endpoint: 'http://localhost:11434',
  model: 'translategemma:4b',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const ollamaFetch = (showStatus = 200) =>
  vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/tags') return jsonResponse({ models: [{ name: 'translategemma:4b' }] });
    if (path === '/api/show') return jsonResponse({}, showStatus);
    throw new Error(`rota inesperada: ${path}`);
  });

const setup = (options: { granted?: boolean; showStatus?: number } = {}) => {
  const fetchFn = ollamaFetch(options.showStatus);
  const permissionsContains = vi.fn(async () => options.granted ?? true);
  const handle = createMessageHandler({ runtimeId: RUNTIME_ID, permissionsContains, fetchFn });
  return { fetchFn, permissionsContains, handle };
};

describe('isHandledMessage', () => {
  it('reconhece apenas o tipo de teste de conexão', () => {
    expect(isHandledMessage(MESSAGE)).toBe(true);
    expect(isHandledMessage({ type: 'ollama:test-connection' })).toBe(true);
    expect(isHandledMessage({ type: 'outro' })).toBe(false);
    expect(isHandledMessage(null)).toBe(false);
    expect(isHandledMessage('ollama:test-connection')).toBe(false);
  });
});

describe('createMessageHandler: remetente', () => {
  it.each([
    ['outra extensão', { id: 'abcdefghijklmnopabcdefghijklmnop', url: SENDER.url }],
    ['sem id', { url: SENDER.url }],
    ['página web com id do Lerium', { id: RUNTIME_ID, url: 'https://example.com/' }],
    ['sem url', { id: RUNTIME_ID }],
    [
      'url de outra extensão',
      { id: RUNTIME_ID, url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html' },
    ],
  ])('ignora %s sem consultar permissões nem rede', async (_label, sender) => {
    const { fetchFn, permissionsContains, handle } = setup();

    await expect(handle(MESSAGE, sender)).resolves.toBeUndefined();
    expect(permissionsContains).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('ignora mensagens de outro tipo', async () => {
    const { fetchFn, handle } = setup();

    await expect(handle({ type: 'ollama:chat' }, SENDER)).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('createMessageHandler: validação', () => {
  it.each([
    ['endpoint ausente', { type: 'ollama:test-connection', model: 'a' }],
    [
      'modelo não string',
      { type: 'ollama:test-connection', endpoint: 'http://localhost', model: 1 },
    ],
    ['endpoint remoto', { ...MESSAGE, endpoint: 'http://example.com:11434' }],
    ['endpoint https', { ...MESSAGE, endpoint: 'https://localhost:11434' }],
    ['endpoint com caminho', { ...MESSAGE, endpoint: 'http://localhost:11434/api' }],
    ['modelo inválido', { ...MESSAGE, model: '../etc' }],
    ['modelo vazio', { ...MESSAGE, model: '  ' }],
  ])('%s vira invalid_request sem rede', async (_label, message) => {
    const { fetchFn, permissionsContains, handle } = setup();

    await expect(handle(message, SENDER)).resolves.toEqual({
      ok: false,
      error: 'invalid_request',
    });
    expect(permissionsContains).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('createMessageHandler: permissão de host', () => {
  it('consulta a permissão da origem exata normalizada', async () => {
    const { permissionsContains, handle } = setup();

    await handle({ ...MESSAGE, endpoint: ' http://127.0.0.1:8080/ ' }, SENDER);

    expect(permissionsContains).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:8080/*');
  });

  it('sem permissão devolve permission_required sem rede', async () => {
    const { fetchFn, handle } = setup({ granted: false });

    await expect(
      handle({ ...MESSAGE, endpoint: 'http://localhost:8080' }, SENDER),
    ).resolves.toEqual({ ok: false, error: 'permission_required' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('falha ao consultar a permissão também vira permission_required', async () => {
    const fetchFn = ollamaFetch();
    const handle = createMessageHandler({
      runtimeId: RUNTIME_ID,
      permissionsContains: async () => {
        throw new Error('x');
      },
      fetchFn,
    });

    await expect(handle(MESSAGE, SENDER)).resolves.toEqual({
      ok: false,
      error: 'permission_required',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('createMessageHandler: encaminhamento', () => {
  it('encaminha ao testConnection e devolve o sucesso', async () => {
    const { fetchFn, handle } = setup();

    await expect(handle(MESSAGE, SENDER)).resolves.toEqual({
      ok: true,
      models: ['translategemma:4b'],
      modelInstalled: true,
    });
    expect(fetchFn.mock.calls.map(([input]) => String(input))).toEqual([
      'http://localhost:11434/api/tags',
      'http://localhost:11434/api/show',
    ]);
  });

  it('devolve forbidden quando /api/show responde 403', async () => {
    const { handle } = setup({ showStatus: 403 });

    await expect(handle(MESSAGE, SENDER)).resolves.toEqual({
      ok: false,
      error: 'forbidden',
      status: 403,
    });
  });

  it('devolve modelInstalled false quando /api/show responde 404', async () => {
    const { handle } = setup({ showStatus: 404 });

    await expect(handle(MESSAGE, SENDER)).resolves.toEqual({
      ok: true,
      models: ['translategemma:4b'],
      modelInstalled: false,
    });
  });

  it('repassa timeoutMs ao cliente', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      );
      const handle = createMessageHandler({
        runtimeId: RUNTIME_ID,
        permissionsContains: async () => true,
        fetchFn,
        timeoutMs: 50,
      });

      const pending = handle(MESSAGE, SENDER);
      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
