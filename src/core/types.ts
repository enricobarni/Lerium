/**
 * Idiomas suportados no MVP. Lista fechada e pequena de propósito: cobre o
 * destino principal (pt-BR) e os idiomas de origem mais comuns de novels
 * (inglês, japonês, coreano e chinês simplificado), além do espanhol.
 * Ampliar exige incluir o rótulo em `LANGUAGE_LABELS` (constants.ts).
 */
export type LanguageCode = 'en' | 'pt-BR' | 'es' | 'ja' | 'ko' | 'zh-CN';

/** Preferências globais do usuário, persistidas em `chrome.storage.local` (ADR-008). */
export interface TranslationSettings {
  schemaVersion: 1;
  /** Origem loopback normalizada, sem barra final (ex.: `http://localhost:11434`). */
  endpoint: string;
  model: string;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
}

export interface LanguageOption {
  code: LanguageCode;
  /** Rótulo exibido na interface, em PT-BR. */
  label: string;
}
