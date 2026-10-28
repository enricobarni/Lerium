import { LANGUAGE_CODES } from '../core/constants';
import type { LanguageCode } from '../core/types';

/**
 * Validadores puros das configurações. Devolvem códigos de motivo, nunca
 * mensagens: o texto em PT-BR é responsabilidade da interface.
 */
export type ValidationResult<T, R extends string> =
  { ok: true; value: T } | { ok: false; reason: R };

export type EndpointErrorReason =
  | 'invalid_type'
  | 'empty'
  | 'invalid_url'
  | 'protocol'
  | 'credentials'
  | 'query'
  | 'hash'
  | 'host'
  | 'port'
  | 'path';

export type ModelErrorReason = 'invalid_type' | 'empty' | 'too_long' | 'invalid_characters';

export type LanguageErrorReason = 'invalid_type' | 'unsupported';

/** Hosts aceitos após a normalização do URL (MVP: apenas loopback, RF01/RF07). */
const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/** Nomes de modelo do Ollama são curtos; o limite só barra entradas absurdas. */
export const MODEL_MAX_LENGTH = 200;

// Espaços, controles C0/C1 e barra invertida: o parser de URL os remove ou
// reinterpreta em silêncio, então são recusados antes de chegar a ele.
const ENDPOINT_FORBIDDEN_CHARS = /[\s\p{Cc}\\]/u;
const MODEL_FORBIDDEN_CHARS = /[\s\p{Cc}]/u;
const HTTP_PREFIX = /^http:\/\//i;

const fail = <R extends string>(reason: R): { ok: false; reason: R } => ({ ok: false, reason });

/**
 * Valida um endpoint do Ollama e devolve a origem canônica, sem barra final
 * (ex.: `http://localhost:11434`). Espaços nas pontas são ignorados.
 *
 * Formas IPv4 alternativas (`127.1`, `0x7f.0.0.1`) são canonizadas pelo URL
 * para `127.0.0.1` e, por isso, aceitas; o valor devolvido é sempre canônico.
 */
export function normalizeEndpoint(input: unknown): ValidationResult<string, EndpointErrorReason> {
  if (typeof input !== 'string') return fail('invalid_type');
  const raw = input.trim();
  if (raw === '') return fail('empty');
  if (ENDPOINT_FORBIDDEN_CHARS.test(raw)) return fail('invalid_url');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('invalid_url');
  }

  if (url.protocol !== 'http:') return fail('protocol');
  // O URL aceita `http:localhost`; exigimos a forma explícita `http://`.
  if (!HTTP_PREFIX.test(raw)) return fail('invalid_url');

  const afterScheme = raw.slice('http://'.length);
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? '';
  if (url.username !== '' || url.password !== '' || authority.includes('@')) {
    return fail('credentials');
  }
  // `?` e `#` vazios somem de `search`/`hash`, então o texto original é checado.
  if (url.search !== '' || afterScheme.includes('?')) return fail('query');
  if (url.hash !== '' || afterScheme.includes('#')) return fail('hash');
  if (!ALLOWED_HOSTNAMES.has(url.hostname)) return fail('host');
  if (url.port !== '' && Number(url.port) < 1) return fail('port');
  if (url.pathname !== '/') return fail('path');

  return { ok: true, value: url.origin };
}

/** Valida o nome do modelo, removendo espaços nas pontas. */
export function validateModel(input: unknown): ValidationResult<string, ModelErrorReason> {
  if (typeof input !== 'string') return fail('invalid_type');
  const model = input.trim();
  if (model === '') return fail('empty');
  if (model.length > MODEL_MAX_LENGTH) return fail('too_long');
  if (MODEL_FORBIDDEN_CHARS.test(model)) return fail('invalid_characters');
  return { ok: true, value: model };
}

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (LANGUAGE_CODES as readonly string[]).includes(value);
}

/** Valida um código de idioma exato (sem trim nem ajuste de maiúsculas). */
export function validateLanguage(
  input: unknown,
): ValidationResult<LanguageCode, LanguageErrorReason> {
  if (typeof input !== 'string') return fail('invalid_type');
  return isLanguageCode(input) ? { ok: true, value: input } : fail('unsupported');
}
