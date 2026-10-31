import { MAX_OUTPUT_CHARS, MAX_UNIT_CHARS } from '../core/text-limits';
import type { TranslationErrorKind } from '../core/translation-provider';

/**
 * Contrato das mensagens do job de página, trocadas por um `chrome.runtime.Port`
 * entre o content script e o service worker, único cliente HTTP do Ollama
 * (ADR-009). Módulo puro, sem `chrome` nem DOM.
 *
 * Os parsers validam em tempo de execução tudo que atravessa a porta: formas
 * inesperadas viram `null`, e campos extras são descartados (o resultado é
 * sempre um objeto novo). Idiomas de origem e destino não viajam na mensagem:
 * o service worker os lê das configurações.
 */

export { MAX_OUTPUT_CHARS, MAX_UNIT_CHARS } from '../core/text-limits';

export const PAGE_JOB_PORT_NAME = 'lerium:page-job';

/** Comprimento máximo de um `unitId` (`seg-0#text@7`, `seg-3#node-12@41`…). */
export const MAX_UNIT_ID_CHARS = 64;

// ---------------------------------------------------------------------------
// content → service worker

/** Pedido de tradução de uma unidade do plano (ADR-014). */
export interface JobUnitMessage {
  type: 'job:unit';
  jobId: string;
  unitId: string;
  text: string;
}

export interface JobPingMessage {
  type: 'job:ping';
  jobId: string;
}

export type ContentToWorkerMessage = JobUnitMessage | JobPingMessage;

// ---------------------------------------------------------------------------
// service worker → content

/** `busy`: o service worker recusou a unidade por já estar ocupado. */
export type JobUnitErrorKind = TranslationErrorKind | 'busy';

/**
 * Falhas que encerram o job inteiro, não só uma unidade. `network`: o Ollama
 * está inacessível, então insistir nas próximas unidades seria inútil.
 */
export type JobFatalErrorKind =
  'invalid_config' | 'model_missing' | 'forbidden' | 'network' | 'settings_unavailable';

export type JobResultMessage =
  | { type: 'job:result'; jobId: string; unitId: string; ok: true; text: string }
  | {
      type: 'job:result';
      jobId: string;
      unitId: string;
      ok: false;
      error: JobUnitErrorKind;
      retryable: boolean;
    };

/** Progresso de uma unidade: só a contagem de caracteres, nunca o texto. */
export interface JobProgressMessage {
  type: 'job:progress';
  jobId: string;
  unitId: string;
  chars: number;
}

export interface JobFatalMessage {
  type: 'job:fatal';
  jobId: string;
  error: JobFatalErrorKind;
}

export type WorkerToContentMessage = JobResultMessage | JobProgressMessage | JobFatalMessage;

// ---------------------------------------------------------------------------
// Validação

// Record obriga, em tempo de compilação, listar todo código de erro.
const UNIT_ERROR_KINDS: Readonly<Record<JobUnitErrorKind, true>> = Object.freeze({
  invalid_config: true,
  network: true,
  timeout: true,
  forbidden: true,
  model_missing: true,
  http_error: true,
  provider_error: true,
  invalid_response: true,
  truncated: true,
  empty_response: true,
  cancelled: true,
  invalid_input: true,
  consumer_error: true,
  internal_error: true,
  busy: true,
});

const FATAL_ERROR_KINDS: Readonly<Record<JobFatalErrorKind, true>> = Object.freeze({
  invalid_config: true,
  model_missing: true,
  forbidden: true,
  network: true,
  settings_unavailable: true,
});

/** UUID v4 canônico, só minúsculas (formato de `crypto.randomUUID()`). */
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Allowlist ASCII compatível com `seg-N#part@token` do page-applier. */
const UNIT_ID_PATTERN = /^[A-Za-z0-9#@:_-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isJobId = (value: unknown): value is string =>
  typeof value === 'string' && JOB_ID_PATTERN.test(value);

export const isUnitId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_UNIT_ID_CHARS && UNIT_ID_PATTERN.test(value);

const isTextWithin = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;

const isUnitErrorKind = (value: unknown): value is JobUnitErrorKind =>
  typeof value === 'string' && Object.hasOwn(UNIT_ERROR_KINDS, value);

const isFatalErrorKind = (value: unknown): value is JobFatalErrorKind =>
  typeof value === 'string' && Object.hasOwn(FATAL_ERROR_KINDS, value);

export function parseContentToWorker(input: unknown): ContentToWorkerMessage | null {
  if (!isRecord(input)) return null;
  const { type, jobId } = input;
  if (!isJobId(jobId)) return null;
  if (type === 'job:ping') return { type: 'job:ping', jobId };
  if (type === 'job:unit') {
    const { unitId, text } = input;
    if (!isUnitId(unitId) || !isTextWithin(text, MAX_UNIT_CHARS)) return null;
    return { type: 'job:unit', jobId, unitId, text };
  }
  return null;
}

function parseResult(input: Record<string, unknown>, jobId: string): JobResultMessage | null {
  const { unitId, ok } = input;
  if (!isUnitId(unitId)) return null;
  if (ok === true) {
    const { text } = input;
    if (!isTextWithin(text, MAX_OUTPUT_CHARS)) return null;
    return { type: 'job:result', jobId, unitId, ok: true, text };
  }
  if (ok === false) {
    const { error, retryable } = input;
    if (!isUnitErrorKind(error) || typeof retryable !== 'boolean') return null;
    return { type: 'job:result', jobId, unitId, ok: false, error, retryable };
  }
  return null;
}

export function parseWorkerToContent(input: unknown): WorkerToContentMessage | null {
  if (!isRecord(input)) return null;
  const { type, jobId } = input;
  if (!isJobId(jobId)) return null;
  switch (type) {
    case 'job:result':
      return parseResult(input, jobId);
    case 'job:progress': {
      const { unitId, chars } = input;
      if (!isUnitId(unitId)) return null;
      if (typeof chars !== 'number' || !Number.isSafeInteger(chars) || chars < 0) return null;
      return { type: 'job:progress', jobId, unitId, chars };
    }
    case 'job:fatal': {
      const { error } = input;
      if (!isFatalErrorKind(error)) return null;
      return { type: 'job:fatal', jobId, error };
    }
    default:
      return null;
  }
}
