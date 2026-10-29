import { describe, expect, it } from 'vitest';
import type { OllamaErrorKind } from '../../src/core/ollama-client';
import {
  ENDPOINT_ERROR_MESSAGES,
  LANGUAGE_ERROR_MESSAGES,
  MODEL_ERROR_MESSAGES,
  OLLAMA_ERROR_MESSAGES,
  connectedMessage,
  endpointErrorMessage,
  extensionOrigin,
  languageErrorMessage,
  missingModelMessage,
  modelErrorMessage,
  ollamaErrorMessage,
} from '../../src/options/messages';
import type {
  EndpointErrorReason,
  LanguageErrorReason,
  LanguagePairErrorReason,
  ModelErrorReason,
} from '../../src/shared/validation';

// Listas explícitas: se um código novo surgir, o Record em messages.ts falha
// no typecheck, e estas listas documentam os códigos esperados.
const ENDPOINT_REASONS: EndpointErrorReason[] = [
  'invalid_type',
  'empty',
  'invalid_url',
  'invalid_characters',
  'protocol',
  'credentials',
  'query',
  'hash',
  'host',
  'port',
  'path',
];
const MODEL_REASONS: ModelErrorReason[] = [
  'invalid_type',
  'empty',
  'too_long',
  'invalid_characters',
  'invalid_format',
];
const LANGUAGE_REASONS: (LanguageErrorReason | LanguagePairErrorReason)[] = [
  'invalid_type',
  'unsupported',
  'same_language',
];

describe('mensagens de validação', () => {
  it('cobre exatamente os códigos conhecidos', () => {
    expect(Object.keys(ENDPOINT_ERROR_MESSAGES).sort()).toEqual([...ENDPOINT_REASONS].sort());
    expect(Object.keys(MODEL_ERROR_MESSAGES).sort()).toEqual([...MODEL_REASONS].sort());
    expect(Object.keys(LANGUAGE_ERROR_MESSAGES).sort()).toEqual([...LANGUAGE_REASONS].sort());
  });

  it.each(ENDPOINT_REASONS)('endpoint "%s" tem mensagem não vazia', (reason) => {
    expect(endpointErrorMessage(reason).trim()).not.toBe('');
  });

  it.each(MODEL_REASONS)('modelo "%s" tem mensagem não vazia', (reason) => {
    expect(modelErrorMessage(reason).trim()).not.toBe('');
  });

  it.each(LANGUAGE_REASONS)('idioma "%s" tem mensagem não vazia', (reason) => {
    expect(languageErrorMessage(reason).trim()).not.toBe('');
  });

  it('explica endereços remotos e https', () => {
    expect(endpointErrorMessage('host')).toBe(
      'Apenas endereços locais são permitidos (localhost ou 127.0.0.1).',
    );
    expect(endpointErrorMessage('protocol')).toMatch(/http:\/\//);
    expect(endpointErrorMessage('protocol')).toMatch(/https/);
  });
});

const OLLAMA_ERRORS: OllamaErrorKind[] = [
  'invalid_endpoint',
  'invalid_model',
  'network',
  'timeout',
  'forbidden',
  'not_found',
  'http_error',
  'invalid_response',
];

describe('mensagens de diagnóstico da conexão', () => {
  it('cobre exatamente os erros do cliente do Ollama', () => {
    expect(Object.keys(OLLAMA_ERROR_MESSAGES).sort()).toEqual([...OLLAMA_ERRORS].sort());
  });

  it.each(OLLAMA_ERRORS)('erro "%s" tem mensagem não vazia', (error) => {
    expect(ollamaErrorMessage(error).trim()).not.toBe('');
  });

  it('forbidden cita o HTTP 403, OLLAMA_ORIGINS e o reinício, sem curinga', () => {
    expect(ollamaErrorMessage('forbidden')).toBe(
      'O Ollama recusou a conexão do Lerium (HTTP 403): a origem da extensão não está liberada em OLLAMA_ORIGINS, ou o Ollama não foi reiniciado depois de configurá-la.',
    );
    expect(ollamaErrorMessage('forbidden')).not.toContain('*');
  });

  it('network cobre Ollama desligado ou porta errada', () => {
    expect(ollamaErrorMessage('network')).toBe(
      'Não foi possível conectar ao Ollama. Verifique se ele está aberto e se a porta está correta.',
    );
  });

  it('not_found e invalid_response indicam que não parece ser o Ollama', () => {
    expect(ollamaErrorMessage('not_found')).toMatch(/não parece ser o Ollama/);
    expect(ollamaErrorMessage('invalid_response')).toMatch(/não parece ser o Ollama/);
  });

  it('http_error inclui o status quando informado', () => {
    expect(ollamaErrorMessage('http_error', 500)).toMatch(/500/);
    expect(ollamaErrorMessage('http_error').trim()).not.toBe('');
  });

  it('modelo ausente cita o nome e o comando ollama pull', () => {
    const message = missingModelMessage('translategemma:4b');
    expect(message).toContain('"translategemma:4b"');
    expect(message).toContain('ollama pull translategemma:4b');
  });

  it('conexão bem-sucedida informa a quantidade de modelos', () => {
    expect(connectedMessage(3)).toBe('Conectado. 3 modelo(s) encontrado(s).');
    expect(connectedMessage(0)).toBe('Conectado. 0 modelo(s) encontrado(s).');
  });

  it('monta a origem da extensão a partir do ID, sem curinga', () => {
    const origin = extensionOrigin('mjkoppimccgajnabfeheglepjapkchlk');
    expect(origin).toBe('chrome-extension://mjkoppimccgajnabfeheglepjapkchlk');
    expect(origin).not.toContain('*');
  });
});
