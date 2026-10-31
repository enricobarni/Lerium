import type { BrowserContext, Page, Worker } from '@playwright/test';
import type {
  PageCommandName,
  PageCommandResponse,
  PageInjectResponse,
  PageStateView,
} from '../../src/shared/page-control';
import { MOCK_ENDPOINT } from './fixtures';
import { CHAT_SOURCE, CHAT_TARGET, FIXTURE_PATH, LONG_FIXTURE_PATH } from './mock-ollama';

/**
 * Pilota a tradução de página como o popup faria: uma página da extensão
 * (popup/index.html, aberta numa aba) envia `page:inject` ao service worker e
 * `page:command` ao content script da aba da fixture. Os callbacks de
 * `evaluate` rodam no navegador; `chrome` não tem tipos neste tsconfig.
 */

export const FIXTURE_URL = `${MOCK_ENDPOINT}${FIXTURE_PATH}`;
export const LONG_FIXTURE_URL = `${MOCK_ENDPOINT}${LONG_FIXTURE_PATH}`;

/** Subconjunto de `chrome` usado nos callbacks (tipado à mão). */
interface ChromeLike {
  runtime: { sendMessage(message: unknown): Promise<unknown> };
  tabs: {
    query(info: { url: string }): Promise<Array<{ id?: number }>>;
    getCurrent(): Promise<{ id?: number } | undefined>;
    sendMessage(tabId: number, message: unknown, options: { frameId: number }): Promise<unknown>;
  };
  storage: { local: { set(items: Record<string, unknown>): Promise<void> } };
}

/** Grava configurações completas e válidas, apontando para o mock. */
export async function resetSettings(serviceWorker: Worker): Promise<void> {
  await serviceWorker.evaluate(
    async (settings) => {
      const { chrome } = globalThis as unknown as { chrome: ChromeLike };
      await chrome.storage.local.set({ settings });
    },
    {
      schemaVersion: 1,
      endpoint: MOCK_ENDPOINT,
      model: 'translategemma:4b',
      sourceLanguage: CHAT_SOURCE,
      targetLanguage: CHAT_TARGET,
    },
  );
}

export interface FixtureTab {
  page: Page;
  tabId: number;
}

/**
 * Abre a fixture numa aba nova e descobre o id da aba pelo service worker.
 * `knownTabIds`: abas já abertas com a mesma URL, ignoradas na busca.
 */
export async function openFixture(
  context: BrowserContext,
  serviceWorker: Worker,
  url: string = FIXTURE_URL,
  knownTabIds: readonly number[] = [],
): Promise<FixtureTab> {
  const page = await context.newPage();
  await page.goto(url);
  const ids = (
    await serviceWorker.evaluate(async (target) => {
      const { chrome } = globalThis as unknown as { chrome: ChromeLike };
      return (await chrome.tabs.query({ url: target })).map((tab) => tab.id);
    }, url)
  ).filter((id) => typeof id !== 'number' || !knownTabIds.includes(id));
  if (ids.length !== 1 || typeof ids[0] !== 'number') {
    throw new Error(`Esperava uma aba nova da fixture, achei ${ids.length}.`);
  }
  return { page, tabId: ids[0] };
}

export class PageDriver {
  private constructor(readonly page: Page) {}

  static async open(context: BrowserContext, extensionId: string): Promise<PageDriver> {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
    return new PageDriver(page);
  }

  /** Id da aba do próprio driver (página `chrome-extension://`). */
  async ownTabId(): Promise<number> {
    const id = await this.page.evaluate(async () => {
      const { chrome } = globalThis as unknown as { chrome: ChromeLike };
      return (await chrome.tabs.getCurrent())?.id;
    });
    if (typeof id !== 'number') throw new Error('Aba do driver sem id.');
    return id;
  }

  inject(tabId: number): Promise<PageInjectResponse> {
    return this.page.evaluate(async (id) => {
      const { chrome } = globalThis as unknown as { chrome: ChromeLike };
      return (await chrome.runtime.sendMessage({ type: 'page:inject', tabId: id })) as never;
    }, tabId);
  }

  command(tabId: number, command: PageCommandName): Promise<PageCommandResponse> {
    return this.page.evaluate(
      async ({ id, name }) => {
        const { chrome } = globalThis as unknown as { chrome: ChromeLike };
        return (await chrome.tabs.sendMessage(
          id,
          { type: 'page:command', command: name },
          { frameId: 0 },
        )) as never;
      },
      { id: tabId, name: command },
    );
  }

  /** Estado do job; lança se o content script recusar o comando. */
  async state(tabId: number, command: PageCommandName = 'get-state'): Promise<PageStateView> {
    const response = await this.command(tabId, command);
    if (!response.ok) throw new Error(`Comando "${command}" recusado: ${response.error}`);
    return response.state;
  }
}

/** `outerHTML` do documento inteiro (só leitura, para comparar byte a byte). */
export const outerHtml = (page: Page): Promise<string> =>
  page.evaluate(() => document.documentElement.outerHTML);
