import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  createContentController,
  handlePageHide,
  toPageStateView,
  type ContentController,
} from '../../src/content/controller';
import { installOnce } from '../../src/content/install-once';
import { createJobRunner, type JobRunner, type JobState } from '../../src/content/job-runner';
import {
  PAGE_COMMAND_MESSAGE_TYPE,
  parsePageCommandResponse,
  type PageCommandName,
} from '../../src/shared/page-control';
import { PAGE_JOB_PORT_NAME, type JobUnitMessage } from '../../src/shared/page-messages';
import type { PortLike } from '../../src/shared/port-like';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${RUNTIME_ID}/`;
const POPUP = { id: RUNTIME_ID, url: `${ORIGIN}src/popup/index.html` };
const JOB_ID = '00000000-0000-4000-8000-000000000001';

const command = (name: PageCommandName): unknown => ({
  type: PAGE_COMMAND_MESSAGE_TYPE,
  command: name,
});

function parse(body: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body>${body}</body></html>`,
    'text/html',
  );
}

const serialize = (document: Document): string => new XMLSerializer().serializeToString(document);

interface FakePort {
  readonly port: PortLike;
  readonly inFlight: JobUnitMessage[];
  disconnected(): boolean;
  runToEnd(translate: (text: string) => string): void;
}

function createFakePort(): FakePort {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const inFlight: JobUnitMessage[] = [];
  let disconnected = false;
  const port: PortLike = {
    name: PAGE_JOB_PORT_NAME,
    postMessage(message) {
      if (disconnected) throw new Error('disconnected');
      if ((message as { type?: unknown }).type === 'job:unit') {
        inFlight.push(message as JobUnitMessage);
      }
    },
    disconnect() {
      disconnected = true;
    },
    onMessage: {
      addListener: (listener) => messageListeners.add(listener),
      removeListener: (listener) => messageListeners.delete(listener),
    },
    onDisconnect: {
      addListener: (listener) => disconnectListeners.add(listener),
      removeListener: (listener) => disconnectListeners.delete(listener),
    },
  };
  return {
    port,
    inFlight,
    disconnected: () => disconnected,
    runToEnd(translate) {
      for (let unit = inFlight.shift(); unit !== undefined; unit = inFlight.shift()) {
        const result = {
          type: 'job:result',
          jobId: unit.jobId,
          unitId: unit.unitId,
          ok: true,
          text: translate(unit.text),
        };
        for (const listener of [...messageListeners]) listener(result);
      }
    },
  };
}

interface Harness {
  readonly document: Document;
  readonly runner: JobRunner;
  readonly controller: ContentController;
  readonly ports: FakePort[];
  readonly port: () => FakePort;
}

function setup(body = '<p>Plain sentence here.</p><p>Second line.</p>'): Harness {
  const document = parse(body);
  const ports: FakePort[] = [];
  const runner = createJobRunner({
    root: document,
    connect: () => {
      const fake = createFakePort();
      ports.push(fake);
      return fake.port;
    },
    randomUUID: () => JOB_ID,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as Parameters<typeof clearInterval>[0]),
  });
  const controller = createContentController({
    runner,
    runtimeId: RUNTIME_ID,
    extensionOrigin: ORIGIN,
  });
  return {
    document,
    runner,
    controller,
    ports,
    port: () => {
      const last = ports[ports.length - 1];
      if (last === undefined) throw new Error('nenhuma porta aberta');
      return last;
    },
  };
}

/** Runner falso que só registra as chamadas. */
function fakeRunner(state: JobState): { runner: JobRunner; calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  return {
    calls,
    runner: {
      start: record('start'),
      cancel: record('cancel'),
      showOriginal: record('showOriginal'),
      showTranslation: record('showTranslation'),
      dispose: record('dispose'),
      getState: () => ({ ...state }),
    },
  };
}

const IDLE_STATE: JobState = {
  status: 'idle',
  view: 'original',
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
};

const upperCase = (text: string): string => text.toUpperCase();

const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
let consoleSpies: MockInstance[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  consoleSpies = consoleMethods.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
  vi.useRealTimers();
});

describe('createContentController — remetente', () => {
  const untrusted: [string, { id?: string; url?: string }][] = [
    ['sem id nem url', {}],
    ['outra extensão', { id: 'x'.repeat(32), url: `chrome-extension://${'x'.repeat(32)}/p.html` }],
    ['id certo, url de página (content script)', { id: RUNTIME_ID, url: 'https://example.com/' }],
    ['id certo, sem url', { id: RUNTIME_ID }],
    ['url da extensão, id errado', { id: 'outro', url: POPUP.url }],
    ['url com prefixo enganoso', { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}.evil/` }],
  ];

  it.each(untrusted)('%s: ignorado, sem resposta nem efeito', (_label, sender) => {
    const { runner, calls } = fakeRunner(IDLE_STATE);
    const controller = createContentController({
      runner,
      runtimeId: RUNTIME_ID,
      extensionOrigin: ORIGIN,
    });
    expect(controller.handleMessage(command('start'), sender)).toBeUndefined();
    expect(controller.handleMessage('lixo', sender)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('runtimeId vazio ou origem incoerente: nada é aceito', () => {
    for (const [runtimeId, extensionOrigin] of [
      ['', 'chrome-extension:///'],
      [RUNTIME_ID, 'chrome-extension://'],
      [RUNTIME_ID, `chrome-extension://${RUNTIME_ID}`],
      [RUNTIME_ID, 'https://example.com/'],
    ] as const) {
      const { runner, calls } = fakeRunner(IDLE_STATE);
      const controller = createContentController({ runner, runtimeId, extensionOrigin });
      expect(controller.handleMessage(command('start'), { id: runtimeId, url: POPUP.url })).toBe(
        undefined,
      );
      expect(calls).toEqual([]);
    }
  });
});

describe('createContentController — validação do comando', () => {
  it.each([
    ['não objeto', 'start'],
    ['nulo', null],
    ['tipo errado', { type: 'page:inject', command: 'start' }],
    ['comando desconhecido', { type: PAGE_COMMAND_MESSAGE_TYPE, command: 'destroy' }],
    ['sem comando', { type: PAGE_COMMAND_MESSAGE_TYPE }],
    ['array', [PAGE_COMMAND_MESSAGE_TYPE, 'start']],
  ])('%s → invalid_request sem efeito', (_label, message) => {
    const { runner, calls } = fakeRunner(IDLE_STATE);
    const controller = createContentController({
      runner,
      runtimeId: RUNTIME_ID,
      extensionOrigin: ORIGIN,
    });
    expect(controller.handleMessage(message, POPUP)).toEqual({
      ok: false,
      error: 'invalid_request',
    });
    expect(calls).toEqual([]);
  });

  it('campos extras não chegam ao runner nem à resposta', () => {
    const { runner, calls } = fakeRunner(IDLE_STATE);
    const controller = createContentController({
      runner,
      runtimeId: RUNTIME_ID,
      extensionOrigin: ORIGIN,
    });
    const response = controller.handleMessage(
      { type: PAGE_COMMAND_MESSAGE_TYPE, command: 'get-state', text: 'segredo' },
      POPUP,
    );
    expect(response).toEqual({ ok: true, state: IDLE_STATE });
    expect(calls).toEqual([]);
  });
});

describe('createContentController — comandos', () => {
  it.each([
    ['start', 'start'],
    ['cancel', 'cancel'],
    ['show-original', 'showOriginal'],
    ['show-translation', 'showTranslation'],
  ] as const)('%s chama runner.%s e responde o estado', (name, method) => {
    const { runner, calls } = fakeRunner(IDLE_STATE);
    const controller = createContentController({
      runner,
      runtimeId: RUNTIME_ID,
      extensionOrigin: ORIGIN,
    });
    expect(controller.handleMessage(command(name), POPUP)).toEqual({
      ok: true,
      state: IDLE_STATE,
    });
    expect(calls).toEqual([method]);
  });

  it('get-state não chama nenhum comando', () => {
    const { runner, calls } = fakeRunner(IDLE_STATE);
    const controller = createContentController({
      runner,
      runtimeId: RUNTIME_ID,
      extensionOrigin: ORIGIN,
    });
    expect(controller.handleMessage(command('get-state'), POPUP)).toEqual({
      ok: true,
      state: IDLE_STATE,
    });
    expect(calls).toEqual([]);
  });

  it('fluxo real: start, tradução, original, tradução, com respostas válidas', () => {
    const { document, controller, port } = setup();
    const before = serialize(document);

    const started = controller.handleMessage(command('start'), POPUP);
    expect(started).toEqual({
      ok: true,
      state: {
        status: 'translating',
        view: 'translation',
        total: 2,
        done: 0,
        failed: 0,
        skipped: 0,
      },
    });
    expect(parsePageCommandResponse(started)).toEqual(started);

    port().runToEnd(upperCase);
    const translated = serialize(document);
    expect(controller.handleMessage(command('get-state'), POPUP)).toEqual({
      ok: true,
      state: {
        status: 'translated',
        view: 'translation',
        total: 2,
        done: 2,
        failed: 0,
        skipped: 0,
      },
    });

    expect(controller.handleMessage(command('show-original'), POPUP)).toMatchObject({
      ok: true,
      state: { status: 'translated', view: 'original' },
    });
    expect(serialize(document)).toBe(before);

    expect(controller.handleMessage(command('show-translation'), POPUP)).toMatchObject({
      ok: true,
      state: { status: 'translated', view: 'translation' },
    });
    expect(serialize(document)).toBe(translated);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel real durante o job fecha a porta e responde cancelled', () => {
    const { controller, port } = setup();
    controller.handleMessage(command('start'), POPUP);
    expect(controller.handleMessage(command('cancel'), POPUP)).toMatchObject({
      ok: true,
      state: { status: 'cancelled', view: 'translation' },
    });
    expect(port().disconnected()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('get-state nunca carrega texto da página', () => {
    const { controller, port } = setup('<p>Segredo literário aqui.</p>');
    controller.handleMessage(command('start'), POPUP);
    port().runToEnd(upperCase);
    const response = controller.handleMessage(command('get-state'), POPUP);
    expect(response?.ok).toBe(true);
    const state = response?.ok === true ? response.state : null;
    expect(Object.keys(state ?? {}).sort()).toEqual([
      'done',
      'failed',
      'skipped',
      'status',
      'total',
      'view',
    ]);
    expect(JSON.stringify(response)).not.toMatch(/segredo|literário|aqui/i);
  });

  it('erro do job aparece como código na resposta', () => {
    const { runner, calls } = fakeRunner({
      ...IDLE_STATE,
      status: 'error',
      view: 'translation',
      error: 'model_missing',
    });
    const controller = createContentController({
      runner,
      runtimeId: RUNTIME_ID,
      extensionOrigin: ORIGIN,
    });
    const response = controller.handleMessage(command('get-state'), POPUP);
    expect(response).toEqual({
      ok: true,
      state: { ...IDLE_STATE, status: 'error', view: 'translation', error: 'model_missing' },
    });
    expect(parsePageCommandResponse(response)).toEqual(response);
    expect(calls).toEqual([]);
  });
});

describe('toPageStateView', () => {
  it('copia só os campos do contrato', () => {
    const state = { ...IDLE_STATE, extra: 'texto' } as JobState;
    expect(toPageStateView(state)).toEqual(IDLE_STATE);
    expect(toPageStateView({ ...IDLE_STATE, error: 'interrupted' })).toEqual({
      ...IDLE_STATE,
      error: 'interrupted',
    });
  });
});

describe('createContentController — pagehide', () => {
  it('persisted=true (bfcache) só cancela', () => {
    const { runner, calls } = fakeRunner(IDLE_STATE);
    const controller = createContentController({
      runner,
      runtimeId: RUNTIME_ID,
      extensionOrigin: ORIGIN,
    });
    controller.onPageHide(true);
    expect(calls).toEqual(['cancel']);
  });

  it('persisted=false descarta o runner', () => {
    const { runner, calls } = fakeRunner(IDLE_STATE);
    const controller = createContentController({
      runner,
      runtimeId: RUNTIME_ID,
      extensionOrigin: ORIGIN,
    });
    controller.onPageHide(false);
    expect(calls).toEqual(['dispose']);
  });

  it('runner real: bfcache cancela e permite reiniciar na volta', () => {
    const { controller, ports } = setup();
    controller.handleMessage(command('start'), POPUP);
    controller.onPageHide(true);
    expect(ports[0]?.disconnected()).toBe(true);
    expect(controller.handleMessage(command('get-state'), POPUP)).toMatchObject({
      state: { status: 'cancelled' },
    });
    controller.handleMessage(command('start'), POPUP);
    expect(ports).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
    controller.handleMessage(command('cancel'), POPUP);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runner real: descarregamento encerra e comandos seguintes não abrem porta', () => {
    const { controller, ports } = setup();
    controller.handleMessage(command('start'), POPUP);
    controller.onPageHide(false);
    expect(ports[0]?.disconnected()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.handleMessage(command('start'), POPUP)).toMatchObject({
      ok: true,
      state: { status: 'cancelled' },
    });
    expect(ports).toHaveLength(1);
  });
});

describe('handlePageHide', () => {
  const controllerWith = () => {
    const { runner, calls } = fakeRunner(IDLE_STATE);
    const controller = createContentController({
      runner,
      runtimeId: RUNTIME_ID,
      extensionOrigin: ORIGIN,
    });
    return { controller, calls };
  };

  it('evento sintético da página (isTrusted=false) é ignorado', () => {
    const { controller, calls } = controllerWith();
    handlePageHide({ isTrusted: false, persisted: false }, controller);
    handlePageHide({ isTrusted: false, persisted: true }, controller);
    expect(calls).toEqual([]);
  });

  it('dispatchEvent real em jsdom gera isTrusted=false e não desativa', () => {
    const { controller, calls } = controllerWith();
    const listener = (event: PageTransitionEvent): void => handlePageHide(event, controller);
    window.addEventListener('pagehide', listener);
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    window.removeEventListener('pagehide', listener);
    expect(calls).toEqual([]);
  });

  it('evento confiável com persisted=false descarta o runner', () => {
    const { controller, calls } = controllerWith();
    handlePageHide({ isTrusted: true, persisted: false }, controller);
    expect(calls).toEqual(['dispose']);
  });

  it('evento confiável com persisted=true só cancela', () => {
    const { controller, calls } = controllerWith();
    handlePageHide({ isTrusted: true, persisted: true }, controller);
    expect(calls).toEqual(['cancel']);
  });
});

describe('installOnce', () => {
  it('instala uma vez só por host e chave', () => {
    const host = {};
    const key = Symbol.for('lerium.content.test');
    const install = vi.fn();
    expect(installOnce(host, key, install)).toBe(true);
    expect(installOnce(host, key, install)).toBe(false);
    expect(install).toHaveBeenCalledTimes(1);
    expect(installOnce({}, key, install)).toBe(true);
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('marca antes de instalar: reentrância e falha não instalam de novo', () => {
    const host = {};
    const key = Symbol('k');
    let inner: boolean | undefined;
    const install = vi.fn(() => {
      inner = installOnce(host, key, install);
      throw new Error('falhou');
    });
    expect(() => installOnce(host, key, install)).toThrow('falhou');
    expect(inner).toBe(false);
    expect(installOnce(host, key, install)).toBe(false);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('a marca não é enumerável nem removível', () => {
    const host: Record<symbol, unknown> = {};
    const key = Symbol('k');
    installOnce(host, key, () => undefined);
    expect(Object.keys(host)).toEqual([]);
    expect(Reflect.deleteProperty(host, key)).toBe(false);
    expect(Reflect.set(host, key, false)).toBe(false);
    expect(installOnce(host, key, () => undefined)).toBe(false);
  });
});
