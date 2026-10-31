import { createOllamaTranslationProvider } from '../core/ollama-translation-provider';
import { createSettingsRepository } from '../storage/settings-repository';
import { restrictToTrustedContexts } from '../storage/storage-access';
import { createInjectHandler, createInjectionRegistry } from './injection';
import { createMessageHandler, isHandledMessage } from './message-router';
import { createPageJobHandler } from './page-job';

/**
 * Service worker do Lerium (ADR-009): único cliente HTTP do Ollama. O
 * listener é registrado de forma síncrona no topo do módulo, como exige o
 * MV3 para acordar o worker. O único estado global é o registro de injeção
 * (ids de documento, sem conteúdo); nada de dados vai para log.
 */
// Content scripts acessam `storage.local` por padrão; o Lerium não precisa
// disso (o worker repassa o necessário pela port). Restringe a páginas da
// extensão e ao worker. Melhor esforço, repetido a cada despertar do worker,
// que sempre roda antes de qualquer injeção. Confirmar no smoke que um
// content script recebe erro ao ler `chrome.storage.local`.
void restrictToTrustedContexts(chrome.storage.local);

const settingsRepository = createSettingsRepository(chrome.storage.local);
const permissionsContains = (originPattern: string): Promise<boolean> =>
  chrome.permissions.contains({ origins: [originPattern] });

// Documentos em que o Lerium injetou o content script (ADR-010).
const injectionRegistry = createInjectionRegistry();
chrome.tabs.onRemoved.addListener((tabId) => injectionRegistry.forget(tabId));
// Prerender/instant: a aba `removed` foi trocada por `added` sem `onRemoved`.
chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) =>
  injectionRegistry.forget(removedTabId),
);

const injectPage = createInjectHandler({
  // `url` só vem preenchida com acesso à aba: o grant de `activeTab` (clique
  // no ícone) vale para a extensão inteira, inclusive o service worker.
  getTabUrl: async (tabId) => (await chrome.tabs.get(tabId)).url ?? null,
  loadSettings: () => settingsRepository.load().catch(() => null),
  hasOriginPermission: permissionsContains,
  executeScript: async (tabId) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ['content.js'],
    });
    return results[0] ?? null;
  },
  registry: injectionRegistry,
});

const handleMessage = createMessageHandler({
  runtimeId: chrome.runtime.id,
  permissionsContains,
  fetchFn: (input, init) => fetch(input, init),
  injectPage,
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isHandledMessage(message)) return false;
  handleMessage(message, sender).then(
    (response) => sendResponse(response),
    () => sendResponse({ ok: false, error: 'invalid_request' }),
  );
  // Mantém o canal aberto até `sendResponse`.
  return true;
});

// Job de página: uma port por job, aberta pelo content script da aba.
chrome.runtime.onConnect.addListener(
  createPageJobHandler({
    runtimeId: chrome.runtime.id,
    isInjectedDocument: (tabId, documentId) => injectionRegistry.isInjected(tabId, documentId),
    loadSettings: () => settingsRepository.load().catch(() => null),
    createProvider: (settings) =>
      createOllamaTranslationProvider({
        endpoint: settings.endpoint,
        model: settings.model,
        fetchFn: (input, init) => fetch(input, init),
      }),
  }),
);
