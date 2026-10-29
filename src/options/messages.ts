import type { OllamaErrorKind } from '../core/ollama-client';
import type { TestConnectionErrorKind } from '../shared/runtime-messages';
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
  invalid_model: 'Nome de modelo inválido. Use o nome exibido por "ollama list".',
  network:
    'Não foi possível conectar ao Ollama. Verifique se ele está aberto e se a porta está correta.',
  timeout:
    'O Ollama demorou demais para responder. Verifique se ele está em execução e tente novamente.',
  forbidden:
    'O Ollama recusou a conexão do Lerium (HTTP 403): a origem da extensão não está liberada em OLLAMA_ORIGINS, ou o Ollama não foi reiniciado depois de configurá-la.',
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
 * Códigos que a página de opções pode exibir após "Testar conexão": os do
 * service worker mais `extension_error`, falha local ao falar com ele
 * (worker inativo, extensão recarregada, resposta fora do contrato).
 */
export type ConnectionErrorKind = TestConnectionErrorKind | 'extension_error';

export const CONNECTION_ERROR_MESSAGES: Readonly<Record<ConnectionErrorKind, string>> =
  Object.freeze({
    ...OLLAMA_ERROR_MESSAGES,
    permission_required:
      'O Lerium ainda não tem permissão para acessar esse endereço. Clique em "Testar conexão" para concedê-la.',
    invalid_request:
      'O serviço da extensão recusou o pedido. Confira o endereço e o modelo e tente de novo.',
    extension_error:
      'Não foi possível falar com o serviço da extensão. Recarregue o Lerium em chrome://extensions e tente de novo.',
  });

/** Mensagem de falha do teste de conexão; `status` HTTP é citado quando informado. */
export function connectionErrorMessage(error: ConnectionErrorKind, status?: number): string {
  if (error === 'http_error') return ollamaErrorMessage(error, status);
  return CONNECTION_ERROR_MESSAGES[error];
}

/**
 * Usuário negou a permissão opcional de host. `origin` vem de
 * `normalizeEndpoint` (só loopback e porta numérica).
 */
export function permissionDeniedMessage(origin: string): string {
  return `Sem permissão para acessar ${origin}, o Lerium não consegue falar com o Ollama nessa porta.`;
}

/**
 * Modelo configurado ausente no Ollama (`/api/show` respondeu 404). O nome
 * já passou pela allowlist de `validateModel`, então pode compor o comando
 * sugerido.
 */
export function missingModelMessage(model: string): string {
  return `O modelo "${model}" não está instalado no Ollama. Instale-o com: ollama pull ${model}`;
}

/** Resultado do botão "Testar conexão" quando o Ollama respondeu. */
export function connectedMessage(count: number): string {
  return `Conectado. ${count} modelo(s) encontrado(s).`;
}

/** Origem que o Ollama recebe no cabeçalho `Origin` das páginas da extensão. */
export function extensionOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}`;
}
