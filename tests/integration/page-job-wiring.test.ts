import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageJobHandler } from '../../src/background/page-job';
import { createTranslationGate, type TranslationGate } from '../../src/background/translation-gate';
import { collectTextNodes } from '../../src/content/dom-collector';
import { createJobRunner, type JobRunner, type JobState } from '../../src/content/job-runner';
import { createPageApplier } from '../../src/content/page-applier';
import { segmentTextNodes } from '../../src/content/segmenter';
import type {
  TranslationInput,
  TranslationProvider,
  TranslationResult,
} from '../../src/core/translation-provider';
import type { TranslationSettings } from '../../src/core/types';
import { PAGE_JOB_PORT_NAME } from '../../src/shared/page-messages';
import type { PortLike, PortSenderLike } from '../../src/shared/port-like';

/**
 * Executor do content script (`createJobRunner`) ligado ao lado do service
 * worker (`createPageJobHandler`), ambos reais, por um par de Ports falsas.
 * Só o provedor é falso: cada tradução fica pendente até o teste resolver.
 * O semáforo é o real.
 *
 * O par imita `chrome.runtime.Port`: a mensagem é serializada (JSON) e
 * entregue ao outro lado numa tarefa posterior (`setTimeout(0)`, com timers
 * falsos), nunca de forma síncrona; `disconnect()` de um lado fecha os dois e
 * dispara `onDisconnect` só do outro lado.
 */

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/novel-chapter.html',
);
const FIXTURE_HTML = readFileSync(FIXTURE_PATH, 'utf8');

const RUNTIME_ID = 'mjkoppimccgajnabfeheglepjapkchlk';
const WINDOW = 2;

const SETTINGS: TranslationSettings = {
  schemaVersion: 1,
  endpoint: 'http://localhost:11434',
  model: 'translategemma:4b',
  sourceLanguage: 'en',
  targetLanguage: 'pt-BR',
};

interface Tab {
  readonly tabId: number;
  readonly documentId: string;
}

const senderOf = (tab: Tab): PortSenderLike => ({
  id: RUNTIME_ID,
  url: `https://example.com/novel/tab-${String(tab.tabId)}`,
  frameId: 0,
  documentId: tab.documentId,
  documentLifecycle: 'active',
  tab: { id: tab.tabId },
});

interface Envelope {
  readonly type?: unknown;
  readonly unitId?: unknown;
  readonly text?: unknown;
  readonly ok?: unknown;
  readonly error?: unknown;
}

interface PortPair {
  readonly content: PortLike;
  readonly worker: PortLike;
  /** Mensagens já entregues, por direção, na ordem de entrega. */
  readonly toWorker: Envelope[];
  readonly toContent: Envelope[];
  /** Maior número de unidades enviadas pelo content ainda sem resultado entregue. */
  maxOutstanding(): number;
  /** Entregas agendadas ainda não feitas. */
  pending(): number;
}

function createPortPair(sender: PortSenderLike): PortPair {
  type Side = {
    readonly messageListeners: Set<(message: unknown) => void>;
    readonly disconnectListeners: Set<() => void>;
  };
  const sides: Record<'content' | 'worker', Side> = {
    content: { messageListeners: new Set(), disconnectListeners: new Set() },
    worker: { messageListeners: new Set(), disconnectListeners: new Set() },
  };
  let closed = false;
  let scheduled = 0;
  let outstanding = 0;
  let maxOutstanding = 0;
  const toWorker: Envelope[] = [];
  const toContent: Envelope[] = [];

  const deliver = (target: 'content' | 'worker', message: unknown): void => {
    // Serialização como a do Chrome: o outro lado nunca recebe a mesma referência.
    const wire = JSON.stringify(message);
    scheduled += 1;
    setTimeout(() => {
      scheduled -= 1;
      if (closed) return;
      const copy = JSON.parse(wire) as Envelope;
      if (target === 'worker') {
        toWorker.push(copy);
      } else {
        toContent.push(copy);
        if (copy.type === 'job:result') outstanding -= 1;
      }
      for (const listener of [...sides[target].messageListeners]) listener(copy);
    }, 0);
  };

  const close = (other: 'content' | 'worker'): void => {
    if (closed) return;
    closed = true;
    scheduled += 1;
    setTimeout(() => {
      scheduled -= 1;
      for (const listener of [...sides[other].disconnectListeners]) listener();
    }, 0);
  };

  const makePort = (self: 'content' | 'worker'): PortLike => {
    const other = self === 'content' ? 'worker' : 'content';
    return {
      name: PAGE_JOB_PORT_NAME,
      ...(self === 'worker' ? { sender } : {}),
      postMessage(message) {
        if (closed) throw new Error('Attempting to use a disconnected port object');
        if (self === 'content' && (message as Envelope).type === 'job:unit') {
          outstanding += 1;
          maxOutstanding = Math.max(maxOutstanding, outstanding);
        }
        deliver(other, message);
      },
      disconnect() {
        close(other);
      },
      onMessage: {
        addListener: (listener) => sides[self].messageListeners.add(listener),
        removeListener: (listener) => sides[self].messageListeners.delete(listener),
      },
      onDisconnect: {
        addListener: (listener) => sides[self].disconnectListeners.add(listener),
        removeListener: (listener) => sides[self].disconnectListeners.delete(listener),
      },
    };
  };

  return {
    content: makePort('content'),
    worker: makePort('worker'),
    toWorker,
    toContent,
    maxOutstanding: () => maxOutstanding,
    pending: () => scheduled,
  };
}

interface PendingCall {
  readonly input: TranslationInput;
  readonly resolve: (result: TranslationResult) => void;
}

/** Provedor controlado: cada chamada fica pendente até o teste resolver. */
function createFakeProvider() {
  const calls: PendingCall[] = [];
  let active = 0;
  let maxActive = 0;
  const provider: TranslationProvider = {
    translate: (input) =>
      new Promise<TranslationResult>((resolvePromise) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push({
          input,
          resolve: (result) => {
            active -= 1;
            resolvePromise(result);
          },
        });
      }),
  };
  return { provider, calls, maxActive: () => maxActive, active: () => active };
}

type FakeProvider = ReturnType<typeof createFakeProvider>;

const ok = (text: string): TranslationResult => ({ ok: true, text, durationMs: 1 });
const identity = (text: string): string => text;

interface Wired {
  readonly runner: JobRunner;
  readonly document: Document;
  readonly states: JobState[];
  readonly pairs: PortPair[];
}

const JOB_IDS = [
  '00000000-0000-4000-8000-00000000000a',
  '00000000-0000-4000-8000-00000000000b',
  '00000000-0000-4000-8000-00000000000c',
];
let nextJobId = 0;

/** Um runner real, numa "aba", cujas Ports chegam ao `onConnect` do worker real. */
function wireTab(tab: Tab, document: Document, onConnect: (port: PortLike) => void): Wired {
  const pairs: PortPair[] = [];
  const states: JobState[] = [];
  const runner = createJobRunner({
    root: document,
    connect: () => {
      const pair = createPortPair(senderOf(tab));
      pairs.push(pair);
      onConnect(pair.worker);
      return pair.content;
    },
    randomUUID: () => JOB_IDS[nextJobId++] as string,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as Parameters<typeof clearInterval>[0]),
    measure: () => ({ top: 0, bottom: 20, width: 100, height: 20 }),
    viewportHeight: () => 600,
    clock: () => Number.NaN,
    maxInFlight: WINDOW,
    onState: (state) => states.push(state),
  });
  return { runner, document, states, pairs };
}

function createWorker(gate: TranslationGate, provider: FakeProvider, tabs: readonly Tab[]) {
  return createPageJobHandler({
    runtimeId: RUNTIME_ID,
    isInjectedDocument: (tabId, documentId) =>
      tabs.some((tab) => tab.tabId === tabId && tab.documentId === documentId),
    loadSettings: () => Promise.resolve(SETTINGS),
    createProvider: () => provider.provider,
    gate,
    maxUnitsPerPort: WINDOW,
    now: () => 0,
  });
}

/** Roda entregas e microtarefas até não restar nada agendado nas Ports. */
async function flush(pairs: () => readonly PortPair[]): Promise<void> {
  for (let round = 0; round < 1000; round += 1) {
    await vi.advanceTimersByTimeAsync(1);
    if (pairs().every((pair) => pair.pending() === 0)) {
      // Uma volta extra para as microtarefas disparadas pela última entrega.
      await vi.advanceTimersByTimeAsync(1);
      if (pairs().every((pair) => pair.pending() === 0)) return;
    }
  }
  throw new Error('as Ports não esvaziaram');
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const serialize = (document: Document): string => new XMLSerializer().serializeToString(document);

/** Referência sem transporte: planeja e aplica cada segmento no mesmo processo. */
function applyInProcess(html: string, translate: (text: string) => string): string {
  const document = parse(html);
  const applier = createPageApplier();
  for (const segment of segmentTextNodes(collectTextNodes(document))) {
    let plan = applier.plan(segment);
    while (!('skipped' in plan)) {
      const results = new Map(plan.units.map((unit) => [unit.unitId, translate(unit.text)]));
      const result = applier.apply(plan.segmentId, results);
      if (result.ok || result.fallback === undefined) break;
      plan = result.fallback;
    }
  }
  return serialize(document);
}

const TAB_A: Tab = { tabId: 7, documentId: 'DOC-7' };
const TAB_B: Tab = { tabId: 8, documentId: 'DOC-8' };

beforeEach(() => {
  vi.useFakeTimers();
  nextJobId = 0;
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('job-runner ↔ page-job, janela 2 nos dois lados', () => {
  it('resultados em rajada: nenhum busy, no máximo 2 em voo, termina translated', async () => {
    const provider = createFakeProvider();
    const gate = createTranslationGate(2);
    const worker = createWorker(gate, provider, [TAB_A]);
    const paragraphs = Array.from(
      { length: 9 },
      (_, index) => `<p>Line number ${String(index)}.</p>`,
    );
    const tab = wireTab(TAB_A, parse(`<body>${paragraphs.join('')}</body>`), worker);
    const all = (): readonly PortPair[] => tab.pairs;

    tab.runner.start();
    await flush(all);
    expect(provider.calls).toHaveLength(2);

    // Rajada: as duas traduções em voo terminam na mesma volta, várias vezes.
    while (provider.active() > 0) {
      for (const call of provider.calls.slice(-provider.active())) {
        call.resolve(ok(call.input.text.toUpperCase()));
      }
      await flush(all);
      expect(provider.active()).toBeLessThanOrEqual(WINDOW);
    }

    const [pair] = tab.pairs;
    if (pair === undefined) throw new Error('sem port');
    expect(pair.toContent.filter((message) => message.error === 'busy')).toEqual([]);
    expect(pair.toContent.every((message) => message.ok !== false)).toBe(true);
    expect(pair.maxOutstanding()).toBe(WINDOW);
    expect(provider.maxActive()).toBe(WINDOW);
    expect(gate.inUse).toBe(0);
    expect(gate.waiting).toBe(0);
    expect(provider.calls).toHaveLength(9);
    expect(tab.runner.getState()).toEqual({
      status: 'translated',
      view: 'translation',
      total: 9,
      done: 9,
      failed: 0,
      skipped: 0,
    });
    expect(tab.states.some((state) => state.status === 'error')).toBe(false);
    expect(tab.document.body.textContent).toBe(
      Array.from({ length: 9 }, (_, index) => `LINE NUMBER ${String(index)}.`).join(''),
    );
  });

  it('ida e volta byte a byte pelas Ports, igual ao applier direto, e restaura o original', async () => {
    const provider = createFakeProvider();
    const gate = createTranslationGate(2);
    const worker = createWorker(gate, provider, [TAB_A]);
    const document = parse(FIXTURE_HTML);
    const before = serialize(document);
    const tab = wireTab(TAB_A, document, worker);
    const all = (): readonly PortPair[] => tab.pairs;

    tab.runner.start();
    await flush(all);
    for (let resolved = 0; resolved < provider.calls.length; resolved += 1) {
      const call = provider.calls[resolved] as PendingCall;
      call.resolve(ok(identity(call.input.text)));
      await flush(all);
    }

    const [pair] = tab.pairs;
    if (pair === undefined) throw new Error('sem port');
    const sentUnits = pair.toWorker.filter((message) => message.type === 'job:unit');
    expect(sentUnits.length).toBeGreaterThan(WINDOW);
    expect(provider.calls.map((call) => call.input.text)).toEqual(
      sentUnits.map((unit) => unit.text),
    );
    const results = pair.toContent.filter((message) => message.type === 'job:result');
    expect(results.map((result) => result.text)).toEqual(
      provider.calls.map((call) => call.input.text),
    );
    expect(pair.toContent.filter((message) => message.error === 'busy')).toEqual([]);
    expect(pair.maxOutstanding()).toBeLessThanOrEqual(WINDOW);
    expect(tab.runner.getState()).toMatchObject({ status: 'translated', failed: 0 });
    // O applier colapsa espaços do texto do segmento, então a identidade não
    // devolve o HTML original byte a byte; devolve o mesmo que o applier
    // aplicando a identidade direto, sem Ports nem service worker.
    expect(serialize(document)).toBe(applyInProcess(FIXTURE_HTML, identity));

    tab.runner.showOriginal();
    expect(serialize(document)).toBe(before);
  });

  it('duas abas, semáforo 1: provedor um por vez, em ordem FIFO de chegada', async () => {
    const provider = createFakeProvider();
    const gate = createTranslationGate(1);
    const worker = createWorker(gate, provider, [TAB_A, TAB_B]);
    const pageOf = (name: string): Document =>
      parse(
        `<body>${['one', 'two', 'three', 'four'].map((n) => `<p>${name} ${n}.</p>`).join('')}</body>`,
      );
    const tabA = wireTab(TAB_A, pageOf('Alpha'), worker);
    const tabB = wireTab(TAB_B, pageOf('Bravo'), worker);
    const all = (): readonly PortPair[] => [...tabA.pairs, ...tabB.pairs];

    tabA.runner.start();
    tabB.runner.start();
    await flush(all);
    expect(provider.calls).toHaveLength(1);
    expect(gate.waiting).toBe(3);

    // Resolve sempre a única tradução ativa; cada resultado devolve uma vaga
    // à aba, cuja próxima unidade entra no fim da fila do semáforo.
    while (provider.active() > 0) {
      expect(provider.active()).toBe(1);
      const current = provider.calls[provider.calls.length - 1] as PendingCall;
      current.resolve(ok(current.input.text.toUpperCase()));
      await flush(all);
    }

    expect(provider.maxActive()).toBe(1);
    expect(provider.calls.map((call) => call.input.text)).toEqual([
      'Alpha one.',
      'Alpha two.',
      'Bravo one.',
      'Bravo two.',
      'Alpha three.',
      'Alpha four.',
      'Bravo three.',
      'Bravo four.',
    ]);
    for (const tab of [tabA, tabB]) {
      const [pair] = tab.pairs;
      if (pair === undefined) throw new Error('sem port');
      expect(pair.toContent.filter((message) => message.error === 'busy')).toEqual([]);
      expect(pair.maxOutstanding()).toBe(WINDOW);
      expect(tab.runner.getState()).toMatchObject({ status: 'translated', done: 4, failed: 0 });
    }
    expect(tabA.document.body.textContent).toBe('ALPHA ONE.ALPHA TWO.ALPHA THREE.ALPHA FOUR.');
    expect(tabB.document.body.textContent).toBe('BRAVO ONE.BRAVO TWO.BRAVO THREE.BRAVO FOUR.');
    expect(gate.inUse).toBe(0);
    expect(gate.waiting).toBe(0);
  });
});
