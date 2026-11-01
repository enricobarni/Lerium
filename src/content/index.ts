/**
 * Entrada do content script (injetado sob demanda pelo service worker).
 * Só faz a ligação com `chrome`; a lógica fica em `controller.ts` e
 * `job-runner.ts`. Único arquivo de `src/content` que usa `chrome`.
 *
 * O indicador de progresso (`progress-overlay.ts`) só observa o estado do
 * job: não participa da coleta, da aplicação nem da restauração.
 */

import { PAGE_JOB_PORT_NAME } from '../shared/page-messages';
import { createContentController, handlePageHide, toPageStateView } from './controller';
import { installOnce } from './install-once';
import { createJobRunner } from './job-runner';
import { createProgressOverlay } from './progress-overlay';
import { createSegmentZoneTracker } from './segment-zone-tracker';
import { createVisibilityWatcher } from './visibility-watcher';
import type { ZoneRect } from './zone-rect';

const INSTALL_KEY = Symbol.for('lerium.content');

const ZERO_RECT: ZoneRect = { top: 0, bottom: 0, width: 0, height: 0 };

/**
 * Retângulo dos nós de um trecho: um `Range` do início do primeiro nó ao fim
 * do último, criado e descartado na própria medição (nenhum `Range` vivo).
 * Nó ausente ou desconectado → retângulo zerado (zona `out`).
 */
function measureNodes(nodes: readonly Text[]): ZoneRect {
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first === undefined || last === undefined || !first.isConnected || !last.isConnected) {
    return ZERO_RECT;
  }
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.length);
  return range.getBoundingClientRect();
}

/** Scroll (em qualquer elemento rolável, por isso `capture`) e resize da janela. */
const LISTEN_OPTIONS: AddEventListenerOptions = { passive: true, capture: true };

installOnce(globalThis, INSTALL_KEY, () => {
  const overlay = createProgressOverlay({
    doc: document,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
    requestFrame: (cb) => window.requestAnimationFrame(() => cb()),
    cancelFrame: (id) => window.cancelAnimationFrame(id as number),
  });

  const runner = createJobRunner({
    root: document,
    connect: () => chrome.runtime.connect({ name: PAGE_JOB_PORT_NAME }),
    randomUUID: () => crypto.randomUUID(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as number),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
    measure: (block) => block.getBoundingClientRect(),
    measureSegment: (segment) => measureNodes(segment.nodes),
    viewportHeight: () => window.innerHeight,
    // Só leitura do relógio: nada de `performance.mark` (visível à página).
    clock: () => performance.now(),
    // Geometria só pelo IntersectionObserver: nada de leitura síncrona no callback dele.
    createVisibilityWatcher: (onChange) =>
      createVisibilityWatcher(
        (callback, options) => new IntersectionObserver(callback, options),
        onChange,
      ),
    // Trechos de bloco compartilhado: medidos só dentro de um quadro de animação.
    createSegmentZoneTracker: (onChange) =>
      createSegmentZoneTracker(
        {
          measureText: measureNodes,
          viewportHeight: () => window.innerHeight,
          requestFrame: (cb) => window.requestAnimationFrame(() => cb()),
          cancelFrame: (id) => window.cancelAnimationFrame(id),
          listen: (onScroll) => {
            // O alvo diz qual elemento rolou (resize: a janela, que remede todos).
            const handler = (event: Event): void => onScroll(event.target);
            window.addEventListener('scroll', handler, LISTEN_OPTIONS);
            window.addEventListener('resize', handler, LISTEN_OPTIONS);
            return () => {
              window.removeEventListener('scroll', handler, LISTEN_OPTIONS);
              window.removeEventListener('resize', handler, LISTEN_OPTIONS);
            };
          },
        },
        onChange,
      ),
    onState: (state) => {
      try {
        overlay.update(toPageStateView(state));
      } catch {
        // O indicador é acessório: uma falha nele nunca interrompe o job.
      }
    },
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

  // `handlePageHide` só repassa `pagehide` confiável. No descarregamento
  // definitivo o runner é descartado sem emitir estado, então o indicador é
  // descartado aqui; no bfcache, o cancelamento emitido já o esconde.
  window.addEventListener('pagehide', (event) =>
    handlePageHide(event, {
      onPageHide(persisted) {
        controller.onPageHide(persisted);
        if (!persisted) overlay.dispose();
      },
    }),
  );
});
