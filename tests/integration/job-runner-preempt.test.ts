import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createJobRunner, PREEMPT_DEBOUNCE_MS, type JobRunner } from '../../src/content/job-runner';
import type { BlockRect } from '../../src/content/segment-priority';
import type { VisibilityChange, VisibilityZone } from '../../src/content/visibility-watcher';
import { PAGE_JOB_PORT_NAME, type JobUnitMessage } from '../../src/shared/page-messages';
import type { PortLike } from '../../src/shared/port-like';

/**
 * Interrupção de unidade fora da tela quando há visível esperando: observador
 * falso (só emite quando o teste manda), Port falsa e timers falsos.
 */

const JOB_IDS = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];

const VIEWPORT_HEIGHT = 600;
const VISIBLE_RECT: BlockRect = { top: 0, bottom: 20, width: 100, height: 20 };
const BELOW_RECT: BlockRect = { top: 1000, bottom: 1020, width: 100, height: 20 };

/** Bloco com `data-pos="below"` fica abaixo da viewport; o resto é visível. */
const byPosition = (block: Element): BlockRect =>
  block.getAttribute('data-pos') === 'below' ? BELOW_RECT : VISIBLE_RECT;

const upperCase = (text: string): string =>
  text.replace(/<\/?g\d+>|\p{L}+/gu, (match) =>
    match.startsWith('<') ? match : match.toUpperCase(),
  );

const dropMarkers = (text: string): string => upperCase(text.replace(/<\/?g\d+>/gu, ''));

function parse(body: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body>${body}</body></html>`,
    'text/html',
  );
}

interface CancelMessage {
  readonly type: 'job:cancel-unit';
  readonly jobId: string;
  readonly unitId: string;
}

interface FakePort {
  readonly port: PortLike;
  readonly sent: JobUnitMessage[];
  /** `unitId`s dos `job:cancel-unit`, em ordem. */
  readonly cancels: CancelMessage[];
  /** Enviadas sem resultado e sem cancelamento, em ordem de envio. */
  readonly inFlight: JobUnitMessage[];
  emit(message: unknown): void;
  /** Responde a mais antiga em voo. */
  reply(translate: (text: string) => string): void;
  drop(): void;
}

function createFakePort(): FakePort {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const sent: JobUnitMessage[] = [];
  const cancels: CancelMessage[] = [];
  const inFlight: JobUnitMessage[] = [];
  let disconnected = false;
  const emit = (message: unknown): void => {
    for (const listener of [...messageListeners]) listener(message);
  };
  return {
    port: {
      name: PAGE_JOB_PORT_NAME,
      postMessage(message) {
        if (disconnected) throw new Error('Attempting to use a disconnected port object');
        const typed = message as JobUnitMessage | CancelMessage | { type: 'job:ping' };
        if (typed.type === 'job:unit') {
          sent.push(typed);
          inFlight.push(typed);
        } else if (typed.type === 'job:cancel-unit') {
          cancels.push(typed);
          const index = inFlight.findIndex((unit) => unit.unitId === typed.unitId);
          if (index !== -1) inFlight.splice(index, 1);
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
    },
    sent,
    cancels,
    inFlight,
    emit,
    reply(translate) {
      const unit = inFlight.shift();
      if (unit === undefined) throw new Error('nenhuma unidade em voo');
      emit({
        type: 'job:result',
        jobId: unit.jobId,
        unitId: unit.unitId,
        ok: true,
        text: translate(unit.text),
      });
    },
    drop() {
      disconnected = true;
      for (const listener of [...disconnectListeners]) listener();
    },
  };
}

interface FakeWatcher {
  readonly everObserved: Element[];
  readonly unobserved: Element[];
  emit(changes: readonly VisibilityChange[]): void;
}

interface Harness {
  readonly runner: JobRunner;
  readonly port: () => FakePort;
  readonly watcher: () => FakeWatcher;
  /** Timers de interrupção pendentes (armados, nem disparados nem limpos). */
  readonly pendingTimeouts: () => number;
  /** Quantos timers de interrupção foram armados. */
  readonly armed: () => number;
}

interface SetupOptions {
  maxInFlight?: number;
  withTimeout?: boolean;
}

function setup(document: Document, options: SetupOptions = {}): Harness {
  const ports: FakePort[] = [];
  const watchers: FakeWatcher[] = [];
  const pending = new Set<unknown>();
  let armed = 0;
  let nextId = 0;
  const runner = createJobRunner({
    root: document,
    connect: () => {
      const fake = createFakePort();
      ports.push(fake);
      return fake.port;
    },
    randomUUID: () => JOB_IDS[nextId++] as string,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as Parameters<typeof clearInterval>[0]),
    ...(options.withTimeout === false
      ? {}
      : {
          setTimeout: (fn: () => void, ms: number) => {
            armed += 1;
            const id = setTimeout(() => {
              pending.delete(id);
              fn();
            }, ms);
            pending.add(id);
            return id;
          },
          clearTimeout: (id: unknown) => {
            pending.delete(id);
            clearTimeout(id as Parameters<typeof clearTimeout>[0]);
          },
        }),
    measure: byPosition,
    viewportHeight: () => VIEWPORT_HEIGHT,
    clock: () => Number.NaN,
    maxInFlight: options.maxInFlight ?? 1,
    createVisibilityWatcher: (onChange) => {
      const fake: FakeWatcher = {
        everObserved: [],
        unobserved: [],
        emit: (changes) => onChange(changes),
      };
      watchers.push(fake);
      return {
        observe(block: Element) {
          fake.everObserved.push(block);
        },
        unobserve(block: Element) {
          fake.unobserved.push(block);
        },
        disconnect() {},
      };
    },
  });
  const last = <T>(items: T[], what: string): T => {
    const item = items[items.length - 1];
    if (item === undefined) throw new Error(`nenhum ${what}`);
    return item;
  };
  return {
    runner,
    port: () => last(ports, 'porta'),
    watcher: () => last(watchers, 'observador'),
    pendingTimeouts: () => pending.size,
    armed: () => armed,
  };
}

/** `seg-0#text@7` → `seg-0#text`. */
const labelOf = (unitId: string): string => unitId.replace(/@\d+$/u, '');
const labels = (fake: FakePort): string[] => fake.sent.map((unit) => labelOf(unit.unitId));
const segmentsSent = (fake: FakePort): string[] =>
  labels(fake).map((label) => label.replace(/#.*$/u, ''));
const cancelled = (fake: FakePort): string[] =>
  fake.cancels.map((cancel) => labelOf(cancel.unitId));

const blocks = (document: Document): Element[] => [...document.querySelectorAll('p')];

/** Lote com o bloco `index` (entre os `<p>`) na zona dada. */
function changes(document: Document, ...pairs: [number, VisibilityZone][]): VisibilityChange[] {
  const all = blocks(document);
  return pairs.map(([index, zone]) => {
    const block = all[index];
    if (block === undefined) throw new Error(`bloco ${String(index)} não existe`);
    return { block, zone };
  });
}

function runToEnd(fake: FakePort, translate = upperCase): void {
  while (fake.inFlight.length > 0) fake.reply(translate);
}

/** Um visível no topo e `count` parágrafos abaixo da viewport. */
const page = (count: number): string =>
  '<p>Top line.</p>' +
  Array.from(
    { length: count },
    (_, index) => `<p data-pos="below">Line ${String(index + 1)}.</p>`,
  ).join('');

/**
 * Cenário base: seg-0 (visível) respondido, seg-1 (classe 2) em voo, e seg-3
 * entra na tela e espera na classe 0.
 */
function visibleWaitingBehindMain(options: SetupOptions = {}) {
  const document = parse(page(3));
  const harness = setup(document, options);
  harness.runner.start();
  const fake = harness.port();
  fake.reply(upperCase);
  expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1']);
  harness.watcher().emit(changes(document, [3, 'visible']));
  return { document, ...harness, fake };
}

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
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('createJobRunner — interrupção de unidade fora da tela', () => {
  it('PREEMPT_DEBOUNCE_MS é 500', () => {
    expect(PREEMPT_DEBOUNCE_MS).toBe(500);
  });

  it('interrompe a unidade da classe 2 em voo quando um visível espera 500 ms', () => {
    const { runner, fake, pendingTimeouts } = visibleWaitingBehindMain();
    expect(pendingTimeouts()).toBe(1);

    vi.advanceTimersByTime(PREEMPT_DEBOUNCE_MS);
    expect(fake.cancels).toEqual([
      { type: 'job:cancel-unit', jobId: JOB_IDS[0], unitId: fake.sent[1]?.unitId },
    ]);
    // A vaga liberada vai para o visível.
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-3']);
    expect(fake.inFlight.map((unit) => labelOf(unit.unitId))).toEqual(['seg-3#text']);
    expect(pendingTimeouts()).toBe(0);
    expect(runner.getState()).toMatchObject({ status: 'translating', done: 1, failed: 0 });

    runToEnd(fake);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4, failed: 0 });
  });

  it('não interrompe antes de 500 ms', () => {
    const { runner, fake } = visibleWaitingBehindMain();
    vi.advanceTimersByTime(PREEMPT_DEBOUNCE_MS - 1);
    expect(fake.cancels).toEqual([]);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1']);
    vi.advanceTimersByTime(1);
    expect(cancelled(fake)).toEqual(['seg-1#text']);
    runToEnd(fake);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4 });
  });

  it('não interrompe se o visível saiu da classe 0 antes do timer; o timer é limpo', () => {
    const { runner, document, fake, watcher, pendingTimeouts } = visibleWaitingBehindMain();
    vi.advanceTimersByTime(300);
    watcher().emit(changes(document, [3, 'out']));
    expect(pendingTimeouts()).toBe(0);
    vi.advanceTimersByTime(10 * PREEMPT_DEBOUNCE_MS);
    expect(fake.cancels).toEqual([]);
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3']);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4 });
  });

  it('visível enviado antes do timer (a vaga abriu): o timer é limpo e nada é interrompido', () => {
    const { runner, fake, pendingTimeouts } = visibleWaitingBehindMain();
    vi.advanceTimersByTime(200);
    fake.reply(upperCase); // seg-1 termina; seg-3 sai
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-3']);
    expect(pendingTimeouts()).toBe(0);
    vi.advanceTimersByTime(10 * PREEMPT_DEBOUNCE_MS);
    expect(fake.cancels).toEqual([]);
    runToEnd(fake);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4 });
  });

  it('a espera recomeça quando o visível armado sai: o próximo espera 500 ms inteiros', () => {
    const { runner, document, fake, watcher } = visibleWaitingBehindMain();
    vi.advanceTimersByTime(300);
    watcher().emit(changes(document, [2, 'visible']));
    watcher().emit(changes(document, [3, 'out']));
    vi.advanceTimersByTime(PREEMPT_DEBOUNCE_MS - 1);
    expect(fake.cancels).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(cancelled(fake)).toEqual(['seg-1#text']);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-2']);
    runToEnd(fake);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4 });
  });

  it('não interrompe unidade cujo segmento está na classe 1 agora', () => {
    // Vale a classe ATUAL, não a do envio: seg-1 saiu na classe 1 e segue
    // perto (nenhuma zona nova), então é o que o leitor lê em seguida. Se
    // ele sair para `out`, passa a ser interrompível (teste abaixo).
    const document = parse(page(4));
    const { runner, port, watcher, armed } = setup(document);
    runner.start();
    const fake = port();
    watcher().emit(changes(document, [1, 'near']));
    fake.reply(upperCase); // seg-0; seg-1 sai na classe 1
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1']);
    watcher().emit(changes(document, [4, 'visible']));
    vi.advanceTimersByTime(10 * PREEMPT_DEBOUNCE_MS);
    expect(fake.cancels).toEqual([]);
    expect(armed()).toBe(0);
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-4', 'seg-2', 'seg-3']);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 5 });
  });

  it('interrompe unidade enviada na classe 1 cujo segmento foi para fora da tela', () => {
    const document = parse(page(4));
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    watcher().emit(changes(document, [1, 'near']));
    fake.reply(upperCase); // seg-0; seg-1 sai na classe 1
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1']);
    // Rolagem: seg-1 (todo em voo) sai da faixa perto; seg-4 entra na tela.
    watcher().emit(changes(document, [1, 'out']));
    watcher().emit(changes(document, [4, 'visible']));
    vi.advanceTimersByTime(PREEMPT_DEBOUNCE_MS - 1);
    expect(fake.cancels).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(cancelled(fake)).toEqual(['seg-1#text']);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-4']);
    runToEnd(fake);
    // Grupo novo na frente da classe 2 (a atual), antes de seg-2 e seg-3.
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-4', 'seg-1', 'seg-2', 'seg-3']);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 5, failed: 0 });
    expect(document.body.textContent).toBe('TOP LINE.LINE 1.LINE 2.LINE 3.LINE 4.');
  });

  it.each([
    ['perto (classe 1)', 'near'],
    ['na tela (classe 0)', 'visible'],
  ] as const)(
    'não interrompe unidade enviada na classe 2 cujo segmento subiu para %s',
    (_name, zone) => {
      const document = parse(page(3));
      const { runner, port, watcher, armed } = setup(document);
      runner.start();
      const fake = port();
      fake.reply(upperCase);
      expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1']);
      // seg-1 está todo em voo: a zona nova só muda a classe atual dele.
      watcher().emit(changes(document, [1, zone]));
      watcher().emit(changes(document, [3, 'visible']));
      vi.advanceTimersByTime(10 * PREEMPT_DEBOUNCE_MS);
      expect(fake.cancels).toEqual([]);
      expect(armed()).toBe(0);
      runToEnd(fake);
      expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-3', 'seg-2']);
      expect(runner.getState()).toMatchObject({ status: 'translated', done: 4, failed: 0 });
    },
  );

  it('subiu e voltou para fora: interrompível de novo pela classe atual', () => {
    const document = parse(page(3));
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    fake.reply(upperCase);
    watcher().emit(changes(document, [1, 'visible']));
    watcher().emit(changes(document, [3, 'visible']));
    vi.advanceTimersByTime(PREEMPT_DEBOUNCE_MS);
    expect(fake.cancels).toEqual([]);
    // seg-1 passou pelo topo (visible → out): classe 2 de novo.
    watcher().emit(changes(document, [1, 'out']));
    vi.advanceTimersByTime(PREEMPT_DEBOUNCE_MS);
    expect(cancelled(fake)).toEqual(['seg-1#text']);
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-3', 'seg-1', 'seg-2']);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4, failed: 0 });
  });

  it('janela 2: a interrupção fica desligada e nunca envia job:cancel-unit', () => {
    // Com janela > 1 o resultado atrasado da tentativa abortada poderia
    // fechar o reenvio (mesmo `unitId`): nada é interrompido nem armado.
    const document = parse(
      '<p>Top.</p><p data-pos="below">Far <i>away</i> text.</p>' +
        Array.from({ length: 4 }, (_, i) => `<p data-pos="below">Line ${String(i)}.</p>`).join(''),
    );
    const { runner, port, watcher, armed } = setup(document, { maxInFlight: 2 });
    runner.start();
    const fake = port();
    fake.reply(upperCase); // seg-0; seg-2 sai (seg-1 e seg-2 em voo, classe 2)
    expect(fake.inFlight.map((unit) => labelOf(unit.unitId))).toEqual([
      'seg-1#markers',
      'seg-2#text',
    ]);
    watcher().emit(changes(document, [5, 'visible']));
    vi.advanceTimersByTime(10 * PREEMPT_DEBOUNCE_MS);
    fake.reply(dropMarkers); // seg-1 → fallback; node-0 sai
    watcher().emit(changes(document, [4, 'visible']));
    vi.advanceTimersByTime(10 * PREEMPT_DEBOUNCE_MS);
    runToEnd(fake);
    expect(fake.cancels).toEqual([]);
    expect(armed()).toBe(0);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 6, failed: 0 });
  });

  it('nunca interrompe unidade enviada na classe 0', () => {
    const document = parse('<p>One.</p><p>Two.</p><p>Three.</p>');
    const { runner, port, armed } = setup(document);
    runner.start();
    const fake = port();
    expect(segmentsSent(fake)).toEqual(['seg-0']);
    vi.advanceTimersByTime(10 * PREEMPT_DEBOUNCE_MS);
    expect(fake.cancels).toEqual([]);
    expect(armed()).toBe(0);
    runToEnd(fake);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 3 });
  });

  it('não interrompe unidade cujo segmento subiu para a classe 0 depois do envio', () => {
    // seg-1 (nó a nó, classe 2) tem uma unidade em voo e a outra na fila; o
    // segmento entra na tela: interromper a unidade dele seria perder leitura.
    const document = parse(
      '<p>Top.</p><p data-pos="below">Far<!-- c --> away.</p><p data-pos="below">Two.</p>',
    );
    const { runner, port, watcher, armed } = setup(document);
    runner.start();
    const fake = port();
    fake.reply(upperCase);
    expect(labels(fake)).toEqual(['seg-0#text', 'seg-1#node-0']);
    watcher().emit(changes(document, [1, 'visible']));
    vi.advanceTimersByTime(10 * PREEMPT_DEBOUNCE_MS);
    expect(fake.cancels).toEqual([]);
    expect(armed()).toBe(0);
    runToEnd(fake);
    expect(labels(fake)).toEqual(['seg-0#text', 'seg-1#node-0', 'seg-1#node-1', 'seg-2#text']);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 3, failed: 0 });
  });

  it('no máximo uma interrupção por unidade: o reenvio termina normalmente', () => {
    const { runner, document, fake, watcher, armed } = visibleWaitingBehindMain();
    vi.advanceTimersByTime(PREEMPT_DEBOUNCE_MS);
    expect(cancelled(fake)).toEqual(['seg-1#text']);
    fake.reply(upperCase); // seg-3; seg-1 é reenviada
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-3', 'seg-1']);
    const armedBefore = armed();

    watcher().emit(changes(document, [2, 'visible']));
    vi.advanceTimersByTime(10 * PREEMPT_DEBOUNCE_MS);
    expect(cancelled(fake)).toEqual(['seg-1#text']);
    expect(armed()).toBe(armedBefore);
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-3', 'seg-1', 'seg-2']);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4, failed: 0 });
  });

  it('a interrompida volta à frente da classe e é reenviada depois do visível', () => {
    const document = parse(page(4));
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    fake.reply(upperCase);
    watcher().emit(changes(document, [4, 'visible']));
    vi.advanceTimersByTime(PREEMPT_DEBOUNCE_MS);
    runToEnd(fake);
    // seg-1 reenviada à frente de seg-2 e seg-3 (classe 2), depois de seg-4.
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-4', 'seg-1', 'seg-2', 'seg-3']);
    expect(fake.sent[1]?.unitId).toBe(fake.sent[3]?.unitId);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 5, failed: 0 });
    expect(document.body.textContent).toBe('TOP LINE.LINE 1.LINE 2.LINE 3.LINE 4.');
  });

  it('com o grupo ainda na fila, a interrompida entra à frente das irmãs, em ordem', () => {
    const document = parse(
      '<p>Top.</p><p data-pos="below">Far <i>away</i> text.</p>' +
        '<p data-pos="below">Two.</p><p data-pos="below">Three.</p>',
    );
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    fake.reply(upperCase);
    fake.reply(dropMarkers); // fallback de seg-1 na frente da classe 2; node-0 sai
    expect(labels(fake)).toEqual(['seg-0#text', 'seg-1#markers', 'seg-1#node-0']);
    watcher().emit(changes(document, [3, 'visible']));
    vi.advanceTimersByTime(PREEMPT_DEBOUNCE_MS);
    expect(cancelled(fake)).toEqual(['seg-1#node-0']);
    runToEnd(fake);
    expect(labels(fake)).toEqual([
      'seg-0#text',
      'seg-1#markers',
      'seg-1#node-0',
      'seg-3#text',
      'seg-1#node-0',
      'seg-1#node-1',
      'seg-1#node-2',
      'seg-2#text',
    ]);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4, failed: 0 });
    expect(document.body.textContent).toBe('TOP.FAR AWAY TEXT.TWO.THREE.');
    expect(document.querySelector('i')?.textContent).toBe('AWAY');
  });

  it('fallback na classe 2 que entra na tela sobe para a classe 0 e não é interrompido', () => {
    const document = parse(
      '<p>Top.</p><p data-pos="below">Far <i>away</i> text.</p>' +
        '<p data-pos="below">Two.</p><p data-pos="below">Three.</p>',
    );
    const { runner, port, watcher, armed, pendingTimeouts } = setup(document);
    runner.start();
    const fake = port();
    const seg1Block = blocks(document)[1] as Element;
    fake.reply(upperCase);
    fake.reply(dropMarkers); // fallback de seg-1 na frente da classe 2; node-0 sai
    expect(labels(fake)).toEqual(['seg-0#text', 'seg-1#markers', 'seg-1#node-0']);
    // O bloco segue observado com o fallback na fila (sem observação nova).
    expect(watcher().unobserved).not.toContain(seg1Block);
    expect(watcher().everObserved.filter((block) => block === seg1Block)).toHaveLength(1);

    // seg-3 entra na tela: node-0 (classe 2) é interrompível, o timer arma.
    watcher().emit(changes(document, [3, 'visible']));
    expect(armed()).toBe(1);
    vi.advanceTimersByTime(300);
    // O fallback entra na tela: o grupo sobe para o fim da classe 0 e node-0
    // deixa de ser interrompível; o timer é limpo.
    watcher().emit(changes(document, [1, 'visible']));
    expect(pendingTimeouts()).toBe(0);
    watcher().emit(changes(document, [2, 'near']));
    vi.advanceTimersByTime(10 * PREEMPT_DEBOUNCE_MS);
    expect(fake.cancels).toEqual([]);
    expect(armed()).toBe(1);

    runToEnd(fake);
    // Classe 0 (seg-3, depois o fallback) antes da classe 1 (seg-2).
    expect(labels(fake)).toEqual([
      'seg-0#text',
      'seg-1#markers',
      'seg-1#node-0',
      'seg-3#text',
      'seg-1#node-1',
      'seg-1#node-2',
      'seg-2#text',
    ]);
    expect(watcher().unobserved.filter((block) => block === seg1Block)).toHaveLength(1);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4, failed: 0 });
    expect(document.body.textContent).toBe('TOP.FAR AWAY TEXT.TWO.THREE.');
  });

  it('fallback na classe 0 que sai da tela deixa de contar como visível esperando', () => {
    const document = parse(
      '<p>Far <i>away</i> text.</p><p data-pos="below">Two.</p><p data-pos="below">Three.</p>',
    );
    const { runner, port, watcher, armed } = setup(document);
    runner.start();
    const fake = port();
    const seg0Block = blocks(document)[0] as Element;
    // Primeira zona do observador: confirma a medição (classe 0).
    watcher().emit(changes(document, [0, 'visible']));
    fake.reply(dropMarkers); // fallback na frente da classe 0; node-0 sai
    expect(labels(fake)).toEqual(['seg-0#markers', 'seg-0#node-0']);
    // Sem evento novo do observador o fallback não é rebaixado: o bloco não
    // foi observado de novo e não há "primeira zona" a reinterpretar.
    expect(watcher().everObserved.filter((block) => block === seg0Block)).toHaveLength(1);
    expect(watcher().unobserved).not.toContain(seg0Block);
    expect(armed()).toBe(0);

    watcher().emit(changes(document, [2, 'near']));
    // Passou pelo topo: o fallback vai para o fim da classe 2 e node-0 fica
    // interrompível, mas não resta visível esperando: nada é armado.
    watcher().emit(changes(document, [0, 'out']));
    vi.advanceTimersByTime(10 * PREEMPT_DEBOUNCE_MS);
    expect(fake.cancels).toEqual([]);
    expect(armed()).toBe(0);

    runToEnd(fake);
    expect(labels(fake)).toEqual([
      'seg-0#markers',
      'seg-0#node-0',
      'seg-2#text',
      'seg-1#text',
      'seg-0#node-1',
      'seg-0#node-2',
    ]);
    expect(watcher().unobserved.filter((block) => block === seg0Block)).toHaveLength(1);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 3, failed: 0 });
    expect(document.body.textContent).toBe('FAR AWAY TEXT.TWO.THREE.');
  });

  it('resultado atrasado da interrompida é ignorado até o reenvio', () => {
    const { runner, document, fake } = visibleWaitingBehindMain();
    vi.advanceTimersByTime(PREEMPT_DEBOUNCE_MS);
    const cancelledId = fake.cancels[0]?.unitId;
    expect(labelOf(cancelledId ?? '')).toBe('seg-1#text');
    const before = runner.getState();

    fake.emit({
      type: 'job:result',
      jobId: JOB_IDS[0],
      unitId: cancelledId,
      ok: true,
      text: 'LATE',
    });
    fake.emit({
      type: 'job:result',
      jobId: JOB_IDS[0],
      unitId: cancelledId,
      ok: false,
      error: 'cancelled',
      retryable: false,
    });
    expect(runner.getState()).toEqual(before);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-3']);
    expect(blocks(document)[1]?.textContent).toBe('Line 1.');

    runToEnd(fake);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4, failed: 0 });
    expect(document.body.textContent).toBe('TOP LINE.LINE 1.LINE 2.LINE 3.');
  });

  it('o bloco segue observado em voo e na volta à fila; sai só ao aplicar', () => {
    const { runner, document, fake, watcher } = visibleWaitingBehindMain({ maxInFlight: 1 });
    const seg1Block = blocks(document)[1] as Element;
    const timesObserved = (): number =>
      watcher().everObserved.filter((block) => block === seg1Block).length;
    // Em voo desde o envio de seg-1: observado uma vez só, nunca liberado.
    expect(timesObserved()).toBe(1);
    expect(watcher().unobserved).not.toContain(seg1Block);
    vi.advanceTimersByTime(PREEMPT_DEBOUNCE_MS);
    expect(timesObserved()).toBe(1);
    expect(watcher().unobserved).not.toContain(seg1Block);
    // seg-2 vai para a classe 1; seg-1 entra na tela e passa à frente dele.
    watcher().emit(changes(document, [2, 'near']));
    watcher().emit(changes(document, [1, 'visible']));
    fake.reply(upperCase); // seg-3; seg-1 é reenviada
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-3', 'seg-1']);
    expect(watcher().unobserved).not.toContain(seg1Block);
    fake.reply(upperCase); // seg-1 aplicado
    expect(watcher().unobserved.filter((block) => block === seg1Block)).toHaveLength(1);
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-3', 'seg-1', 'seg-2']);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4 });
  });

  it('sem setTimeout nas dependências, nada é interrompido', () => {
    const { runner, fake } = visibleWaitingBehindMain({ withTimeout: false });
    vi.advanceTimersByTime(10 * PREEMPT_DEBOUNCE_MS);
    expect(fake.cancels).toEqual([]);
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-3', 'seg-2']);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4 });
  });

  const terminations: [string, (harness: ReturnType<typeof visibleWaitingBehindMain>) => void][] = [
    ['cancel', ({ runner }) => runner.cancel()],
    ['showOriginal', ({ runner }) => runner.showOriginal()],
    ['dispose', ({ runner }) => runner.dispose()],
    [
      'job:fatal',
      ({ fake }) => fake.emit({ type: 'job:fatal', jobId: JOB_IDS[0], error: 'network' }),
    ],
    ['desconexão', ({ fake }) => fake.drop()],
    [
      'novo start',
      ({ runner, port }) => {
        runner.start();
        runner.cancel();
        expect(port().cancels).toEqual([]);
      },
    ],
  ];

  it.each(terminations)('timer limpo no término por %s', (_name, terminate) => {
    const harness = visibleWaitingBehindMain();
    expect(harness.pendingTimeouts()).toBe(1);
    terminate(harness);
    expect(harness.pendingTimeouts()).toBe(0);
    vi.advanceTimersByTime(10 * PREEMPT_DEBOUNCE_MS);
    expect(harness.fake.cancels).toEqual([]);
  });

  it('timer limpo no fim normal (translated)', () => {
    const { runner, fake, pendingTimeouts } = visibleWaitingBehindMain();
    vi.advanceTimersByTime(PREEMPT_DEBOUNCE_MS);
    runToEnd(fake);
    expect(runner.getState()).toMatchObject({ status: 'translated' });
    expect(pendingTimeouts()).toBe(0);
  });
});
