import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createJobRunner, type JobRunner, type JobState } from '../../src/content/job-runner';
import type { BlockRect } from '../../src/content/segment-priority';
import type { VisibilityChange, VisibilityZone } from '../../src/content/visibility-watcher';
import { PAGE_JOB_PORT_NAME, type JobUnitMessage } from '../../src/shared/page-messages';
import type { PortLike } from '../../src/shared/port-like';

/**
 * Reordenação por visibilidade no executor: o observador é falso e só emite
 * quando o teste manda, como o IntersectionObserver real (assíncrono).
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

interface FakePort {
  readonly port: PortLike;
  readonly sent: JobUnitMessage[];
  readonly inFlight: JobUnitMessage[];
  emit(message: unknown): void;
  reply(translate: (text: string) => string): void;
  drop(): void;
}

function createFakePort(): FakePort {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const sent: JobUnitMessage[] = [];
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
        const unit = message as JobUnitMessage;
        if (unit.type !== 'job:unit') return;
        sent.push(unit);
        inFlight.push(unit);
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
  /** Blocos observados agora. */
  readonly observed: Set<Element>;
  /** Todo bloco que já foi observado, em ordem. */
  readonly everObserved: Element[];
  readonly unobserved: Element[];
  disconnects: number;
  /** Entrega um lote ao executor, mesmo depois de `disconnect` (evento atrasado). */
  emit(changes: readonly VisibilityChange[]): void;
}

interface Harness {
  readonly runner: JobRunner;
  readonly ports: FakePort[];
  readonly watchers: FakeWatcher[];
  readonly states: JobState[];
  readonly measured: () => number;
  readonly port: () => FakePort;
  readonly watcher: () => FakeWatcher;
}

interface SetupOptions {
  maxInFlight?: number;
  withWatcher?: boolean;
  /** Padrão: relógio sem leitura válida (NaN), então o estado não leva tempos. */
  clock?: () => number;
}

function setup(document: Document, options: SetupOptions = {}): Harness {
  const ports: FakePort[] = [];
  const watchers: FakeWatcher[] = [];
  const states: JobState[] = [];
  let measured = 0;
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
    measure: (block) => {
      measured += 1;
      return byPosition(block);
    },
    viewportHeight: () => VIEWPORT_HEIGHT,
    clock: options.clock ?? (() => Number.NaN),
    maxInFlight: options.maxInFlight ?? 1,
    ...(options.withWatcher === false
      ? {}
      : {
          createVisibilityWatcher: (onChange: (changes: readonly VisibilityChange[]) => void) => {
            const fake: FakeWatcher = {
              observed: new Set(),
              everObserved: [],
              unobserved: [],
              disconnects: 0,
              emit: (changes) => onChange(changes),
            };
            watchers.push(fake);
            return {
              observe(block: Element) {
                fake.observed.add(block);
                fake.everObserved.push(block);
              },
              unobserve(block: Element) {
                fake.observed.delete(block);
                fake.unobserved.push(block);
              },
              disconnect() {
                fake.observed.clear();
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
    ports,
    watchers,
    states,
    measured: () => measured,
    port: () => last(ports, 'porta'),
    watcher: () => last(watchers, 'observador'),
  };
}

/** `seg-0#text@7` → `seg-0#text`. */
const labelOf = (unit: JobUnitMessage): string => unit.unitId.replace(/@\d+$/u, '');
const labels = (fake: FakePort): string[] => fake.sent.map(labelOf);
const segmentsSent = (fake: FakePort): string[] =>
  labels(fake).map((label) => label.replace(/#.*$/u, ''));

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

/** Responde uma unidade por vez até o fim (janela 1). */
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

describe('createJobRunner — reordenação por visibilidade', () => {
  it('bloco que entra em visible é o próximo enviado', () => {
    const document = parse(page(3));
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    expect(segmentsSent(fake)).toEqual(['seg-0']);

    watcher().emit(changes(document, [3, 'visible']));
    fake.reply(upperCase);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-3']);
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-3', 'seg-1', 'seg-2']);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4, failed: 0 });
  });

  it('sair de visible para near vai à frente da classe 1; para out, ao fim da classe 2', () => {
    const document = parse(
      '<p>One.</p><p>Two.</p><p>Three.</p><p>Four.</p><p data-pos="below">Five.</p>' +
        '<p data-pos="below">Six.</p>',
    );
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    // Observação inicial: os quatro estão na tela; seg-5 já está perto (fim da classe 1).
    watcher().emit(changes(document, [1, 'visible'], [2, 'visible'], [3, 'visible'], [5, 'near']));
    // Rolou para cima: seg-1 desceu para a faixa perto e passa à frente de seg-5.
    watcher().emit(changes(document, [1, 'near']));
    // Passou pelo topo: seg-2 já foi lido; volta ao fim da classe 2, depois de
    // seg-4 (antes, ia à frente da classe dos de fora da tela, à frente do que
    // ainda está por ler).
    watcher().emit(changes(document, [2, 'out']));
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-3', 'seg-1', 'seg-5', 'seg-4', 'seg-2']);
  });

  it('near em lotes sucessivos sai na ordem de entrada (FIFO)', () => {
    const document = parse(page(6));
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    // Rolando para baixo: B5 entra na faixa perto num lote, B6 no seguinte.
    watcher().emit(changes(document, [5, 'near']));
    watcher().emit(changes(document, [6, 'near']));
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual([
      'seg-0',
      'seg-5',
      'seg-6',
      'seg-1',
      'seg-2',
      'seg-3',
      'seg-4',
    ]);
  });

  it('sair de near para out estando na classe 1 vai à frente da classe 2', () => {
    const document = parse(page(3));
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    watcher().emit(changes(document, [1, 'near'], [2, 'near']));
    watcher().emit(changes(document, [1, 'out']));
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-2', 'seg-1', 'seg-3']);
  });

  it('deslocamento de layout que tira da faixa perto por baixo mantém a ordem de documento', () => {
    const document = parse(page(3));
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    watcher().emit(changes(document, [1, 'near']));
    watcher().emit(changes(document, [2, 'near']));
    // O conteúdo acima cresceu: seg-2 saiu da faixa perto pela borda de baixo.
    watcher().emit(changes(document, [2, 'out']));
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3']);
  });

  it('vários near → out no mesmo lote vão à frente da classe 2 em ordem de documento', () => {
    const document = parse(page(5));
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    watcher().emit(changes(document, [4, 'near'], [5, 'near']));
    watcher().emit(changes(document, [5, 'out'], [4, 'out']));
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-4', 'seg-5', 'seg-1', 'seg-2', 'seg-3']);
  });

  it('frente da classe 1 no mesmo lote fica em ordem de documento', () => {
    const document = parse(
      '<p>One.</p><p>Two.</p><p>Three.</p><p>Four.</p><p data-pos="below">Five.</p>',
    );
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    watcher().emit(changes(document, [1, 'visible'], [2, 'visible'], [3, 'visible']));
    watcher().emit(changes(document, [3, 'near'], [2, 'near']));
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3', 'seg-4']);
  });

  it('near leva ao fim da classe 1', () => {
    const document = parse(page(3));
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    watcher().emit(changes(document, [3, 'near']));
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-3', 'seg-1', 'seg-2']);
  });

  describe('segmento inicial que o observador vê fora da tela', () => {
    // seg-0..seg-2 medidos na tela (classe 0); seg-3 abaixo (classe 2).
    const html = '<p>One.</p><p>Two.</p><p>Three.</p><p data-pos="below">Four.</p><p>Five.</p>';

    it('primeira zona near: frente da classe 1, atrás dos de fato visíveis', () => {
      const document = parse(html);
      const { runner, port, watcher } = setup(document);
      runner.start();
      const fake = port();
      // Rolou entre a medição e o primeiro callback: seg-1 desceu para perto.
      watcher().emit(changes(document, [1, 'near'], [2, 'visible'], [4, 'visible']));
      runToEnd(fake);
      expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-2', 'seg-4', 'seg-1', 'seg-3']);
    });

    it('primeira zona out: fim da classe 2', () => {
      const document = parse(html);
      const { runner, port, watcher } = setup(document);
      runner.start();
      const fake = port();
      watcher().emit(changes(document, [1, 'out'], [2, 'visible']));
      runToEnd(fake);
      expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-2', 'seg-4', 'seg-3', 'seg-1']);
    });

    it('só a primeira zona é tratada assim; depois valem as regras normais', () => {
      const document = parse(html);
      const { runner, port, watcher } = setup(document);
      runner.start();
      const fake = port();
      // seg-1 confirmado na tela; seg-2 e seg-4 também.
      watcher().emit(changes(document, [1, 'visible'], [2, 'visible'], [4, 'visible']));
      // seg-2 rolou para perto: rebaixado; seg-1 e seg-4 seguem na classe 0.
      watcher().emit(changes(document, [2, 'near']));
      runToEnd(fake);
      expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-4', 'seg-2', 'seg-3']);
    });

    it('segmento inicialmente fora da tela não é afetado pela primeira zona', () => {
      const document = parse(html);
      const { runner, port, watcher } = setup(document);
      runner.start();
      const fake = port();
      // seg-3 (classe 2) com primeira zona out: nada muda.
      watcher().emit(changes(document, [3, 'out']));
      runToEnd(fake);
      expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-4', 'seg-3']);
    });
  });

  it('o lote é aplicado em ordem de documento, qualquer que seja a ordem das entradas', () => {
    const toVisible = parse(page(4));
    const first = setup(toVisible);
    first.runner.start();
    first.watcher().emit(changes(toVisible, [4, 'visible'], [2, 'visible']));
    runToEnd(first.port());
    expect(segmentsSent(first.port())).toEqual(['seg-0', 'seg-2', 'seg-4', 'seg-1', 'seg-3']);

    const toNear = parse(page(4));
    const second = setup(toNear);
    second.runner.start();
    second.watcher().emit(changes(toNear, [4, 'near'], [3, 'near']));
    runToEnd(second.port());
    expect(segmentsSent(second.port())).toEqual(['seg-0', 'seg-3', 'seg-4', 'seg-1', 'seg-2']);
  });

  it('periféricos nunca são observados nem movidos', () => {
    const document = parse(
      '<nav><p>Menu.</p></nav><p data-pos="below">Far.</p><p>Seen.</p><footer><p>Foot.</p></footer>',
    );
    const { runner, port, watcher } = setup(document);
    runner.start();
    const all = blocks(document);
    // Ordem da classificação (visível primeiro); nada de nav nem footer.
    expect(watcher().everObserved).toHaveLength(2);
    expect(watcher().everObserved[0]).toBe(all[2]);
    expect(watcher().everObserved[1]).toBe(all[1]);
    // Evento para um bloco não observado não muda nada.
    watcher().emit(changes(document, [0, 'visible'], [3, 'visible']));
    runToEnd(port());
    expect(segmentsSent(port())).toEqual(['seg-2', 'seg-1', 'seg-0', 'seg-3']);
  });

  it('o callback só reordena: não envia, não aplica e não mede', () => {
    const document = parse(page(3));
    const before = new XMLSerializer().serializeToString(document);
    const { runner, port, watcher, states, measured } = setup(document, { maxInFlight: 2 });
    runner.start();
    const fake = port();
    const sentBefore = fake.sent.length;
    const statesBefore = states.length;
    const measuredBefore = measured();

    watcher().emit(changes(document, [3, 'visible'], [1, 'near']));
    watcher().emit(changes(document, [3, 'out']));

    expect(fake.sent).toHaveLength(sentBefore);
    expect(states).toHaveLength(statesBefore);
    expect(measured()).toBe(measuredBefore);
    expect(new XMLSerializer().serializeToString(document)).toBe(before);
    runToEnd(fake);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4 });
  });

  it('unobserve só quando a última unidade do grupo sai da fila', () => {
    const document = parse('<p>Top.</p><p data-pos="below">Hello<!--x--> world</p>');
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    const [top, perNode] = blocks(document) as [Element, Element];
    expect(watcher().unobserved).toEqual([top]);

    fake.reply(upperCase);
    expect(labels(fake)).toEqual(['seg-0#text', 'seg-1#node-0']);
    // Uma unidade do grupo ainda na fila: continua observado e movível.
    expect(watcher().observed.has(perNode)).toBe(true);
    fake.reply(upperCase);
    expect(labels(fake)).toEqual(['seg-0#text', 'seg-1#node-0', 'seg-1#node-1']);
    expect(watcher().unobserved).toEqual([top, perNode]);
    expect(watcher().observed.size).toBe(0);
    fake.reply(upperCase);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 2 });
  });

  it('bloco com dois segmentos sai só quando os dois saem da fila', () => {
    const document = parse('<p>Top.</p><p data-pos="below">First half.<br>Second half.</p>');
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    const shared = blocks(document)[1] as Element;
    fake.reply(upperCase);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1']);
    expect(watcher().observed.has(shared)).toBe(true);
    fake.reply(upperCase);
    expect(watcher().observed.has(shared)).toBe(false);
    runToEnd(fake);
  });

  describe('disconnect em todo término; eventos depois são ignorados', () => {
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
      const document = parse(page(3));
      const harness = setup(document);
      harness.runner.start();
      const old = harness.watcher();
      const oldPort = harness.port();
      terminate(harness);

      expect(old.disconnects).toBe(1);
      expect(old.observed.size).toBe(0);
      const sent = oldPort.sent.length;
      const state = harness.runner.getState();
      expect(() => old.emit(changes(document, [3, 'visible'], [1, 'near']))).not.toThrow();
      expect(oldPort.sent).toHaveLength(sent);
      expect(harness.runner.getState()).toEqual(state);
      // Restart: o job novo segue a ordem própria, sem efeito do evento velho.
      if (harness.watchers.length === 2) {
        runToEnd(harness.port());
        expect(segmentsSent(harness.port())).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3']);
      }
    });
  });

  it('fallback nó a nó herda a classe atual do segmento promovido', () => {
    const document = parse(
      '<p>Top.</p><p data-pos="below">One.</p><p data-pos="below">Two.</p>' +
        '<p data-pos="below">Far <i>away</i> text.</p><p data-pos="below">Four.</p>',
    );
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    watcher().emit(changes(document, [3, 'visible'], [4, 'visible']));
    fake.reply(upperCase);
    expect(labels(fake)).toEqual(['seg-0#text', 'seg-3#markers']);
    fake.reply(dropMarkers);
    runToEnd(fake);
    // Na classe 0 (atual), à frente de seg-4; na inicial (2) sairia depois dele.
    expect(labels(fake)).toEqual([
      'seg-0#text',
      'seg-3#markers',
      'seg-3#node-0',
      'seg-3#node-1',
      'seg-3#node-2',
      'seg-4#text',
      'seg-1#text',
      'seg-2#text',
    ]);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 5, failed: 0 });
  });

  it('fila finita: com rolagem contínua os periféricos ainda saem (sem aging)', () => {
    const document = parse(
      '<nav><p>Menu.</p></nav>' +
        Array.from({ length: 6 }, (_, i) => `<p data-pos="below">Line ${String(i)}.</p>`).join(''),
    );
    const { runner, port, watcher } = setup(document);
    runner.start();
    const fake = port();
    const zones: VisibilityZone[] = ['visible', 'near', 'out'];
    let tick = 0;
    while (fake.inFlight.length > 0) {
      const index = 1 + (tick % 6);
      watcher().emit(changes(document, [index, zones[tick % 3] as VisibilityZone]));
      tick += 1;
      fake.reply(upperCase);
    }
    const sent = segmentsSent(fake);
    expect(sent).toHaveLength(7);
    expect(new Set(sent).size).toBe(7);
    expect(sent[sent.length - 1]).toBe('seg-0');
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 7 });
    expect(watcher().disconnects).toBe(1);
  });

  it('sem a dependência a ordem é a da classificação inicial', () => {
    const document = parse(page(3));
    const { runner, port, watchers } = setup(document, { withWatcher: false });
    runner.start();
    runToEnd(port());
    expect(watchers).toHaveLength(0);
    expect(segmentsSent(port())).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3']);
  });

  it('página só com periféricos não cria observador', () => {
    const document = parse('<nav><p>Menu.</p></nav>');
    const { runner, port, watchers } = setup(document);
    runner.start();
    expect(watchers).toHaveLength(0);
    runToEnd(port());
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 1 });
  });
});

describe('createJobRunner — latência do trecho que entrou na tela', () => {
  /** Relógio falso: `now` muda só quando o teste manda. */
  function fakeClock(start = 1000): { read: () => number; advance: (ms: number) => void } {
    let now = start;
    return {
      read: () => now,
      advance: (ms) => {
        now += ms;
      },
    };
  }

  it('mede da entrada na tela até a aplicação: count, mediana e máximo', () => {
    const clock = fakeClock();
    const document = parse(page(4));
    const { runner, port, watcher, states } = setup(document, { clock: clock.read });
    runner.start();
    const fake = port();
    expect(Object.hasOwn(runner.getState(), 'visibleLatency')).toBe(false);

    clock.advance(10);
    watcher().emit(changes(document, [1, 'visible'])); // promovido em 1010
    clock.advance(30);
    watcher().emit(changes(document, [3, 'visible'], [4, 'visible'])); // promovidos em 1040
    fake.reply(upperCase); // seg-0 (já visível no início: não conta)
    expect(Object.hasOwn(runner.getState(), 'visibleLatency')).toBe(false);
    clock.advance(20);
    fake.reply(upperCase); // seg-1 aplicado em 1060 → 50 ms
    expect(runner.getState().visibleLatency).toEqual({ count: 1, medianMs: 50, maxMs: 50 });
    clock.advance(100);
    fake.reply(upperCase); // seg-3 em 1160 → 120
    clock.advance(200);
    fake.reply(upperCase); // seg-4 em 1360 → 320
    expect(runner.getState().visibleLatency).toEqual({ count: 3, medianMs: 120, maxMs: 320 });
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-3', 'seg-4', 'seg-2']);
    runToEnd(fake); // seg-2 nunca entrou na tela
    expect(runner.getState()).toMatchObject({
      status: 'translated',
      visibleLatency: { count: 3, medianMs: 120, maxMs: 320 },
    });
    // Só números no estado emitido.
    const last = states[states.length - 1];
    expect(Object.values(last?.visibleLatency ?? {}).every((v) => typeof v === 'number')).toBe(
      true,
    );
  });

  it('segmento visível desde o start com primeira zona visible não entra na medida', () => {
    const clock = fakeClock();
    const document = parse('<p>One.</p><p>Two.</p><p>Three.</p><p data-pos="below">Four.</p>');
    const { runner, port, watcher } = setup(document, { clock: clock.read });
    runner.start();
    const fake = port();
    // Zona inicial do observador: confirma o que a medição viu.
    watcher().emit(changes(document, [1, 'visible'], [2, 'visible'], [3, 'out']));
    clock.advance(40);
    runToEnd(fake);
    expect(segmentsSent(fake)).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3']);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 4 });
    expect(Object.hasOwn(runner.getState(), 'visibleLatency')).toBe(false);
  });

  it('mediana de quantidade par é a média dos dois do meio', () => {
    const clock = fakeClock();
    const document = parse(page(2));
    const { runner, port, watcher } = setup(document, { clock: clock.read });
    runner.start();
    const fake = port();
    watcher().emit(changes(document, [1, 'visible'], [2, 'visible']));
    clock.advance(10);
    fake.reply(upperCase); // seg-0
    clock.advance(10);
    fake.reply(upperCase); // seg-1 → 20
    clock.advance(40);
    fake.reply(upperCase); // seg-2 → 60
    expect(runner.getState().visibleLatency).toEqual({ count: 2, medianMs: 40, maxMs: 60 });
  });

  it('sair da tela antes de ser aplicado descarta a medida', () => {
    const clock = fakeClock();
    const document = parse(page(3));
    const { runner, port, watcher } = setup(document, { clock: clock.read });
    runner.start();
    const fake = port();
    watcher().emit(changes(document, [1, 'visible']));
    clock.advance(5);
    watcher().emit(changes(document, [1, 'out']));
    runToEnd(fake);
    expect(Object.hasOwn(runner.getState(), 'visibleLatency')).toBe(false);

    // Volta à tela: a medida recomeça na nova entrada.
    const again = parse(page(3));
    const second = setup(again, { clock: clock.read });
    second.runner.start();
    second.watcher().emit(changes(again, [1, 'visible']));
    clock.advance(500);
    second.watcher().emit(changes(again, [1, 'near']));
    second.watcher().emit(changes(again, [1, 'visible']));
    clock.advance(7);
    second.port().reply(upperCase); // seg-0
    second.port().reply(upperCase); // seg-1 → 7, não 507
    expect(second.runner.getState().visibleLatency).toEqual({ count: 1, medianMs: 7, maxMs: 7 });
    runToEnd(second.port());
  });

  it('segmento que falha não entra na medida', () => {
    const clock = fakeClock();
    const document = parse(page(2));
    const { runner, port, watcher } = setup(document, { clock: clock.read });
    runner.start();
    const fake = port();
    watcher().emit(changes(document, [1, 'visible']));
    fake.reply(upperCase);
    clock.advance(9);
    const unit = fake.inFlight.shift();
    if (unit === undefined) throw new Error('sem unidade');
    fake.emit({
      type: 'job:result',
      jobId: unit.jobId,
      unitId: unit.unitId,
      ok: false,
      error: 'timeout',
      retryable: false,
    });
    runToEnd(fake);
    expect(runner.getState()).toMatchObject({ status: 'translated', failed: 1 });
    expect(Object.hasOwn(runner.getState(), 'visibleLatency')).toBe(false);
  });

  it('com fallback mede até o fallback ser aplicado', () => {
    const clock = fakeClock();
    const document = parse('<p>Top.</p><p data-pos="below">Far <i>away</i> text.</p>');
    const { runner, port, watcher } = setup(document, { clock: clock.read });
    runner.start();
    const fake = port();
    watcher().emit(changes(document, [1, 'visible']));
    fake.reply(upperCase); // seg-0
    clock.advance(10);
    fake.reply(dropMarkers); // markers inválidos → fallback nó a nó
    expect(Object.hasOwn(runner.getState(), 'visibleLatency')).toBe(false);
    clock.advance(15);
    runToEnd(fake);
    expect(runner.getState()).toMatchObject({
      status: 'translated',
      done: 2,
      visibleLatency: { count: 1, medianMs: 25, maxMs: 25 },
    });
  });

  it('zerada a cada start; relógio inválido ou que volta descarta a medida', () => {
    let now = 1000;
    const document = parse(page(2));
    const { runner, port, watcher } = setup(document, { clock: () => now });
    runner.start();
    watcher().emit(changes(document, [1, 'visible']));
    now = 1004;
    runToEnd(port());
    expect(runner.getState().visibleLatency).toEqual({ count: 1, medianMs: 4, maxMs: 4 });

    runner.start();
    expect(Object.hasOwn(runner.getState(), 'visibleLatency')).toBe(false);
    watcher().emit(changes(document, [1, 'visible'], [2, 'visible']));
    now = 900; // voltou no tempo
    port().reply(upperCase); // seg-0
    port().reply(upperCase); // seg-1: negativo, descartado
    expect(Object.hasOwn(runner.getState(), 'visibleLatency')).toBe(false);
    now = Number.NaN;
    runToEnd(port()); // seg-2: leitura inválida, descartado
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 3 });
    expect(Object.hasOwn(runner.getState(), 'visibleLatency')).toBe(false);
  });

  it('getState devolve cópia do resumo', () => {
    const clock = fakeClock();
    const document = parse(page(1));
    const { runner, port, watcher } = setup(document, { clock: clock.read });
    runner.start();
    watcher().emit(changes(document, [1, 'visible']));
    clock.advance(3);
    runToEnd(port());
    const first = runner.getState();
    (first.visibleLatency as { count: number }).count = 99;
    expect(runner.getState().visibleLatency).toEqual({ count: 1, medianMs: 3, maxMs: 3 });
  });
});
