import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_ERROR_MESSAGES,
  LANGUAGE_ERROR_MESSAGES,
  MODEL_ERROR_MESSAGES,
  endpointErrorMessage,
  languageErrorMessage,
  modelErrorMessage,
} from '../../src/options/messages';
import type {
  EndpointErrorReason,
  LanguageErrorReason,
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
];
const LANGUAGE_REASONS: LanguageErrorReason[] = ['invalid_type', 'unsupported'];

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
