import type { SettingsStorageArea } from '../../src/storage/settings-repository';

/**
 * Área de storage em memória com a mesma semântica de cópia do
 * chrome.storage (valores clonados na entrada e na saída).
 */
export class FakeStorageArea implements SettingsStorageArea {
  readonly data = new Map<string, unknown>();
  getCalls = 0;
  setCalls = 0;

  constructor(initial: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.data.set(key, structuredClone(value));
    }
  }

  async get(key: string): Promise<Record<string, unknown>> {
    this.getCalls += 1;
    return this.data.has(key) ? { [key]: structuredClone(this.data.get(key)) } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls += 1;
    for (const [key, value] of Object.entries(items)) {
      this.data.set(key, structuredClone(value));
    }
  }

  /** Cópia do conteúdo atual, para comparar antes e depois. */
  snapshot(): Record<string, unknown> {
    return structuredClone(Object.fromEntries(this.data));
  }
}
