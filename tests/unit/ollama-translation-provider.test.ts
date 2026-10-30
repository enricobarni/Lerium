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

  it('sinal falso com a forma de AbortSignal -> invalid_input sem fetch', async () => {
    const fetchFn = fetchWith(() => okResponse(token('x'), doneLine()));
    const fakeSignal = {
      aborted: false,
      reason: undefined,
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const result = await providerWith(fetchFn).translate(INPUT, {
      signal: fakeSignal as unknown as AbortSignal,
    });

    expect(result).toEqual({ ok: false, error: 'invalid_input', retryable: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([null, 'fn', 42, {}])(
    'onToken %s (não função) -> invalid_input sem fetch',
    async (value) => {
      const fetchFn = fetchWith(() => okResponse(token('x'), doneLine()));

      const result = await providerWith(fetchFn).translate(INPUT, {
        onToken: value as unknown as (delta: string) => void,
      });

      expect(result).toEqual({ ok: false, error: 'invalid_input', retryable: false });
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('getter de opção que lança -> invalid_input sem fetch', async () => {
    const fetchFn = fetchWith(() => okResponse(token('x'), doneLine()));
    const options = {
      get signal(): AbortSignal {
        throw new Error('getter');
      },
    };

    await expect(providerWith(fetchFn).translate(INPUT, options)).resolves.toEqual({
      ok: false,
      error: 'invalid_input',
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('nunca rejeita: exceção inesperada interna -> internal_error', async () => {
    const fetchFn = fetchWith(() => okResponse(token('x'), doneLine()));
    const now = () => {
      throw new Error('relógio quebrado');
    };

    await expect(providerWith(fetchFn, { now }).translate(INPUT)).resolves.toEqual({
      ok: false,
      error: 'internal_error',
      retryable: false,
    });
  });

  it('exceção interna depois do chat -> internal_error, não invalid_input', async () => {
    const fetchFn = fetchWith(() => okResponse(token('Oi'), doneLine()));
    let calls = 0;
    // 1ª leitura (início) funciona; a 2ª (fim, para durationMs) lança.
    const now = () => {
      calls += 1;
      if (calls > 1) throw new Error('relógio quebrado');
      return 0;
    };

    const result = await settle(providerWith(fetchFn, { now }).translate(INPUT));

    expect(result).toEqual({ ok: false, error: 'internal_error', retryable: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
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

/** `fetch` que responde, em ordem, com cada fábrica dada (a última se repete). */
const fetchSequence = (...steps: (() => Response | Promise<Response>)[]) => {
  let call = 0;
  return vi.fn<typeof fetch>(async () => {
    const step = steps[Math.min(call, steps.length - 1)];
    call += 1;
    if (step === undefined) throw new Error('sequência vazia');
    return step();
  });
};

const throwNetwork = (): never => {
  throw new TypeError('Failed to fetch');
};

describe('translate: nova tentativa interna', () => {
  it.each<[string, () => Response]>([
    ['erro de rede', throwNetwork],
    ['stream sem done e sem token', () => okResponse()],
    ['503', () => statusResponse(503)],
    ['500', () => statusResponse(500)],
    ['429', () => statusResponse(429)],
  ])('sucesso na 2ª tentativa após %s, com tokens só dela', async (_label, first) => {
    const fetchFn = fetchSequence(first, () =>
      okResponse(token('A noite '), token('era fria.'), doneLine()),
    );
    const tokens: string[] = [];

    const result = await settle(
      providerWith(fetchFn).translate(INPUT, { onToken: (delta) => tokens.push(delta) }),
    );

    expect(result).toMatchObject({ ok: true, text: 'A noite era fria.' });
    expect(tokens).toEqual(['A noite ', 'era fria.']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('reusa o mesmo pedido na 2ª tentativa', async () => {
    const fetchFn = fetchSequence(throwNetwork, () => okResponse(token('Oi'), doneLine()));

    await settle(providerWith(fetchFn).translate(INPUT));

    const [first, second] = fetchFn.mock.calls;
    expect(String(second?.[0])).toBe(String(first?.[0]));
    expect(second?.[1]?.body).toBe(first?.[1]?.body);
  });

  it.each<[string, () => Response, Omit<Extract<TranslationResult, { ok: false }>, 'ok'>]>([
    ['404', () => statusResponse(404), { error: 'model_missing', retryable: false, status: 404 }],
    ['500', () => statusResponse(500), { error: 'http_error', retryable: true, status: 500 }],
    ['400', () => statusResponse(400), { error: 'http_error', retryable: false, status: 400 }],
    ['done sem texto', () => okResponse(doneLine()), { error: 'empty_response', retryable: false }],
  ])('falha da 2ª tentativa (%s) é a devolvida', async (_label, second, expected) => {
    const fetchFn = fetchSequence(() => statusResponse(503), second);

    const result = await settle(providerWith(fetchFn).translate(INPUT));

    expect(result).toEqual({ ok: false, ...expected });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('nunca passa de duas chamadas', async () => {
    const fetchFn = networkFailure();

    const result = await settle(providerWith(fetchFn).translate(INPUT));

    expect(result).toEqual({ ok: false, error: 'network', retryable: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('não repete após token entregue', async () => {
    const fetchFn = fetchSequence(
      () => okResponse(token('A noite')),
      () => okResponse(token('x'), doneLine()),
    );
    const tokens: string[] = [];

    const result = await settle(
      providerWith(fetchFn).translate(INPUT, { onToken: (delta) => tokens.push(delta) }),
    );

    expect(result).toEqual({ ok: false, error: 'network', retryable: true });
    expect(tokens).toEqual(['A noite']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => Response]>([
    ['400', () => statusResponse(400)],
    ['401', () => statusResponse(401)],
    ['403', () => statusResponse(403)],
    ['404', () => statusResponse(404)],
    ['linha de erro do Ollama', () => okResponse(`${JSON.stringify({ error: 'boom' })}\n`)],
    ['resposta inválida', () => okResponse('not json\n')],
    ['truncada', () => okResponse(token('A'), doneLine({ done_reason: 'length' }))],
    ['vazia', () => okResponse(doneLine())],
  ])('não repete após %s', async (_label, first) => {
    const fetchFn = fetchSequence(first, () => okResponse(token('x'), doneLine()));

    const result = await settle(providerWith(fetchFn).translate(INPUT));

    expect(result.ok).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('não repete após prazo estourado', async () => {
    const fetchFn = hangingFetch();
    const pending = providerWith(fetchFn, { timeouts: { firstTokenMs: 1000 } }).translate(INPUT);

    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ ok: false, error: 'timeout', retryable: true });
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('não repete quando onToken lança', async () => {
    const fetchFn = fetchSequence(
      () => okResponse(token('A')),
      () => okResponse(token('x'), doneLine()),
    );

    const result = await settle(
      providerWith(fetchFn).translate(INPUT, {
        onToken: () => {
          throw new Error('falha do consumidor');
        },
      }),
    );

    expect(result).toEqual({ ok: false, error: 'consumer_error', retryable: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('não repete quando o sinal aborta durante a 1ª tentativa', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>(async () => {
      controller.abort();
      throw new TypeError('Failed to fetch');
    });

    const result = await settle(
      providerWith(fetchFn).translate(INPUT, { signal: controller.signal }),
    );

    expect(result).toEqual({ ok: false, error: 'cancelled', retryable: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('abort logo depois de o chat decidir network -> cancelled, sem 2ª tentativa', async () => {
    const controller = new AbortController();
    const { signal } = controller;
    // O chat remove seu listener do sinal externo no `finally`, já com a
    // falha `network` decidida: abortar ali simula um abort que chega no
    // mesmo tick, depois do chat e antes de o provedor decidir repetir.
    let armed = true;
    signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => {
      AbortSignal.prototype.removeEventListener.apply(signal, args);
      if (armed) {
        armed = false;
        controller.abort();
      }
    };
    const fetchFn = networkFailure();

    const result = await settle(providerWith(fetchFn).translate(INPUT, { signal }));

    expect(armed).toBe(false);
    expect(result).toEqual({ ok: false, error: 'cancelled', retryable: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('abort logo depois de a 2ª tentativa falhar -> cancelled', async () => {
    const controller = new AbortController();
    const { signal } = controller;
    const fetchFn = vi.fn<typeof fetch>(async () => {
      if (fetchFn.mock.calls.length === 2) {
        // Mesmo truque do teste acima, armado só durante a 2ª chamada.
        signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => {
          AbortSignal.prototype.removeEventListener.apply(signal, args);
          controller.abort();
        };
      }
      throw new TypeError('Failed to fetch');
    });

    const result = await settle(providerWith(fetchFn).translate(INPUT, { signal }));

    expect(result).toEqual({ ok: false, error: 'cancelled', retryable: false });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('espera retryDelayMs antes da 2ª chamada', async () => {
    const fetchFn = fetchSequence(throwNetwork, () => okResponse(token('Oi'), doneLine()));
    const pending = providerWith(fetchFn, { retryDelayMs: 300 }).translate(INPUT);

    await vi.advanceTimersByTimeAsync(299);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toMatchObject({ ok: true, text: 'Oi' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '500'])(
    'retryDelayMs inválido (%s) usa o padrão de 500 ms',
    async (retryDelayMs) => {
      const fetchFn = fetchSequence(throwNetwork, () => okResponse(token('Oi'), doneLine()));
      const pending = providerWith(fetchFn, { retryDelayMs: retryDelayMs as number }).translate(
        INPUT,
      );

      await vi.advanceTimersByTimeAsync(499);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toMatchObject({ ok: true });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    },
  );

  it('abort durante a espera devolve cancelled na hora, sem 2ª chamada', async () => {
    const controller = new AbortController();
    const fetchFn = fetchSequence(throwNetwork, () => okResponse(token('Oi'), doneLine()));
    const pending = providerWith(fetchFn).translate(INPUT, { signal: controller.signal });
    const state = track(pending);

    await vi.advanceTimersByTimeAsync(100);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(state.settled).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(state.settled).toBe(true);
    expect(await pending).toEqual({ ok: false, error: 'cancelled', retryable: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a 2ª tentativa tem prazos novos', async () => {
    let call = 0;
    const hang = hangingFetch();
    const fetchFn = vi.fn<typeof fetch>((input, init) => {
      call += 1;
      if (call === 1) {
        return new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new TypeError('Failed to fetch')), 900);
        });
      }
      return hang(input, init);
    });
    const pending = providerWith(fetchFn, {
      timeouts: { firstTokenMs: 1000, totalMs: 1000 },
    }).translate(INPUT);
    const state = track(pending);

    await vi.advanceTimersByTimeAsync(900 + 500 + 999);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ ok: false, error: 'timeout', retryable: true });
  });

  it('durationMs cobre as duas tentativas e a espera', async () => {
    let clock = 0;
    const fetchFn = fetchSequence(
      () => {
        clock += 100;
        return throwNetwork();
      },
      () => {
        clock += 500 + 250;
        return okResponse(token('Oi'), doneLine());
      },
    );

    const result = await settle(providerWith(fetchFn, { now: () => clock }).translate(INPUT));

    expect(result).toMatchObject({ ok: true, durationMs: 850 });
  });
});

/** PRNG determinístico (mulberry32): os cortes se repetem em toda execução. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fatia `bytes` em pontos aleatórios, inclusive no meio de caracteres multibyte. */
function sliceRandomly(bytes: Uint8Array, random: () => number): Uint8Array[] {
  const cuts = new Set<number>();
  const count = 1 + Math.floor(random() * 40);
  for (let i = 0; i < count; i += 1) cuts.add(1 + Math.floor(random() * (bytes.length - 1)));
  const sorted = [...cuts].sort((a, b) => a - b);
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const cut of [...sorted, bytes.length]) {
    chunks.push(bytes.slice(start, cut));
    start = cut;
  }
  return chunks;
}

/** Byte de continuação UTF-8 (`10xxxxxx`): cortar antes dele divide um caractere. */
const isContinuationByte = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0xc0) === 0x80;

describe('translate: nenhum conteúdo perdido por chunk', () => {
  const EXPECTED = 'Ação no coração — “olá”, disse ela. 😀🐉 世界の物語 한국어 fim.';
  // Tokens de tamanhos variados, por ponto de código (sem quebrar pares substitutos).
  const codePoints = [...EXPECTED];
  const tokens: string[] = [];
  for (let i = 0; i < codePoints.length; i += 1 + (i % 4)) {
    tokens.push(codePoints.slice(i, i + 1 + (i % 4)).join(''));
  }
  const bytes = encoder.encode(tokens.map(token).join('') + doneLine({ eval_count: 9 }));
  const random = mulberry32(0x1e21);
  const RUNS = 64;
  let midCharacterCuts = 0;

  it('os tokens recompõem o texto esperado', () => {
    expect(tokens.join('')).toBe(EXPECTED);
  });

  it(`${RUNS} fatiamentos aleatórios preservam o texto`, async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const chunks = sliceRandomly(bytes, random);
      let offset = 0;
      for (const chunk of chunks.slice(0, -1)) {
        offset += chunk.length;
        if (isContinuationByte(bytes[offset])) midCharacterCuts += 1;
      }
      const fetchFn = fetchWith(() => okResponse(...chunks));
      const received: string[] = [];

      const result = await providerWith(fetchFn).translate(INPUT, {
        onToken: (delta) => received.push(delta),
      });

      expect(result).toMatchObject({ ok: true, text: EXPECTED, outputTokens: 9 });
      expect(received.join('')).toBe(EXPECTED);
    }
    // Garante que o cenário difícil (corte no meio de um caractere) foi exercitado.
    expect(midCharacterCuts).toBeGreaterThan(0);
  });
});
