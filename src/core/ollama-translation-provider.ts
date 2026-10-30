import {
  chatStream,
  MAX_TIMEOUT_MS,
  type ChatStreamErrorKind,
  type ChatStreamResult,
  type ChatStreamTimeouts,
} from './ollama-client';
import { buildChatRequest, type BuildChatRequestError } from './prompt-builder';
import type {
  TranslateOptions,
  TranslationErrorKind,
  TranslationInput,
  TranslationProvider,
  TranslationResult,
} from './translation-provider';

/**
 * Provedor de tradução sobre o chat em streaming do Ollama (Fase 3). Módulo
 * puro: recebe `fetch` por injeção e não referencia `chrome` nem DOM. É o
 * único consumidor de `chatStream` em `src/`.
 *
 * Nova tentativa interna (conservadora): no máximo uma (duas chamadas no
 * total), só para falhas transitórias de transporte (`network`,
 * `incomplete_stream`, HTTP 429/5xx), só se nenhum token foi entregue ao
 * consumidor e o sinal externo não abortou. Prazo estourado nunca é repetido
 * aqui: o modelo pode estar lento de fato, e a decisão fica com a fila.
 */

/** Espera padrão antes da nova tentativa interna. */
export const DEFAULT_RETRY_DELAY_MS = 500;

export interface OllamaTranslationProviderConfig {
  /** Endpoint loopback; validado a cada tradução por `chatStream`. */
  endpoint: string;
  /** Modelo do Ollama; validado a cada tradução por `buildChatRequest`. */
  model: string;
  fetchFn: typeof fetch;
  /** Prazos do chat; campos ausentes ou inválidos usam `DEFAULT_CHAT_TIMEOUTS`. */
  timeouts?: Partial<ChatStreamTimeouts>;
  /**
   * Espera fixa antes da nova tentativa interna. Inteiro de 0 a
   * `MAX_TIMEOUT_MS`; fora disso vale `DEFAULT_RETRY_DELAY_MS`.
   */
  retryDelayMs?: number;
  /** Relógio monotônico em milissegundos; padrão `performance.now()`. */
  now?: () => number;
}

type TranslationFailure = Extract<TranslationResult, { ok: false }>;
type ChatFailure = Extract<ChatStreamResult, { ok: false }>;

const failure = (
  error: TranslationErrorKind,
  retryable: boolean,
  status?: number,
): TranslationFailure => ({
  ok: false,
  error,
  retryable,
  ...(status !== undefined ? { status } : {}),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** 429 (sobrecarga) e 5xx (falha do servidor) podem passar numa repetição. */
const isTransientStatus = (status: number | undefined): boolean =>
  status !== undefined && (status === 429 || (status >= 500 && status <= 599));

/** Converte um erro do `PromptBuilder` no código do contrato. */
export function mapBuildError(error: BuildChatRequestError): TranslationFailure {
  switch (error) {
    case 'invalid_model':
    case 'invalid_source_language':
    case 'invalid_target_language':
    case 'same_language':
      return failure('invalid_config', false);
    case 'invalid_text':
    case 'empty_text':
      return failure('invalid_input', false);
    default: {
      const unreachable: never = error;
      return unreachable;
    }
  }
}

/**
 * Converte uma falha do chat no código do contrato. `retryable` indica se o
 * consumidor pode repetir a chamada; o `status` HTTP é repassado quando houver.
 */
export function mapChatFailure({ error, status }: ChatFailure): TranslationFailure {
  const kind: ChatStreamErrorKind = error;
  switch (kind) {
    case 'invalid_endpoint':
    case 'invalid_model':
      return failure('invalid_config', false);
    case 'invalid_request':
      return failure('invalid_input', false);
    case 'network':
    case 'incomplete_stream':
      return failure('network', true);
    case 'timeout':
      return failure('timeout', true);
    case 'forbidden':
      return failure('forbidden', false, status);
    case 'model_missing':
      return failure('model_missing', false, status);
    case 'http_error':
      return failure('http_error', isTransientStatus(status), status);
    case 'ollama_error':
      return failure('provider_error', false);
    case 'invalid_response':
      return failure('invalid_response', false);
    case 'truncated':
      return failure('truncated', false);
    case 'empty_response':
      return failure('empty_response', false);
    case 'cancelled':
      return failure('cancelled', false);
    case 'consumer_error':
      return failure('consumer_error', false);
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

const defaultNow = (): number => performance.now();

/** Falhas do chat que podem passar numa nova tentativa imediata e idêntica. */
const isInternallyRetryable = ({ error, status }: ChatFailure): boolean =>
  error === 'network' ||
  error === 'incomplete_stream' ||
  (error === 'http_error' && isTransientStatus(status));

const resolveRetryDelay = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TIMEOUT_MS
    ? value
    : DEFAULT_RETRY_DELAY_MS;

/**
 * Espera `ms`; resolve `false` assim que `signal` abortar. Em qualquer
 * desfecho não sobra timer nem listener pendente.
 */
function waitUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Cria um provedor com snapshot do endpoint, do modelo e dos prazos: mudar a
 * configuração exige outra instância. Nunca lança na criação; configuração
 * inválida aparece como `invalid_config` em `translate`.
 */
export function createOllamaTranslationProvider(
  config: OllamaTranslationProviderConfig,
): TranslationProvider {
  const endpoint = config.endpoint;
  const model = config.model;
  const fetchFn = config.fetchFn;
  const timeouts = isRecord(config.timeouts) ? { ...config.timeouts } : undefined;
  const now = typeof config.now === 'function' ? config.now : defaultNow;
  const retryDelayMs = resolveRetryDelay(config.retryDelayMs);

  const run = async (input: unknown, options: unknown): Promise<TranslationResult> => {
    const startedAt = now();
    if (!isRecord(input)) return failure('invalid_input', false);
    const opts: TranslateOptions = isRecord(options) ? (options as TranslateOptions) : {};

    const built = buildChatRequest({
      text: input.text as string,
      source: input.source as TranslationInput['source'],
      target: input.target as TranslationInput['target'],
      model,
    });
    if (!built.ok) return mapBuildError(built.error);

    const { signal, onToken: userOnToken } = opts;
    let delivered = false;
    // Cada tentativa é uma chamada nova (prazos do zero) com o mesmo pedido.
    const attempt = (): Promise<ChatStreamResult> =>
      chatStream(endpoint, built.request, {
        fetchFn,
        ...(signal !== undefined ? { signal } : {}),
        ...(timeouts !== undefined ? { timeouts } : {}),
        onToken: (delta) => {
          // Marcado antes: mesmo que o consumidor lance, ele já viu o token.
          delivered = true;
          userOnToken?.(delta);
        },
      });

    let result = await attempt();
    if (!result.ok && isInternallyRetryable(result) && !delivered && !signal?.aborted) {
      if (!(await waitUnlessAborted(retryDelayMs, signal))) return failure('cancelled', false);
      result = await attempt();
    }
    if (!result.ok) return mapChatFailure(result);

    const outputTokens = result.metrics.evalCount;
    return {
      ok: true,
      text: result.text,
      durationMs: Math.max(0, Math.round(now() - startedAt)),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  };

  return {
    async translate(input, options) {
      try {
        return await run(input, options);
      } catch {
        // Só chega aqui com entrada ou opções anômalas vindas de JS (getter
        // que lança, sinal que não é `AbortSignal`): o pedido é inutilizável.
        return failure('invalid_input', false);
      }
    },
  };
}
