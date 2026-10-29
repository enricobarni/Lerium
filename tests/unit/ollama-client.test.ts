import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIST_MODELS_TIMEOUT_MS, hasModel, listModels } from '../../src/core/ollama-client';

const ENDPOINT = 'http://localhost:11434';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const fetchReturning = (response: Response) => vi.fn<typeof fetch>(async () => response);

afterEach(() => {
  vi.useRealTimers();
});

describe('listModels: requisição', () => {
  it('faz GET em /api/tags sem credenciais nem cache', async () => {
    const fetchFn = fetchReturning(jsonResponse({ models: [] }));

    await listModels(ENDPOINT, { fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://localhost:11434/api/tags');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('omit');
    expect(init?.cache).toBe('no-store');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('normaliza o endpoint de forma defensiva', async () => {
    const fetchFn = fetchReturning(jsonResponse({ models: [] }));

    await listModels(' http://127.0.0.1:8080/ ', { fetchFn });

    expect(String(fetchFn.mock.calls[0]?.[0])).toBe('http://127.0.0.1:8080/api/tags');
  });

  it.each(['http://example.com:11434', 'https://localhost:11434', 'http://localhost:11434/x', ''])(
    'recusa o endpoint "%s" sem chamar fetch',
    async (endpoint) => {
      const fetchFn = fetchReturning(jsonResponse({ models: [] }));

      await expect(listModels(endpoint, { fetchFn })).resolves.toEqual({
        ok: false,
        error: 'invalid_endpoint',
      });
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
});

describe('listModels: sucesso', () => {
  it('devolve nomes únicos e ordenados', async () => {
    const fetchFn = fetchReturning(
      jsonResponse({
        models: [
          { name: 'qwen3:8b', size: 1 },
          { name: 'translategemma:4b' },
          { name: 'llama3.1:8b' },
          { name: 'qwen3:8b' },
        ],
      }),
    );

    await expect(listModels(ENDPOINT, { fetchFn })).resolves.toEqual({
      ok: true,
      models: ['llama3.1:8b', 'qwen3:8b', 'translategemma:4b'],
    });
  });

  it('aceita lista vazia', async () => {
    const fetchFn = fetchReturning(jsonResponse({ models: [] }));

    await expect(listModels(ENDPOINT, { fetchFn })).resolves.toEqual({ ok: true, models: [] });
  });

  it('ignora entradas malformadas ou com nome fora da allowlist', async () => {
    const fetchFn = fetchReturning(
      jsonResponse({
        models: [
          null,
          'llama3',
          { model: 'sem-name' },
          { name: 42 },
          { name: '' },
          { name: '<img src=x>' },
          { name: '../etc' },
          { name: 'ok:1b' },
        ],
      }),
    );

    await expect(listModels(ENDPOINT, { fetchFn })).resolves.toEqual({
      ok: true,
      models: ['ok:1b'],
    });
  });
});

describe('listModels: erros HTTP', () => {
  it.each([
    [403, { ok: false, error: 'forbidden', status: 403 }],
    [404, { ok: false, error: 'not_found', status: 404 }],
    [500, { ok: false, error: 'http_error', status: 500 }],
    [401, { ok: false, error: 'http_error', status: 401 }],
  ])('status %i vira o erro esperado', async (status, expected) => {
    const fetchFn = fetchReturning(jsonResponse({ error: 'x' }, status));

    await expect(listModels(ENDPOINT, { fetchFn })).resolves.toEqual(expected);
  });
});

describe('listModels: resposta inválida', () => {
  it.each([
    ['JSON inválido', new Response('<html>não é json</html>', { status: 200 })],
    ['objeto sem models', jsonResponse({ tags: [] })],
    ['models não é lista', jsonResponse({ models: 'qwen3' })],
    ['corpo nulo', jsonResponse(null)],
    ['corpo é lista', jsonResponse([{ name: 'qwen3' }])],
  ])('%s vira invalid_response', async (_label, response) => {
    const fetchFn = fetchReturning(response);

    await expect(listModels(ENDPOINT, { fetchFn })).resolves.toEqual({
      ok: false,
      error: 'invalid_response',
    });
  });
});

describe('listModels: rede e timeout', () => {
  it('TypeError de rede vira network, com um único fetch', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(listModels(ENDPOINT, { fetchFn })).resolves.toEqual({
      ok: false,
      error: 'network',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['2xx', () => jsonResponse({ models: [] })],
    ['403', () => jsonResponse({ error: 'x' }, 403)],
    ['404', () => jsonResponse({ error: 'x' }, 404)],
    ['500', () => jsonResponse({ error: 'x' }, 500)],
    ['JSON inválido', () => new Response('<html></html>', { status: 200 })],
    [
      'TypeError',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ])('faz exatamente um fetch, nunca no-cors (%s)', async (_label, make) => {
    const fetchFn = vi.fn<typeof fetch>(async () => make());

    await listModels(ENDPOINT, { fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    for (const [, init] of fetchFn.mock.calls) {
      expect(init?.mode).not.toBe('no-cors');
    }
  });

  it('aborto não causado pelo timeout vira network', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });

    await expect(listModels(ENDPOINT, { fetchFn })).resolves.toEqual({
      ok: false,
      error: 'network',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  const hangingFetch = () =>
    vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

  it('aborta a requisição e devolve timeout no prazo padrão', async () => {
    vi.useFakeTimers();
    const fetchFn = hangingFetch();

    const pending = listModels(ENDPOINT, { fetchFn });
    await vi.advanceTimersByTimeAsync(DEFAULT_LIST_MODELS_TIMEOUT_MS - 1);
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' });
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('respeita timeoutMs personalizado', async () => {
    vi.useFakeTimers();
    const fetchFn = hangingFetch();

    const pending = listModels(ENDPOINT, { fetchFn, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' });
  });

  it('o timeout também cobre a leitura do corpo', async () => {
    vi.useFakeTimers();
    const slowBody = {
      ok: true,
      status: 200,
      json: () => new Promise<unknown>(() => {}),
    } as unknown as Response;
    const fetchFn = fetchReturning(slowBody);

    const pending = listModels(ENDPOINT, { fetchFn, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' });
  });

  it('limpa o timer após sucesso e após erro', async () => {
    vi.useFakeTimers();

    await listModels(ENDPOINT, { fetchFn: fetchReturning(jsonResponse({ models: [] })) });
    expect(vi.getTimerCount()).toBe(0);

    await listModels(ENDPOINT, {
      fetchFn: vi.fn<typeof fetch>(async () => {
        throw new TypeError('Failed to fetch');
      }),
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('hasModel', () => {
  const models = ['llama3.1:8b', 'qwen3:latest', 'hf.co/user/repo:Q4_K_M'];

  it('encontra o nome exato', () => {
    expect(hasModel(models, 'llama3.1:8b')).toBe(true);
    expect(hasModel(models, 'hf.co/user/repo:Q4_K_M')).toBe(true);
  });

  it('trata "nome" e "nome:latest" como equivalentes', () => {
    expect(hasModel(models, 'qwen3')).toBe(true);
    expect(hasModel(['qwen3'], 'qwen3:latest')).toBe(true);
    expect(hasModel(['hf.co/user/repo'], 'hf.co/user/repo:latest')).toBe(true);
  });

  it('não confunde tags diferentes nem prefixos', () => {
    expect(hasModel(models, 'llama3.1')).toBe(false);
    expect(hasModel(models, 'llama3.1:70b')).toBe(false);
    expect(hasModel(models, 'qwen3:8b')).toBe(false);
    expect(hasModel(models, 'qwen')).toBe(false);
    expect(hasModel([], 'qwen3')).toBe(false);
  });
});
