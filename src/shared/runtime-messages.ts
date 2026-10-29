import type { OllamaErrorKind } from '../core/ollama-client';

/**
 * Contrato das mensagens entre as páginas da extensão e o service worker,
 * único cliente HTTP do Ollama (ADR-009). Módulo puro, sem `chrome`.
 *
 * Os parsers validam em tempo de execução tudo que atravessa
 * `chrome.runtime.sendMessage`: formas inesperadas viram `null`, e campos
 * extras são descartados (o resultado é sempre um objeto novo).
 */
export const TEST_CONNECTION_MESSAGE_TYPE = 'ollama:test-connection';

export interface TestConnectionRequest {
  type: typeof TEST_CONNECTION_MESSAGE_TYPE;
  endpoint: string;
  model: string;
}

/**
 * `permission_required`: falta a permissão opcional de host para a origem
 * (porta personalizada). `invalid_request`: mensagem, endpoint ou modelo
 * recusados pelo service worker.
 */
export type TestConnectionErrorKind = OllamaErrorKind | 'permission_required' | 'invalid_request';

export type TestConnectionResponse =
  | { ok: true; models: string[]; modelInstalled: boolean }
  | { ok: false; error: TestConnectionErrorKind; status?: number };

// Record obriga, em tempo de compilação, listar todo código de erro.
const ERROR_KINDS: Readonly<Record<TestConnectionErrorKind, true>> = Object.freeze({
  invalid_endpoint: true,
  invalid_model: true,
  network: true,
  timeout: true,
  forbidden: true,
  not_found: true,
  http_error: true,
  invalid_response: true,
  permission_required: true,
  invalid_request: true,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isErrorKind = (value: unknown): value is TestConnectionErrorKind =>
  typeof value === 'string' && Object.hasOwn(ERROR_KINDS, value);

export function parseTestConnectionRequest(input: unknown): TestConnectionRequest | null {
  if (!isRecord(input) || input.type !== TEST_CONNECTION_MESSAGE_TYPE) return null;
  const { endpoint, model } = input;
  if (typeof endpoint !== 'string' || typeof model !== 'string') return null;
  return { type: TEST_CONNECTION_MESSAGE_TYPE, endpoint, model };
}

export function parseTestConnectionResponse(input: unknown): TestConnectionResponse | null {
  if (!isRecord(input)) return null;
  if (input.ok === true) {
    const { models, modelInstalled } = input;
    if (!Array.isArray(models) || !models.every((model) => typeof model === 'string')) {
      return null;
    }
    if (typeof modelInstalled !== 'boolean') return null;
    return { ok: true, models: [...(models as string[])], modelInstalled };
  }
  if (input.ok === false) {
    const { error, status } = input;
    if (!isErrorKind(error)) return null;
    if (status === undefined) return { ok: false, error };
    if (typeof status !== 'number' || !Number.isInteger(status)) return null;
    return { ok: false, error, status };
  }
  return null;
}
