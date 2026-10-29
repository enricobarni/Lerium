import { testConnection } from '../core/ollama-client';
import {
  TEST_CONNECTION_MESSAGE_TYPE,
  parseTestConnectionRequest,
  type TestConnectionResponse,
} from '../shared/runtime-messages';
import { normalizeEndpoint, validateModel } from '../shared/validation';

/**
 * Roteador de mensagens do service worker (ADR-009). Módulo puro: `chrome`
 * entra por injeção, para ser testável no Node; só `index.ts` toca a API.
 * Não guarda estado entre mensagens e não registra dados em log.
 */

/** Subconjunto de `chrome.runtime.MessageSender` usado aqui. */
export interface MessageSenderLike {
  id?: string;
  url?: string;
}

export interface MessageHandlerDeps {
  /** `chrome.runtime.id`. */
  runtimeId: string;
  /** Envolve `chrome.permissions.contains({ origins: [pattern] })`. */
  permissionsContains: (originPattern: string) => Promise<boolean>;
  fetchFn: typeof fetch;
  timeoutMs?: number;
}

export type MessageHandler = (
  message: unknown,
  sender: MessageSenderLike,
) => Promise<TestConnectionResponse | undefined>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Indica, de forma síncrona, se a mensagem é de um tipo tratado aqui. O
 * listener precisa disso para decidir entre `return true` (resposta
 * assíncrona) e `return false` (deixar a mensagem para outros listeners).
 */
export function isHandledMessage(message: unknown): boolean {
  return isRecord(message) && message.type === TEST_CONNECTION_MESSAGE_TYPE;
}

/**
 * Só páginas da própria extensão (opções, popup) pedem o teste de conexão.
 * O `id` barra outras extensões; a `url` barra content scripts, que rodam
 * dentro de páginas web e não precisam desta ação.
 */
function isTrustedSender(sender: MessageSenderLike, runtimeId: string): boolean {
  if (sender.id !== runtimeId || typeof sender.url !== 'string') return false;
  return sender.url.startsWith(`chrome-extension://${runtimeId}/`);
}

export function createMessageHandler(deps: MessageHandlerDeps): MessageHandler {
  return async (message, sender) => {
    if (!isTrustedSender(sender, deps.runtimeId) || !isHandledMessage(message)) {
      return undefined;
    }

    const request = parseTestConnectionRequest(message);
    if (!request) return { ok: false, error: 'invalid_request' };
    // Revalida no worker: a página pode ter sido adulterada.
    const endpoint = normalizeEndpoint(request.endpoint);
    const model = validateModel(request.model);
    if (!endpoint.ok || !model.ok) return { ok: false, error: 'invalid_request' };

    let granted: boolean;
    try {
      granted = await deps.permissionsContains(`${endpoint.value}/*`);
    } catch {
      granted = false;
    }
    if (!granted) return { ok: false, error: 'permission_required' };

    return testConnection(endpoint.value, model.value, {
      fetchFn: deps.fetchFn,
      timeoutMs: deps.timeoutMs,
    });
  };
}
