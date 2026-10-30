import type { JobFatalErrorKind } from './page-messages';

/**
 * Contrato do controle da página pelo popup. Módulo puro, sem `chrome` nem DOM.
 *
 * - popup → service worker (`chrome.runtime.sendMessage`): injeção do content
 *   script na aba (`page:inject`).
 * - popup → content script (`chrome.tabs.sendMessage`): comandos sobre o job
 *   da página (`page:command`), respondidos com o estado atual.
 *
 * Os parsers validam em tempo de execução tudo que atravessa as mensagens:
 * formas inesperadas viram `null`, e campos extras são descartados (o
 * resultado é sempre um objeto novo). O estado nunca carrega texto da página,
 * só contagens e códigos.
 */

export const PAGE_INJECT_MESSAGE_TYPE = 'page:inject';
export const PAGE_COMMAND_MESSAGE_TYPE = 'page:command';

/** Comprimento máximo de um `documentId` do Chrome. */
export const MAX_DOCUMENT_ID_CHARS = 128;

// ---------------------------------------------------------------------------
// popup → service worker

export interface PageInjectRequest {
  type: typeof PAGE_INJECT_MESSAGE_TYPE;
  tabId: number;
}

/**
 * `permission_required`: falta permissão de host para a aba.
 * `page_unsupported`: página em que a extensão não pode injetar.
 * `settings_unavailable`: configurações ilegíveis ou inválidas.
 * `injection_failed`: `chrome.scripting` falhou.
 * `invalid_request`: mensagem recusada pelo service worker.
 */
export type PageInjectErrorKind =
  | 'permission_required'
  | 'page_unsupported'
  | 'settings_unavailable'
  | 'injection_failed'
  | 'invalid_request';

export type PageInjectResponse =
  { ok: true; documentId: string } | { ok: false; error: PageInjectErrorKind };

// ---------------------------------------------------------------------------
// popup → content script

export type PageCommandName =
  'get-state' | 'start' | 'cancel' | 'show-original' | 'show-translation';

export interface PageCommand {
  type: typeof PAGE_COMMAND_MESSAGE_TYPE;
  command: PageCommandName;
}

export type PageStatus = 'idle' | 'translating' | 'translated' | 'cancelled' | 'error';

export type PageView = 'original' | 'translation';

/** Erro do job: falha fatal do service worker ou porta perdida. */
export type PageStateError = JobFatalErrorKind | 'interrupted';

export interface PageStateView {
  status: PageStatus;
  view: PageView;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  error?: PageStateError;
}

export type PageCommandResponse =
  { ok: true; state: PageStateView } | { ok: false; error: 'invalid_request' };

// ---------------------------------------------------------------------------
// Validação

// Record obriga, em tempo de compilação, listar todo valor da união.
const INJECT_ERROR_KINDS: Readonly<Record<PageInjectErrorKind, true>> = Object.freeze({
  permission_required: true,
  page_unsupported: true,
  settings_unavailable: true,
  injection_failed: true,
  invalid_request: true,
});

const COMMANDS: Readonly<Record<PageCommandName, true>> = Object.freeze({
  'get-state': true,
  start: true,
  cancel: true,
  'show-original': true,
  'show-translation': true,
});

const STATUSES: Readonly<Record<PageStatus, true>> = Object.freeze({
  idle: true,
  translating: true,
  translated: true,
  cancelled: true,
  error: true,
});

const VIEWS: Readonly<Record<PageView, true>> = Object.freeze({
  original: true,
  translation: true,
});

const STATE_ERRORS: Readonly<Record<PageStateError, true>> = Object.freeze({
  invalid_config: true,
  model_missing: true,
  forbidden: true,
  network: true,
  settings_unavailable: true,
  interrupted: true,
});

/** ASCII imprimível sem espaço (0x21–0x7E). */
const DOCUMENT_ID_PATTERN = /^[\x21-\x7e]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(
  allowlist: Readonly<Record<T, true>>,
  value: unknown,
): value is T => typeof value === 'string' && Object.hasOwn(allowlist, value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const isDocumentId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= MAX_DOCUMENT_ID_CHARS &&
  DOCUMENT_ID_PATTERN.test(value);

export function parsePageInjectRequest(input: unknown): PageInjectRequest | null {
  if (!isRecord(input) || input.type !== PAGE_INJECT_MESSAGE_TYPE) return null;
  const { tabId } = input;
  if (!isCount(tabId)) return null;
  return { type: PAGE_INJECT_MESSAGE_TYPE, tabId };
}

export function parsePageInjectResponse(input: unknown): PageInjectResponse | null {
  if (!isRecord(input)) return null;
  if (input.ok === true) {
    const { documentId } = input;
    if (!isDocumentId(documentId)) return null;
    return { ok: true, documentId };
  }
  if (input.ok === false) {
    const { error } = input;
    if (!isOneOf(INJECT_ERROR_KINDS, error)) return null;
    return { ok: false, error };
  }
  return null;
}

export function parsePageCommand(input: unknown): PageCommand | null {
  if (!isRecord(input) || input.type !== PAGE_COMMAND_MESSAGE_TYPE) return null;
  const { command } = input;
  if (!isOneOf(COMMANDS, command)) return null;
  return { type: PAGE_COMMAND_MESSAGE_TYPE, command };
}

function parseStateView(input: unknown): PageStateView | null {
  if (!isRecord(input)) return null;
  const { status, view, total, done, failed, skipped, error } = input;
  if (!isOneOf(STATUSES, status) || !isOneOf(VIEWS, view)) return null;
  if (!isCount(total) || !isCount(done) || !isCount(failed) || !isCount(skipped)) return null;
  const state: PageStateView = { status, view, total, done, failed, skipped };
  if (error === undefined) return state;
  if (!isOneOf(STATE_ERRORS, error)) return null;
  return { ...state, error };
}

export function parsePageCommandResponse(input: unknown): PageCommandResponse | null {
  if (!isRecord(input)) return null;
  if (input.ok === true) {
    const state = parseStateView(input.state);
    if (state === null) return null;
    return { ok: true, state };
  }
  if (input.ok === false) {
    if (input.error !== 'invalid_request') return null;
    return { ok: false, error: 'invalid_request' };
  }
  return null;
}
