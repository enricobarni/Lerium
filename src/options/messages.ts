import type { OllamaErrorKind } from '../core/ollama-client';
import type {
  EndpointErrorReason,
  LanguageErrorReason,
  LanguagePairErrorReason,
  ModelErrorReason,
} from '../shared/validation';
import { MODEL_MAX_LENGTH } from '../shared/validation';

/**
 * Mensagens PT-BR para os códigos de validação. Módulo puro (sem `chrome`)
 * para ser testável; o `Record` obriga uma mensagem para cada código.
 */
export const ENDPOINT_ERROR_MESSAGES: Readonly<Record<EndpointErrorReason, string>> = Object.freeze(
  {
    invalid_type: 'Informe o endereço do Ollama como texto, por exemplo http://localhost:11434.',
    empty: 'Informe o endereço do Ollama, por exemplo http://localhost:11434.',
    invalid_url: 'Endereço inválido. Use o formato http://localhost:11434, sem barras invertidas.',
    invalid_characters:
      'O endereço contém espaços, acentos ou caracteres especiais. Digite-o novamente, como http://localhost:11434.',
    protocol:
      'Use um endereço começando com http://. O Ollama local não usa https; por exemplo http://localhost:11434.',
    credentials: 'Remova usuário e senha do endereço; o Ollama local não usa login.',
    query: 'Remova a parte após "?" do endereço; informe apenas o host e a porta.',
    hash: 'Remova a parte após "#" do endereço; informe apenas o host e a porta.',
    host: 'Apenas endereços locais são permitidos (localhost ou 127.0.0.1).',
    port: 'Porta inválida. Use um número entre 1 e 65535, por exemplo 11434.',
    path: 'Remova o caminho após a porta; informe apenas o host e a porta, como http://localhost:11434.',
  },
);

export const MODEL_ERROR_MESSAGES: Readonly<Record<ModelErrorReason, string>> = Object.freeze({
  invalid_type: 'Informe o nome do modelo como texto, por exemplo translategemma:4b.',
  empty: 'Informe o nome do modelo, por exemplo translategemma:4b.',
  too_long: `O nome do modelo deve ter no máximo ${MODEL_MAX_LENGTH} caracteres.`,
  invalid_characters:
    'O nome do modelo só pode ter letras sem acento, números e os sinais . _ : / -. Use o nome exibido por "ollama list".',
  invalid_format:
    'Nome de modelo inválido: não comece com "/" nem use "//", "." ou ".." entre barras. Use o nome exibido por "ollama list".',
});

/** Códigos por campo de idioma, incluindo o erro entre origem e destino. */
export type LanguageFieldErrorReason = LanguageErrorReason | LanguagePairErrorReason;

export const LANGUAGE_ERROR_MESSAGES: Readonly<Record<LanguageFieldErrorReason, string>> =
  Object.freeze({
    invalid_type: 'Escolha um idioma da lista.',
    unsupported: 'Idioma não suportado. Escolha um idioma da lista.',
    same_language: 'O idioma de destino deve ser diferente do idioma de origem.',
  });

export function endpointErrorMessage(reason: EndpointErrorReason): string {
  return ENDPOINT_ERROR_MESSAGES[reason];
}

export function modelErrorMessage(reason: ModelErrorReason): string {
  return MODEL_ERROR_MESSAGES[reason];
}

export function languageErrorMessage(reason: LanguageFieldErrorReason): string {
  return LANGUAGE_ERROR_MESSAGES[reason];
}

/**
 * Diagnóstico da conexão com o Ollama (RF01). Mensagens curtas; o passo a
 * passo de `OLLAMA_ORIGINS` (ADR-007) fica na página de opções.
 */
export const OLLAMA_ERROR_MESSAGES: Readonly<Record<OllamaErrorKind, string>> = Object.freeze({
  invalid_endpoint: 'Endereço do Ollama inválido. Corrija-o, por exemplo http://localhost:11434.',
  network:
    'Não foi possível conectar ao Ollama. Verifique se ele está em execução e se a porta do endereço está correta (padrão 11434).',
  timeout:
    'O Ollama demorou demais para responder. Verifique se ele está em execução e tente novamente.',
  forbidden:
    'O Ollama recusou a origem da extensão. Libere o ID do Lerium em OLLAMA_ORIGINS e reinicie o Ollama.',
  not_found:
    'Algo respondeu nesse endereço, mas não parece ser o Ollama. Confira o host e a porta.',
  http_error: 'O Ollama respondeu com erro. Tente novamente; se persistir, reinicie o Ollama.',
  invalid_response:
    'Algo respondeu nesse endereço, mas não parece ser o Ollama. Confira o host e a porta.',
});

/** Mensagem do erro de conexão; `status` HTTP é citado quando informado. */
export function ollamaErrorMessage(error: OllamaErrorKind, status?: number): string {
  if (error === 'http_error' && status !== undefined) {
    return `O Ollama respondeu com erro HTTP ${status}. Tente novamente; se persistir, reinicie o Ollama.`;
  }
  return OLLAMA_ERROR_MESSAGES[error];
}

/**
 * Modelo configurado ausente em `/api/tags`. O nome já passou pela
 * allowlist de `validateModel`, então pode compor o comando sugerido.
 */
export function missingModelMessage(model: string): string {
  return `O modelo "${model}" não está instalado no Ollama. Instale-o com: ollama pull ${model}`;
}

/** Resultado do botão "Testar conexão" quando `/api/tags` respondeu. */
export function connectedMessage(count: number): string {
  return `Conectado. ${count} modelo(s) encontrado(s).`;
}

/** Origem que o Ollama recebe no cabeçalho `Origin` das páginas da extensão. */
export function extensionOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}`;
}
