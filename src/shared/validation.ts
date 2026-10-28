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
  | 'invalid_characters'
  | 'protocol'
  | 'credentials'
  | 'query'
  | 'hash'
  | 'host'
  | 'port'
  | 'path';

export type ModelErrorReason =
  'invalid_type' | 'empty' | 'too_long' | 'invalid_characters' | 'invalid_format';

export type LanguageErrorReason = 'invalid_type' | 'unsupported';

/** Erro entre campos: origem e destino não podem ser o mesmo idioma. */
export type LanguagePairErrorReason = 'same_language';

/** Hosts aceitos após a normalização do URL (MVP: apenas loopback, RF01/RF07). */
const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/** Nomes de modelo do Ollama são curtos; o limite só barra entradas absurdas. */
export const MODEL_MAX_LENGTH = 200;

// Só ASCII visível (0x21-0x7E): espaços, controles, caracteres invisíveis
// (\p{Cf}, como o soft hyphen) e formas largas são removidos ou mapeados em
// silêncio pelo parser de URL, então são recusados antes de chegar a ele.
const ENDPOINT_NON_ASCII_VISIBLE = /[^\x21-\x7E]/;
// A barra invertida é ASCII, mas o URL a trata como `/` em esquemas especiais.
const ENDPOINT_BACKSLASH = /\\/;
// Allowlist dos nomes do Ollama (`hf.co/user/repo:Q4_K_M`, `qwen3.5:latest`).
const MODEL_ALLOWED_CHARS = /^[A-Za-z0-9._:/-]+$/;
const HTTP_PREFIX = /^http:\/\//i;
const MAX_PORT = 65535;
// Porta no fim da authority (após o último `@`). `]` fica de fora para não
// confundir os `:` de um IPv6 entre colchetes com a porta.
const AUTHORITY_PORT = /:([^:\]]*)$/;
const DIGITS = /^\d+$/;

const fail = <R extends string>(reason: R): { ok: false; reason: R } => ({ ok: false, reason });

/**
 * Valida um endpoint do Ollama e devolve a origem canônica, sem barra final
 * (ex.: `http://localhost:11434`). Espaços nas pontas são ignorados.
 *
 * Formas IPv4 alternativas (`127.1`, `0x7f.0.0.1`) são canonizadas pelo URL
 * para `127.0.0.1` e, por isso, aceitas; o valor devolvido é sempre canônico.
 * O mesmo vale para escapes percentuais no host (`%6cocalhost` vira
 * `localhost`): a lista de hosts é aplicada ao hostname já decodificado.
 */
export function normalizeEndpoint(input: unknown): ValidationResult<string, EndpointErrorReason> {
  if (typeof input !== 'string') return fail('invalid_type');
  const raw = input.trim();
  if (raw === '') return fail('empty');
  if (ENDPOINT_NON_ASCII_VISIBLE.test(raw)) return fail('invalid_characters');
  if (ENDPOINT_BACKSLASH.test(raw)) return fail('invalid_url');

  const hasHttpPrefix = HTTP_PREFIX.test(raw);
  const afterScheme = hasHttpPrefix ? raw.slice('http://'.length) : '';
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? '';
  if (hasHttpPrefix) {
    // O URL aceitaria `http:///localhost`; exigimos o host logo após `http://`.
    if (authority === '') return fail('invalid_url');
    // Porta não numérica ou acima de 65535 faz o URL lançar erro genérico;
    // checada antes para devolver o motivo específico.
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const port = AUTHORITY_PORT.exec(hostPort)?.[1];
    if (port !== undefined && port !== '' && (!DIGITS.test(port) || Number(port) > MAX_PORT)) {
      return fail('port');
    }
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('invalid_url');
  }

  if (url.protocol !== 'http:') return fail('protocol');
  // O URL aceita `http:localhost`; exigimos a forma explícita `http://`.
  if (!hasHttpPrefix) return fail('invalid_url');

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
  if (!MODEL_ALLOWED_CHARS.test(model)) return fail('invalid_characters');
  // Segmentos vazios, `.` e `..` (e o `/` inicial, que gera segmento vazio)
  // não formam nomes válidos e poderiam ser lidos como caminho relativo.
  const segments = model.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return fail('invalid_format');
  }
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
