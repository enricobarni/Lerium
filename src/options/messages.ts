import type {
  EndpointErrorReason,
  LanguageErrorReason,
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
    invalid_url:
      'Endereço inválido. Use o formato http://localhost:11434, sem espaços nem barras invertidas.',
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
    'O nome do modelo não pode conter espaços nem caracteres de controle. Use o nome exibido por "ollama list".',
});

export const LANGUAGE_ERROR_MESSAGES: Readonly<Record<LanguageErrorReason, string>> = Object.freeze(
  {
    invalid_type: 'Escolha um idioma da lista.',
    unsupported: 'Idioma não suportado. Escolha um idioma da lista.',
  },
);

export function endpointErrorMessage(reason: EndpointErrorReason): string {
  return ENDPOINT_ERROR_MESSAGES[reason];
}

export function modelErrorMessage(reason: ModelErrorReason): string {
  return MODEL_ERROR_MESSAGES[reason];
}

export function languageErrorMessage(reason: LanguageErrorReason): string {
  return LANGUAGE_ERROR_MESSAGES[reason];
}
