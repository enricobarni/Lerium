import { PAGE_COMMAND_MESSAGE_TYPE, PAGE_INJECT_MESSAGE_TYPE } from '../shared/page-control';
import { createPopupController, type ActiveTab } from './page-actions';
import { createPopupRenderer, getPopupElements } from './page-render';

/**
 * Entrada do popup. Só faz a ligação com `chrome`; a lógica fica em
 * `page-actions.ts` (controlador), `page-view.ts` (mensagens) e
 * `page-render.ts` (DOM). Único arquivo de `src/popup` que usa `chrome`.
 */

const OPEN_OPTIONS_ERROR = 'Não foi possível abrir as configurações. Tente novamente.';

const feedback = document.getElementById('feedback');

async function openOptions(): Promise<void> {
  try {
    await chrome.runtime.openOptionsPage();
    // A aba de configurações recebe o foco; fechar o popup evita deixá-lo aberto por trás dela.
    window.close();
  } catch {
    // Sem registrar detalhes do erro: a mensagem ao usuário basta.
    if (feedback) {
      // Limpa antes de escrever para que leitores de tela anunciem o erro mesmo se ele se repetir.
      feedback.textContent = '';
      requestAnimationFrame(() => {
        feedback.textContent = OPEN_OPTIONS_ERROR;
      });
    }
  }
}

async function getActiveTab(): Promise<ActiveTab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const id = tab?.id;
  if (id === undefined || !Number.isSafeInteger(id) || id < 0) return null;
  return tab?.url === undefined ? { id } : { id, url: tab.url };
}

const elements = getPopupElements(document);

if (elements) {
  const controller = createPopupController({
    getActiveTab,
    sendInject: (tabId) => chrome.runtime.sendMessage({ type: PAGE_INJECT_MESSAGE_TYPE, tabId }),
    sendCommand: (tabId, command) =>
      chrome.tabs.sendMessage(
        tabId,
        { type: PAGE_COMMAND_MESSAGE_TYPE, command },
        // Só o frame principal tem o content script (ADR-010).
        { frameId: 0 },
      ),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
    render: createPopupRenderer(elements, (callback) => requestAnimationFrame(callback)),
  });

  const { buttons } = elements;
  buttons.translate.addEventListener('click', () => void controller.translate());
  buttons.cancel.addEventListener('click', () => void controller.cancel());
  buttons.showOriginal.addEventListener('click', () => void controller.showOriginal());
  buttons.showTranslation.addEventListener('click', () => void controller.showTranslation());
  buttons.openOptions.addEventListener('click', () => void openOptions());
  // O popup fechou: nada de polling órfão. `unload` está obsoleto no Chrome.
  window.addEventListener('pagehide', () => controller.dispose());

  void controller.open();
}
