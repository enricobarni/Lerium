import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  createJobRunner,
  PREEMPT_DEBOUNCE_MS,
  type JobRunner,
  type JobState,
  type SegmentZoneChange,
} from '../../src/content/job-runner';
import type { BlockRect } from '../../src/content/segment-priority';
import type { SegmentZoneTracker } from '../../src/content/segment-zone-tracker';
import type { TranslationSegment } from '../../src/content/segmenter';
import type { VisibilityChange, VisibilityZone } from '../../src/content/visibility-watcher';
import { PAGE_JOB_PORT_NAME, type JobUnitMessage } from '../../src/shared/page-messages';
import type { PortLike } from '../../src/shared/port-like';

/**
 * Executor com o rastreador de zona por trecho: observador e rastreador são
 * falsos e só emitem quando o teste manda, como os reais (assíncronos).
 */

const JOB_IDS = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];

const VIEWPORT_HEIGHT = 600;
const VISIBLE_RECT: BlockRect = { top: 0, bottom: 20, width: 100, height: 20 };
const BELOW_RECT: BlockRect = { top: 1000, bottom: 1020, width: 100, height: 20 };

/** Bloco com `data-pos="below"` fica abaixo da viewport; o resto é visível. */
const byPosition = (block: Element): BlockRect =>
  block.getAttribute('data-pos') === 'below' ? BELOW_RECT : VISIBLE_RECT;

/** Trecho `R01`/`R02` está na tela no `start`; os demais, abaixo dela. */
const bySegmentMarker = (segment: TranslationSegment): BlockRect =>
  /^\s*R0[12]\b/u.test(segment.text) ? VISIBLE_RECT : BELOW_RECT;

const upperCase = (text: string): string =>
  text.replace(/<\/?g\d+>|\p{L}+/gu, (match) =>
    match.startsWith('<') ? match : match.toUpperCase(),
  );

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
  readonly cancels: CancelMessage[];
  readonly inFlight: JobUnitMessage[];
  emit(message: unknown): void;
  reply(translate?: (text: string) => string): void;
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
    reply(translate = upperCase) {
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
  readonly observed: Set<Element>;
  disconnects: number;
  emit(changes: readonly VisibilityChange[]): void;
}

interface FakeTracker {
  /** Cada `track`: bloco e `segmentId`s em ordem. */
  readonly tracks: { block: Element; ids: string[] }[];
  readonly gates: { block: Element; zone: VisibilityZone }[];
  readonly invalidated: Element[];
  readonly untracked: string[];
  disconnects: number;
  /** Entrega um lote ao executor, mesmo depois de `disconnect` (evento atrasado). */
  emit(changes: readonly SegmentZoneChange[]): void;
}

interface Harness {
  readonly runner: JobRunner;
  readonly states: JobState[];
  readonly trackers: FakeTracker[];
  readonly watchers: FakeWatcher[];
  readonly measured: () => number;
  readonly measuredSegments: () => number;
  readonly port: () => FakePort;
  readonly watcher: () => FakeWatcher;
  readonly tracker: () => FakeTracker;
  readonly advance: (ms: number) => void;
}

interface SetupOptions {
  withWatcher?: boolean;
  withTracker?: boolean;
  withMeasureSegment?: boolean;
}

function setup(document: Document, options: SetupOptions = {}): Harness {
  const ports: FakePort[] = [];
  const watchers: FakeWatcher[] = [];
  const trackers: FakeTracker[] = [];
  const states: JobState[] = [];
  let measured = 0;
  let measuredSegments = 0;
  let now = 1000;
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
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as Parameters<typeof clearTimeout>[0]),
    measure: (block) => {
      measured += 1;
      return byPosition(block);
    },
    ...(options.withMeasureSegment === false
      ? {}
      : {
          measureSegment: (segment: TranslationSegment) => {
            measuredSegments += 1;
            return bySegmentMarker(segment);
          },
        }),
    viewportHeight: () => VIEWPORT_HEIGHT,
    clock: () => now,
    maxInFlight: 1,
    ...(options.withWatcher === false
      ? {}
      : {
          createVisibilityWatcher: (onChange: (changes: readonly VisibilityChange[]) => void) => {
            const fake: FakeWatcher = {
              observed: new Set(),
              disconnects: 0,
              emit: (changes) => onChange(changes),
            };
            watchers.push(fake);
            return {
              observe: (block: Element) => fake.observed.add(block),
              unobserve: (block: Element) => fake.observed.delete(block),
              disconnect() {
                fake.observed.clear();
                fake.disconnects += 1;
              },
            };
          },
        }),
    ...(options.withTracker === false
      ? {}
      : {
          createSegmentZoneTracker: (
            onChange: (changes: readonly SegmentZoneChange[]) => void,
          ): SegmentZoneTracker => {
            const fake: FakeTracker = {
              tracks: [],
              gates: [],
              invalidated: [],
              untracked: [],
              disconnects: 0,
              emit: (changes) => onChange(changes),
            };
            trackers.push(fake);
            return {
              track: (block, segments) =>
                fake.tracks.push({ block, ids: segments.map((s) => s.segmentId) }),
              setBlockZone: (block, zone) => fake.gates.push({ block, zone }),
              invalidate: (block) => fake.invalidated.push(block),
              untrack: (segmentId) => fake.untracked.push(segmentId),
              disconnect: () => {
                fake.disconnects += 1;
              },
            };
          },
        }),
    onState: (state) => states.push(state),
  });
  const last = <T>(items: T[], what: string): T => {
    const item = items[items.length - 1];
    if (item === undefined) throw new Error(`nenhum ${what}`);
    return item;
  };
  return {
    runner,
    states,
    trackers,
    watchers,
    measured: () => measured,
    measuredSegments: () => measuredSegments,
    port: () => last(ports, 'porta'),
    watcher: () => last(watchers, 'observador'),
    tracker: () => last(trackers, 'rastreador'),
    advance: (ms) => {
      now += ms;
    },
  };
}

const segmentsSent = (fake: FakePort): string[] =>
  fake.sent.map((unit) => unit.unitId.replace(/#.*$/u, ''));

function runToEnd(fake: FakePort): void {
  while (fake.inFlight.length > 0) fake.reply();
}

/** Capítulo num único `<div>` separado por `<br>`: seg-0..seg-4 = R01, R02, R03, R20, R21. */
const CHAPTER =
  '<div id="chapter">R01 one.<br>R02 two.<br>R03 three.<br>R20 twenty.<br>R21 more.</div>';

const chapterOf = (document: Document): Element => {
  const chapter = document.getElementById('chapter');
  if (chapter === null) throw new Error('sem capítulo');
  return chapter;
};

const zones = (...pairs: [string, VisibilityZone][]): SegmentZoneChange[] =>
  pairs.map(([segmentId, zone]) => ({ segmentId, zone }));

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

describe('createJobRunner — rastreador de zona por trecho', () => {
  it('classifica por trecho e cria um rastreador para o bloco compartilhado', () => {
    const document = parse(CHAPTER);
    const { runner, port, trackers, watcher, measured, measuredSegments } = setup(document);
    runner.start();
    expect(measuredSegments()).toBe(5);
    expect(measured()).toBe(0);
    expect(trackers).toHaveLength(1);
    expect([...watcher().observed]).toEqual([chapterOf(document)]);
    // Sem zona do observador ainda, nada vai ao rastreador.
    expect(trackers[0]?.tracks).toEqual([]);
    expect(trackers[0]?.gates).toEqual([]);
    runToEnd(port());
    expect(segmentsSent(port())).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3', 'seg-4']);
  });

  it('a zona do bloco vira portão do rastreador e não é espalhada para os segmentos', () => {
    const document = parse(CHAPTER);
    const { runner, port, watcher, tracker } = setup(document);
    runner.start();
    const fake = port();
    fake.reply(); // seg-0 aplicado antes da primeira zona do bloco
    watcher().emit([{ block: chapterOf(document), zone: 'visible' }]);
    const chapter = chapterOf(document);
    // `track` só agora, sem o segmento já aplicado, e antes do portão.
    expect(tracker().tracks).toEqual([
      { block: chapter, ids: ['seg-1', 'seg-2', 'seg-3', 'seg-4'] },
    ]);
    expect(tracker().gates).toEqual([{ block: chapter, zone: 'visible' }]);
    watcher().emit([{ block: chapter, zone: 'near' }]);
    expect(tracker().tracks).toHaveLength(1);
    expect(tracker().gates).toHaveLength(2);
    // Sem emissão do rastreador, a ordem é a da classificação: a zona do
    // bloco (visible, depois near) não moveu ninguém.
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3', 'seg-4']);
  });

  it('R20 visível pelo rastreador: próximo envio é R20 e entra em visibleLatency', () => {
    const document = parse(CHAPTER);
    const { runner, port, watcher, tracker, advance } = setup(document);
    runner.start();
    const fake = port();
    expect(segmentsSent(fake)).toEqual(['seg-0']);
    watcher().emit([{ block: chapterOf(document), zone: 'visible' }]);
    // Primeira passada do rastreador depois de rolar até R20 (seg-3).
    advance(10);
    tracker().emit(
      zones(
        ['seg-0', 'out'],
        ['seg-1', 'out'],
        ['seg-2', 'out'],
        ['seg-3', 'visible'],
        ['seg-4', 'near'],
      ),
    );
    advance(240);
    fake.reply(); // seg-0
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-3']);
    advance(50);
    fake.reply(); // seg-3, promovido 290 ms antes
    expect(runner.getState().visibleLatency).toEqual({ count: 1, medianMs: 290, maxMs: 290 });
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-3', 'seg-4', 'seg-2', 'seg-1']);
    expect(runner.getState()).toMatchObject({
      status: 'translated',
      done: 5,
      failed: 0,
      visibleLatency: { count: 1, medianMs: 290, maxMs: 290 },
    });
  });

  it('cada segmento aplicado invalida o bloco e sai do rastreador', () => {
    const document = parse(CHAPTER);
    const { runner, port, watcher, tracker } = setup(document);
    runner.start();
    const fake = port();
    const chapter = chapterOf(document);
    watcher().emit([{ block: chapter, zone: 'visible' }]);
    fake.reply(); // seg-0
    expect(tracker().untracked).toEqual(['seg-0']);
    expect(tracker().invalidated).toEqual([chapter]);
    fake.reply(); // seg-1
    expect(tracker().untracked).toEqual(['seg-0', 'seg-1']);
    expect(tracker().invalidated).toEqual([chapter, chapter]);
    expect(watcher().observed.has(chapter)).toBe(true);
    runToEnd(fake);
    expect(tracker().untracked).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3', 'seg-4']);
    // O último aplicado já não deixa trecho para medir: não invalida.
    expect(tracker().invalidated).toHaveLength(4);
    expect(watcher().observed.has(chapter)).toBe(false);
  });

  it('interrompe a unidade da classe 2 quando um trecho compartilhado fica visível', () => {
    const document = parse(CHAPTER);
    const { runner, port, watcher, tracker, states } = setup(document);
    runner.start();
    const fake = port();
    fake.reply(); // seg-0
    fake.reply(); // seg-1
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-2']); // seg-2 na classe 2
    watcher().emit([{ block: chapterOf(document), zone: 'visible' }]);
    tracker().emit(zones(['seg-2', 'out'], ['seg-3', 'visible'], ['seg-4', 'near']));
    vi.advanceTimersByTime(PREEMPT_DEBOUNCE_MS - 1);
    expect(fake.cancels).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fake.cancels.map((cancel) => cancel.unitId.replace(/#.*$/u, ''))).toEqual(['seg-2']);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3']);
    expect(states.at(-1)?.preempted).toBe(1);
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3', 'seg-4', 'seg-2']);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 5, preempted: 1 });
  });

  describe('disconnect do rastreador em todo término; eventos depois são ignorados', () => {
    const terminations: [string, (harness: Harness) => void][] = [
      ['cancel', ({ runner }) => runner.cancel()],
      [
        'job:fatal',
        ({ port }) => port().emit({ type: 'job:fatal', jobId: JOB_IDS[0], error: 'network' }),
      ],
      ['interrupted', ({ port }) => port().drop()],
      ['translated', ({ port }) => runToEnd(port())],
      ['dispose', ({ runner }) => runner.dispose()],
      ['showOriginal', ({ runner }) => runner.showOriginal()],
      ['restart', ({ runner }) => runner.start()],
    ];

    it.each(terminations)('%s', (_, terminate) => {
      const document = parse(CHAPTER);
      const harness = setup(document);
      harness.runner.start();
      const old = harness.tracker();
      const oldPort = harness.port();
      harness.watcher().emit([{ block: chapterOf(document), zone: 'visible' }]);
      terminate(harness);

      expect(old.disconnects).toBe(1);
      const sent = oldPort.sent.length;
      const state = harness.runner.getState();
      expect(() => old.emit(zones(['seg-3', 'visible']))).not.toThrow();
      expect(oldPort.sent).toHaveLength(sent);
      expect(harness.runner.getState()).toEqual(state);
      if (harness.trackers.length === 2) {
        runToEnd(harness.port());
        expect(segmentsSent(harness.port())).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3', 'seg-4']);
      }
    });
  });

  it('blocos simples ao lado do compartilhado seguem a zona do bloco', () => {
    const document = parse(
      `<p>Top.</p>${CHAPTER}<p data-pos="below">Below one.</p><p data-pos="below">Below two.</p>`,
    );
    const { runner, port, watcher, tracker, measured, measuredSegments } = setup(document);
    runner.start();
    // Cada <p> medido uma vez pelo bloco; os trechos do capítulo, um a um.
    expect(measured()).toBe(3);
    expect(measuredSegments()).toBe(5);
    const fake = port();
    const [, , belowTwo] = [...document.querySelectorAll('p')];
    if (belowTwo === undefined) throw new Error('sem bloco');
    watcher().emit([
      { block: chapterOf(document), zone: 'visible' },
      { block: belowTwo, zone: 'visible' },
    ]);
    expect(tracker().gates).toEqual([{ block: chapterOf(document), zone: 'visible' }]);
    expect(tracker().tracks.map(({ ids }) => ids)).toEqual([
      ['seg-1', 'seg-2', 'seg-3', 'seg-4', 'seg-5'],
    ]);
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual([
      'seg-0',
      'seg-1',
      'seg-2',
      'seg-7',
      'seg-3',
      'seg-4',
      'seg-5',
      'seg-6',
    ]);
  });

  describe('página só com blocos simples: mesmos envios e medições de hoje', () => {
    const PAGE =
      '<p>Top.</p><p data-pos="below">One.</p><p data-pos="below">Two.</p>' +
      '<p data-pos="below">Three.</p>';

    function run(options: SetupOptions): {
      sent: string[];
      measured: number;
      measuredSegments: number;
      trackers: number;
      states: JobState[];
    } {
      const document = parse(PAGE);
      const harness = setup(document, options);
      harness.runner.start();
      const fake = harness.port();
      const all = [...document.querySelectorAll('p')];
      harness.watcher().emit([
        { block: all[0] as Element, zone: 'visible' },
        { block: all[3] as Element, zone: 'visible' },
        { block: all[1] as Element, zone: 'near' },
      ]);
      runToEnd(fake);
      return {
        sent: segmentsSent(fake),
        measured: harness.measured(),
        measuredSegments: harness.measuredSegments(),
        trackers: harness.trackers.length,
        states: harness.states,
      };
    }

    it('com e sem rastreador e medida por trecho', () => {
      const withTracker = run({});
      const without = run({ withTracker: false, withMeasureSegment: false });
      expect(withTracker.trackers).toBe(0);
      expect(withTracker.measuredSegments).toBe(0);
      expect(withTracker.measured).toBe(4);
      expect(without.measured).toBe(4);
      expect(withTracker.sent).toEqual(['seg-0', 'seg-3', 'seg-1', 'seg-2']);
      expect(withTracker.sent).toEqual(without.sent);
      expect(withTracker.states).toEqual(without.states);
    });
  });

  it('sem rastreador, a zona do bloco compartilhado vale para todos os segmentos', () => {
    const document = parse(CHAPTER);
    const { runner, port, watcher } = setup(document, { withTracker: false });
    runner.start();
    const fake = port();
    watcher().emit([{ block: chapterOf(document), zone: 'visible' }]);
    fake.reply();
    // seg-1 (classe 0) e depois os promovidos pela zona do bloco, em ordem de documento.
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3', 'seg-4']);
    expect(runner.getState().visibleLatency?.count).toBe(3);
  });

  it('sem observador, o rastreador não é criado', () => {
    const document = parse(CHAPTER);
    const { runner, port, trackers, measuredSegments } = setup(document, { withWatcher: false });
    runner.start();
    expect(trackers).toHaveLength(0);
    expect(measuredSegments()).toBe(5);
    runToEnd(port());
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 5 });
  });
});
