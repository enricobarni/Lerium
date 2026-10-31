import {
  firstActionButton,
  focusFallback,
  type PageButton,
  type PageButtons,
  type PageViewModel,
} from './page-view';

/**
 * Aplica um `PageViewModel` ao DOM do popup. Sem `chrome`; só escreve texto
 * fixo com `textContent`. Cuida de três detalhes de acessibilidade:
 *
 * - Anúncio: a região de status só é reescrita quando `announce` muda, com o
 *   padrão limpar-e-reescrever (o mesmo das opções) para repetir anúncios.
 * - Botões que não se aplicam ficam `hidden` (não `disabled`).
 * - Foco: se o botão focado some, o foco vai para o equivalente visível
 *   (`focusFallback`). Sem equivalente (ação em andamento), o foco espera no
 *   título e passa ao primeiro botão de ação quando ele voltar.
 */

export interface PopupElements {
  message: HTMLElement;
  status: HTMLElement;
  progress: HTMLProgressElement;
  /** Destino temporário do foco (`tabindex="-1"`). */
  focusHolder: HTMLElement;
  buttons: Record<PageButton, HTMLButtonElement>;
}

const BUTTON_IDS: Readonly<Record<PageButton, string>> = Object.freeze({
  translate: 'translate',
  cancel: 'cancel',
  showOriginal: 'show-original',
  showTranslation: 'show-translation',
  openOptions: 'open-options',
});

const BUTTON_NAMES = Object.keys(BUTTON_IDS) as PageButton[];

/** Localiza os elementos do popup; `null` se o HTML não tiver algum deles. */
export function getPopupElements(doc: Document): PopupElements | null {
  const message = doc.getElementById('page-message');
  const status = doc.getElementById('page-status');
  const progress = doc.getElementById('page-progress');
  const focusHolder = doc.getElementById('popup-title');
  if (!message || !status || !focusHolder || !(progress instanceof HTMLProgressElement)) {
    return null;
  }
  const buttons: Partial<Record<PageButton, HTMLButtonElement>> = {};
  for (const name of BUTTON_NAMES) {
    const button = doc.getElementById(BUTTON_IDS[name]);
    if (!(button instanceof HTMLButtonElement)) return null;
    buttons[name] = button;
  }
  return { message, status, progress, focusHolder, buttons: buttons as PopupElements['buttons'] };
}

export type Schedule = (callback: () => void) => void;

export function createPopupRenderer(
  elements: PopupElements,
  schedule: Schedule,
): (view: PageViewModel) => void {
  const { message, status, progress, focusHolder, buttons } = elements;
  const doc = message.ownerDocument;
  let announced: string | null = null;
  let focusPending = false;

  function focusedButton(): PageButton | null {
    const active = doc.activeElement;
    return BUTTON_NAMES.find((name) => buttons[name] === active) ?? null;
  }

  function moveFocus(previous: PageButton | null, visible: PageButtons): void {
    const active = doc.activeElement;
    if (previous !== null && !visible[previous]) {
      const next = focusFallback(previous, visible);
      if (next !== null) {
        buttons[next].focus();
        focusPending = false;
      } else {
        focusHolder.focus();
        focusPending = true;
      }
      return;
    }
    if (!focusPending) return;
    // O usuário levou o foco a outro lugar: não o puxa de volta.
    if (active !== focusHolder && active !== doc.body && active !== null) {
      focusPending = false;
      return;
    }
    const first = firstActionButton(visible);
    if (first !== null) {
      buttons[first].focus();
      focusPending = false;
    }
  }

  function announce(text: string): void {
    if (text === announced) return;
    announced = text;
    // Limpa antes de escrever para que leitores de tela anunciem mensagens repetidas.
    status.textContent = '';
    schedule(() => {
      if (announced === text) status.textContent = text;
    });
  }

  return (view) => {
    message.textContent = view.message;
    message.dataset.tone = view.tone;

    if (view.progress === undefined) {
      progress.hidden = true;
    } else {
      progress.max = view.progress.max;
      progress.value = view.progress.value;
      progress.hidden = false;
    }

    const previous = focusedButton();
    for (const name of BUTTON_NAMES) buttons[name].hidden = !view.buttons[name];
    // Uma ação em destaque por vez: com a correção nas configurações, elas
    // passam a ser o botão principal.
    buttons.openOptions.classList.toggle('primary', view.highlightOptions);
    buttons.openOptions.classList.toggle('secondary', !view.highlightOptions);
    buttons.translate.classList.toggle('primary', !view.highlightOptions);
    buttons.translate.classList.toggle('secondary', view.highlightOptions);
    moveFocus(previous, view.buttons);

    announce(view.announce);
  };
}
