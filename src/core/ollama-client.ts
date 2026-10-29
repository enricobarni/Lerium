import { normalizeEndpoint, validateModel } from '../shared/validation';

/**
 * Cliente da API local do Ollama (RF06). Módulo puro: recebe `fetch` por
 * injeção e não referencia `chrome`, para ser testável no Node.
 *
 * Devolve códigos de erro, nunca mensagens: o texto em PT-BR fica na
 * interface (`src/options/messages.ts`).
 */
export type OllamaErrorKind =
  | 'invalid_endpoint'
  | 'network'
  | 'timeout'
  | 'forbidden'
  | 'not_found'
  | 'http_error'
  | 'invalid_response';

export type ListModelsResult =
  { ok: true; models: string[] } | { ok: false; error: OllamaErrorKind; status?: number };

export interface ListModelsOptions {
  fetchFn: typeof fetch;
  /** Prazo total (conexão + corpo), em milissegundos. */
  timeoutMs?: number;
}

export const DEFAULT_LIST_MODELS_TIMEOUT_MS = 5000;

const LATEST_TAG = ':latest';

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

function httpError(status: number): ListModelsResult {
  if (status === 403) return { ok: false, error: 'forbidden', status };
  if (status === 404) return { ok: false, error: 'not_found', status };
  return { ok: false, error: 'http_error', status };
}

/**
 * Lista os modelos instalados via `GET /api/tags`. Nunca lança: falhas de
 * rede, timeout, status HTTP e corpo inesperado viram `{ ok: false }`.
 */
export async function listModels(
  endpoint: string,
  options: ListModelsOptions,
): Promise<ListModelsResult> {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized.ok) return { ok: false, error: 'invalid_endpoint' };

  const { timeoutMs = DEFAULT_LIST_MODELS_TIMEOUT_MS } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // O prazo cobre também a leitura do corpo, que pode travar após o status.
  const timeout = new Promise<'timeout'>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve('timeout'), { once: true });
  });

  const url = new URL('/api/tags', normalized.value);

  const request = async (): Promise<ListModelsResult> => {
    let response: Response;
    try {
      response = await options.fetchFn(url, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        // O endpoint é loopback; seguir redirecionamento poderia levar a outro host.
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      // TypeError de rede (Ollama desligado, porta errada) ou aborto externo.
      // Com host_permissions (ADR-009) o 403 chega como status, não aqui.
      return { ok: false, error: timedOut ? 'timeout' : 'network' };
    }
    if (!response.ok) return httpError(response.status);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: timedOut ? 'timeout' : 'invalid_response' };
    }
    const parsed = parseTags(body);
    return parsed.ok ? parsed : { ok: false, error: 'invalid_response' };
  };

  try {
    // `request` nunca rejeita; a corrida só encerra a espera no timeout.
    const result = await Promise.race([request(), timeout]);
    return result === 'timeout' ? { ok: false, error: 'timeout' } : result;
  } finally {
    clearTimeout(timer);
  }
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
