import type { LanguageCode } from './types';

/**
 * Contrato do motor de tradução (Fase 3, PLAN.md). Módulo só de tipos: não
 * depende do cliente do Ollama, para que consumidores (fila, DOM, seleção)
 * conheçam apenas esta interface.
 */

/**
 * Códigos de erro de uma tradução. Nunca carregam texto da página, do modelo
 * nem mensagens do Ollama: a interface traduz o código em PT-BR.
 *
 * - `invalid_input`: o segmento não é utilizável (não é objeto, texto
 *   ausente ou vazio, pedido não serializável);
 * - `consumer_error`: o `onToken` do consumidor lançou.
 */
export type TranslationErrorKind =
  | 'invalid_config'
  | 'network'
  | 'timeout'
  | 'forbidden'
  | 'model_missing'
  | 'http_error'
  | 'provider_error'
  | 'invalid_response'
  | 'truncated'
  | 'empty_response'
  | 'cancelled'
  | 'invalid_input'
  | 'consumer_error';

/** Um segmento a traduzir. `text` é dado não confiável da página. */
export interface TranslationInput {
  text: string;
  source: LanguageCode;
  target: LanguageCode;
}

export interface TranslateOptions {
  /** Cancela a tradução; o resultado vira `{ ok: false, error: 'cancelled' }`. */
  signal?: AbortSignal;
  /**
   * Recebe cada trecho gerado, em ordem, para exibição progressiva. Se o
   * resultado final for `ok: false`, o consumidor deve descartar tudo o que
   * acumulou por aqui: não há texto parcial em erro e o original da página
   * é preservado (RF06).
   */
  onToken?: (delta: string) => void;
}

/**
 * Resultado de `translate`. Em erro não há texto parcial e `status` traz o
 * código HTTP quando houver.
 *
 * `retryable`: o consumidor (fila/usuário) pode repetir a mesma chamada com
 * chance de sucesso (rede, prazo, sobrecarga). É distinto da nova tentativa
 * interna automática que o provedor pode já ter feito antes de devolver o
 * resultado.
 */
export type TranslationResult =
  | { ok: true; text: string; durationMs: number; outputTokens?: number }
  | { ok: false; error: TranslationErrorKind; retryable: boolean; status?: number };

/**
 * Provedor de tradução. Cada instância é criada com um snapshot do endpoint e
 * do modelo vigentes; mudar as configurações exige criar outra instância, de
 * modo que uma tradução em andamento não troca de destino no meio.
 *
 * `translate` nunca lança nem rejeita: toda falha vira `{ ok: false }`.
 */
export interface TranslationProvider {
  translate(input: TranslationInput, options?: TranslateOptions): Promise<TranslationResult>;
}
