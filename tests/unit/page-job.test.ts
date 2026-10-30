import { describe, expect, it, vi } from 'vitest';
import {
  PROGRESS_INTERVAL_MS,
  createPageJobHandler,
  type PageJobDeps,
} from '../../src/background/page-job';
import type {
  TranslateOptions,
  TranslationInput,
  TranslationProvider,
  TranslationResult,
} from '../../src/core/translation-provider';
import type { TranslationSettings } from '../../src/core/types';
import { MAX_OUTPUT_CHARS, PAGE_JOB_PORT_NAME } from '../../src/shared/page-messages';
import type { PortLike, PortSenderLike } from '../../src/shared/port-like';

const RUNTIME_ID = 'mjkoppimccgajnabfeheglepjapkchlk';
const JOB_ID = '0b9a6c1e-2f3d-4a5b-8c7d-9e0f1a2b3c4d';
const OTHER_JOB_ID = '1c0b7d2f-3a4e-4b6c-9d8e-0f1a2b3c4d5e';
const UNIT_TEXT = 'The dragon slept beneath the mountain.';
const TRANSLATED = 'O dragão dormia sob a montanha.';

const SETTINGS: TranslationSettings = {
  schemaVersion: 1,
  endpoint: 'http://localhost:11434',
  model: 'translategemma:4b',
  sourceLanguage: 'en',
  targetLanguage: 'pt-BR',
};

/** Documento em que o worker injetou o content script, por aba. */
const INJECTED_DOCUMENTS = new Map([
  [7, 'DOC-7'],
  [8, 'DOC-8'],
]);
const isInjectedDocument = (tabId: number, documentId: string): boolean =>
  INJECTED_DOCUMENTS.get(tabId) === documentId;

const VALID_SENDER: PortSenderLike = {
  id: RUNTIME_ID,
  url: 'https://example.com/novel/chapter-1',
  frameId: 0,
  documentId: 'DOC-7',
  documentLifecycle: 'active',
  tab: { id: 7 },
};

interface FakePort extends PortLike {
  sent: unknown[];
  disconnect: ReturnType<typeof vi.fn<() => void>>;
  emit(message: unknown): void;
  /** Simula o outro lado fechando a port. */
  close(): void;
  listenerCount(): number;
}

function createFakePort(
  sender: PortSenderLike | null = VALID_SENDER,
  name = PAGE_JOB_PORT_NAME,
): FakePort {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  let closed = false;
  const sent: unknown[] = [];
  return {
    name,
    ...(sender !== null ? { sender } : {}),
    sent,
    postMessage(message: unknown) {
      if (closed) throw new Error('Attempting to use a disconnected port object');
      sent.push(message);
    },
    disconnect: vi.fn(() => {
      closed = true;
    }),
    onMessage: {
      addListener: (listener) => messageListeners.add(listener),
      removeListener: (listener) => messageListeners.delete(listener),
    },
    onDisconnect: {
      addListener: (listener) => disconnectListeners.add(listener),
      removeListener: (listener) => disconnectListeners.delete(listener),
    },
    emit(message) {
      for (const listener of [...messageListeners]) listener(message);
    },
    close() {
      closed = true;
      for (const listener of [...disconnectListeners]) listener();
    },
    listenerCount: () => messageListeners.size + disconnectListeners.size,
  };
}

interface PendingCall {
  input: TranslationInput;
  options: TranslateOptions | undefined;
  resolve(result: TranslationResult): void;
}

/** Provedor controlado pelo teste: cada chamada fica pendente até `resolve`. */
function createFakeProvider() {
  const calls: PendingCall[] = [];
  const provider: TranslationProvider = {
    translate: (input, options) =>
      new Promise<TranslationResult>((resolve) => {
        calls.push({ input, options, resolve });
      }),
  };
  return { provider, calls };
}

function setup(overrides: Partial<PageJobDeps> = {}) {
  const fake = createFakeProvider();
  const createProvider = vi.fn(() => fake.provider);
  const loadSettings = vi.fn(async () => SETTINGS);
  const handler = createPageJobHandler({
    runtimeId: RUNTIME_ID,
    isInjectedDocument,
    loadSettings,
    createProvider,
    ...overrides,
  });
  const port = createFakePort();
  handler(port);
  return { handler, port, calls: fake.calls, createProvider, loadSettings };
}

const unit = (unitId = 'seg-0#text@1', jobId = JOB_ID, text = UNIT_TEXT) => ({
  type: 'job:unit',
  jobId,
  unitId,
  text,
});

/** Esvazia microtarefas (carga de settings e encadeamentos). */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('createPageJobHandler — remetente', () => {
  const cases: [string, PortSenderLike | null, string?][] = [
    ['nome de port diferente', VALID_SENDER, 'outra-port'],
    ['sem sender', null],
    ['outra extensão', { ...VALID_SENDER, id: 'abcdefghijklmnopabcdefghijklmnop' }],
    ['sem aba', { ...VALID_SENDER, tab: undefined }],
    ['aba sem id', { ...VALID_SENDER, tab: {} }],
    ['iframe', { ...VALID_SENDER, frameId: 3 }],
    ['frameId ausente', { ...VALID_SENDER, frameId: undefined }],
    ['página da extensão', { ...VALID_SENDER, url: `chrome-extension://${RUNTIME_ID}/x.html` }],
    ['url file:', { ...VALID_SENDER, url: 'file:///C:/novel.html' }],
    ['url ausente', { ...VALID_SENDER, url: undefined }],
    ['url inválida', { ...VALID_SENDER, url: 'não é url' }],
    ['documento em prerender', { ...VALID_SENDER, documentLifecycle: 'prerender' }],
    ['documento no bfcache', { ...VALID_SENDER, documentLifecycle: 'cached' }],
    ['documento pendente de exclusão', { ...VALID_SENDER, documentLifecycle: 'pending_deletion' }],
    ['documentLifecycle ausente', { ...VALID_SENDER, documentLifecycle: undefined }],
    ['documentId ausente', { ...VALID_SENDER, documentId: undefined }],
    ['documentId não registrado', { ...VALID_SENDER, documentId: 'DOC-OUTRO' }],
    ['documentId de outra aba', { ...VALID_SENDER, documentId: 'DOC-8' }],
    ['aba sem injeção registrada', { ...VALID_SENDER, tab: { id: 9 }, documentId: 'DOC-7' }],
  ];

  it.each(cases)('recusa %s sem responder', async (_label, sender, name) => {
    const loadSettings = vi.fn(async () => SETTINGS);
    const handler = createPageJobHandler({
      runtimeId: RUNTIME_ID,
      isInjectedDocument,
      loadSettings,
      createProvider: () => createFakeProvider().provider,
    });
    const port = createFakePort(sender, name);
    handler(port);
    expect(port.disconnect).toHaveBeenCalledTimes(1);
    expect(port.listenerCount()).toBe(0);
    port.emit(unit());
    await flush();
    expect(port.sent).toEqual([]);
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it('aceita frame principal http', () => {
    const handler = createPageJobHandler({
      runtimeId: RUNTIME_ID,
      isInjectedDocument,
      loadSettings: async () => SETTINGS,
      createProvider: () => createFakeProvider().provider,
    });
    const port = createFakePort({ ...VALID_SENDER, url: 'http://127.0.0.1:8080/a' });
    handler(port);
    expect(port.disconnect).not.toHaveBeenCalled();
    expect(port.listenerCount()).toBe(2);
  });

  it('aceita documento ativo', () => {
    const handler = createPageJobHandler({
      runtimeId: RUNTIME_ID,
      isInjectedDocument,
      loadSettings: async () => SETTINGS,
      createProvider: () => createFakeProvider().provider,
    });
    const port = createFakePort({ ...VALID_SENDER, documentLifecycle: 'active' });
    handler(port);
    expect(port.disconnect).not.toHaveBeenCalled();
    expect(port.listenerCount()).toBe(2);
  });
});

describe('createPageJobHandler — configurações', () => {
  it.each([
    ['null', async () => null],
    ['rejeição', async () => Promise.reject(new Error('storage'))],
  ])('settings indisponíveis (%s) → fatal e disconnect', async (_label, loadSettings) => {
    const { port, createProvider } = setup({ loadSettings });
    port.emit(unit());
    await flush();
    expect(port.sent).toEqual([
      { type: 'job:fatal', jobId: JOB_ID, error: 'settings_unavailable' },
    ]);
    expect(port.disconnect).toHaveBeenCalledTimes(1);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it('carrega settings e cria o provedor uma única vez por port', async () => {
    const { port, calls, loadSettings, createProvider } = setup();
    port.emit({ type: 'job:ping', jobId: JOB_ID });
    port.emit(unit('a'));
    await flush();
    calls[0]!.resolve({ ok: true, text: TRANSLATED, durationMs: 1 });
    await flush();
    port.emit(unit('b'));
    await flush();
    expect(calls).toHaveLength(2);
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledWith(SETTINGS);
  });
});

describe('createPageJobHandler — tradução', () => {
  it('traduz com idiomas das settings e devolve o texto', async () => {
    const { port, calls } = setup();
    port.emit(unit());
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual({ text: UNIT_TEXT, source: 'en', target: 'pt-BR' });
    expect(calls[0]!.options?.signal).toBeInstanceOf(AbortSignal);
    expect(typeof calls[0]!.options?.onToken).toBe('function');
    calls[0]!.resolve({ ok: true, text: TRANSLATED, durationMs: 10 });
    await flush();
    expect(port.sent).toEqual([
      { type: 'job:result', jobId: JOB_ID, unitId: 'seg-0#text@1', ok: true, text: TRANSLATED },
    ]);
    expect(port.disconnect).not.toHaveBeenCalled();
  });

  it('erro repetível vira job:result sem fatal', async () => {
    const { port, calls } = setup();
    port.emit(unit());
    await flush();
    calls[0]!.resolve({ ok: false, error: 'timeout', retryable: true, status: 504 });
    await flush();
    expect(port.sent).toEqual([
      {
        type: 'job:result',
        jobId: JOB_ID,
        unitId: 'seg-0#text@1',
        ok: false,
        error: 'timeout',
        retryable: true,
      },
    ]);
    expect(port.disconnect).not.toHaveBeenCalled();
  });

  it.each(['invalid_config', 'model_missing', 'forbidden'] as const)(
    '%s → job:result, job:fatal e disconnect',
    async (error) => {
      const { port, calls } = setup();
      port.emit(unit());
      await flush();
      calls[0]!.resolve({ ok: false, error, retryable: false });
      await flush();
      expect(port.sent).toEqual([
        {
          type: 'job:result',
          jobId: JOB_ID,
          unitId: 'seg-0#text@1',
          ok: false,
          error,
          retryable: false,
        },
        { type: 'job:fatal', jobId: JOB_ID, error },
      ]);
      expect(port.disconnect).toHaveBeenCalledTimes(1);
      expect(port.listenerCount()).toBe(0);
    },
  );

  it('provedor que rejeita vira internal_error', async () => {
    const handler = createPageJobHandler({
      runtimeId: RUNTIME_ID,
      isInjectedDocument,
      loadSettings: async () => SETTINGS,
      createProvider: () => ({ translate: () => Promise.reject(new Error('boom')) }),
    });
    const port = createFakePort();
    handler(port);
    port.emit(unit());
    await flush();
    expect(port.sent).toEqual([
      {
        type: 'job:result',
        jobId: JOB_ID,
        unitId: 'seg-0#text@1',
        ok: false,
        error: 'internal_error',
        retryable: false,
      },
    ]);
  });

  it('saída acima do limite vira invalid_response não repetível', async () => {
    const { port, calls } = setup();
    port.emit(unit());
    await flush();
    calls[0]!.resolve({ ok: true, text: 'x'.repeat(MAX_OUTPUT_CHARS + 1), durationMs: 1 });
    await flush();
    expect(port.sent).toEqual([
      {
        type: 'job:result',
        jobId: JOB_ID,
        unitId: 'seg-0#text@1',
        ok: false,
        error: 'invalid_response',
        retryable: false,
      },
    ]);
  });

  it('saída exatamente no limite é aceita', async () => {
    const { port, calls } = setup();
    port.emit(unit());
    await flush();
    const text = 'x'.repeat(MAX_OUTPUT_CHARS);
    calls[0]!.resolve({ ok: true, text, durationMs: 1 });
    await flush();
    expect(port.sent).toEqual([
      { type: 'job:result', jobId: JOB_ID, unitId: 'seg-0#text@1', ok: true, text },
    ]);
  });

  it('streaming acima do limite aborta cedo e responde uma vez só', async () => {
    const { port, calls } = setup();
    port.emit(unit('a'));
    await flush();
    const { signal, onToken } = calls[0]!.options!;
    onToken!('x'.repeat(MAX_OUTPUT_CHARS));
    expect(signal!.aborted).toBe(false);
    expect(port.sent).toEqual([]);
    onToken!('y');
    expect(signal!.aborted).toBe(true);
    const overflow = {
      type: 'job:result',
      jobId: JOB_ID,
      unitId: 'a',
      ok: false,
      error: 'invalid_response',
      retryable: false,
    };
    expect(port.sent).toEqual([overflow]);

    // Tokens e resultado tardios do provedor são ignorados.
    onToken!('z'.repeat(10));
    calls[0]!.resolve({ ok: true, text: 'x'.repeat(MAX_OUTPUT_CHARS + 11), durationMs: 1 });
    await flush();
    expect(port.sent).toEqual([overflow]);
    expect(port.disconnect).not.toHaveBeenCalled();

    // O slot fica livre: a próxima unidade não recebe busy.
    port.emit(unit('b'));
    await flush();
    expect(calls).toHaveLength(2);
    expect(port.sent).toEqual([overflow]);
  });
});

describe('createPageJobHandler — concorrência e jobId', () => {
  it('segunda unidade com tradução em voo → busy repetível', async () => {
    const { port, calls } = setup();
    port.emit(unit('a'));
    port.emit(unit('b'));
    await flush();
    expect(calls).toHaveLength(1);
    expect(port.sent).toEqual([
      { type: 'job:result', jobId: JOB_ID, unitId: 'b', ok: false, error: 'busy', retryable: true },
    ]);
    calls[0]!.resolve({ ok: true, text: TRANSLATED, durationMs: 1 });
    await flush();
    port.emit(unit('b'));
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('ignora mensagens de outro jobId', async () => {
    const { port, calls } = setup();
    port.emit({ type: 'job:ping', jobId: JOB_ID });
    port.emit(unit('a', OTHER_JOB_ID));
    await flush();
    expect(calls).toHaveLength(0);
    expect(port.sent).toEqual([]);
    port.emit(unit('a'));
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('ignora mensagens inválidas sem derrubar a port', async () => {
    const { port, calls, loadSettings } = setup();
    for (const bad of [
      null,
      'texto',
      { type: 'job:unit', jobId: 'nao-uuid', unitId: 'a', text: 'x' },
      { type: 'job:unit', jobId: JOB_ID, unitId: 'tem espaço', text: 'x' },
      { type: 'job:unit', jobId: JOB_ID, unitId: 'a', text: 42 },
      { type: 'job:result', jobId: JOB_ID },
    ]) {
      port.emit(bad);
    }
    await flush();
    expect(port.sent).toEqual([]);
    expect(port.disconnect).not.toHaveBeenCalled();
    expect(loadSettings).not.toHaveBeenCalled();
    // Mensagem inválida não fixa jobId: o próximo válido ainda pode fixar.
    port.emit(unit('a', OTHER_JOB_ID));
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('job:ping não gera resposta', async () => {
    const { port } = setup();
    port.emit({ type: 'job:ping', jobId: JOB_ID });
    port.emit({ type: 'job:ping', jobId: JOB_ID });
    await flush();
    expect(port.sent).toEqual([]);
    expect(port.disconnect).not.toHaveBeenCalled();
  });
});

describe('createPageJobHandler — desligamento', () => {
  it('disconnect aborta a unidade em voo e nada é postado depois', async () => {
    const { port, calls } = setup();
    port.emit(unit());
    await flush();
    const signal = calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    port.close();
    expect(signal.aborted).toBe(true);
    calls[0]!.options!.onToken!('abc');
    calls[0]!.resolve({ ok: false, error: 'cancelled', retryable: false });
    await flush();
    port.emit(unit('b'));
    await flush();
    expect(port.sent).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(port.listenerCount()).toBe(0);
  });

  it('disconnect durante a carga das settings não inicia tradução', async () => {
    let release: (value: TranslationSettings) => void = () => {};
    const { port, calls } = setup({
      loadSettings: () =>
        new Promise<TranslationSettings>((resolve) => {
          release = resolve;
        }),
    });
    port.emit(unit());
    port.close();
    release(SETTINGS);
    await flush();
    expect(calls).toHaveLength(0);
    expect(port.sent).toEqual([]);
  });

  it('postMessage que lança é tratado como desligamento', async () => {
    const { port, calls } = setup();
    port.emit(unit('a'));
    await flush();
    // Port morta sem onDisconnect (corrida no Chrome).
    port.postMessage = () => {
      throw new Error('disconnected');
    };
    calls[0]!.resolve({ ok: true, text: TRANSLATED, durationMs: 1 });
    await flush();
    expect(port.listenerCount()).toBe(0);
  });
});

describe('createPageJobHandler — progresso', () => {
  it('envia só contagem, no máximo a cada 5 s, sem texto', async () => {
    let clock = 1_000;
    const { port, calls } = setup({ now: () => clock });
    port.emit(unit());
    await flush();
    const onToken = calls[0]!.options!.onToken!;
    onToken('O dragão ');
    clock += PROGRESS_INTERVAL_MS - 1;
    onToken('dormia ');
    expect(port.sent).toEqual([]);
    clock += 1;
    onToken('sob ');
    clock += 1_000;
    onToken('a ');
    clock += PROGRESS_INTERVAL_MS;
    onToken('montanha.');
    calls[0]!.resolve({ ok: true, text: TRANSLATED, durationMs: 1 });
    await flush();

    expect(port.sent).toEqual([
      { type: 'job:progress', jobId: JOB_ID, unitId: 'seg-0#text@1', chars: 20 },
      { type: 'job:progress', jobId: JOB_ID, unitId: 'seg-0#text@1', chars: 31 },
      { type: 'job:result', jobId: JOB_ID, unitId: 'seg-0#text@1', ok: true, text: TRANSLATED },
    ]);
    // Nenhuma mensagem carrega o texto da unidade nem trechos do modelo,
    // exceto o resultado final.
    for (const message of port.sent.slice(0, -1)) {
      const serialized = JSON.stringify(message);
      expect(serialized).not.toContain(UNIT_TEXT);
      expect(serialized).not.toContain('dragão');
      expect(serialized).not.toContain('montanha');
    }
    expect(port.sent.some((message) => JSON.stringify(message).includes(UNIT_TEXT))).toBe(false);
  });
});

describe('createPageJobHandler — uma port por aba', () => {
  const otherTab: PortSenderLike = { ...VALID_SENDER, tab: { id: 8 }, documentId: 'DOC-8' };

  it('nova port da mesma aba derruba a anterior e aborta a unidade em voo', async () => {
    const { handler, port: first, calls } = setup();
    first.emit(unit('a'));
    await flush();
    const signal = calls[0]!.options!.signal!;

    const second = createFakePort();
    handler(second);
    expect(signal.aborted).toBe(true);
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(first.listenerCount()).toBe(0);
    expect(second.disconnect).not.toHaveBeenCalled();

    calls[0]!.options!.onToken!('abc');
    calls[0]!.resolve({ ok: true, text: TRANSLATED, durationMs: 1 });
    second.emit(unit('b'));
    await flush();
    expect(first.sent).toEqual([]);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ ok: true, text: TRANSLATED, durationMs: 1 });
    await flush();
    expect(second.sent).toEqual([
      { type: 'job:result', jobId: JOB_ID, unitId: 'b', ok: true, text: TRANSLATED },
    ]);
  });

  it('abas diferentes coexistem', async () => {
    const { handler, port: first, calls } = setup();
    const second = createFakePort(otherTab);
    handler(second);
    first.emit(unit('a'));
    second.emit(unit('b'));
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.options!.signal!.aborted === false)).toBe(true);
    expect(first.disconnect).not.toHaveBeenCalled();
    expect(second.disconnect).not.toHaveBeenCalled();
  });

  it('disconnect da port substituída não remove a nova do registro', () => {
    const { handler, port: first } = setup();
    const second = createFakePort();
    handler(second);
    first.close();
    // Se a segunda ainda está registrada, a terceira a derruba.
    const third = createFakePort();
    handler(third);
    expect(second.disconnect).toHaveBeenCalledTimes(1);
    expect(second.listenerCount()).toBe(0);
    expect(third.disconnect).not.toHaveBeenCalled();
  });

  it('port encerrada sai do registro sem afetar a próxima', () => {
    const { handler, port: first } = setup();
    first.close();
    const second = createFakePort();
    handler(second);
    expect(first.disconnect).not.toHaveBeenCalled();
    expect(second.disconnect).not.toHaveBeenCalled();
  });
});
