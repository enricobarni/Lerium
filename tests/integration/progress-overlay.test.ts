import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectTextNodes, LERIUM_UI_ATTRIBUTE } from '../../src/content/dom-collector';
import {
  AUTO_HIDE_MS,
  createProgressOverlay,
  OVERLAY_CSS,
  type ProgressOverlayDeps,
} from '../../src/content/progress-overlay';
import type { PageStateView } from '../../src/shared/page-control';
import {
  partialMessage,
  STATE_ERROR_MESSAGES,
  TRANSLATED_MESSAGE,
  TRANSLATING_ANNOUNCE,
  translatingMessage,
} from '../../src/shared/page-status-text';

const state = (overrides: Partial<PageStateView> = {}): PageStateView => ({
  status: 'idle',
  view: 'translation',
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  ...overrides,
});

const translating = (done: number, total = 4): PageStateView =>
  state({ status: 'translating', total, done });
const translated = (overrides: Partial<PageStateView> = {}): PageStateView =>
  state({ status: 'translated', total: 4, done: 4, ...overrides });

/** Shadow roots criados durante o teste (o modo fechado não os expõe em `host.shadowRoot`). */
let roots: ShadowRoot[];
let attachSpy: ReturnType<typeof vi.spyOn>;
let withAdoptedSheets: boolean;

beforeEach(() => {
  document.documentElement.replaceChildren(
    document.createElement('head'),
    document.createElement('body'),
  );
  document.body.append(Object.assign(document.createElement('p'), { textContent: 'Capítulo um.' }));
  roots = [];
  withAdoptedSheets = false;
  const original = HTMLElement.prototype.attachShadow;
  attachSpy = vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (
    this: HTMLElement,
    init: ShadowRootInit,
  ) {
    const root = original.call(this, init);
    // O jsdom não tem `adoptedStyleSheets`; alguns testes o simulam.
    if (withAdoptedSheets) {
      Object.defineProperty(root, 'adoptedStyleSheets', {
        value: [],
        writable: true,
        configurable: true,
      });
    }
    roots.push(root);
    return root;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(overrides: Partial<ProgressOverlayDeps> = {}) {
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const frames = new Map<number, () => void>();
  const trusted = new WeakSet<Event>();
  const deps: ProgressOverlayDeps = {
    doc: document,
    setTimeout: vi.fn((fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    }),
    clearTimeout: vi.fn((id: unknown) => {
      timers.delete(id as number);
    }),
    requestFrame: vi.fn((cb: () => void) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    }),
    cancelFrame: vi.fn((id: unknown) => {
      frames.delete(id as number);
    }),
    isTrusted: (event) => trusted.has(event),
    ...overrides,
  };
  const overlay = createProgressOverlay(deps);

  /** Roda os quadros pendentes até não sobrar nenhum. */
  const flush = (): void => {
    for (let guard = 0; frames.size > 0 && guard < 10; guard += 1) {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, cb] of pending) cb();
    }
  };
  const runTimers = (): void => {
    const pending = [...timers.entries()];
    timers.clear();
    for (const [, { fn }] of pending) fn();
  };
  const hosts = (): Element[] => [...document.querySelectorAll(`[${LERIUM_UI_ATTRIBUTE}]`)];
  const host = (): Element | undefined => hosts()[0];
  const root = (): ShadowRoot => {
    const last = roots.at(-1);
    if (last === undefined) throw new Error('sem shadow root');
    return last;
  };
  const q = <T extends Element>(selector: string): T => {
    const element = root().querySelector<T>(selector);
    if (element === null) throw new Error(`sem ${selector}`);
    return element;
  };
  const message = (): string => q('.message').textContent ?? '';
  const status = (): HTMLElement => q<HTMLElement>('[role="status"]');
  const progress = (): HTMLProgressElement => q<HTMLProgressElement>('progress');
  const closeButton = (): HTMLButtonElement => q<HTMLButtonElement>('button');
  const trustedClick = (target: Element): void => {
    const event = new MouseEvent('click', { bubbles: true, composed: true });
    trusted.add(event);
    target.dispatchEvent(event);
  };
  const show = (input: PageStateView): void => {
    overlay.update(input);
    flush();
  };

  return {
    overlay,
    deps,
    timers,
    frames,
    flush,
    runTimers,
    hosts,
    host,
    root,
    q,
    message,
    status,
    progress,
    closeButton,
    trustedClick,
    show,
  };
}

describe('progress overlay: quando aparece', () => {
  it('não aparece antes de um translating', () => {
    const t = setup();
    t.show(state());
    t.show(translated());
    t.show(state({ status: 'translated', total: 0 }));
    t.show(state({ status: 'error', error: 'network' }));
    expect(t.hosts()).toEqual([]);
    expect(attachSpy).not.toHaveBeenCalled();
  });

  it('aparece em translating: host anônimo, só com data-lerium-ui, no fim do documento', () => {
    const t = setup();
    t.show(translating(1));
    const host = t.host();
    expect(host).toBeDefined();
    expect(host?.parentNode).toBe(document.documentElement);
    expect(document.documentElement.lastElementChild).toBe(host);
    expect(host?.localName).toBe('div');
    expect(host?.getAttributeNames()).toEqual([LERIUM_UI_ATTRIBUTE]);
    expect(host?.id).toBe('');
    expect(host?.className).toBe('');
  });

  it('usa shadow root fechado', () => {
    const t = setup();
    t.show(translating(0));
    expect(attachSpy).toHaveBeenCalledWith({ mode: 'closed' });
    expect((t.host() as HTMLElement).shadowRoot).toBeNull();
  });

  it('não aparece nem pede quadro enquanto oculto', () => {
    const t = setup();
    t.overlay.update(state());
    expect(t.deps.requestFrame).not.toHaveBeenCalled();
  });
});

describe('progress overlay: conteúdo', () => {
  it('texto, barra e estrutura acessível', () => {
    const t = setup();
    t.show(translating(1, 4));
    expect(t.message()).toBe(translatingMessage(1, 4));
    const pill = t.q<HTMLElement>('.pill');
    expect(pill.lang).toBe('pt-BR');
    expect(pill.dataset.tone).toBe('info');
    expect(t.progress().hidden).toBe(false);
    expect(t.progress().value).toBe(1);
    expect(t.progress().max).toBe(4);
    expect(t.progress().getAttribute('aria-label')).toBe('Progresso da tradução');
    expect(t.status().getAttribute('aria-live')).toBe('polite');
    // O texto visível fica fora da região viva.
    expect(t.status().contains(t.q('.message'))).toBe(false);
    expect(t.closeButton().type).toBe('button');
    expect(t.closeButton().textContent).toBe('Fechar');
  });

  it('sem total: oculta a barra', () => {
    const t = setup();
    t.show(translating(0, 0));
    expect(t.message()).toBe('Traduzindo…');
    expect(t.progress().hidden).toBe(true);
  });

  it('anuncia limpando e reescrevendo, uma vez por mudança de anúncio', () => {
    const t = setup();
    t.overlay.update(translating(0));
    // Primeiro quadro: texto visível; a região viva começa vazia.
    const [first] = [...t.frames.values()];
    t.frames.clear();
    first?.();
    expect(t.status().textContent).toBe('');
    t.flush();
    expect(t.status().textContent).toBe(TRANSLATING_ANNOUNCE);

    const observer = new MutationObserver(() => undefined);
    observer.observe(t.status(), { childList: true, characterData: true, subtree: true });
    t.show(translating(1));
    t.show(translating(2));
    t.show(translating(3));
    expect(observer.takeRecords()).toEqual([]);
    expect(t.message()).toBe(translatingMessage(3, 4));

    t.show(translated({ failed: 1, done: 3 }));
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    expect(t.status().textContent).toBe(partialMessage(1));
    observer.disconnect();
  });

  it('agrupa atualizações em um render por quadro', () => {
    const t = setup();
    t.overlay.update(translating(0));
    t.overlay.update(translating(1));
    t.overlay.update(translating(2));
    expect(t.deps.requestFrame).toHaveBeenCalledTimes(1);
    t.flush();
    expect(t.message()).toBe(translatingMessage(2, 4));
    expect(t.hosts()).toHaveLength(1);
  });

  it('erro e parcial ficam até fechar', () => {
    const t = setup();
    t.show(translating(1));
    t.show(state({ status: 'error', error: 'network', total: 4, done: 1 }));
    expect(t.message()).toBe(STATE_ERROR_MESSAGES.network);
    expect(t.q<HTMLElement>('.pill').dataset.tone).toBe('error');
    expect(t.progress().hidden).toBe(true);
    expect(t.timers.size).toBe(0);

    t.show(translating(0));
    t.show(translated({ done: 2, skipped: 2 }));
    expect(t.message()).toBe(partialMessage(2));
    expect(t.q<HTMLElement>('.pill').dataset.tone).toBe('warning');
    expect(t.timers.size).toBe(0);
  });

  it('cancelado ou visão original: remove o host', () => {
    const t = setup();
    t.show(translating(1));
    t.show(state({ status: 'cancelled', total: 4, done: 1 }));
    expect(t.hosts()).toEqual([]);

    t.show(translating(1));
    expect(t.hosts()).toHaveLength(1);
    t.show(state({ status: 'cancelled', view: 'original', total: 4, done: 1 }));
    expect(t.hosts()).toEqual([]);
    // Voltar à tradução depois do fim não traz o indicador de volta.
    t.show(state({ status: 'cancelled', total: 4, done: 1 }));
    t.show(translated());
    expect(t.hosts()).toEqual([]);
  });

  it('volta ao documento se a página remover o host', () => {
    const t = setup();
    t.show(translating(1));
    t.host()?.remove();
    t.show(translating(2));
    expect(t.hosts()).toHaveLength(1);
    expect(t.message()).toBe(translatingMessage(2, 4));
  });
});

describe('progress overlay: Fechar', () => {
  it('ignora clique não confiável (verificador padrão)', () => {
    const t = setup({ isTrusted: undefined });
    t.show(translating(1));
    t.closeButton().click();
    t.closeButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    t.flush();
    expect(t.hosts()).toHaveLength(1);
  });

  it('ignora clique que o verificador recusa', () => {
    const t = setup();
    t.show(translating(1));
    t.closeButton().click();
    expect(t.hosts()).toHaveLength(1);
  });

  it('clique confiável esconde sem cancelar; só um novo início o traz de volta', () => {
    const t = setup();
    t.show(translating(1));
    t.trustedClick(t.closeButton());
    expect(t.hosts()).toEqual([]);
    expect(t.frames.size).toBe(0);

    // O mesmo job continua: nada aparece, nem no fim.
    t.show(translating(2));
    t.show(translated());
    t.show(state({ status: 'error', error: 'network' }));
    expect(t.hosts()).toEqual([]);

    // Novo início.
    t.show(translating(0));
    expect(t.hosts()).toHaveLength(1);
    expect(t.message()).toBe(translatingMessage(0, 4));
  });
});

describe('progress overlay: sucesso some sozinho', () => {
  it(`some em ${AUTO_HIDE_MS} ms e não volta ao alternar a visão`, () => {
    const t = setup();
    t.show(translating(3));
    t.show(translated());
    expect(t.message()).toBe(TRANSLATED_MESSAGE);
    expect(t.q<HTMLElement>('.pill').dataset.tone).toBe('success');
    expect([...t.timers.values()].map((timer) => timer.ms)).toEqual([AUTO_HIDE_MS]);
    t.runTimers();
    expect(t.hosts()).toEqual([]);

    t.show(translated({ view: 'original' }));
    t.show(translated());
    expect(t.hosts()).toEqual([]);
  });

  it('estado repetido não reinicia a contagem', () => {
    const t = setup();
    t.show(translating(3));
    t.show(translated());
    t.show(translated());
    expect(t.deps.setTimeout).toHaveBeenCalledTimes(1);
  });

  it('pausa com o foco dentro e recomeça quando ele sai', () => {
    const t = setup();
    t.show(translating(3));
    t.show(translated());
    t.closeButton().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(t.timers.size).toBe(0);
    t.closeButton().dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: null }),
    );
    expect(t.timers.size).toBe(1);
    t.runTimers();
    expect(t.hosts()).toEqual([]);
  });

  it('foco que passa entre elementos do indicador não retoma a contagem', () => {
    const t = setup();
    t.show(translating(3));
    t.show(translated());
    const pill = t.q<HTMLElement>('.pill');
    t.closeButton().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    t.closeButton().dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: t.q('.message') }),
    );
    expect(pill.contains(t.q('.message'))).toBe(true);
    expect(t.timers.size).toBe(0);
  });

  it('pausa com o ponteiro dentro', () => {
    const t = setup();
    t.show(translating(3));
    const pill = t.q<HTMLElement>('.pill');
    pill.dispatchEvent(new Event('pointerenter'));
    t.show(translated());
    expect(t.timers.size).toBe(0);
    pill.dispatchEvent(new Event('pointerleave'));
    expect(t.timers.size).toBe(1);
  });

  it('nunca chama focus()', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const t = setup();
    t.show(translating(1));
    t.show(translated());
    t.trustedClick(t.closeButton());
    t.show(translating(0));
    t.show(state({ status: 'error', error: 'forbidden' }));
    expect(focus).not.toHaveBeenCalled();
  });
});

describe('progress overlay: isolamento da página', () => {
  it('a coleta não inclui o indicador', () => {
    const t = setup();
    const before = collectTextNodes(document);
    t.show(translating(1));
    t.show(translated({ failed: 1, done: 3 }));
    const after = collectTextNodes(document);
    expect(after).toEqual(before);
    expect(after.map((node) => node.data)).toEqual(['Capítulo um.']);
  });

  it('dispose remove o host e não deixa timers nem quadros', () => {
    const t = setup();
    t.show(translating(3));
    t.show(translated());
    t.overlay.update(translating(0));
    expect(t.timers.size + t.frames.size).toBeGreaterThan(0);
    t.overlay.dispose();
    expect(t.hosts()).toEqual([]);
    expect(t.timers.size).toBe(0);
    expect(t.frames.size).toBe(0);
    t.show(translating(1));
    expect(t.hosts()).toEqual([]);
    expect(t.frames.size).toBe(0);
  });
});

describe('progress overlay: estilos', () => {
  it('sem adoptedStyleSheets (jsdom): cai num <style> com o CSS', () => {
    const t = setup();
    t.show(translating(1));
    const styles = t.root().querySelectorAll('style');
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toBe(OVERLAY_CSS);
  });

  it('createSheet null: cai num <style>', () => {
    withAdoptedSheets = true;
    const t = setup({ createSheet: () => null });
    t.show(translating(1));
    expect(t.root().querySelectorAll('style')).toHaveLength(1);
  });

  it('com suporte: replaceSync e adoptedStyleSheets, sem <style>', () => {
    withAdoptedSheets = true;
    const sheet = { replaceSync: vi.fn() } as unknown as CSSStyleSheet;
    const t = setup({ createSheet: () => sheet });
    t.show(translating(1));
    expect(sheet.replaceSync).toHaveBeenCalledWith(OVERLAY_CSS);
    expect(t.root().adoptedStyleSheets).toEqual([sheet]);
    expect(t.root().querySelectorAll('style')).toHaveLength(0);
  });

  it('replaceSync falha: cai num <style>', () => {
    withAdoptedSheets = true;
    const sheet = {
      replaceSync: vi.fn(() => {
        throw new Error('sem suporte');
      }),
    } as unknown as CSSStyleSheet;
    const t = setup({ createSheet: () => sheet });
    t.show(translating(1));
    expect(t.root().querySelectorAll('style')).toHaveLength(1);
  });

  it('o CSS protege o host e respeita preferências do usuário', () => {
    for (const rule of [
      'all: initial !important',
      'position: fixed !important',
      'inset: auto 16px 16px auto !important',
      'z-index: 2147483647 !important',
      'max-width: min(320px',
      '@media (prefers-color-scheme: dark)',
      '@media (forced-colors: active)',
      '@media (prefers-reduced-motion: reduce)',
      '@media print',
      ':host { display: none !important; }',
    ]) {
      expect(OVERLAY_CSS).toContain(rule);
    }
    expect(OVERLAY_CSS).not.toMatch(/popover|rem\b|em;/);
  });
});
