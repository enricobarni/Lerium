import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, LANGUAGES, LANGUAGE_CODES } from '../../src/core/constants';

describe('DEFAULT_SETTINGS', () => {
  it('usa Ollama local, translategemma:4b e inglês para português do Brasil', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      schemaVersion: 1,
      endpoint: 'http://localhost:11434',
      model: 'translategemma:4b',
      sourceLanguage: 'en',
      targetLanguage: 'pt-BR',
    });
  });

  it('é congelado para não ser alterado por quem o consome', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
  });
});

describe('LANGUAGES', () => {
  it('lista códigos únicos com rótulos em PT-BR não vazios', () => {
    const codes = LANGUAGES.map((language) => language.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const language of LANGUAGES) {
      expect(language.label.trim()).not.toBe('');
    }
  });

  it('coincide com LANGUAGE_CODES e inclui os idiomas padrão', () => {
    expect(LANGUAGES.map((language) => language.code)).toEqual([...LANGUAGE_CODES]);
    expect(LANGUAGE_CODES).toContain(DEFAULT_SETTINGS.sourceLanguage);
    expect(LANGUAGE_CODES).toContain(DEFAULT_SETTINGS.targetLanguage);
  });

  it('é congelada, inclusive os itens', () => {
    expect(Object.isFrozen(LANGUAGES)).toBe(true);
    expect(Object.isFrozen(LANGUAGE_CODES)).toBe(true);
    expect(LANGUAGES.every((language) => Object.isFrozen(language))).toBe(true);
  });
});
