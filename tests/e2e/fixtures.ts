import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { MOCK_HOST, MOCK_PORT, startMockOllama, type MockOllama } from './mock-ollama';

/** ID fixo da extensão, derivado da `key` do manifesto (ADR-007). */
export const EXTENSION_ID = 'mjkoppimccgajnabfeheglepjapkchlk';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
export const MOCK_ENDPOINT = `http://${MOCK_HOST}:${MOCK_PORT}`;

const DIST_DIR = fileURLToPath(new URL('../../dist', import.meta.url));
const DIST_MANIFEST = fileURLToPath(new URL('../../dist/manifest.json', import.meta.url));

export interface LoggedMessage {
  source: 'page' | 'service-worker';
  type: string;
  text: string;
}

interface Fixtures {
  ollama: MockOllama;
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  /** Mensagens de console e erros não tratados da página e do service worker. */
  consoleMessages: LoggedMessage[];
}

export const test = base.extend<Fixtures>({
  // Sobe antes do contexto: o teste automático da página de opções roda ao abrir.
  // eslint-disable-next-line no-empty-pattern
  ollama: async ({}, use) => {
    const ollama = await startMockOllama();
    await use(ollama);
    await ollama.close();
  },

  // eslint-disable-next-line no-empty-pattern
  consoleMessages: async ({}, use) => {
    await use([]);
  },

  context: async ({ ollama, reducedMotion, consoleMessages }, use) => {
    void ollama;
    if (!existsSync(DIST_MANIFEST)) {
      throw new Error(
        `Extensão não encontrada em ${DIST_MANIFEST}. Rode "npm run build" antes de "npm run test:e2e".`,
      );
    }
    // O Chrome estável não aceita --load-extension; o Chromium do Playwright aceita.
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      reducedMotion,
      args: [`--disable-extensions-except=${DIST_DIR}`, `--load-extension=${DIST_DIR}`],
    });
    context.on('page', (page) => {
      page.on('console', (message) =>
        consoleMessages.push({ source: 'page', type: message.type(), text: message.text() }),
      );
      page.on('pageerror', (error) =>
        consoleMessages.push({ source: 'page', type: 'pageerror', text: String(error) }),
      );
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context, consoleMessages }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    worker.on('console', (message) =>
      consoleMessages.push({
        source: 'service-worker',
        type: message.type(),
        text: message.text(),
      }),
    );
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    const id = new URL(serviceWorker.url()).host;
    if (id !== EXTENSION_ID) {
      throw new Error(
        `ID da extensão inesperado: ${id} (esperado ${EXTENSION_ID}). A "key" do manifesto mudou?`,
      );
    }
    // Endereço explícito em IPv4: "localhost" poderia resolver para ::1, onde o mock não escuta.
    await serviceWorker.evaluate(async (endpoint) => {
      // Roda no service worker; tsconfig.node.json não carrega os tipos de `chrome`.
      const { chrome } = globalThis as unknown as {
        chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } };
      };
      await chrome.storage.local.set({ settings: { schemaVersion: 1, endpoint } });
    }, MOCK_ENDPOINT);
    await use(id);
  },
});

export const expect = test.expect;
