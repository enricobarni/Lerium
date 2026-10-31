import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POLL_INTERVAL_MS,
  RESPONSE_TIMEOUT_MS,
  createPopupController,
  type ActiveTab,
  type PopupController,
} from '../../src/popup/page-actions';
import {
  createPopupRenderer,
  getPopupElements,
  type PopupElements,
} from '../../src/popup/page-render';
import {
  BUSY_MESSAGE,
  CANCELLED_MESSAGE,
  COMMAND_FAILED_MESSAGE,
  INVALID_CONFIG_MESSAGE,
  PREPARE_FAILED_MESSAGE,
  READY_MESSAGE,
  SHOWING_ORIGINAL_MESSAGE,
  TRANSLATED_MESSAGE,
  TRANSLATING_ANNOUNCE,
  UNSUPPORTED_MESSAGE,
  type PageButton,
} from '../../src/popup/page-view';
import type {
  PageCommandName,
  PageInjectErrorKind,
  PageStateView,
} from '../../src/shared/page-control';

// No jsdom o `URL` global é o do jsdom, que `fileURLToPath` recusa (ver dom-collector.test.ts).
const POPUP_HTML = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/popup/index.html'),
  'utf8',
);

const TAB: ActiveTab = { id: 7, url: 'https://example.com/capitulo-1' };

/** Monta o `<body>` real do popup, sem o script de entrada. */
function loadPopup(): PopupElements {
  const parsed = new DOMParser().parseFromString(POPUP_HTML, 'text/html');
  parsed.querySelectorAll('script').forEach((script) => script.remove());
  document.body.replaceChildren(...document.adoptNode(parsed.body).childNodes);
  const elements = getPopupElements(document);
  if (elements === null) throw new Error('HTML do popup sem os elementos esperados.');
  return elements;
}

const pageState = (overrides: Partial<PageStateView> = {}): PageStateView => ({
  status: 'idle',
  view: 'translation',
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  ...overrides,
});

const ok = (state: PageStateView) => ({ ok: true, state });

/** Fila de callbacks do `requestAnimationFrame` falso. */
class FrameQueue {
  private callbacks: Array<() => void> = [];
  readonly schedule = (callback: () => void): void => {
    this.callbacks.push(callback);
  };
  get size(): number {
    return this.callbacks.length;
  }
  flush(options: { reversed?: boolean } = {}): void {
    const pending = options.reversed ? this.callbacks.reverse() : this.callbacks;
    this.callbacks = [];
    for (const callback of pending) callback();
  }
}

/** Intervalos falsos: só rodam em `tick()`. */
class FakeIntervals {
  private next = 1;
  readonly active = new Map<number, () => void>();
  readonly delays: number[] = [];
  readonly setInterval = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.active.set(id, fn);
    this.delays.push(ms);
    return id;
  };
  readonly clearInterval = (id: unknown): void => {
    this.active.delete(id as number);
  };
  tick(): void {
    for (const fn of [...this.active.values()]) fn();
  }
}

type Responder = (command: PageCommandName) => unknown;

interface Harness {
  elements: PopupElements;
  controller: PopupController;
  calls: string[];
  frames: FrameQueue;
  intervals: FakeIntervals;
  render: ReturnType<typeof vi.fn>;
  /** Troca a resposta dos comandos (o "content script"). */
  respond(responder: Responder): void;
  injectWith(response: () => Promise<unknown>): void;
}

function setUp(
  options: { tab?: ActiveTab | null | (() => Promise<ActiveTab | null>) } = {},
): Harness {
  const elements = loadPopup();
  const calls: string[] = [];
  const frames = new FrameQueue();
  const intervals = new FakeIntervals();
  let responder: Responder = () => ok(pageState());
  let injectResponse: () => Promise<unknown> = async () => ({ ok: true, documentId: 'DOC-1' });
  const renderer = createPopupRenderer(elements, frames.schedule);
  const render = vi.fn(renderer);
  const tab = options.tab === undefined ? TAB : options.tab;

  const controller = createPopupController({
    getActiveTab: typeof tab === 'function' ? tab : async () => tab,
    // Sem `async`: um `injectWith` que lança simula a exceção síncrona do `chrome`.
    sendInject: (tabId) => {
      calls.push(`inject:${tabId}`);
      return injectResponse();
    },
    sendCommand: async (tabId, command) => {
      calls.push(`${command}:${tabId}`);
      const response = responder(command);
      if (response instanceof Error) throw response;
      return response;
    },
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
    // Resolvidos na hora da chamada, para valerem os fake timers do teste.
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
    render,
  });

  return {
    elements,
    controller,
    calls,
    frames,
    intervals,
    render,
    respond: (next) => {
      responder = next;
    },
    injectWith: (next) => {
      injectResponse = next;
    },
  };
}

/** Deixa as promessas pendentes do controlador assentarem. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const NO_RECEIVER = () =>
  new Error('Could not establish connection. Receiving end does not exist.');

function visibleButtons(elements: PopupElements): PageButton[] {
  return (Object.keys(elements.buttons) as PageButton[]).filter(
    (name) => !elements.buttons[name].hidden,
  );
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('popup: HTML', () => {
  it('não tem mais o aviso de indisponível e tem os controles esperados', () => {
    const elements = loadPopup();
    expect(document.body.textContent).not.toContain('ainda não está disponível');
    expect(elements.status.getAttribute('role')).toBe('status');
    expect(elements.progress.getAttribute('aria-label')).toBe('Progresso da tradução');
    expect(elements.progress.hidden).toBe(true);
    expect(elements.focusHolder.getAttribute('tabindex')).toBe('-1');
    for (const button of Object.values(elements.buttons)) {
      expect(button.type).toBe('button');
      expect(button.disabled).toBe(false);
    }
  });
});

describe('popup: abrir', () => {
  it('página suportada: consulta o estado e oferece Traduzir', async () => {
    const h = setUp();
    await h.controller.open();
    expect(h.calls).toEqual(['get-state:7']);
    expect(h.elements.message.textContent).toBe(READY_MESSAGE);
    expect(visibleButtons(h.elements)).toEqual(['translate', 'openOptions']);
    h.frames.flush();
    expect(h.elements.status.textContent).toBe(READY_MESSAGE);
  });

  it.each([
    'chrome://extensions/',
    'chrome-extension://abc/popup/index.html',
    'file:///c:/a.pdf',
    'nada',
  ])('url "%s": não suportada, sem chamar nada', async (url) => {
    const h = setUp({ tab: { id: 3, url } });
    await h.controller.open();
    expect(h.calls).toEqual([]);
    expect(h.elements.message.textContent).toBe(UNSUPPORTED_MESSAGE);
    expect(h.elements.message.dataset.tone).toBe('warning');
    expect(visibleButtons(h.elements)).toEqual(['openOptions']);
  });

  it('sem aba ativa, ou falha ao consultá-la: não suportada', async () => {
    for (const tab of [null, () => Promise.reject(new Error('x'))]) {
      const h = setUp({ tab });
      await h.controller.open();
      expect(h.calls).toEqual([]);
      expect(h.elements.message.textContent).toBe(UNSUPPORTED_MESSAGE);
    }
  });

  it('url ausente: consulta e deixa a injeção decidir', async () => {
    const h = setUp({ tab: { id: 9 } });
    await h.controller.open();
    expect(h.calls).toEqual(['get-state:9']);
  });

  it('sem content script (rejeição): pronto para traduzir', async () => {
    const h = setUp();
    h.respond(() => NO_RECEIVER());
    await h.controller.open();
    expect(h.elements.message.textContent).toBe(READY_MESSAGE);
    expect(visibleButtons(h.elements)).toEqual(['translate', 'openOptions']);
  });

  it('estado já traduzido: mostra a tradução e Mostrar original', async () => {
    const h = setUp();
    h.respond(() => ok(pageState({ status: 'translated', total: 3, done: 3 })));
    await h.controller.open();
    expect(h.elements.message.textContent).toBe(TRANSLATED_MESSAGE);
    expect(visibleButtons(h.elements)).toEqual(['translate', 'showOriginal', 'openOptions']);
  });

  it.each([
    ['undefined', undefined],
    ['forma estranha', { ok: true, state: { status: 'feito' } }],
    ['recusa', { ok: false, error: 'invalid_request' }],
    ['texto', 'página'],
  ])('resposta inválida (%s): falha de comando', async (_name, response) => {
    const h = setUp();
    h.respond(() => response);
    await h.controller.open();
    expect(h.elements.message.textContent).toBe(COMMAND_FAILED_MESSAGE);
    expect(h.elements.message.dataset.tone).toBe('error');
    expect(visibleButtons(h.elements)).toEqual(['translate', 'openOptions']);
  });

  it('campos extras com texto da página não chegam ao DOM', async () => {
    const h = setUp();
    h.respond(() => ({
      ok: true,
      state: { ...pageState({ status: 'translated', total: 1, done: 1 }), text: 'SEGREDO' },
      title: 'SEGREDO',
    }));
    await h.controller.open();
    h.frames.flush();
    expect(document.body.textContent).not.toContain('SEGREDO');
  });
});

describe('popup: traduzir', () => {
  it('inject antes de start, sempre, inclusive na segunda vez', async () => {
    const h = setUp();
    await h.controller.open();
    h.respond((command) =>
      command === 'start'
        ? ok(pageState({ status: 'translating', total: 4 }))
        : ok(pageState({ status: 'translated', total: 4, done: 4 })),
    );
    await h.controller.translate();
    h.intervals.tick();
    await settle();
    await h.controller.translate();
    expect(h.calls).toEqual([
      'get-state:7',
      'inject:7',
      'start:7',
      'get-state:7',
      'inject:7',
      'start:7',
    ]);
  });

  it('mostra "preparando" durante a injeção, sem botões de ação', async () => {
    const h = setUp();
    await h.controller.open();
    let release: (value: unknown) => void = () => undefined;
    h.injectWith(() => new Promise((resolve) => (release = resolve)));
    const pending = h.controller.translate();
    await settle();
    expect(h.elements.message.textContent).toBe(BUSY_MESSAGE);
    expect(visibleButtons(h.elements)).toEqual(['openOptions']);
    // Cliques repetidos durante a ação são ignorados.
    await h.controller.translate();
    release({ ok: true, documentId: 'DOC-1' });
    await pending;
    expect(h.calls.filter((call) => call.startsWith('inject'))).toHaveLength(1);
  });

  const injectErrors: Array<[PageInjectErrorKind, string, boolean]> = [
    [
      'permission_required',
      'Falta permissão para a porta configurada do Ollama. Abra as configurações e salve o endereço.',
      true,
    ],
    ['page_unsupported', UNSUPPORTED_MESSAGE, false],
    ['settings_unavailable', INVALID_CONFIG_MESSAGE, true],
    ['injection_failed', PREPARE_FAILED_MESSAGE, true],
    ['invalid_request', PREPARE_FAILED_MESSAGE, true],
  ];

  it.each(injectErrors)('inject "%s": mensagem, sem start', async (error, message, translate) => {
    const h = setUp();
    await h.controller.open();
    h.injectWith(async () => ({ ok: false, error }));
    await h.controller.translate();
    expect(h.calls).toEqual(['get-state:7', 'inject:7']);
    expect(h.elements.message.textContent).toBe(message);
    expect(h.elements.buttons.translate.hidden).toBe(!translate);
    expect(h.elements.buttons.openOptions.hidden).toBe(false);
  });

  it('inject rejeitado ou com resposta inválida: mensagem de preparo', async () => {
    for (const response of [
      () => Promise.reject(new Error('worker')),
      async () => ({ ok: true, documentId: 'com espaço' }),
      async () => ({ ok: false, error: 'outro' }),
      async () => undefined,
    ]) {
      const h = setUp();
      await h.controller.open();
      h.injectWith(response);
      await h.controller.translate();
      expect(h.calls).toEqual(['get-state:7', 'inject:7']);
      expect(h.elements.message.textContent).toBe(PREPARE_FAILED_MESSAGE);
    }
  });

  it('start sem resposta logo após injetar: falha de preparo', async () => {
    const h = setUp();
    await h.controller.open();
    h.respond(() => NO_RECEIVER());
    await h.controller.translate();
    expect(h.elements.message.textContent).toBe(PREPARE_FAILED_MESSAGE);
  });

  it('start com resposta inválida: falha de comando, não de preparo', async () => {
    const h = setUp();
    await h.controller.open();
    h.respond((command) =>
      command === 'start' ? { ok: false, error: 'invalid_request' } : ok(pageState()),
    );
    await h.controller.translate();
    expect(h.calls).toEqual(['get-state:7', 'inject:7', 'start:7']);
    expect(h.elements.message.textContent).toBe(COMMAND_FAILED_MESSAGE);
  });

  it('erros de configuração do job destacam "Abrir configurações"', async () => {
    const h = setUp();
    await h.controller.open();
    expect(h.elements.buttons.translate.classList.contains('primary')).toBe(true);
    expect(h.elements.buttons.openOptions.classList.contains('secondary')).toBe(true);

    h.respond(() => ok(pageState({ status: 'error', error: 'forbidden' })));
    await h.controller.translate();
    expect(h.elements.message.textContent).toMatch(/OLLAMA_ORIGINS/);
    expect(h.elements.message.dataset.tone).toBe('error');
    expect(h.elements.buttons.openOptions.classList.contains('primary')).toBe(true);
    expect(h.elements.buttons.openOptions.classList.contains('secondary')).toBe(false);
    expect(h.elements.buttons.translate.classList.contains('secondary')).toBe(true);

    h.respond(() => ok(pageState({ status: 'error', error: 'network' })));
    await h.controller.translate();
    expect(h.elements.buttons.openOptions.classList.contains('secondary')).toBe(true);
    expect(h.elements.buttons.translate.classList.contains('primary')).toBe(true);
  });
});

describe('popup: polling', () => {
  it('consulta a cada 1 s só enquanto traduz e para ao terminar', async () => {
    const h = setUp();
    await h.controller.open();
    expect(h.intervals.active.size).toBe(0);

    h.respond(() => ok(pageState({ status: 'translating', total: 4, done: 1 })));
    await h.controller.translate();
    expect(h.intervals.active.size).toBe(1);
    expect(h.intervals.delays).toEqual([POLL_INTERVAL_MS]);
    expect(POLL_INTERVAL_MS).toBe(1000);
    expect(h.elements.progress.hidden).toBe(false);
    expect(h.elements.progress.value).toBe(1);
    expect(h.elements.progress.max).toBe(4);

    h.respond(() => ok(pageState({ status: 'translating', total: 4, done: 3 })));
    h.intervals.tick();
    await settle();
    expect(h.elements.message.textContent).toBe('Traduzindo… 3 de 4 trechos.');
    expect(h.elements.progress.value).toBe(3);
    // Continua sendo um só intervalo.
    expect(h.intervals.delays).toHaveLength(1);

    h.respond(() => ok(pageState({ status: 'translated', total: 4, done: 4 })));
    h.intervals.tick();
    await settle();
    expect(h.intervals.active.size).toBe(0);
    expect(h.elements.progress.hidden).toBe(true);
    expect(h.elements.message.textContent).toBe(TRANSLATED_MESSAGE);
  });

  it('não sobrepõe consultas pendentes', async () => {
    const h = setUp();
    await h.controller.open();
    h.respond(() => ok(pageState({ status: 'translating', total: 4 })));
    await h.controller.translate();
    let release: () => void = () => undefined;
    h.respond(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok(pageState({ status: 'translating', total: 4, done: 2 })));
        }),
    );
    h.intervals.tick();
    h.intervals.tick();
    h.intervals.tick();
    expect(h.calls.filter((call) => call === 'get-state:7')).toHaveLength(2);
    release();
    await settle();
  });

  it('cancelar para o polling', async () => {
    const h = setUp();
    await h.controller.open();
    h.respond((command) =>
      command === 'cancel'
        ? ok(pageState({ status: 'cancelled', total: 4 }))
        : ok(pageState({ status: 'translating', total: 4 })),
    );
    await h.controller.translate();
    await h.controller.cancel();
    expect(h.calls.at(-1)).toBe('cancel:7');
    expect(h.elements.message.textContent).toBe(CANCELLED_MESSAGE);
    expect(h.intervals.active.size).toBe(0);
  });

  it('content script some durante a tradução: para e volta a "pronto"', async () => {
    const h = setUp();
    await h.controller.open();
    h.respond(() => ok(pageState({ status: 'translating', total: 4 })));
    await h.controller.translate();
    h.respond(() => NO_RECEIVER());
    h.intervals.tick();
    await settle();
    expect(h.intervals.active.size).toBe(0);
    expect(h.elements.message.textContent).toBe(READY_MESSAGE);
  });

  it('consulta antiga não sobrescreve o resultado de uma ação', async () => {
    const h = setUp();
    await h.controller.open();
    h.respond(() => ok(pageState({ status: 'translating', total: 4 })));
    await h.controller.translate();

    let releasePoll: () => void = () => undefined;
    h.respond(
      () =>
        new Promise((resolve) => {
          releasePoll = () => resolve(ok(pageState({ status: 'translating', total: 4, done: 1 })));
        }),
    );
    h.intervals.tick();
    h.respond(() => ok(pageState({ status: 'cancelled', total: 4 })));
    await h.controller.cancel();
    releasePoll();
    await settle();
    expect(h.elements.message.textContent).toBe(CANCELLED_MESSAGE);
    expect(h.intervals.active.size).toBe(0);
  });

  it('dispose (pagehide) para o polling e ignora respostas pendentes', async () => {
    const h = setUp();
    await h.controller.open();
    h.respond(() => ok(pageState({ status: 'translating', total: 4 })));
    await h.controller.translate();
    let releasePoll: () => void = () => undefined;
    h.respond(
      () =>
        new Promise((resolve) => {
          releasePoll = () => resolve(ok(pageState({ status: 'translated', total: 4, done: 4 })));
        }),
    );
    h.intervals.tick();
    const renders = h.render.mock.calls.length;
    h.controller.dispose();
    expect(h.intervals.active.size).toBe(0);
    releasePoll();
    await settle();
    expect(h.render.mock.calls.length).toBe(renders);
    await h.controller.translate();
    expect(h.render.mock.calls.length).toBe(renders);
  });
});

describe('popup: prazo de resposta', () => {
  const never = () => new Promise<never>(() => undefined);

  it('prazo de 10 s', () => {
    expect(RESPONSE_TIMEOUT_MS).toBe(10_000);
  });

  it('inject sem resposta: falha de preparo no prazo, sem start, timer limpo', async () => {
    vi.useFakeTimers();
    const h = setUp();
    await h.controller.open();
    h.injectWith(never);
    const pending = h.controller.translate();
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS - 1);
    expect(h.elements.message.textContent).toBe(BUSY_MESSAGE);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(h.calls).toEqual(['get-state:7', 'inject:7']);
    expect(h.elements.message.textContent).toBe(PREPARE_FAILED_MESSAGE);
    expect(visibleButtons(h.elements)).toEqual(['translate', 'openOptions']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('comando sem resposta: sai do estado de espera no prazo e ignora a resposta tardia', async () => {
    vi.useFakeTimers();
    const h = setUp();
    let release: (value: unknown) => void = () => undefined;
    h.respond(() => new Promise((resolve) => (release = resolve)));
    const pending = h.controller.open();
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS);
    await pending;
    expect(h.elements.message.textContent).toBe(COMMAND_FAILED_MESSAGE);
    expect(vi.getTimerCount()).toBe(0);
    const renders = h.render.mock.calls.length;
    release(ok(pageState({ status: 'translated', total: 1, done: 1 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.render.mock.calls.length).toBe(renders);
  });

  it('consulta do polling sem resposta: mostra a falha e para o polling', async () => {
    vi.useFakeTimers();
    const h = setUp();
    await h.controller.open();
    h.respond(() => ok(pageState({ status: 'translating', total: 4 })));
    await h.controller.translate();
    h.respond(never);
    h.intervals.tick();
    h.intervals.tick();
    // A consulta pendente não é duplicada enquanto espera o prazo.
    expect(h.calls.filter((call) => call === 'get-state:7')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS);
    expect(h.elements.message.textContent).toBe(COMMAND_FAILED_MESSAGE);
    expect(h.intervals.active.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('respostas, rejeições e exceções síncronas limpam o timer', async () => {
    vi.useFakeTimers();
    for (const response of [
      async () => ({ ok: true, documentId: 'DOC-1' }),
      () => Promise.reject(new Error('worker')),
      () => {
        throw new Error('síncrono');
      },
    ]) {
      const h = setUp();
      await h.controller.open();
      h.injectWith(response);
      await h.controller.translate();
      expect(vi.getTimerCount()).toBe(0);
    }
    const h = setUp();
    h.respond(() => NO_RECEIVER());
    await h.controller.open();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose limpa o prazo de uma consulta pendente', async () => {
    vi.useFakeTimers();
    const h = setUp();
    await h.controller.open();
    h.respond(() => ok(pageState({ status: 'translating', total: 4 })));
    await h.controller.translate();
    h.respond(never);
    h.intervals.tick();
    expect(vi.getTimerCount()).toBe(1);
    h.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('popup: falha de comando', () => {
  const failures: Array<[string, unknown]> = [
    ['recusa', { ok: false, error: 'invalid_request' }],
    ['forma estranha', { ok: true, state: { status: 'feito' } }],
    ['undefined', undefined],
  ];
  const translated = ok(pageState({ status: 'translated', total: 2, done: 2 }));
  const translating = ok(pageState({ status: 'translating', total: 2 }));

  const actions: Array<[PageCommandName, (c: PopupController) => Promise<void>, unknown]> = [
    ['cancel', (c) => c.cancel(), translating],
    ['show-original', (c) => c.showOriginal(), translated],
    ['show-translation', (c) => c.showTranslation(), translated],
  ];

  for (const [command, run, before] of actions) {
    it.each(failures)(`"${command}" com resposta %s: falha de comando`, async (_name, failure) => {
      const h = setUp();
      h.respond(() => before);
      await h.controller.open();
      h.respond((sent) => (sent === command ? failure : before));
      await run(h.controller);
      expect(h.calls.at(-1)).toBe(`${command}:7`);
      expect(h.elements.message.textContent).toBe(COMMAND_FAILED_MESSAGE);
      expect(h.elements.message.dataset.tone).toBe('error');
      expect(visibleButtons(h.elements)).toEqual(['translate', 'openOptions']);
      expect(h.intervals.active.size).toBe(0);
    });
  }

  it.each(failures)(
    'get-state do polling com resposta %s: falha de comando',
    async (_n, failure) => {
      const h = setUp();
      await h.controller.open();
      h.respond(() => translating);
      await h.controller.translate();
      h.respond(() => failure);
      h.intervals.tick();
      await settle();
      expect(h.elements.message.textContent).toBe(COMMAND_FAILED_MESSAGE);
      expect(h.intervals.active.size).toBe(0);
    },
  );

  it('Traduzir depois da falha injeta de novo e recupera', async () => {
    const h = setUp();
    h.respond(() => ({ ok: false, error: 'invalid_request' }));
    await h.controller.open();
    h.respond(() => translating);
    await h.controller.translate();
    expect(h.calls).toEqual(['get-state:7', 'inject:7', 'start:7']);
    expect(h.elements.message.textContent).toBe('Traduzindo… 0 de 2 trechos.');
  });
});

describe('popup: alternar original', () => {
  it('Mostrar original e Mostrar tradução enviam os comandos', async () => {
    const h = setUp();
    h.respond((command) =>
      ok(
        pageState({
          status: 'translated',
          view: command === 'show-original' ? 'original' : 'translation',
          total: 2,
          done: 2,
        }),
      ),
    );
    await h.controller.open();
    await h.controller.showOriginal();
    expect(h.elements.message.textContent).toBe(SHOWING_ORIGINAL_MESSAGE);
    expect(visibleButtons(h.elements)).toEqual(['translate', 'showTranslation', 'openOptions']);
    await h.controller.showTranslation();
    expect(h.elements.message.textContent).toBe(TRANSLATED_MESSAGE);
    expect(h.calls).toEqual(['get-state:7', 'show-original:7', 'show-translation:7']);
  });
});

describe('popup: anúncios', () => {
  it('a região de status só muda quando o status muda', async () => {
    const h = setUp();
    await h.controller.open();
    h.frames.flush();
    h.respond(() => ok(pageState({ status: 'translating', total: 4, done: 1 })));
    await h.controller.translate();
    h.frames.flush();
    expect(h.elements.status.textContent).toBe(TRANSLATING_ANNOUNCE);

    h.respond(() => ok(pageState({ status: 'translating', total: 4, done: 2 })));
    h.intervals.tick();
    await settle();
    expect(h.frames.size).toBe(0);
    expect(h.elements.status.textContent).toBe(TRANSLATING_ANNOUNCE);
    expect(h.elements.message.textContent).toBe('Traduzindo… 2 de 4 trechos.');
  });

  it('limpa e reescreve: o texto entra no quadro seguinte', async () => {
    const h = setUp();
    await h.controller.open();
    h.frames.flush();
    h.respond(() => ok(pageState({ status: 'cancelled', total: 1 })));
    await h.controller.cancel();
    expect(h.elements.status.textContent).toBe('');
    h.frames.flush();
    expect(h.elements.status.textContent).toBe(CANCELLED_MESSAGE);
  });

  it('anúncio superado não é escrito, mesmo se o quadro dele rodar por último', async () => {
    const h = setUp();
    await h.controller.open();
    h.respond(() => ok(pageState({ status: 'cancelled', total: 1 })));
    await h.controller.cancel();
    expect(h.frames.size).toBe(2);
    h.frames.flush({ reversed: true });
    expect(h.elements.status.textContent).toBe(CANCELLED_MESSAGE);
  });
});

describe('popup: foco', () => {
  it('Traduzir → (título) → Cancelar → Mostrar original → Mostrar tradução', async () => {
    const h = setUp();
    await h.controller.open();
    const { buttons, focusHolder } = h.elements;
    buttons.translate.focus();

    let releaseInject: (value: unknown) => void = () => undefined;
    h.injectWith(() => new Promise((resolve) => (releaseInject = resolve)));
    h.respond(() => ok(pageState({ status: 'translating', total: 2 })));
    const pending = h.controller.translate();
    await settle();
    // Nenhum equivalente visível durante a preparação: o foco espera no título.
    expect(document.activeElement).toBe(focusHolder);
    releaseInject({ ok: true, documentId: 'DOC-1' });
    await pending;
    expect(document.activeElement).toBe(buttons.cancel);

    h.respond(() => ok(pageState({ status: 'translated', total: 2, done: 2 })));
    h.intervals.tick();
    await settle();
    expect(document.activeElement).toBe(buttons.showOriginal);

    h.respond(() => ok(pageState({ status: 'translated', view: 'original', total: 2, done: 2 })));
    await h.controller.showOriginal();
    expect(document.activeElement).toBe(buttons.showTranslation);
  });

  it('Cancelar sem tradução aplicada: foco volta a Traduzir', async () => {
    const h = setUp();
    h.respond(() => ok(pageState({ status: 'translating', total: 2 })));
    await h.controller.open();
    h.elements.buttons.cancel.focus();
    h.respond(() => ok(pageState({ status: 'cancelled', total: 2 })));
    await h.controller.cancel();
    expect(document.activeElement).toBe(h.elements.buttons.translate);
  });

  it('foco levado a outro botão pelo usuário não é puxado de volta', async () => {
    const h = setUp();
    await h.controller.open();
    h.elements.buttons.translate.focus();
    let releaseInject: (value: unknown) => void = () => undefined;
    h.injectWith(() => new Promise((resolve) => (releaseInject = resolve)));
    h.respond(() => ok(pageState({ status: 'translating', total: 2 })));
    const pending = h.controller.translate();
    await settle();
    h.elements.buttons.openOptions.focus();
    releaseInject({ ok: true, documentId: 'DOC-1' });
    await pending;
    expect(document.activeElement).toBe(h.elements.buttons.openOptions);
  });

  it.each([
    ['erro do job', () => ok(pageState({ status: 'error', error: 'forbidden' })), null],
    ['erro de injeção', () => ok(pageState()), 'permission_required' as const],
  ])('%s com correção nas configurações: foco em "Abrir configurações"', async (_n, r, error) => {
    const h = setUp();
    await h.controller.open();
    h.elements.buttons.translate.focus();
    let releaseInject: (value: unknown) => void = () => undefined;
    h.injectWith(() => new Promise((resolve) => (releaseInject = resolve)));
    h.respond(r);
    const pending = h.controller.translate();
    await settle();
    expect(document.activeElement).toBe(h.elements.focusHolder);
    releaseInject(error === null ? { ok: true, documentId: 'DOC-1' } : { ok: false, error });
    await pending;
    expect(h.elements.buttons.translate.hidden).toBe(false);
    expect(document.activeElement).toBe(h.elements.buttons.openOptions);
  });

  it('erro sem correção nas configurações: foco volta a Traduzir', async () => {
    const h = setUp();
    await h.controller.open();
    h.elements.buttons.translate.focus();
    let releaseInject: (value: unknown) => void = () => undefined;
    h.injectWith(() => new Promise((resolve) => (releaseInject = resolve)));
    h.respond(() => ok(pageState({ status: 'error', error: 'network' })));
    const pending = h.controller.translate();
    await settle();
    releaseInject({ ok: true, documentId: 'DOC-1' });
    await pending;
    expect(document.activeElement).toBe(h.elements.buttons.translate);
  });

  it('sem foco em botão, a renderização não move o foco', async () => {
    const h = setUp();
    h.respond(() => ok(pageState({ status: 'translated', total: 2, done: 2 })));
    await h.controller.open();
    expect(document.activeElement).toBe(document.body);
  });
});
