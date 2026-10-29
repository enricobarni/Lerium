import { createMessageHandler, isHandledMessage } from './message-router';

/**
 * Service worker do Lerium (ADR-009): único cliente HTTP do Ollama. O
 * listener é registrado de forma síncrona no topo do módulo, como exige o
 * MV3 para acordar o worker. Sem estado global e sem logs de dados.
 */
const handleMessage = createMessageHandler({
  runtimeId: chrome.runtime.id,
  permissionsContains: (originPattern) => chrome.permissions.contains({ origins: [originPattern] }),
  fetchFn: (input, init) => fetch(input, init),
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
