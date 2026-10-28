import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION } from '../core/constants';
import type { TranslationSettings } from '../core/types';
import {
  normalizeEndpoint,
  validateLanguage,
  validateModel,
  type EndpointErrorReason,
  type LanguageErrorReason,
  type LanguagePairErrorReason,
  type ModelErrorReason,
} from '../shared/validation';

/** Chave única das preferências no storage (ADR-008). */
export const SETTINGS_STORAGE_KEY = 'settings';

/**
 * Subconjunto mínimo de `chrome.storage.StorageArea` usado aqui. Declarado
 * localmente para o módulo não depender dos tipos do Chrome e ser testável
 * com um fake; `chrome.storage.local` é compatível estruturalmente.
 */
export interface SettingsStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** Campos editáveis pelo usuário; valores chegam sem tipo garantido (formulário). */
export type SettingsInput = Record<
  'endpoint' | 'model' | 'sourceLanguage' | 'targetLanguage',
  unknown
>;

export interface SettingsFieldErrors {
  endpoint?: EndpointErrorReason;
  model?: ModelErrorReason;
  sourceLanguage?: LanguageErrorReason;
  /** Também recebe `same_language` quando origem e destino coincidem. */
  targetLanguage?: LanguageErrorReason | LanguagePairErrorReason;
}

export type SaveResult =
  { ok: true; settings: TranslationSettings } | { ok: false; errors: SettingsFieldErrors };

export interface SettingsRepository {
  /** Lê as preferências mescladas com os padrões. Nunca grava. */
  load(): Promise<TranslationSettings>;
  /** Valida tudo e grava só se todos os campos forem válidos. */
  save(input: SettingsInput): Promise<SaveResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readStored(area: SettingsStorageArea): Promise<Record<string, unknown>> {
  const items = await area.get(SETTINGS_STORAGE_KEY);
  const stored = items[SETTINGS_STORAGE_KEY];
  return isRecord(stored) ? stored : {};
}

function validateInput(input: SettingsInput): SaveResult {
  const endpoint = normalizeEndpoint(input.endpoint);
  const model = validateModel(input.model);
  const sourceLanguage = validateLanguage(input.sourceLanguage);
  const targetLanguage = validateLanguage(input.targetLanguage);

  const sameLanguage =
    sourceLanguage.ok && targetLanguage.ok && sourceLanguage.value === targetLanguage.value;

  if (endpoint.ok && model.ok && sourceLanguage.ok && targetLanguage.ok && !sameLanguage) {
    return {
      ok: true,
      settings: {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        endpoint: endpoint.value,
        model: model.value,
        sourceLanguage: sourceLanguage.value,
        targetLanguage: targetLanguage.value,
      },
    };
  }

  const errors: SettingsFieldErrors = {};
  if (!endpoint.ok) errors.endpoint = endpoint.reason;
  if (!model.ok) errors.model = model.reason;
  if (!sourceLanguage.ok) errors.sourceLanguage = sourceLanguage.reason;
  if (!targetLanguage.ok) errors.targetLanguage = targetLanguage.reason;
  if (sameLanguage) errors.targetLanguage = 'same_language';
  return { ok: false, errors };
}

export function createSettingsRepository(area: SettingsStorageArea): SettingsRepository {
  return {
    async load() {
      const stored = await readStored(area);
      // Mescla por campo: valor armazenado válido vence; inválido ou ausente
      // usa o padrão apenas em memória (sem regravar, ADR-008).
      const endpoint = normalizeEndpoint(stored.endpoint);
      const model = validateModel(stored.model);
      const sourceLanguage = validateLanguage(stored.sourceLanguage);
      const targetLanguage = validateLanguage(stored.targetLanguage);
      let source = sourceLanguage.ok ? sourceLanguage.value : DEFAULT_SETTINGS.sourceLanguage;
      let target = targetLanguage.ok ? targetLanguage.value : DEFAULT_SETTINGS.targetLanguage;
      // Par efetivo igual (armazenado ou após a mescla) não é traduzível:
      // ambos voltam ao padrão, também só em memória.
      if (source === target) {
        source = DEFAULT_SETTINGS.sourceLanguage;
        target = DEFAULT_SETTINGS.targetLanguage;
      }
      return {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        endpoint: endpoint.ok ? endpoint.value : DEFAULT_SETTINGS.endpoint,
        model: model.ok ? model.value : DEFAULT_SETTINGS.model,
        sourceLanguage: source,
        targetLanguage: target,
      };
    },

    async save(input) {
      const result = validateInput(input);
      if (!result.ok) return result;

      // Chaves desconhecidas (de versões futuras ou anteriores) são preservadas.
      const stored = await readStored(area);
      await area.set({ [SETTINGS_STORAGE_KEY]: { ...stored, ...result.settings } });
      return result;
    },
  };
}
