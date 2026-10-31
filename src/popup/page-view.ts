import type { PageInjectErrorKind, PageStateError, PageStateView } from '../shared/page-control';

/**
 * Traduz o estado da página em mensagens e botões do popup. Módulo puro, sem
 * `chrome` nem DOM. As mensagens são fixas: do estado só entram contagens,
 * nunca texto da página.
 */

export type PageViewInput =
  | { kind: 'unsupported' }
  | { kind: 'not_injected' }
  | { kind: 'inject_error'; error: PageInjectErrorKind }
  | { kind: 'state'; state: PageStateView }
  | { kind: 'busy' };

export type PageTone = 'info' | 'success' | 'warning' | 'error';

export interface PageButtons {
  translate: boolean;
  cancel: boolean;
  showOriginal: boolean;
  showTranslation: boolean;
  openOptions: boolean;
}

export type PageButton = keyof PageButtons;

export interface PageViewModel {
  message: string;
  tone: PageTone;
  progress?: { value: number; max: number };
  buttons: PageButtons;
  /** Destaca "Abrir configurações": a correção está lá. */
  highlightOptions: boolean;
  /**
   * Texto da região de status. Não carrega contagens que mudam a cada
   * consulta, para o leitor de tela só anunciar quando o status muda.
   */
  announce: string;
}

export const READY_MESSAGE = 'Pronto para traduzir esta página.';
export const BUSY_MESSAGE = 'Preparando a página…';
export const TRANSLATING_ANNOUNCE = 'Traduzindo a página.';
export const TRANSLATED_MESSAGE = 'Página traduzida.';
export const NOTHING_TRANSLATED_MESSAGE = 'Nenhum trecho foi traduzido.';
export const NO_TEXT_MESSAGE = 'Não há texto para traduzir nesta página.';
export const SHOWING_ORIGINAL_MESSAGE = 'Mostrando o texto original.';
export const CANCELLED_MESSAGE = 'Tradução cancelada.';
export const UNSUPPORTED_MESSAGE =
  'Esta página não pode ser traduzida. Páginas do Chrome, da Chrome Web Store, PDFs e ' +
  'outras extensões não são suportados.';
export const PREPARE_FAILED_MESSAGE =
  'Não foi possível preparar a página. Recarregue e tente de novo.';
export const INVALID_CONFIG_MESSAGE = 'Configuração inválida. Revise as configurações.';

const STATE_ERROR_MESSAGES: Readonly<Record<PageStateError, string>> = Object.freeze({
  network: 'O Ollama não respondeu. Verifique se ele está aberto e tente de novo.',
  forbidden:
    'O Ollama recusou o Lerium. Libere a origem do Lerium em OLLAMA_ORIGINS ' +
    '(veja as configurações).',
  model_missing: 'O modelo configurado não está instalado no Ollama.',
  invalid_config: INVALID_CONFIG_MESSAGE,
  settings_unavailable: INVALID_CONFIG_MESSAGE,
  interrupted: 'A tradução foi interrompida. Tente de novo.',
});

/** Erros do job cuja correção está nas configurações. */
const STATE_ERRORS_FIXED_IN_OPTIONS: Readonly<Record<PageStateError, boolean>> = Object.freeze({
  network: false,
  forbidden: true,
  model_missing: true,
  invalid_config: true,
  settings_unavailable: true,
  interrupted: false,
});

const INJECT_ERROR_MESSAGES: Readonly<Record<PageInjectErrorKind, string>> = Object.freeze({
  permission_required:
    'Falta permissão para a porta configurada do Ollama. Abra as configurações e salve o ' +
    'endereço.',
  page_unsupported: UNSUPPORTED_MESSAGE,
  settings_unavailable: INVALID_CONFIG_MESSAGE,
  injection_failed: PREPARE_FAILED_MESSAGE,
  invalid_request: PREPARE_FAILED_MESSAGE,
});

const INJECT_ERRORS_FIXED_IN_OPTIONS: Readonly<Record<PageInjectErrorKind, boolean>> =
  Object.freeze({
    permission_required: true,
    page_unsupported: false,
    settings_unavailable: true,
    injection_failed: false,
    invalid_request: false,
  });

const trechos = (count: number): string => (count === 1 ? 'trecho' : 'trechos');

export const translatingMessage = (processed: number, total: number): string =>
  total === 0 ? 'Traduzindo…' : `Traduzindo… ${processed} de ${total} ${trechos(total)}.`;

export const partialMessage = (untranslated: number): string =>
  untranslated === 1
    ? `${TRANSLATED_MESSAGE} 1 trecho continua no original.`
    : `${TRANSLATED_MESSAGE} ${untranslated} trechos continuam no original.`;

const NO_BUTTONS: PageButtons = Object.freeze({
  translate: false,
  cancel: false,
  showOriginal: false,
  showTranslation: false,
  openOptions: true,
});

function view(
  message: string,
  tone: PageTone,
  buttons: Partial<PageButtons>,
  options: { highlightOptions?: boolean; announce?: string } = {},
): PageViewModel {
  return {
    message,
    tone,
    buttons: { ...NO_BUTTONS, ...buttons },
    highlightOptions: options.highlightOptions ?? false,
    announce: options.announce ?? message,
  };
}

function describeState(state: PageStateView): PageViewModel {
  const { status, total, done, failed, skipped } = state;

  if (status === 'translating') {
    const processed = Math.min(done + failed + skipped, total);
    const translating = view(
      translatingMessage(processed, total),
      'info',
      { cancel: true },
      {
        announce: TRANSLATING_ANNOUNCE,
      },
    );
    // `<progress>` exige `max` positivo; sem total, a barra fica oculta.
    return total > 0 ? { ...translating, progress: { value: processed, max: total } } : translating;
  }

  // Fora de `translating`, sempre é possível traduzir de novo e alternar a
  // tradução já aplicada.
  const hasTranslation = done > 0;
  const toggles: Partial<PageButtons> = {
    translate: true,
    showOriginal: hasTranslation && state.view === 'translation',
    showTranslation: hasTranslation && state.view === 'original',
  };

  if (status === 'error') {
    const error = state.error ?? 'interrupted';
    return view(STATE_ERROR_MESSAGES[error], 'error', toggles, {
      highlightOptions: STATE_ERRORS_FIXED_IN_OPTIONS[error],
    });
  }

  if (hasTranslation && state.view === 'original') {
    return view(SHOWING_ORIGINAL_MESSAGE, 'info', toggles);
  }

  if (status === 'cancelled') return view(CANCELLED_MESSAGE, 'info', toggles);

  if (status === 'translated') {
    if (total === 0) return view(NO_TEXT_MESSAGE, 'warning', toggles);
    if (!hasTranslation) return view(NOTHING_TRANSLATED_MESSAGE, 'warning', toggles);
    const untranslated = failed + skipped;
    if (untranslated > 0) return view(partialMessage(untranslated), 'warning', toggles);
    return view(TRANSLATED_MESSAGE, 'success', toggles);
  }

  return view(READY_MESSAGE, 'info', toggles);
}

export function describePage(input: PageViewInput): PageViewModel {
  switch (input.kind) {
    case 'unsupported':
      return view(UNSUPPORTED_MESSAGE, 'warning', {});
    case 'not_injected':
      return view(READY_MESSAGE, 'info', { translate: true });
    case 'busy':
      return view(BUSY_MESSAGE, 'info', {});
    case 'inject_error': {
      const { error } = input;
      return view(
        INJECT_ERROR_MESSAGES[error],
        error === 'page_unsupported' ? 'warning' : 'error',
        { translate: error !== 'page_unsupported' },
        { highlightOptions: INJECT_ERRORS_FIXED_IN_OPTIONS[error] },
      );
    }
    case 'state':
      return describeState(input.state);
  }
}

/** Ordem dos botões de ação equivalentes, para onde o foco vai quando o focado some. */
const FOCUS_FALLBACK: Readonly<Record<PageButton, readonly PageButton[]>> = Object.freeze({
  translate: ['cancel', 'showOriginal', 'showTranslation'],
  cancel: ['showOriginal', 'translate', 'showTranslation'],
  showOriginal: ['showTranslation', 'translate', 'cancel'],
  showTranslation: ['showOriginal', 'translate', 'cancel'],
  openOptions: [],
});

/**
 * Botão que deve receber o foco quando `hidden` (que estava focado) some.
 * `null`: nenhum equivalente visível.
 */
export function focusFallback(hidden: PageButton, buttons: PageButtons): PageButton | null {
  return FOCUS_FALLBACK[hidden].find((button) => buttons[button]) ?? null;
}

/** Primeiro botão de ação visível, na ordem da tela. */
export function firstActionButton(buttons: PageButtons): PageButton | null {
  const order: readonly PageButton[] = ['translate', 'cancel', 'showOriginal', 'showTranslation'];
  return order.find((button) => buttons[button]) ?? null;
}
