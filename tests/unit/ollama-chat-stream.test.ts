import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatStream,
  DEFAULT_CHAT_TIMEOUTS,
  type ChatStreamOptions,
} from '../../src/core/ollama-client';
import type { ChatRequest } from '../../src/core/prompt-builder';

const ENDPOINT = 'http://localhost:11434';

const REQUEST: ChatRequest = {
  model: 'translategemma:4b',
  messages: [{ role: 'user', content: 'Please translate the following text: hello' }],
  stream: true,
  options: { temperature: 0.2, num_predict: 256 },
};

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

/** Corpo controlado pelo teste; `cancel` registra o cancelamento do leitor. */
function controlledBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel,
  });
  return {
    stream,
    cancel,
    push(chunk: string | Uint8Array) {
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    },
    close() {
      controller.close();
    },
    error() {
      controller.error(new TypeError('network error'));
    },
  };
}

/** Corpo já completo, dividido nos chunks dados. */
const bodyOf = (...chunks: (string | Uint8Array)[]) => {
  const body = controlledBody();
  for (const chunk of chunks) body.push(chunk);
  body.close();
  return body;
};

const okResponse = (stream: ReadableStream<Uint8Array>): Response =>
  new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });

const fetchReturning = (response: Response) => vi.fn<typeof fetch>(async () => response);

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

/** Promessa observável: indica se já foi resolvida sem precisar aguardá-la. */
function track<T>(promise: Promise<T>) {
  const state = { settled: false };
  void promise.then(() => {
    state.settled = true;
  });
  return state;
}

const run = (fetchFn: typeof fetch, extra: Partial<ChatStreamOptions> = {}) =>
  chatStream(ENDPOINT, REQUEST, { fetchFn, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Todo caminho (sucesso, erro, prazo, cancelamento) limpa os seus timers.
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('chatStream: requisição', () => {
  it('faz POST JSON em /api/chat com as opções de segurança e stream: true', async () => {
    const fetchFn = fetchReturning(okResponse(bodyOf(token('Oi'), doneLine()).stream));

    await run(fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://localhost:11434/api/chat');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('omit');
    expect(init?.cache).toBe('no-store');
    expect(init?.redirect).toBe('error');
    expect(init?.mode).not.toBe('no-cors');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual(REQUEST);
    expect(JSON.parse(String(init?.body)).stream).toBe(true);
  });

  it('normaliza o endpoint de forma defensiva', async () => {
    const fetchFn = fetchReturning(okResponse(bodyOf(token('Oi'), doneLine()).stream));

    await chatStream(' http://127.0.0.1:8080/ ', REQUEST, { fetchFn });

    expect(String(fetchFn.mock.calls[0]?.[0])).toBe('http://127.0.0.1:8080/api/chat');
  });

  it.each(['http://example.com:11434', 'https://localhost:11434', 'http://localhost:11434/x', ''])(
    'recusa o endpoint "%s" sem chamar fetch',
    async (endpoint) => {
      const fetchFn = hangingFetch();

      await expect(chatStream(endpoint, REQUEST, { fetchFn })).resolves.toEqual({
        ok: false,
        error: 'invalid_endpoint',
      });
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it.each(['', '../etc', '<img src=x>', 42])(
    'recusa o modelo %j sem chamar fetch',
    async (model) => {
      const fetchFn = hangingFetch();
      const request = { ...REQUEST, model } as unknown as ChatRequest;

      await expect(chatStream(ENDPOINT, request, { fetchFn })).resolves.toEqual({
        ok: false,
        error: 'invalid_model',
      });
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('sinal já abortado devolve cancelled sem chamar fetch', async () => {
    const fetchFn = hangingFetch();
    const controller = new AbortController();
    controller.abort();

    await expect(run(fetchFn, { signal: controller.signal })).resolves.toEqual({
      ok: false,
      error: 'cancelled',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('chatStream: tokens e NDJSON', () => {
  it('entrega vários tokens em ordem e devolve o texto acumulado', async () => {
    const onToken = vi.fn();
    const body = bodyOf(token('Olá'), token(', '), token('mundo'), doneLine());

    const result = await run(fetchReturning(okResponse(body.stream)), { onToken });

    expect(onToken.mock.calls.map(([delta]) => delta)).toEqual(['Olá', ', ', 'mundo']);
    expect(result).toEqual({ ok: true, text: 'Olá, mundo', doneReason: 'stop', metrics: {} });
  });

  it('remonta JSON e UTF-8 divididos em chunks de 1 byte', async () => {
    const onToken = vi.fn();
    const bytes = encoder.encode(token('Coração ') + token('日本語') + doneLine());
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));

    const result = await run(fetchReturning(okResponse(bodyOf(...chunks).stream)), { onToken });

    expect(onToken.mock.calls.map(([delta]) => delta)).toEqual(['Coração ', '日本語']);
    expect(result).toMatchObject({ ok: true, text: 'Coração 日本語' });
  });

  it('remonta um caractere UTF-8 dividido entre dois chunks', async () => {
    const bytes = encoder.encode(token('ç') + doneLine());
    const cedilla = encoder.encode('ç');
    const split = bytes.indexOf(cedilla[0] ?? 0) + 1;

    const result = await run(
      fetchReturning(okResponse(bodyOf(bytes.slice(0, split), bytes.slice(split)).stream)),
    );

    expect(result).toMatchObject({ ok: true, text: 'ç' });
  });

  it('processa duas linhas no mesmo chunk', async () => {
    const onToken = vi.fn();
    const body = bodyOf(token('a') + token('b'), doneLine());

    const result = await run(fetchReturning(okResponse(body.stream)), { onToken });

    expect(onToken).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, text: 'ab' });
  });

  it('aceita a linha done sem \\n final', async () => {
    const body = bodyOf(token('fim'), doneLine().trimEnd());

    await expect(run(fetchReturning(okResponse(body.stream)))).resolves.toMatchObject({
      ok: true,
      text: 'fim',
    });
  });

  it('processa o conteúdo de uma linha done antes de encerrar', async () => {
    const onToken = vi.fn();
    const last = `${JSON.stringify({ message: { content: '!' }, done: true, done_reason: 'stop' })}\n`;
    const body = bodyOf(token('Oi'), last);

    const result = await run(fetchReturning(okResponse(body.stream)), { onToken });

    expect(onToken).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, text: 'Oi!' });
  });

  it('ignora linhas após done, inclusive no mesmo chunk', async () => {
    const onToken = vi.fn();
    const body = controlledBody();
    body.push(token('a') + doneLine() + token('b') + '{"error":"x"}\n' + 'não é json\n');

    const result = await run(fetchReturning(okResponse(body.stream)), { onToken });

    expect(onToken).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, text: 'a' });
    expect(body.cancel).toHaveBeenCalled();
  });

  it('copia só métricas numéricas finitas da linha done', async () => {
    const body = bodyOf(
      token('x'),
      doneLine({
        eval_count: 12,
        prompt_eval_count: '5',
        total_duration: 1000,
        load_duration: null,
        eval_duration: 500,
      }),
    );

    await expect(run(fetchReturning(okResponse(body.stream)))).resolves.toEqual({
      ok: true,
      text: 'x',
      doneReason: 'stop',
      metrics: { evalCount: 12, totalDurationNs: 1000, evalDurationNs: 500 },
    });
  });

  it('omite doneReason quando não é string', async () => {
    const body = bodyOf(token('x'), doneLine({ done_reason: 7 }));

    await expect(run(fetchReturning(okResponse(body.stream)))).resolves.toEqual({
      ok: true,
      text: 'x',
      metrics: {},
    });
  });
});

describe('chatStream: fim do stream', () => {
  it('done_reason length vira truncated, sem texto parcial', async () => {
    const body = bodyOf(token('parcial'), doneLine({ done_reason: 'length' }));

    await expect(run(fetchReturning(okResponse(body.stream)))).resolves.toEqual({
      ok: false,
      error: 'truncated',
    });
  });

  it('done com texto vazio vira empty_response', async () => {
    const body = bodyOf(token(''), doneLine());

    await expect(run(fetchReturning(okResponse(body.stream)))).resolves.toEqual({
      ok: false,
      error: 'empty_response',
    });
  });

  it('EOF sem done vira incomplete_stream', async () => {
    const body = bodyOf(token('a'), token('b'));

    await expect(run(fetchReturning(okResponse(body.stream)))).resolves.toEqual({
      ok: false,
      error: 'incomplete_stream',
    });
  });

  it('corpo vazio vira incomplete_stream', async () => {
    await expect(run(fetchReturning(okResponse(bodyOf().stream)))).resolves.toEqual({
      ok: false,
      error: 'incomplete_stream',
    });
  });

  it('linha { error } vira ollama_error sem copiar a mensagem', async () => {
    const body = bodyOf(token('a'), '{"error":"segredo interno do servidor"}\n');

    const result = await run(fetchReturning(okResponse(body.stream)));

    expect(result).toEqual({ ok: false, error: 'ollama_error' });
    expect(JSON.stringify(result)).not.toContain('segredo');
  });

  it.each([
    ['JSON inválido', 'não é json\n'],
    ['número', '42\n'],
    ['lista', '[1,2]\n'],
    ['null', 'null\n'],
    ['string', '"texto"\n'],
  ])('%s vira invalid_response', async (_label, line) => {
    const onToken = vi.fn();
    const body = bodyOf(line, token('depois'), doneLine());

    await expect(run(fetchReturning(okResponse(body.stream)), { onToken })).resolves.toEqual({
      ok: false,
      error: 'invalid_response',
    });
    expect(onToken).not.toHaveBeenCalled();
  });

  it('linha longa demais vira invalid_response', async () => {
    const body = controlledBody();
    body.push('a'.repeat(1024 * 1024 + 10));

    await expect(run(fetchReturning(okResponse(body.stream)))).resolves.toEqual({
      ok: false,
      error: 'invalid_response',
    });
    expect(body.cancel).toHaveBeenCalled();
  });

  it('erro da conexão no meio do corpo vira network', async () => {
    const body = controlledBody();
    body.push(token('a'));
    const pending = run(fetchReturning(okResponse(body.stream)));
    await vi.advanceTimersByTimeAsync(0);
    body.error();

    await expect(pending).resolves.toEqual({ ok: false, error: 'network' });
  });
});

describe('chatStream: HTTP e rede', () => {
  it('corpo nulo vira invalid_response', async () => {
    const fetchFn = fetchReturning(new Response(null, { status: 200 }));

    await expect(run(fetchFn)).resolves.toEqual({ ok: false, error: 'invalid_response' });
  });

  it.each([
    [403, { ok: false, error: 'forbidden', status: 403 }],
    [404, { ok: false, error: 'model_missing', status: 404 }],
    [500, { ok: false, error: 'http_error', status: 500 }],
  ])('status %i vira o erro esperado, sem a mensagem do corpo', async (status, expected) => {
    const fetchFn = fetchReturning(new Response('{"error":"segredo interno"}', { status }));

    const result = await run(fetchFn);

    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain('segredo');
  });

  it('fetch rejeitando vira network', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(run(fetchFn)).resolves.toEqual({ ok: false, error: 'network' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('fetch lançando de forma síncrona vira network', async () => {
    const fetchFn = vi.fn<typeof fetch>(() => {
      throw new TypeError('Failed to fetch');
    });

    await expect(run(fetchFn)).resolves.toEqual({ ok: false, error: 'network' });
  });
});

describe('chatStream: prazos', () => {
  it('first_token vence em 120 s quando os cabeçalhos nunca chegam', async () => {
    const fetchFn = hangingFetch();
    const pending = run(fetchFn);
    const state = track(pending);

    await vi.advanceTimersByTimeAsync(DEFAULT_CHAT_TIMEOUTS.firstTokenMs - 1);
    expect(state.settled).toBe(false);
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout', timeout: 'first_token' });
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('first_token vence quando o corpo chega só com linhas sem conteúdo', async () => {
    const body = controlledBody();
    const fetchFn = fetchReturning(okResponse(body.stream));
    const pending = run(fetchFn);

    await vi.advanceTimersByTimeAsync(60_000);
    body.push(token(''));
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout', timeout: 'first_token' });
    expect(body.cancel).toHaveBeenCalled();
  });

  it('idle vence 30 s após o último token', async () => {
    const body = controlledBody();
    const pending = run(fetchReturning(okResponse(body.stream)));
    const state = track(pending);

    await vi.advanceTimersByTimeAsync(1000);
    body.push(token('a'));
    await vi.advanceTimersByTimeAsync(DEFAULT_CHAT_TIMEOUTS.idleMs - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout', timeout: 'idle' });
    expect(body.cancel).toHaveBeenCalled();
  });

  it('o primeiro token desarma first_token', async () => {
    const body = controlledBody();
    const pending = run(fetchReturning(okResponse(body.stream)));
    const state = track(pending);

    for (let elapsed = 0; elapsed < 150_000; elapsed += 20_000) {
      body.push(token('.'));
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(state.settled).toBe(false);
    body.push(doneLine());

    await expect(pending).resolves.toMatchObject({ ok: true, text: '........' });
  });

  it('linhas sem conteúdo não rearmam idle', async () => {
    const body = controlledBody();
    const pending = run(fetchReturning(okResponse(body.stream)));
    const state = track(pending);

    body.push(token('a'));
    await vi.advanceTimersByTimeAsync(20_000);
    body.push(token(''));
    body.push('{"done":false}\n');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout', timeout: 'idle' });
  });

  it('total vence em 300 s mesmo com tokens a cada 20 s', async () => {
    const body = controlledBody();
    const onToken = vi.fn();
    const pending = run(fetchReturning(okResponse(body.stream)), { onToken });
    const state = track(pending);

    for (let elapsed = 0; elapsed < 280_000; elapsed += 20_000) {
      body.push(token('t'));
      await vi.advanceTimersByTimeAsync(20_000);
    }
    body.push(token('t'));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout', timeout: 'total' });
    expect(onToken).toHaveBeenCalledTimes(15);
  });

  it('mescla timeouts parciais com o padrão', async () => {
    const fetchFn = hangingFetch();
    const pending = run(fetchFn, { timeouts: { idleMs: 1000 } });
    const state = track(pending);

    await vi.advanceTimersByTimeAsync(DEFAULT_CHAT_TIMEOUTS.firstTokenMs - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout', timeout: 'first_token' });
  });

  it('aplica o idle personalizado', async () => {
    const body = controlledBody();
    const pending = run(fetchReturning(okResponse(body.stream)), { timeouts: { idleMs: 1000 } });

    body.push(token('a'));
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout', timeout: 'idle' });
  });
});

describe('chatStream: cancelamento e consumidor', () => {
  it('abort durante o fetch vira cancelled', async () => {
    const fetchFn = hangingFetch();
    const controller = new AbortController();
    const pending = run(fetchFn, { signal: controller.signal });

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, error: 'cancelled' });
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('abort durante o stream vira cancelled e cancela o leitor', async () => {
    const body = controlledBody();
    const onToken = vi.fn();
    const controller = new AbortController();
    const pending = run(fetchReturning(okResponse(body.stream)), {
      signal: controller.signal,
      onToken,
    });

    body.push(token('a'));
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();

    const result = await pending;
    expect(result).toEqual({ ok: false, error: 'cancelled' });
    expect(body.cancel).toHaveBeenCalled();
    expect(onToken).toHaveBeenCalledTimes(1);
  });

  it('abort após o timeout mantém timeout', async () => {
    const fetchFn = hangingFetch();
    const controller = new AbortController();
    const pending = run(fetchFn, { signal: controller.signal });

    await vi.advanceTimersByTimeAsync(DEFAULT_CHAT_TIMEOUTS.firstTokenMs);
    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout', timeout: 'first_token' });
  });

  it('abort externo disparado no mesmo instante do timeout não sobrescreve o motivo', async () => {
    const controller = new AbortController();
    // O abort interno (pelo prazo) dispara o externo de forma síncrona.
    const fetchFn = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            controller.abort();
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const pending = run(fetchFn, { signal: controller.signal });

    await vi.advanceTimersByTimeAsync(DEFAULT_CHAT_TIMEOUTS.firstTokenMs);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout', timeout: 'first_token' });
    expect(controller.signal.aborted).toBe(true);
  });

  it('abort feito pelo próprio onToken vira cancelled', async () => {
    const controller = new AbortController();
    const body = bodyOf(token('a'), doneLine());

    const result = await run(fetchReturning(okResponse(body.stream)), {
      signal: controller.signal,
      onToken: () => controller.abort(),
    });

    expect(result).toEqual({ ok: false, error: 'cancelled' });
  });

  it('onToken lançando vira consumer_error e libera o stream', async () => {
    const body = controlledBody();
    body.push(token('a') + token('b'));
    const onToken = vi.fn(() => {
      throw new Error('falha do consumidor');
    });
    const fetchFn = fetchReturning(okResponse(body.stream));

    const result = await run(fetchFn, { onToken });

    expect(result).toEqual({ ok: false, error: 'consumer_error' });
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(body.cancel).toHaveBeenCalled();
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('remove o listener do sinal externo ao terminar', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const body = bodyOf(token('a'), doneLine());

    await run(fetchReturning(okResponse(body.stream)), { signal: controller.signal });

    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

/** `fetch` surdo ao sinal: só resolve ou rejeita quando o teste mandar. */
function deafFetch() {
  let resolve: (response: Response) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const fetchFn = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  );
  return {
    fetchFn,
    resolve: (response: Response) => resolve(response),
    reject: (error: unknown) => reject(error),
  };
}

const doneWithText = (content: string): string =>
  `${JSON.stringify({ message: { role: 'assistant', content }, done: true, done_reason: 'stop' })}\n`;

describe('chatStream: corridas com o cancelamento', () => {
  it('linha done com texto e abort no mesmo tick vira cancelled', async () => {
    const body = controlledBody();
    const onToken = vi.fn();
    const controller = new AbortController();
    const pending = run(fetchReturning(okResponse(body.stream)), {
      signal: controller.signal,
      onToken,
    });
    await vi.advanceTimersByTimeAsync(0);

    body.push(doneWithText('fim'));
    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, error: 'cancelled' });
    expect(onToken).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalled();
  });

  it('token e abort no mesmo tick: onToken não é chamado após o abort', async () => {
    const body = controlledBody();
    const onToken = vi.fn();
    const controller = new AbortController();
    const pending = run(fetchReturning(okResponse(body.stream)), {
      signal: controller.signal,
      onToken,
    });
    body.push(token('a'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onToken).toHaveBeenCalledTimes(1);

    body.push(token('b'));
    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, error: 'cancelled' });
    expect(onToken).toHaveBeenCalledTimes(1);
  });

  it.each([404, 500])('resposta %i no mesmo tick do abort vira cancelled', async (status) => {
    const deaf = deafFetch();
    const errorBody = controlledBody();
    const controller = new AbortController();
    const pending = run(deaf.fetchFn, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);

    deaf.resolve(new Response(errorBody.stream, { status }));
    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, error: 'cancelled' });
    expect(errorBody.cancel).toHaveBeenCalled();
  });

  it('fetch surdo ao sinal: first_token vence em 120 s', async () => {
    const deaf = deafFetch();
    const pending = run(deaf.fetchFn);
    const state = track(pending);

    await vi.advanceTimersByTimeAsync(DEFAULT_CHAT_TIMEOUTS.firstTokenMs - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout', timeout: 'first_token' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fetch surdo ao sinal: abort externo vira cancelled', async () => {
    const deaf = deafFetch();
    const controller = new AbortController();
    const pending = run(deaf.fetchFn, { signal: controller.signal });

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, error: 'cancelled' });
  });

  it('Response que chega depois do abort tem o corpo cancelado', async () => {
    const deaf = deafFetch();
    const body = controlledBody();
    const controller = new AbortController();
    const pending = run(deaf.fetchFn, { signal: controller.signal });

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, error: 'cancelled' });

    deaf.resolve(okResponse(body.stream));
    await vi.advanceTimersByTimeAsync(0);
    expect(body.cancel).toHaveBeenCalled();
  });

  it('fetch que rejeita depois do abort não gera rejeição sem tratamento', async () => {
    const deaf = deafFetch();
    const controller = new AbortController();
    const pending = run(deaf.fetchFn, { signal: controller.signal });

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, error: 'cancelled' });

    deaf.reject(new TypeError('Failed to fetch'));
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe('chatStream: pedido inválido', () => {
  it.each([undefined, null, 'texto', 42, ['a']])(
    'pedido %j vira invalid_request sem chamar fetch',
    async (request) => {
      const fetchFn = hangingFetch();

      await expect(
        chatStream(ENDPOINT, request as unknown as ChatRequest, { fetchFn }),
      ).resolves.toEqual({ ok: false, error: 'invalid_request' });
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('pedido não serializável vira invalid_request sem chamar fetch', async () => {
    const fetchFn = hangingFetch();
    const request: Record<string, unknown> = { ...REQUEST };
    request.self = request;

    await expect(
      chatStream(ENDPOINT, request as unknown as ChatRequest, { fetchFn }),
    ).resolves.toEqual({ ok: false, error: 'invalid_request' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
