import { describe, expect, it } from 'vitest';
import type {
  PageInjectErrorKind,
  PageStateError,
  PageStateView,
  PageStatus,
  PageView,
} from '../../src/shared/page-control';
import {
  BUSY_MESSAGE,
  CANCELLED_MESSAGE,
  INVALID_CONFIG_MESSAGE,
  NO_TEXT_MESSAGE,
  NOTHING_TRANSLATED_MESSAGE,
  PREPARE_FAILED_MESSAGE,
  READY_MESSAGE,
  SHOWING_ORIGINAL_MESSAGE,
  TRANSLATED_MESSAGE,
  TRANSLATING_ANNOUNCE,
  UNSUPPORTED_MESSAGE,
  describePage,
  firstActionButton,
  focusFallback,
  type PageButtons,
  type PageViewInput,
} from '../../src/popup/page-view';

const STATUSES: PageStatus[] = ['idle', 'translating', 'translated', 'cancelled', 'error'];
const VIEWS: PageView[] = ['original', 'translation'];
const STATE_ERRORS: PageStateError[] = [
  'network',
  'forbidden',
  'model_missing',
  'invalid_config',
  'settings_unavailable',
  'interrupted',
];
const INJECT_ERRORS: PageInjectErrorKind[] = [
  'permission_required',
  'page_unsupported',
  'settings_unavailable',
  'injection_failed',
  'invalid_request',
];

const state = (overrides: Partial<PageStateView> = {}): PageViewInput => ({
  kind: 'state',
  state: {
    status: 'idle',
    view: 'translation',
    total: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    ...overrides,
  },
});

const buttons = (visible: Partial<PageButtons>): PageButtons => ({
  translate: false,
  cancel: false,
  showOriginal: false,
  showTranslation: false,
  openOptions: true,
  ...visible,
});

describe('describePage: fora do job', () => {
  it('página não suportada: aviso, sem Traduzir', () => {
    expect(describePage({ kind: 'unsupported' })).toEqual({
      message: UNSUPPORTED_MESSAGE,
      tone: 'warning',
      buttons: buttons({}),
      highlightOptions: false,
      announce: UNSUPPORTED_MESSAGE,
    });
  });

  it('sem content script: pronto, só Traduzir e configurações', () => {
    expect(describePage({ kind: 'not_injected' })).toEqual({
      message: READY_MESSAGE,
      tone: 'info',
      buttons: buttons({ translate: true }),
      highlightOptions: false,
      announce: READY_MESSAGE,
    });
  });

  it('ocupado: nenhuma ação além das configurações', () => {
    const view = describePage({ kind: 'busy' });
    expect(view).toMatchObject({ message: BUSY_MESSAGE, tone: 'info', buttons: buttons({}) });
    expect(view.progress).toBeUndefined();
  });
});

describe('describePage: erros de injeção', () => {
  const expected: Record<PageInjectErrorKind, [string, boolean, boolean]> = {
    // [mensagem, Traduzir visível, destaque nas configurações]
    permission_required: [
      'Falta permissão para a porta configurada do Ollama. Abra as configurações e salve o endereço.',
      true,
      true,
    ],
    page_unsupported: [UNSUPPORTED_MESSAGE, false, false],
    settings_unavailable: [INVALID_CONFIG_MESSAGE, true, true],
    injection_failed: [PREPARE_FAILED_MESSAGE, true, false],
    invalid_request: [PREPARE_FAILED_MESSAGE, true, false],
  };

  it.each(INJECT_ERRORS)('"%s"', (error) => {
    const [message, translate, highlightOptions] = expected[error];
    const view = describePage({ kind: 'inject_error', error });
    expect(view).toEqual({
      message,
      tone: error === 'page_unsupported' ? 'warning' : 'error',
      buttons: buttons({ translate }),
      highlightOptions,
      announce: message,
    });
  });
});

describe('describePage: idle', () => {
  it.each(VIEWS)('view "%s": pronto para traduzir', (pageView) => {
    expect(describePage(state({ status: 'idle', view: pageView }))).toEqual({
      message: READY_MESSAGE,
      tone: 'info',
      buttons: buttons({ translate: true }),
      highlightOptions: false,
      announce: READY_MESSAGE,
    });
  });
});

describe('describePage: translating', () => {
  it('conta feitos, falhos e pulados sobre o total, com progresso', () => {
    const view = describePage(
      state({ status: 'translating', total: 12, done: 1, failed: 1, skipped: 1 }),
    );
    expect(view).toEqual({
      message: 'Traduzindo… 3 de 12 trechos.',
      tone: 'info',
      progress: { value: 3, max: 12 },
      buttons: buttons({ cancel: true }),
      highlightOptions: false,
      announce: TRANSLATING_ANNOUNCE,
    });
  });

  it.each(VIEWS)('view "%s": só Cancelar, sem alternância', (pageView) => {
    const view = describePage(state({ status: 'translating', view: pageView, total: 4, done: 2 }));
    expect(view.buttons).toEqual(buttons({ cancel: true }));
  });

  it('o anúncio não muda com o progresso', () => {
    const first = describePage(state({ status: 'translating', total: 5, done: 1 }));
    const later = describePage(state({ status: 'translating', total: 5, done: 4 }));
    expect(first.message).not.toBe(later.message);
    expect(first.announce).toBe(later.announce);
  });

  it('singular quando o total é 1', () => {
    expect(describePage(state({ status: 'translating', total: 1 })).message).toBe(
      'Traduzindo… 0 de 1 trecho.',
    );
  });

  it('total 0: sem contagem nem barra', () => {
    const view = describePage(state({ status: 'translating' }));
    expect(view.message).toBe('Traduzindo…');
    expect(view.progress).toBeUndefined();
  });

  it('contagens incoerentes não passam do total', () => {
    const view = describePage(state({ status: 'translating', total: 2, done: 2, failed: 3 }));
    expect(view.progress).toEqual({ value: 2, max: 2 });
    expect(view.message).toBe('Traduzindo… 2 de 2 trechos.');
  });
});

describe('describePage: translated', () => {
  it('tudo traduzido: sucesso, Traduzir e Mostrar original', () => {
    expect(describePage(state({ status: 'translated', total: 3, done: 3 }))).toEqual({
      message: TRANSLATED_MESSAGE,
      tone: 'success',
      buttons: buttons({ translate: true, showOriginal: true }),
      highlightOptions: false,
      announce: TRANSLATED_MESSAGE,
    });
  });

  it('com falhas e pulados: aviso com a contagem no original', () => {
    const view = describePage(
      state({ status: 'translated', total: 5, done: 3, failed: 1, skipped: 1 }),
    );
    expect(view).toMatchObject({
      message: 'Página traduzida. 2 trechos continuam no original.',
      tone: 'warning',
      buttons: buttons({ translate: true, showOriginal: true }),
    });
  });

  it('uma falha: singular', () => {
    const view = describePage(state({ status: 'translated', total: 2, done: 1, failed: 1 }));
    expect(view.message).toBe('Página traduzida. 1 trecho continua no original.');
  });

  it('nada traduzido: aviso, sem alternância', () => {
    const view = describePage(state({ status: 'translated', total: 2, failed: 2 }));
    expect(view).toMatchObject({
      message: NOTHING_TRANSLATED_MESSAGE,
      tone: 'warning',
      buttons: buttons({ translate: true }),
    });
  });

  it('página sem texto: aviso próprio', () => {
    const view = describePage(state({ status: 'translated' }));
    expect(view).toMatchObject({ message: NO_TEXT_MESSAGE, tone: 'warning' });
  });

  it('view original: mostra o original e oferece Mostrar tradução', () => {
    const view = describePage(state({ status: 'translated', view: 'original', total: 3, done: 3 }));
    expect(view).toEqual({
      message: SHOWING_ORIGINAL_MESSAGE,
      tone: 'info',
      buttons: buttons({ translate: true, showTranslation: true }),
      highlightOptions: false,
      announce: SHOWING_ORIGINAL_MESSAGE,
    });
  });
});

describe('describePage: cancelled', () => {
  it('sem tradução aplicada: só Traduzir', () => {
    expect(describePage(state({ status: 'cancelled', total: 4 }))).toMatchObject({
      message: CANCELLED_MESSAGE,
      tone: 'info',
      buttons: buttons({ translate: true }),
    });
  });

  it('com tradução parcial: Mostrar original', () => {
    expect(describePage(state({ status: 'cancelled', total: 4, done: 2 }))).toMatchObject({
      message: CANCELLED_MESSAGE,
      buttons: buttons({ translate: true, showOriginal: true }),
    });
  });

  it('com tradução parcial e view original: Mostrar tradução', () => {
    const view = describePage(state({ status: 'cancelled', view: 'original', total: 4, done: 2 }));
    expect(view).toMatchObject({
      message: SHOWING_ORIGINAL_MESSAGE,
      buttons: buttons({ translate: true, showTranslation: true }),
    });
  });
});

describe('describePage: error', () => {
  const expected: Record<PageStateError, [string, boolean]> = {
    network: ['O Ollama não respondeu. Verifique se ele está aberto e tente de novo.', false],
    forbidden: [
      'O Ollama recusou o Lerium. Libere a origem do Lerium em OLLAMA_ORIGINS (veja as configurações).',
      true,
    ],
    model_missing: ['O modelo configurado não está instalado no Ollama.', true],
    invalid_config: [INVALID_CONFIG_MESSAGE, true],
    settings_unavailable: [INVALID_CONFIG_MESSAGE, true],
    interrupted: ['A tradução foi interrompida. Tente de novo.', false],
  };

  const cases = STATE_ERRORS.flatMap((error) =>
    VIEWS.flatMap((pageView) => [[error, pageView, 0] as const, [error, pageView, 2] as const]),
  );

  it.each(cases)('"%s", view "%s", done %d', (error, pageView, done) => {
    const [message, highlightOptions] = expected[error];
    const view = describePage(state({ status: 'error', view: pageView, error, total: 4, done }));
    expect(view).toEqual({
      message,
      tone: 'error',
      buttons: buttons({
        translate: true,
        showOriginal: done > 0 && pageView === 'translation',
        showTranslation: done > 0 && pageView === 'original',
      }),
      highlightOptions,
      announce: message,
    });
  });

  it('erro sem código: tratado como interrompido', () => {
    expect(describePage(state({ status: 'error' })).message).toBe(expected.interrupted[0]);
  });
});

describe('describePage: matriz completa', () => {
  const counts = [
    { total: 0, done: 0, failed: 0, skipped: 0 },
    { total: 5, done: 0, failed: 1, skipped: 0 },
    { total: 5, done: 3, failed: 1, skipped: 1 },
  ];
  const errors: Array<PageStateError | undefined> = [undefined, ...STATE_ERRORS];
  const all = STATUSES.flatMap((status) =>
    VIEWS.flatMap((pageView) =>
      counts.flatMap((count) =>
        errors.map((error) => ({
          status,
          view: pageView,
          ...count,
          ...(error === undefined ? {} : { error }),
        })),
      ),
    ),
  );

  it.each(all)('%o: regras gerais dos botões', (pageState) => {
    const view = describePage({ kind: 'state', state: pageState });
    const translating = pageState.status === 'translating';
    expect(view.buttons.openOptions).toBe(true);
    expect(view.buttons.translate).toBe(!translating);
    expect(view.buttons.cancel).toBe(translating);
    expect(view.buttons.showOriginal).toBe(
      !translating && pageState.done > 0 && pageState.view === 'translation',
    );
    expect(view.buttons.showTranslation).toBe(
      !translating && pageState.done > 0 && pageState.view === 'original',
    );
    expect(view.buttons.showOriginal && view.buttons.showTranslation).toBe(false);
    expect(view.message.length).toBeGreaterThan(0);
    expect(view.announce.length).toBeGreaterThan(0);
  });

  it.each(all)('%o: mensagem só com texto fixo e números', (pageState) => {
    const view = describePage({ kind: 'state', state: pageState });
    // Remove os números: o que sobra tem de ser texto fixo do módulo,
    // igual para qualquer contagem.
    const strip = (text: string) => text.replace(/\d+/g, '#');
    const other = describePage({
      kind: 'state',
      state: {
        ...pageState,
        total: pageState.total * 7,
        done: pageState.done * 7,
        failed: pageState.failed * 7,
        skipped: pageState.skipped * 7,
      },
    });
    expect(strip(view.message)).toBe(strip(other.message));
    expect(view.message).not.toMatch(/translat|original'|undefined|null|NaN|\[object/);
  });
});

describe('describePage: nunca reflete texto do estado', () => {
  it('campos extras com texto da página não aparecem', () => {
    const secret = 'SEGREDO da página <b>x</b>';
    const input = {
      kind: 'state',
      state: {
        status: 'translated',
        view: 'translation',
        total: 1,
        done: 1,
        failed: 0,
        skipped: 0,
        text: secret,
        title: secret,
      },
    } as unknown as PageViewInput;
    const view = describePage(input);
    expect(JSON.stringify(view)).not.toContain('SEGREDO');
  });

  it('nenhuma mensagem contém códigos internos', () => {
    const inputs: PageViewInput[] = [
      { kind: 'unsupported' },
      { kind: 'not_injected' },
      { kind: 'busy' },
      ...INJECT_ERRORS.map((error) => ({ kind: 'inject_error', error }) as const),
      ...STATE_ERRORS.map((error) => state({ status: 'error', error })),
    ];
    for (const input of inputs) {
      const { message } = describePage(input);
      // Códigos são snake_case minúsculo; OLLAMA_ORIGINS é nome de variável, permitido.
      expect(message).not.toMatch(/\b[a-z]+_[a-z_]+\b|interrupted|forbidden|network/);
    }
  });
});

describe('focusFallback', () => {
  it('Traduzir some: vai para Cancelar', () => {
    expect(focusFallback('translate', buttons({ cancel: true }))).toBe('cancel');
  });

  it('Cancelar some: Mostrar original, senão Traduzir', () => {
    expect(focusFallback('cancel', buttons({ translate: true, showOriginal: true }))).toBe(
      'showOriginal',
    );
    expect(focusFallback('cancel', buttons({ translate: true }))).toBe('translate');
  });

  it('alternância: vai para o botão oposto', () => {
    expect(focusFallback('showOriginal', buttons({ translate: true, showTranslation: true }))).toBe(
      'showTranslation',
    );
    expect(focusFallback('showTranslation', buttons({ translate: true, showOriginal: true }))).toBe(
      'showOriginal',
    );
  });

  it('sem equivalente visível: null', () => {
    expect(focusFallback('translate', buttons({}))).toBeNull();
    expect(focusFallback('openOptions', buttons({ translate: true }))).toBeNull();
  });
});

describe('firstActionButton', () => {
  it('segue a ordem da tela e ignora configurações', () => {
    expect(firstActionButton(buttons({ translate: true, showOriginal: true }))).toBe('translate');
    expect(firstActionButton(buttons({ cancel: true }))).toBe('cancel');
    expect(firstActionButton(buttons({}))).toBeNull();
  });
});
