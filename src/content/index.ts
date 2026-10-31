/**
 * Entrada do content script (injetado sob demanda pelo service worker).
 * Só faz a ligação com `chrome`; a lógica fica em `controller.ts` e
 * `job-runner.ts`. Único arquivo de `src/content` que usa `chrome`.
 */

import { PAGE_JOB_PORT_NAME } from '../shared/page-messages';
import { createContentController, handlePageHide } from './controller';
import { installOnce } from './install-once';
import { createJobRunner } from './job-runner';

const INSTALL_KEY = Symbol.for('lerium.content');

installOnce(globalThis, INSTALL_KEY, () => {
  const runner = createJobRunner({
    root: document,
    connect: () => chrome.runtime.connect({ name: PAGE_JOB_PORT_NAME }),
    randomUUID: () => crypto.randomUUID(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as number),
  });

  const controller = createContentController({
    runner,
    runtimeId: chrome.runtime.id,
    extensionOrigin: chrome.runtime.getURL(''),
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const response = controller.handleMessage(message, sender);
    if (response !== undefined) sendResponse(response);
    // Resposta sempre síncrona: o canal não fica aberto.
    return false;
  });

  window.addEventListener('pagehide', (event) => handlePageHide(event, controller));
});
