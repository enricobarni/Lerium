import type { PageStateView } from '../shared/page-control';
import { LERIUM_UI_ATTRIBUTE } from './dom-collector';
import { describeProgress, type ProgressViewModel } from './progress-view';

/**
 * Indicador de progresso na página: uma pílula fixa no canto inferior
 * direito, dentro de um shadow root fechado. Sem `chrome`; o tempo e os
 * quadros entram por `ProgressOverlayDeps`.
 *
 * - Aparece só depois de um `translating`. Estados finais que chegam sem ele
 *   (página sem texto, falha ao conectar) ficam só no popup, que é de onde o
 *   usuário acabou de pedir a tradução.
 * - Some quando o modelo vira `null` (cancelado, idle, visão original), no
 *   "Fechar" ou 5 s após o sucesso completo; ao sumir, o host sai do DOM e só
 *   volta com um novo `translating` vindo de um novo início (um estado que não
 *   seja `translating` entre os dois). Alternar a visão depois do fim não o
 *   traz de volta.
 * - "Fechar" só aceita clique confiável (`isTrusted`) e não cancela o job.
 * - A contagem do sucesso para com o ponteiro ou o foco dentro do indicador e
 *   recomeça inteira quando os dois saem. Nunca chama `focus()`.
 * - Fica na top layer (`popover="manual"` + `showPopover()`), contido pela
 *   viewport mesmo com `filter`/`transform`/`contain` em `<html>` (ex.: Dark
 *   Reader no modo filtro), que prenderiam um `position: fixed` comum. Sem a
 *   Popover API, fica como `fixed` no fim do documento.
 * - Sai do DOM enquanto houver tela cheia (`fullscreenElement`) e volta ao
 *   sair dela, se ainda devia estar visível.
 * - Atualizações são agrupadas em um render por quadro.
 * - DOM só com `createElement`/`textContent`/`append`; do estado só entram
 *   contagens (ver `progress-view.ts`). O host tem `data-lerium-ui`, que a
 *   coleta ignora; a coleta também não entra em shadow DOM (ADR-012).
 */

export const AUTO_HIDE_MS = 5000;

export interface ProgressOverlayDeps {
  doc: Document;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  requestFrame(cb: () => void): unknown;
  cancelFrame(id: unknown): void;
  /** Folha construída vazia, ou `null` sem suporte (cai num `<style>`). */
  createSheet?: () => CSSStyleSheet | null;
  /** Só para teste: o jsdom não gera eventos confiáveis. Padrão `event.isTrusted`. */
  isTrusted?: (event: Event) => boolean;
}

export interface ProgressOverlay {
  update(state: PageStateView): void;
  dispose(): void;
}

export const OVERLAY_CSS = `
:host {
  all: initial !important;
  display: block !important;
  position: fixed !important;
  inset: auto 16px 16px auto !important;
  z-index: 2147483647 !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  color: inherit !important;
  overflow: visible !important;
  pointer-events: auto !important;
}
:host::backdrop { display: none !important; }
.pill {
  --bg: #ffffff;
  --fg: #1f2328;
  --border: #8c959f;
  --hover: #eaeef2;
  --accent: #0969da;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: max-content;
  min-width: 200px;
  max-width: min(320px, calc(100vw - 32px));
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 4px solid var(--accent);
  border-radius: 12px;
  background: var(--bg);
  color: var(--fg);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  font: 400 14px/20px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  text-align: start;
  transition: opacity 160ms ease-out, transform 160ms ease-out;
}
@starting-style {
  .pill {
    opacity: 0;
    transform: translateY(4px);
  }
}
.pill[data-tone="success"] { --accent: #1a7f37; }
.pill[data-tone="warning"] { --accent: #9a6700; }
.pill[data-tone="error"] { --accent: #cf222e; }
.row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.message {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
.close {
  flex: none;
  box-sizing: border-box;
  min-width: 24px;
  min-height: 24px;
  margin: 0;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  font: 500 13px/18px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  cursor: pointer;
}
.close:hover { background: var(--hover); }
.close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
progress {
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 6px;
  margin: 0;
  accent-color: var(--accent);
}
progress[hidden] { display: none; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (prefers-color-scheme: dark) {
  .pill {
    --bg: #161b22;
    --fg: #f0f6fc;
    --border: #6e7681;
    --hover: #30363d;
    --accent: #4493f8;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  }
  .pill[data-tone="success"] { --accent: #3fb950; }
  .pill[data-tone="warning"] { --accent: #d29922; }
  .pill[data-tone="error"] { --accent: #f85149; }
}
@media (forced-colors: active) {
  .pill {
    background: Canvas;
    color: CanvasText;
    border-color: CanvasText;
    box-shadow: none;
  }
  .close {
    background: ButtonFace;
    color: ButtonText;
    border-color: ButtonText;
  }
  .close:focus-visible { outline-color: Highlight; }
  progress { accent-color: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .pill { transition: none; }
}
@media print {
  :host { display: none !important; }
}
`;

interface OverlayElements {
  host: HTMLElement;
  pill: HTMLElement;
  message: HTMLElement;
  progress: HTMLProgressElement;
  status: HTMLElement;
}

/** Popover API (top layer); ausente em navegadores antigos e no jsdom. */
function supportsPopover(host: HTMLElement): boolean {
  return typeof (host as { showPopover?: unknown }).showPopover === 'function';
}

function defaultCreateSheet(doc: Document): CSSStyleSheet | null {
  const Sheet = doc.defaultView?.CSSStyleSheet;
  if (Sheet === undefined) return null;
  try {
    return new Sheet();
  } catch {
    return null;
  }
}

export function createProgressOverlay(deps: ProgressOverlayDeps): ProgressOverlay {
  const { doc } = deps;
  const isTrusted = deps.isTrusted ?? ((event: Event) => event.isTrusted);
  const createSheet = deps.createSheet ?? (() => defaultCreateSheet(doc));

  let elements: OverlayElements | null = null;
  /** Modelo pedido pela última atualização; `null` = oculto. */
  let pending: ProgressViewModel | null = null;
  /** Modelo hoje na tela. */
  let shown: ProgressViewModel | null = null;
  let announced: string | null = null;
  let frame: unknown = null;
  let announceFrame: unknown = null;
  let hideTimer: unknown = null;
  /** Visto um `translating` e o indicador ainda não sumiu de vez. */
  let session = false;
  let dismissed = false;
  let lastTranslating = false;
  let pointerInside = false;
  let focusInside = false;
  let disposed = false;
  /** O host foi posto na top layer por `showPopover()`. */
  let inTopLayer = false;

  const isFullscreen = (): boolean => (doc.fullscreenElement ?? null) !== null;

  /** Tira o host da top layer e do DOM. */
  function unplace(host: HTMLElement): void {
    if (inTopLayer) {
      inTopLayer = false;
      try {
        host.hidePopover();
      } catch {
        // A remoção abaixo já o tira da top layer.
      }
    }
    host.remove();
  }

  /** Põe o host no fim do documento e na top layer; em tela cheia, tira-o. */
  function place(host: HTMLElement): void {
    if (isFullscreen()) {
      unplace(host);
      return;
    }
    // A página pode ter tirado o host do DOM (o que também o tira da top layer).
    if (!host.isConnected) {
      inTopLayer = false;
      doc.documentElement.append(host);
    }
    if (inTopLayer || !supportsPopover(host)) return;
    try {
      host.showPopover();
      inTopLayer = true;
    } catch {
      // Fica como `position: fixed` comum.
    }
  }

  function clearHideTimer(): void {
    if (hideTimer === null) return;
    deps.clearTimeout(hideTimer);
    hideTimer = null;
  }

  function cancelFrames(): void {
    if (frame !== null) deps.cancelFrame(frame);
    if (announceFrame !== null) deps.cancelFrame(announceFrame);
    frame = null;
    announceFrame = null;
  }

  function removeHost(): void {
    clearHideTimer();
    if (announceFrame !== null) deps.cancelFrame(announceFrame);
    announceFrame = null;
    if (elements !== null) unplace(elements.host);
    elements = null;
    shown = null;
    announced = null;
    pointerInside = false;
    focusInside = false;
  }

  /** Some de vez: só um novo início o traz de volta. */
  function endSession(): void {
    session = false;
    pending = null;
    if (frame !== null) deps.cancelFrame(frame);
    frame = null;
    removeHost();
  }

  /** Conta o sumiço do sucesso, se nada o segura (ponteiro ou foco dentro). */
  function syncHideTimer(): void {
    const counting = shown?.autoHide === true && !pointerInside && !focusInside;
    if (!counting) {
      clearHideTimer();
      return;
    }
    if (hideTimer !== null) return;
    hideTimer = deps.setTimeout(() => {
      hideTimer = null;
      endSession();
    }, AUTO_HIDE_MS);
  }

  function applyStyles(root: ShadowRoot): void {
    const sheet = createSheet();
    if (sheet !== null && 'adoptedStyleSheets' in root) {
      try {
        sheet.replaceSync(OVERLAY_CSS);
        root.adoptedStyleSheets = [sheet];
        return;
      } catch {
        // Cai no `<style>` abaixo.
      }
    }
    const style = doc.createElement('style');
    style.textContent = OVERLAY_CSS;
    root.append(style);
  }

  function build(): OverlayElements {
    const host = doc.createElement('div');
    host.setAttribute(LERIUM_UI_ATTRIBUTE, '');
    if (supportsPopover(host)) host.setAttribute('popover', 'manual');
    // Referência ao shadow root só nesta closure: a página não o alcança.
    const root = host.attachShadow({ mode: 'closed' });
    applyStyles(root);

    const pill = doc.createElement('div');
    pill.className = 'pill';
    pill.lang = 'pt-BR';

    const row = doc.createElement('div');
    row.className = 'row';
    const message = doc.createElement('p');
    message.className = 'message';
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.textContent = 'Fechar';
    row.append(message, close);

    const progress = doc.createElement('progress');
    progress.setAttribute('aria-label', 'Progresso da tradução');
    progress.hidden = true;

    const status = doc.createElement('div');
    status.className = 'sr-only';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    pill.append(row, progress, status);
    root.append(pill);

    close.addEventListener('click', (event) => {
      if (!isTrusted(event)) return;
      // Esconde até o próximo início; o job segue.
      dismissed = true;
      endSession();
    });
    pill.addEventListener('pointerenter', () => {
      pointerInside = true;
      syncHideTimer();
    });
    pill.addEventListener('pointerleave', () => {
      pointerInside = false;
      syncHideTimer();
    });
    pill.addEventListener('focusin', () => {
      focusInside = true;
      syncHideTimer();
    });
    pill.addEventListener('focusout', (event) => {
      // Sem `instanceof Node`: o alvo pode vir de outro realm.
      const next = event.relatedTarget as Node | null;
      focusInside = next !== null && 'nodeType' in next && pill.contains(next);
      syncHideTimer();
    });

    return { host, pill, message, progress, status };
  }

  function announce(status: HTMLElement, text: string): void {
    if (text === announced) return;
    announced = text;
    // Limpa e reescreve no quadro seguinte, para o leitor de tela anunciar.
    status.textContent = '';
    if (announceFrame !== null) deps.cancelFrame(announceFrame);
    announceFrame = deps.requestFrame(() => {
      announceFrame = null;
      if (elements !== null && announced === text) elements.status.textContent = text;
    });
  }

  function render(): void {
    frame = null;
    const next = pending;
    if (next === null) {
      removeHost();
      return;
    }
    if (elements === null) elements = build();
    place(elements.host);

    const { pill, message, progress, status } = elements;
    message.textContent = next.message;
    pill.dataset.tone = next.tone;
    if (next.progress === undefined) {
      progress.hidden = true;
      progress.removeAttribute('value');
    } else {
      progress.max = next.progress.max;
      progress.value = next.progress.value;
      progress.hidden = false;
    }
    shown = next;
    announce(status, next.announce);
    syncHideTimer();
  }

  /** Tela cheia: o indicador sai do DOM e volta ao fim dela, se ainda visível. */
  function onFullscreenChange(): void {
    if (elements === null) return;
    if (isFullscreen()) {
      // Fora do DOM, ponteiro e foco não ficam mais dentro.
      pointerInside = false;
      focusInside = false;
    }
    place(elements.host);
    syncHideTimer();
  }
  doc.addEventListener('fullscreenchange', onFullscreenChange);

  return {
    update(state) {
      if (disposed) return;
      const translating = state.status === 'translating';
      if (translating && !lastTranslating) {
        // Novo início: reaparece mesmo se o anterior foi fechado.
        session = true;
        dismissed = false;
      }
      lastTranslating = translating;
      if (!session || dismissed) return;

      const next = describeProgress(state);
      if (next === null) {
        endSession();
        return;
      }
      pending = next;
      if (frame === null) frame = deps.requestFrame(render);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      doc.removeEventListener('fullscreenchange', onFullscreenChange);
      session = false;
      pending = null;
      cancelFrames();
      removeHost();
    },
  };
}
