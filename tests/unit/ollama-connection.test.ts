import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LIST_MODELS_TIMEOUT_MS,
  showModel,
  testConnection,
} from '../../src/core/ollama-client';

const ENDPOINT = 'http://localhost:11434';
const MODEL = 'translategemma:4b';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const tagsResponse = (...names: string[]): Response =>
  jsonResponse({ models: names.map((name) => ({ name })) });

/** Responde por caminho; a ordem das chamadas fica em `mock.calls`. */
const routedFetch = (routes: Record<string, () => Response | Promise<Response>>) =>
  vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    const route = routes[path];
    if (!route) throw new Error(`rota inesperada: ${path}`);
    return route();
  });

const hangingUntilAbort = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

afterEach(() => {
  vi.useRealTimers();
});

describe('showModel: requisição', () => {
  it('faz POST JSON em /api/show com o modelo e as opções de segurança', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ modelfile: 'x' }));

    await showModel(ENDPOINT, MODEL, { fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://localhost:11434/api/show');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(init?.body).toBe('{"model":"translategemma:4b"}');
    expect(init?.credentials).toBe('omit');
    expect(init?.cache).toBe('no-store');
    expect(init?.redirect).toBe('error');
    expect(init?.mode).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('normaliza endpoint e modelo antes de enviar', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}));

    await showModel(' http://127.0.0.1:8080/ ', '  qwen3:8b ', { fetchFn });

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:8080/api/show');
    expect(init?.body).toBe('{"model":"qwen3:8b"}');
  });

  it.each(['http://example.com:11434', 'https://localhost:11434', ''])(
    'recusa o endpoint "%s" sem chamar fetch',
    async (endpoint) => {
      const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}));

      await expect(showModel(endpoint, MODEL, { fetchFn })).resolves.toEqual({
        ok: false,
        error: 'invalid_endpoint',
      });
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it.each(['', '../x', 'a b', 42, '/abs'])('recusa o modelo %j sem chamar fetch', async (model) => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}));

    await expect(showModel(ENDPOINT, model as string, { fetchFn })).resolves.toEqual({
      ok: false,
      error: 'invalid_model',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('showModel: resultado', () => {
  it('200 vira ok sem ler nem devolver o corpo', async () => {
    const json = vi.fn();
    const text = vi.fn();
    const response = { ok: true, status: 200, json, text } as unknown as Response;
    const fetchFn = vi.fn<typeof fetch>(async () => response);

    await expect(showModel(ENDPOINT, MODEL, { fetchFn })).resolves.toEqual({ ok: true });
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it.each([
    [403, { ok: false, error: 'forbidden', status: 403 }],
    [404, { ok: false, error: 'model_missing', status: 404 }],
    [500, { ok: false, error: 'http_error', status: 500 }],
    [400, { ok: false, error: 'http_error', status: 400 }],
  ])('status %i vira o erro esperado', async (status, expected) => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ error: 'x' }, status));

    await expect(showModel(ENDPOINT, MODEL, { fetchFn })).resolves.toEqual(expected);
  });

  it('TypeError de rede vira network', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(showModel(ENDPOINT, MODEL, { fetchFn })).resolves.toEqual({
      ok: false,
      error: 'network',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('aborta e devolve timeout no prazo padrão, limpando o timer', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>((_input, init) => hangingUntilAbort(init));

    const pending = showModel(ENDPOINT, MODEL, { fetchFn });
    await vi.advanceTimersByTimeAsync(DEFAULT_LIST_MODELS_TIMEOUT_MS - 1);
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' });
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('respeita timeoutMs personalizado', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>((_input, init) => hangingUntilAbort(init));

    const pending = showModel(ENDPOINT, MODEL, { fetchFn, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' });
  });

  it.each([
    ['200', () => jsonResponse({})],
    ['404', () => jsonResponse({ error: 'x' }, 404)],
    ['500', () => jsonResponse({ error: 'x' }, 500)],
    [
      'TypeError',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ])('não deixa timers pendentes após %s', async (_label, make) => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>(async () => make());

    await showModel(ENDPOINT, MODEL, { fetchFn });

    expect(vi.getTimerCount()).toBe(0);
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });
});

describe('testConnection', () => {
  it('chama /api/tags e depois /api/show, nessa ordem', async () => {
    const fetchFn = routedFetch({
      '/api/tags': () => tagsResponse(MODEL),
      '/api/show': () => jsonResponse({}),
    });

    await testConnection(ENDPOINT, MODEL, { fetchFn });

    expect(fetchFn.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/api/tags',
      '/api/show',
    ]);
    expect(fetchFn.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(fetchFn.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toEqual({ 'content-type': 'application/json' });
    expect(fetchFn.mock.calls[1]?.[1]?.body).toBe('{"model":"translategemma:4b"}');
  });

  it('modelo existente: ok com a lista e modelInstalled true', async () => {
    const fetchFn = routedFetch({
      '/api/tags': () => tagsResponse('qwen3:8b', MODEL),
      '/api/show': () => jsonResponse({}),
    });

    await expect(testConnection(ENDPOINT, MODEL, { fetchFn })).resolves.toEqual({
      ok: true,
      models: ['qwen3:8b', MODEL],
      modelInstalled: true,
    });
  });

  it('modelo ausente (404 em /api/show): ok com modelInstalled false', async () => {
    const fetchFn = routedFetch({
      '/api/tags': () => tagsResponse('qwen3:8b'),
      '/api/show': () => jsonResponse({ error: "model 'translategemma:4b' not found" }, 404),
    });

    await expect(testConnection(ENDPOINT, MODEL, { fetchFn })).resolves.toEqual({
      ok: true,
      models: ['qwen3:8b'],
      modelInstalled: false,
    });
  });

  it('403 em /api/show vira forbidden (origem não liberada)', async () => {
    const fetchFn = routedFetch({
      '/api/tags': () => tagsResponse(MODEL),
      '/api/show': () => jsonResponse({}, 403),
    });

    await expect(testConnection(ENDPOINT, MODEL, { fetchFn })).resolves.toEqual({
      ok: false,
      error: 'forbidden',
      status: 403,
    });
  });

  it.each([
    ['http_error', () => jsonResponse({}, 500), { ok: false, error: 'http_error', status: 500 }],
    [
      'network',
      () => Promise.reject(new TypeError('Failed to fetch')),
      { ok: false, error: 'network' },
    ],
  ])('propaga %s de /api/show', async (_label, show, expected) => {
    const fetchFn = routedFetch({ '/api/tags': () => tagsResponse(MODEL), '/api/show': show });

    await expect(testConnection(ENDPOINT, MODEL, { fetchFn })).resolves.toEqual(expected);
  });

  it.each([
    ['network', () => Promise.reject(new TypeError('Failed to fetch')), { error: 'network' }],
    ['not_found', () => jsonResponse({}, 404), { error: 'not_found', status: 404 }],
    ['forbidden', () => jsonResponse({}, 403), { error: 'forbidden', status: 403 }],
    ['invalid_response', () => jsonResponse({ tags: [] }), { error: 'invalid_response' }],
  ])('falha em /api/tags (%s) é devolvida sem chamar /api/show', async (_label, tags, error) => {
    const fetchFn = routedFetch({ '/api/tags': tags, '/api/show': () => jsonResponse({}) });

    await expect(testConnection(ENDPOINT, MODEL, { fetchFn })).resolves.toEqual({
      ok: false,
      ...error,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('endpoint ou modelo inválidos não fazem nenhum fetch', async () => {
    const fetchFn = routedFetch({});

    await expect(testConnection('http://example.com', MODEL, { fetchFn })).resolves.toEqual({
      ok: false,
      error: 'invalid_endpoint',
    });
    await expect(testConnection(ENDPOINT, '../x', { fetchFn })).resolves.toEqual({
      ok: false,
      error: 'invalid_model',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('cada etapa tem o próprio prazo', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      if (new URL(String(input)).pathname === '/api/tags') {
        // /api/tags consome quase todo o prazo antes de responder.
        await new Promise((resolve) => setTimeout(resolve, 90));
        return tagsResponse(MODEL);
      }
      return hangingUntilAbort(init);
    });

    const pending = testConnection(ENDPOINT, MODEL, { fetchFn, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(90);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(99);
    expect(fetchFn.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' });
    expect(fetchFn.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
