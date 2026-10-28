import type { LanguageCode, LanguageOption, TranslationSettings } from './types';

export const SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: Readonly<TranslationSettings> = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  endpoint: 'http://localhost:11434',
  model: 'translategemma:4b',
  sourceLanguage: 'en',
  targetLanguage: 'pt-BR',
});

// Record garante, em tempo de compilação, um rótulo para cada LanguageCode.
const LANGUAGE_LABELS: Readonly<Record<LanguageCode, string>> = {
  en: 'Inglês',
  'pt-BR': 'Português (Brasil)',
  es: 'Espanhol',
  ja: 'Japonês',
  ko: 'Coreano',
  'zh-CN': 'Chinês (simplificado)',
};

export const LANGUAGES: readonly Readonly<LanguageOption>[] = Object.freeze(
  (Object.keys(LANGUAGE_LABELS) as LanguageCode[]).map((code) =>
    Object.freeze({ code, label: LANGUAGE_LABELS[code] }),
  ),
);

export const LANGUAGE_CODES: readonly LanguageCode[] = Object.freeze(
  LANGUAGES.map((language) => language.code),
);
