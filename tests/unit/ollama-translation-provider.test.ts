import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatStreamErrorKind } from '../../src/core/ollama-client';
import {
  createOllamaTranslationProvider,
  mapBuildError,
  mapChatFailure,
  type OllamaTranslationProviderConfig,
} from '../../src/core/ollama-translation-provider';
import { buildChatRequest, type BuildChatRequestError } from '../../src/core/prompt-builder';
import type {
  TranslationErrorKind,
  TranslationInput,
  TranslationResult,
} from '../../src/core/translation-provider';

const ENDPOINT = 'http://localhost:11434';
const MODEL = 'translategemma:4b';
const INPUT: TranslationInput = { text: 'The night was cold.', source: 'en', target: 'pt-BR' };

const encoder = new TextEncoder();

const token = (content: string): string =>
  `${JSON.stringify({ message: { role: 'assistant', content }, done: false })}\n`;

const doneLine = (extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
    ...extra,
  })}\n`;

/** Corpo já completo, dividido nos chunks dados. */
const streamOf = (...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });

const okResponse = (...chunks: (string | Uint8Array)[]): Response =>
  new Response(streamOf(...chunks), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });

const statusResponse = (status: number): Response => new Response(null, { status });

/** Cada chamada recebe uma `Response` nova, criada por `make`. */
const fetchWith = (make: () => Response | Promise<Response>) =>
  vi.fn<typeof fetch>(async () => make());

/** `fetch` cujos cabeçalhos nunca chegam; rejeita só quando o sinal aborta. */
const hangingFetch = () =>
  vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
  );

const networkFailure = () =>
  vi.fn<typeof fetch>(async () => {
    throw new TypeError('Failed to fetch');
  });

const providerWith = (
  fetchFn: typeof fetch,
  extra: Partial<OllamaTranslationProviderConfig> = {},
) => createOllamaTranslationProvider({ endpoint: ENDPOINT, model: MODEL, fetchFn, ...extra });

/** Promessa observável: indica se já foi resolvida sem precisar aguardá-la. */
function track<T>(promise: Promise<T>) {
  const state = { settled: false };
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

/**
 * Aguarda o resultado avançando o relógio falso em passos curtos (para
 * atravessar esperas internas curtas) sem alcançar os prazos do chat.
 */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const state = track(promise);
  for (let i = 0; i < 20 && !state.settled; i += 1) {
    await vi.advanceTimersByTimeAsync(100);
  }
  return promise;
}

const failureOf = (result: TranslationResult) => {
  if (result.ok) throw new Error('esperava falha');
  return result;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  try {
    // Nenhum caminho deixa timer pendente (prazos do chat ou espera interna).
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

describe('mapeamento de erros do PromptBuilder', () => {
  it.each<[BuildChatRequestError, TranslationErrorKind]>([
    ['invalid_model', 'invalid_config'],
    ['invalid_source_language', 'invalid_config'],
    ['invalid_target_language', 'invalid_config'],
    ['same_language', 'invalid_config'],
    ['invalid_text', 'invalid_input'],
    ['empty_text', 'invalid_input'],
  ])('%s -> %s, não repetível', (error, expected) => {
    expect(mapBuildError(error)).toEqual({ ok: false, error: expected, retryable: false });
  });
});

describe('mapeamento de falhas do chat', () => {
  it.each<[ChatStreamErrorKind, number | undefined, TranslationErrorKind, boolean]>([
    ['invalid_endpoint', undefined, 'invalid_config', false],
    ['invalid_model', undefined, 'invalid_config', false],
    ['invalid_request', undefined, 'invalid_input', false],
    ['network', undefined, 'network', true],
    ['incomplete_stream', undefined, 'network', true],
    ['timeout', undefined, 'timeout', true],
    ['forbidden', 403, 'forbidden', false],
    ['model_missing', 404, 'model_missing', false],
    ['http_error', 500, 'http_error', true],
    ['http_error', 503, 'http_error', true],
    ['http_error', 599, 'http_error', true],
    ['http_error', 429, 'http_error', true],
    ['http_error', 400, 'http_error', false],
    ['http_error', 401, 'http_error', false],
    ['http_error', 600, 'http_error', false],
    ['http_error', undefined, 'http_error', false],
    ['ollama_error', undefined, 'provider_error', false],
    ['invalid_response', undefined, 'invalid_response', false],
    ['truncated', undefined, 'truncated', false],
    ['empty_response', undefined, 'empty_response', false],
    ['cancelled', undefined, 'cancelled', false],
    ['consumer_error', undefined, 'consumer_error', false],
  ])('%s (status %s) -> %s, retryable %s', (error, status, expected, retryable) => {
    const input = { ok: false as const, error, ...(status !== undefined ? { status } : {}) };
    expect(mapChatFailure(input)).toEqual({
      ok: false,
      error: expected,
      retryable,
      ...(status !== undefined ? { status } : {}),
    });
  });

  it.each(['first_token', 'idle', 'total'] as const)(
    'timeout na fase %s -> timeout, repetível',
    (phase) => {
      expect(mapChatFailure({ ok: false, error: 'timeout', timeout: phase })).toEqual({
        ok: false,
        error: 'timeout',
        retryable: true,
      });
    },
  );
});

describe('translate: ponta a ponta com fetch falso', () => {
  it('traduz e entrega os tokens em ordem', async () => {
    const fetchFn = fetchWith(() => okResponse(token('A noite '), token('era fria.'), doneLine()));
    const tokens: string[] = [];

    const result = await providerWith(fetchFn).translate(INPUT, {
      onToken: (delta) => tokens.push(delta),
    });

    expect(result).toMatchObject({ ok: true, text: 'A noite era fria.' });
    expect(tokens).toEqual(['A noite ', 'era fria.']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<TranslationInput> | Record<string, unknown>, TranslationErrorKind]>([
    ['texto não string', { text: 42 }, 'invalid_input'],
    ['texto vazio', { text: '   ' }, 'invalid_input'],
    ['origem inválida', { source: 'xx' }, 'invalid_config'],
    ['destino inválido', { target: 'xx' }, 'invalid_config'],
    ['mesmo idioma', { source: 'en', target: 'en' }, 'invalid_config'],
  ])('%s -> %s sem chamar fetch', async (_label, patch, expected) => {
    const fetchFn = fetchWith(() => okResponse(token('x'), doneLine()));

    const result = await providerWith(fetchFn).translate({
      ...INPUT,
      ...patch,
    } as TranslationInput);

    expect(result).toEqual({ ok: false, error: expected, retryable: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('modelo inválido na criação -> invalid_config sem fetch', async () => {
    const fetchFn = fetchWith(() => okResponse(token('x'), doneLine()));

    const result = await providerWith(fetchFn, { model: 'bad model!' }).translate(INPUT);

    expect(result).toEqual({ ok: false, error: 'invalid_config', retryable: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('endpoint fora do loopback -> invalid_config sem fetch', async () => {
    const fetchFn = fetchWith(() => okResponse(token('x'), doneLine()));

    const result = await providerWith(fetchFn, { endpoint: 'http://example.com:11434' }).translate(
      INPUT,
    );

    expect(result).toEqual({ ok: false, error: 'invalid_config', retryable: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each<[string, () => typeof fetch, Omit<Extract<TranslationResult, { ok: false }>, 'ok'>]>([
    ['erro de rede', networkFailure, { error: 'network', retryable: true }],
    [
      'stream sem done',
      () => fetchWith(() => okResponse(token('A noite'))),
      { error: 'network', retryable: true },
    ],
    [
      '403',
      () => fetchWith(() => statusResponse(403)),
      { error: 'forbidden', retryable: false, status: 403 },
    ],
    [
      '404',
      () => fetchWith(() => statusResponse(404)),
      { error: 'model_missing', retryable: false, status: 404 },
    ],
    [
      '500',
      () => fetchWith(() => statusResponse(500)),
      { error: 'http_error', retryable: true, status: 500 },
    ],
    [
      '503',
      () => fetchWith(() => statusResponse(503)),
      { error: 'http_error', retryable: true, status: 503 },
    ],
    [
      '429',
      () => fetchWith(() => statusResponse(429)),
      { error: 'http_error', retryable: true, status: 429 },
    ],
    [
      '400',
      () => fetchWith(() => statusResponse(400)),
      { error: 'http_error', retryable: false, status: 400 },
    ],
    [
      'linha de erro do Ollama',
      () => fetchWith(() => okResponse(`${JSON.stringify({ error: 'boom' })}\n`)),
      { error: 'provider_error', retryable: false },
    ],
    [
      'linha que não é JSON',
      () => fetchWith(() => okResponse('not json\n')),
      { error: 'invalid_response', retryable: false },
    ],
    [
      'done_reason length',
      () => fetchWith(() => okResponse(token('A'), doneLine({ done_reason: 'length' }))),
      { error: 'truncated', retryable: false },
    ],
    [
      'done sem texto',
      () => fetchWith(() => okResponse(doneLine())),
      { error: 'empty_response', retryable: false },
    ],
  ])('%s', async (_label, makeFetch, expected) => {
    const result = await settle(providerWith(makeFetch()).translate(INPUT));

    expect(result).toEqual({ ok: false, ...expected });
  });

  it('prazo do primeiro token -> timeout, repetível', async () => {
    const fetchFn = hangingFetch();
    const pending = providerWith(fetchFn, { timeouts: { firstTokenMs: 1000 } }).translate(INPUT);

    await vi.advanceTimersByTimeAsync(1000);

    expect(await pending).toEqual({ ok: false, error: 'timeout', retryable: true });
  });

  it('sinal já abortado -> cancelled sem fetch', async () => {
    const fetchFn = fetchWith(() => okResponse(token('x'), doneLine()));
    const controller = new AbortController();
    controller.abort();

    const result = await providerWith(fetchFn).translate(INPUT, { signal: controller.signal });

    expect(result).toEqual({ ok: false, error: 'cancelled', retryable: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('abort durante o stream -> cancelled', async () => {
    const fetchFn = hangingFetch();
    const controller = new AbortController();
    const pending = providerWith(fetchFn).translate(INPUT, { signal: controller.signal });

    controller.abort();

    expect(await pending).toEqual({ ok: false, error: 'cancelled', retryable: false });
  });

  it('onToken que lança -> consumer_error', async () => {
    const fetchFn = fetchWith(() => okResponse(token('A'), token('B'), doneLine()));

    const result = await settle(
      providerWith(fetchFn).translate(INPUT, {
        onToken: () => {
          throw new Error('falha do consumidor');
        },
      }),
    );

    expect(result).toEqual({ ok: false, error: 'consumer_error', retryable: false });
  });
});

describe('translate: entradas anômalas', () => {
  it.each([null, undefined, 'texto', 42, true])(
    'entrada %s -> invalid_input sem fetch',
    async (input) => {
      const fetchFn = fetchWith(() => okResponse(token('x'), doneLine()));

      const result = await providerWith(fetchFn).translate(input as unknown as TranslationInput);

      expect(result).toEqual({ ok: false, error: 'invalid_input', retryable: false });
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('nunca rejeita: getter que lança -> invalid_input', async () => {
    const fetchFn = fetchWith(() => okResponse(token('x'), doneLine()));
    const input = {
      get text(): string {
        throw new Error('getter');
      },
      source: 'en',
      target: 'pt-BR',
    } as TranslationInput;

    await expect(providerWith(fetchFn).translate(input)).resolves.toEqual({
      ok: false,
      error: 'invalid_input',
      retryable: false,
    });
  });

  it('nunca rejeita: sinal que não é AbortSignal -> invalid_input', async () => {
    const fetchFn = fetchWith(() => okResponse(token('x'), doneLine()));

    await expect(
      providerWith(fetchFn).translate(INPUT, { signal: {} as AbortSignal }),
    ).resolves.toEqual({ ok: false, error: 'invalid_input', retryable: false });
  });

  it('opções que não são objeto são ignoradas', async () => {
    const fetchFn = fetchWith(() => okResponse(token('Oi'), doneLine()));

    const result = await providerWith(fetchFn).translate(INPUT, null as never);

    expect(result).toMatchObject({ ok: true, text: 'Oi' });
  });

  it('fetch que lança de forma síncrona -> network', async () => {
    const fetchFn = vi.fn<typeof fetch>(() => {
      throw new TypeError('sync');
    });

    const result = await settle(providerWith(fetchFn).translate(INPUT));

    expect(failureOf(result).error).toBe('network');
  });
});

describe('translate: métricas', () => {
  it('durationMs vem do relógio injetado, arredondado', async () => {
    let clock = 1000;
    const fetchFn = fetchWith(() => {
      clock += 1234.4;
      return okResponse(token('Oi'), doneLine());
    });

    const result = await providerWith(fetchFn, { now: () => clock }).translate(INPUT);

    expect(result).toMatchObject({ ok: true, durationMs: 1234 });
  });

  it('durationMs nunca é negativo', async () => {
    let clock = 5000;
    const fetchFn = fetchWith(() => {
      clock -= 100;
      return okResponse(token('Oi'), doneLine());
    });

    const result = await providerWith(fetchFn, { now: () => clock }).translate(INPUT);

    expect(result).toMatchObject({ ok: true, durationMs: 0 });
  });

  it('outputTokens vem de eval_count', async () => {
    const fetchFn = fetchWith(() => okResponse(token('Oi'), doneLine({ eval_count: 7 })));

    const result = await providerWith(fetchFn).translate(INPUT);

    expect(result).toMatchObject({ ok: true, outputTokens: 7 });
  });

  it('sem eval_count a chave outputTokens é omitida', async () => {
    const fetchFn = fetchWith(() => okResponse(token('Oi'), doneLine()));

    const result = await providerWith(fetchFn).translate(INPUT);

    expect(result.ok).toBe(true);
    expect(Object.keys(result)).not.toContain('outputTokens');
  });
});

describe('translate: snapshot da configuração', () => {
  it('usa o endpoint e o modelo da criação e envia o corpo do PromptBuilder', async () => {
    const fetchFn = fetchWith(() => okResponse(token('Oi'), doneLine()));
    const config: OllamaTranslationProviderConfig = {
      endpoint: 'http://127.0.0.1:8080',
      model: MODEL,
      fetchFn,
    };
    const provider = createOllamaTranslationProvider(config);
    config.endpoint = 'http://localhost:9999';
    config.model = 'outro:1b';

    await provider.translate(INPUT);

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:8080/api/chat');
    const expected = buildChatRequest({ ...INPUT, model: MODEL });
    if (!expected.ok) throw new Error('pedido inválido');
    expect(JSON.parse(String(init?.body))).toEqual(expected.request);
  });

  it('copia os prazos na criação', async () => {
    const fetchFn = hangingFetch();
    const timeouts = { firstTokenMs: 1000 };
    const provider = providerWith(fetchFn, { timeouts });
    timeouts.firstTokenMs = 60_000;

    const pending = provider.translate(INPUT);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await pending).toEqual({ ok: false, error: 'timeout', retryable: true });
  });
});
