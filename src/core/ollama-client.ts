import { normalizeEndpoint, validateModel } from '../shared/validation';
import { createDeadlineScope, type DeadlineReason } from './deadline-scope';
import { createNdjsonParser, type ParsedLine } from './ndjson-parser';
import type { ChatRequest } from './prompt-builder';

/**
 * Cliente da API local do Ollama (RF06). Módulo puro: recebe `fetch` por
 * injeção e não referencia `chrome`, para ser testável no Node.
 *
 * Devolve códigos de erro, nunca mensagens: o texto em PT-BR fica na
 * interface (`src/options/messages.ts`).
 */
export type OllamaErrorKind =
  | 'invalid_endpoint'
  | 'invalid_model'
  | 'network'
  | 'timeout'
  | 'forbidden'
  | 'not_found'
  | 'http_error'
  | 'invalid_response';

export type ListModelsResult =
  { ok: true; models: string[] } | { ok: false; error: OllamaErrorKind; status?: number };

/** `model_missing`: `/api/show` respondeu 404 para o modelo pedido. */
export type ShowModelResult =
  { ok: true } | { ok: false; error: OllamaErrorKind | 'model_missing'; status?: number };

export type TestConnectionResult =
  | { ok: true; models: string[]; modelInstalled: boolean }
  | { ok: false; error: OllamaErrorKind; status?: number };

export interface OllamaRequestOptions {
  fetchFn: typeof fetch;
  /** Prazo de cada requisição (conexão + corpo), em milissegundos. */
  timeoutMs?: number;
}

export type ListModelsOptions = OllamaRequestOptions;

export const DEFAULT_LIST_MODELS_TIMEOUT_MS = 5000;

const LATEST_TAG = ':latest';

/** Opções comuns a toda requisição ao Ollama. Nunca `mode: 'no-cors'` (ADR-009). */
const BASE_INIT: Readonly<RequestInit> = Object.freeze({
  credentials: 'omit',
  cache: 'no-store',
  // O endpoint é loopback; seguir redirecionamento poderia levar a outro host.
  redirect: 'error',
});

type ParsedTags = { ok: true; models: string[] } | { ok: false };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Valida o corpo de `/api/tags` em tempo de execução. Sem `models[]` a
 * resposta é inválida; entradas individuais malformadas, ou com nome fora da
 * allowlist de `validateModel`, são ignoradas, para que um item estranho não
 * esconda os demais modelos instalados.
 */
function parseTags(body: unknown): ParsedTags {
  if (!isRecord(body) || !Array.isArray(body.models)) return { ok: false };
  const names = new Set<string>();
  for (const entry of body.models) {
    if (!isRecord(entry)) continue;
    const name = validateModel(entry.name);
    if (name.ok) names.add(name.value);
  }
  return { ok: true, models: [...names].sort() };
}

function httpError(status: number): { ok: false; error: OllamaErrorKind; status: number } {
  if (status === 403) return { ok: false, error: 'forbidden', status };
  if (status === 404) return { ok: false, error: 'not_found', status };
  return { ok: false, error: 'http_error', status };
}

const TIMED_OUT: unique symbol = Symbol('timeout');

/**
 * Executa `task` com um prazo único (fase `total`), que cobre também a
 * leitura do corpo, que pode travar após o status. `task` não deve rejeitar;
 * recebe o sinal a repassar ao `fetch` e uma função que indica se o prazo
 * estourou.
 */
async function withTotalDeadline<R>(
  timeoutMs: number,
  task: (signal: AbortSignal, timedOut: () => boolean) => Promise<R>,
): Promise<R | typeof TIMED_OUT> {
  const scope = createDeadlineScope<'total'>();
  scope.arm('total', timeoutMs);
  const timedOut = (): boolean => scope.reason()?.kind === 'timeout';
  try {
    return await Promise.race([
      task(scope.signal, timedOut),
      scope.aborted.then((): typeof TIMED_OUT => TIMED_OUT),
    ]);
  } finally {
    scope.dispose();
  }
}

/**
 * Lista os modelos instalados via `GET /api/tags`. Nunca lança: falhas de
 * rede, timeout, status HTTP e corpo inesperado viram `{ ok: false }`.
 *
 * Com `host_permissions` (ADR-009) o Chrome não envia `Origin` neste `GET`,
 * então o sucesso aqui não prova que a origem está liberada; ver
 * `testConnection`.
 */
export async function listModels(
  endpoint: string,
  options: OllamaRequestOptions,
): Promise<ListModelsResult> {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized.ok) return { ok: false, error: 'invalid_endpoint' };
  const url = new URL('/api/tags', normalized.value);

  const result = await withTotalDeadline(
    options.timeoutMs ?? DEFAULT_LIST_MODELS_TIMEOUT_MS,
    async (signal, timedOut): Promise<ListModelsResult> => {
      let response: Response;
      try {
        response = await options.fetchFn(url, { ...BASE_INIT, method: 'GET', signal });
      } catch {
        // TypeError de rede (Ollama desligado, porta errada) ou aborto externo.
        // Com host_permissions (ADR-009) o 403 chega como status, não aqui.
        return { ok: false, error: timedOut() ? 'timeout' : 'network' };
      }
      if (!response.ok) return httpError(response.status);

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, error: timedOut() ? 'timeout' : 'invalid_response' };
      }
      const parsed = parseTags(body);
      return parsed.ok ? parsed : { ok: false, error: 'invalid_response' };
    },
  );
  return result === TIMED_OUT ? { ok: false, error: 'timeout' } : result;
}

/**
 * Consulta `POST /api/show` (somente leitura). Por ser `POST`, o Chrome envia
 * `Origin` (ADR-009): um 403 indica origem não liberada em `OLLAMA_ORIGINS`;
 * um 404, modelo inexistente. O corpo (modelfile, licença) nunca é lido.
 */
export async function showModel(
  endpoint: string,
  model: string,
  options: OllamaRequestOptions,
): Promise<ShowModelResult> {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized.ok) return { ok: false, error: 'invalid_endpoint' };
  const validModel = validateModel(model);
  if (!validModel.ok) return { ok: false, error: 'invalid_model' };
  const url = new URL('/api/show', normalized.value);
  const body = JSON.stringify({ model: validModel.value });

  const result = await withTotalDeadline(
    options.timeoutMs ?? DEFAULT_LIST_MODELS_TIMEOUT_MS,
    async (signal, timedOut): Promise<ShowModelResult> => {
      let response: Response;
      try {
        response = await options.fetchFn(url, {
          ...BASE_INIT,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal,
        });
      } catch {
        return { ok: false, error: timedOut() ? 'timeout' : 'network' };
      }
      if (response.ok) return { ok: true };
      if (response.status === 404) return { ok: false, error: 'model_missing', status: 404 };
      return httpError(response.status);
    },
  );
  return result === TIMED_OUT ? { ok: false, error: 'timeout' } : result;
}

/**
 * Teste de conexão (RF01): `/api/tags` prova o alcance e lista os modelos;
 * `/api/show` prova a liberação da origem e verifica o modelo configurado.
 * Cada etapa tem o próprio prazo de `timeoutMs`.
 */
export async function testConnection(
  endpoint: string,
  model: string,
  options: OllamaRequestOptions,
): Promise<TestConnectionResult> {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized.ok) return { ok: false, error: 'invalid_endpoint' };
  const validModel = validateModel(model);
  if (!validModel.ok) return { ok: false, error: 'invalid_model' };

  const listed = await listModels(normalized.value, options);
  if (!listed.ok) return listed;

  const shown = await showModel(normalized.value, validModel.value, options);
  if (shown.ok) return { ok: true, models: listed.models, modelInstalled: true };
  if (shown.error === 'model_missing') {
    return { ok: true, models: listed.models, modelInstalled: false };
  }
  return { ...shown, error: shown.error };
}

/** Acrescenta `:latest` a nomes sem tag; a tag vem após o último `/`. */
function withDefaultTag(name: string): string {
  const lastSegment = name.slice(name.lastIndexOf('/') + 1);
  return lastSegment.includes(':') ? name : `${name}${LATEST_TAG}`;
}

/** Indica se `wanted` está instalado, tratando `nome` e `nome:latest` como iguais. */
export function hasModel(models: readonly string[], wanted: string): boolean {
  const target = withDefaultTag(wanted);
  return models.some((model) => withDefaultTag(model) === target);
}

/**
 * Erros de `chatStream`:
 * - `model_missing`: `/api/chat` respondeu 404 (modelo não instalado);
 * - `cancelled`: o sinal externo abortou;
 * - `ollama_error`: o stream trouxe uma linha `{ error }` (mensagem descartada);
 * - `truncated`: `done_reason` `length` (limite `num_predict` atingido); tem
 *   precedência sobre o texto vazio, então `length` sem token também é
 *   `truncated`, nunca `empty_response`;
 * - `incomplete_stream`: o corpo terminou sem linha `done: true`;
 * - `empty_response`: `done: true` sem nenhum texto gerado;
 * - `consumer_error`: `onToken` lançou;
 * - `invalid_request`: o pedido não é um objeto serializável em JSON.
 */
export type ChatStreamErrorKind =
  // `chatStream` nunca devolve `not_found`: o 404 vira `model_missing`.
  | Exclude<OllamaErrorKind, 'not_found'>
  | 'model_missing'
  | 'cancelled'
  | 'ollama_error'
  | 'truncated'
  | 'incomplete_stream'
  | 'empty_response'
  | 'consumer_error'
  | 'invalid_request';

/**
 * Fases de prazo do chat: `first_token` vai do início até o primeiro token
 * (inclui carregar o modelo); `idle` é o intervalo máximo entre tokens;
 * `total` cobre a requisição inteira e nunca reinicia.
 */
export type ChatTimeoutPhase = 'first_token' | 'idle' | 'total';

export interface ChatStreamTimeouts {
  firstTokenMs: number;
  idleMs: number;
  totalMs: number;
}

/**
 * Padrões conservadores para hardware modesto: o primeiro token pode esperar
 * o carregamento do modelo do disco; depois disso, 30 s sem token indica
 * travamento; 5 min limitam um segmento inteiro.
 */
export const DEFAULT_CHAT_TIMEOUTS: Readonly<ChatStreamTimeouts> = Object.freeze({
  firstTokenMs: 120_000,
  idleMs: 30_000,
  totalMs: 300_000,
});

export interface ChatStreamOptions {
  fetchFn: typeof fetch;
  signal?: AbortSignal;
  /** Recebe cada trecho de texto, em ordem. Se lançar, o chat é abortado. */
  onToken?: (delta: string) => void;
  /**
   * Campos ausentes ou inválidos usam `DEFAULT_CHAT_TIMEOUTS`. Válido é um
   * inteiro de 1 a `MAX_TIMEOUT_MS`; fora disso (0, negativo, fracionário,
   * `NaN`, `Infinity`, acima do limite) vale o padrão daquela fase.
   */
  timeouts?: Partial<ChatStreamTimeouts>;
}

/** Métricas da linha final do Ollama; durações em nanossegundos. */
export interface ChatMetrics {
  evalCount?: number;
  promptEvalCount?: number;
  totalDurationNs?: number;
  loadDurationNs?: number;
  evalDurationNs?: number;
}

export type ChatStreamResult =
  | { ok: true; text: string; doneReason?: string; metrics: ChatMetrics }
  | { ok: false; error: ChatStreamErrorKind; status?: number; timeout?: ChatTimeoutPhase };

type ChatFailure = Extract<ChatStreamResult, { ok: false }>;

/** Maior atraso aceito por `setTimeout` (2^31 - 1 ms); acima disso dispara já. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

const isValidTimeout = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;

/** Mescla os prazos pedidos com o padrão, descartando valores inválidos. */
function resolveTimeouts(partial: Partial<ChatStreamTimeouts> | undefined): ChatStreamTimeouts {
  const pick = (key: keyof ChatStreamTimeouts): number => {
    const value: unknown = partial?.[key];
    return isValidTimeout(value) ? value : DEFAULT_CHAT_TIMEOUTS[key];
  };
  return { firstTokenMs: pick('firstTokenMs'), idleMs: pick('idleMs'), totalMs: pick('totalMs') };
}

const chatFail = (error: ChatStreamErrorKind): ChatFailure => ({ ok: false, error });

const ABORTED: unique symbol = Symbol('aborted');

const METRIC_FIELDS: ReadonlyArray<readonly [string, keyof ChatMetrics]> = [
  ['eval_count', 'evalCount'],
  ['prompt_eval_count', 'promptEvalCount'],
  ['total_duration', 'totalDurationNs'],
  ['load_duration', 'loadDurationNs'],
  ['eval_duration', 'evalDurationNs'],
];

/**
 * Copia só métricas que são inteiros seguros não negativos (contagens e
 * nanossegundos); negativos, fracionários, `Infinity` e outros tipos são
 * ignorados.
 */
function readMetrics(line: Record<string, unknown>): ChatMetrics {
  const metrics: ChatMetrics = {};
  for (const [field, key] of METRIC_FIELDS) {
    const value = line[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      metrics[key] = value;
    }
  }
  return metrics;
}

function reasonFailure(reason: DeadlineReason<ChatTimeoutPhase>): ChatFailure {
  if (reason.kind === 'timeout') return { ok: false, error: 'timeout', timeout: reason.phase };
  return chatFail(reason.kind);
}

/** Cancela um corpo que não será lido; só libera a conexão. */
const discardBody = (response: Response): void => {
  response.body?.cancel().catch(() => {});
};

/**
 * Conversa com `POST /api/chat` em streaming (RF06). Nunca lança nem
 * rejeita: toda falha vira `{ ok: false }` com um código, sem texto parcial,
 * sem conteúdo do modelo e sem mensagem do Ollama.
 *
 * Cada token (linha com `message.content` não vazio) é entregue a `onToken`
 * e acumulado. A primeira linha `done: true` encerra a leitura; o restante
 * do corpo é ignorado. Prazos por fase em `ChatStreamTimeouts`; o primeiro
 * motivo de encerramento (prazo, cancelamento, erro do consumidor) vence e
 * tem prioridade sobre qualquer dado já lido: depois de registrado, nenhuma
 * linha é processada e `onToken` não é mais chamado.
 */
export async function chatStream(
  endpoint: string,
  request: ChatRequest,
  options: ChatStreamOptions,
): Promise<ChatStreamResult> {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized.ok) return chatFail('invalid_endpoint');
  // Defesa em tempo de execução: o tipo não protege chamadas vindas de JS.
  if (!isRecord(request)) return chatFail('invalid_request');
  const validModel = validateModel(request.model);
  if (!validModel.ok) return chatFail('invalid_model');
  if (options.signal?.aborted) return chatFail('cancelled');

  const timeouts = resolveTimeouts(options.timeouts);
  const url = new URL('/api/chat', normalized.value);
  let body: string;
  try {
    body = JSON.stringify({ ...request, model: validModel.value });
  } catch {
    // Valor não serializável (ciclo, BigInt) no pedido.
    return chatFail('invalid_request');
  }

  const scope = createDeadlineScope<ChatTimeoutPhase>(options.signal);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let text = '';
  let receivedToken = false;

  /** Falha após exceção ou abort: o motivo do escopo, se houver, vence. */
  const failWith = (fallback: ChatStreamErrorKind): ChatFailure => {
    const reason = scope.reason();
    return reason !== undefined ? reasonFailure(reason) : chatFail(fallback);
  };

  /** Processa uma linha; devolve o resultado final quando ela encerra o chat. */
  const handleLine = (line: ParsedLine): ChatStreamResult | undefined => {
    const early = scope.reason();
    if (early !== undefined) return reasonFailure(early);
    if (!line.ok || !isRecord(line.value)) return chatFail('invalid_response');
    const value = line.value;
    if ('error' in value) return chatFail('ollama_error');

    const message = value.message;
    if (isRecord(message) && typeof message.content === 'string' && message.content !== '') {
      const delta = message.content;
      if (!receivedToken) {
        receivedToken = true;
        scope.disarm('first_token');
      }
      scope.arm('idle', timeouts.idleMs);
      const before = scope.reason();
      if (before !== undefined) return reasonFailure(before);
      try {
        options.onToken?.(delta);
      } catch {
        scope.fail({ kind: 'consumer_error' });
      }
      // `onToken` pode ter lançado ou abortado o sinal externo.
      const after = scope.reason();
      if (after !== undefined) return reasonFailure(after);
      text += delta;
    }

    if (value.done !== true) return undefined;
    if (value.done_reason === 'length') return chatFail('truncated');
    if (text === '') return chatFail('empty_response');
    return {
      ok: true,
      text,
      ...(typeof value.done_reason === 'string' ? { doneReason: value.done_reason } : {}),
      metrics: readMetrics(value),
    };
  };

  const handleLines = (lines: readonly ParsedLine[]): ChatStreamResult | undefined => {
    for (const line of lines) {
      const result = handleLine(line);
      if (result !== undefined) return result;
    }
    return undefined;
  };

  try {
    scope.arm('total', timeouts.totalMs);
    scope.arm('first_token', timeouts.firstTokenMs);

    let fetching: Promise<Response>;
    try {
      fetching = Promise.resolve(
        options.fetchFn(url, {
          ...BASE_INIT,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: scope.signal,
        }),
      );
    } catch {
      return failWith('network');
    }

    // O race cobre um `fetch` que ignore o sinal; a `Response` que chegar
    // depois do abort tem o corpo cancelado.
    let response: Response | typeof ABORTED;
    try {
      response = await Promise.race([fetching, scope.aborted.then((): typeof ABORTED => ABORTED)]);
    } catch {
      return failWith('network');
    }
    const afterFetch = scope.reason();
    if (afterFetch !== undefined || response === ABORTED) {
      if (response === ABORTED) fetching.then(discardBody, () => {});
      else discardBody(response);
      return failWith('network');
    }
    if (!response.ok) {
      // O corpo de erro nunca é lido.
      discardBody(response);
      const { status } = response;
      if (status === 404) return { ok: false, error: 'model_missing', status };
      return { ok: false, error: status === 403 ? 'forbidden' : 'http_error', status };
    }
    if (response.body === null) return chatFail('invalid_response');

    const activeReader = response.body.getReader();
    reader = activeReader;
    // Um abort do escopo encerra a leitura pendente, sem `Promise.race`.
    scope.signal.addEventListener('abort', () => void activeReader.cancel().catch(() => {}), {
      once: true,
    });
    const parser = createNdjsonParser();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof activeReader.read>>;
      try {
        chunk = await activeReader.read();
      } catch {
        // Conexão interrompida no meio do corpo.
        return failWith('network');
      }
      // O motivo do escopo vence qualquer chunk já lido no mesmo tick.
      const afterRead = scope.reason();
      if (afterRead !== undefined) return reasonFailure(afterRead);
      if (chunk.done) return handleLines(parser.end()) ?? failWith('incomplete_stream');
      const result = handleLines(parser.push(chunk.value));
      if (result !== undefined) return result;
    }
  } catch {
    return failWith('invalid_response');
  } finally {
    scope.dispose();
    reader?.cancel().catch(() => {});
  }
}
