import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  createJobRunner,
  isSendableUnit,
  PING_INTERVAL_MS,
  type JobRunner,
  type JobState,
} from '../../src/content/job-runner';
import type { SegmentPlan } from '../../src/content/page-applier';
import {
  MAX_UNIT_CHARS,
  MAX_UNIT_ID_CHARS,
  PAGE_JOB_PORT_NAME,
  type JobFatalErrorKind,
  type JobUnitMessage,
} from '../../src/shared/page-messages';
import type { PortLike } from '../../src/shared/port-like';

/**
 * Gancho para alterar o plano real do applier num teste: o planejamento não
 * gera unidades fora do contrato, então a única forma de exercitar a recusa
 * antes do envio é adulterar o plano. `null` = applier sem alteração.
 */
const planHook = vi.hoisted(() => ({
  transform: null as ((plan: SegmentPlan) => SegmentPlan) | null,
}));

vi.mock('../../src/content/page-applier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/content/page-applier')>();
  return {
    ...actual,
    createPageApplier: () => {
      const applier = actual.createPageApplier();
      return {
        ...applier,
        plan: (segment: Parameters<typeof applier.plan>[0]) => {
          const plan = applier.plan(segment);
          const transform = planHook.transform;
          return transform === null || 'skipped' in plan ? plan : transform(plan);
        },
      };
    },
  };
});

const JOB_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];
const FOREIGN_JOB_ID = '00000000-0000-4000-8000-0000000000ff';

/** Tradutor falso: maiúsculas, preservando marcadores `<gN>` e espaço. */
const upperCase = (text: string): string =>
  text.replace(/<\/?g\d+>|\p{L}+/gu, (match) =>
    match.startsWith('<') ? match : match.toUpperCase(),
  );

const dropMarkers = (text: string): string => upperCase(text.replace(/<\/?g\d+>/gu, ''));

/** Documento novo; nunca `innerHTML` nem `document.write`. */
function parse(body: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body>${body}</body></html>`,
    'text/html',
  );
}

const serialize = (document: Document): string => new XMLSerializer().serializeToString(document);

const bodyHtml = (document: Document): string => {
  const serialized = new XMLSerializer().serializeToString(document.body);
  return serialized.replace(/^<body[^>]*>|<\/body>$/g, '');
};

interface FakePort {
  readonly port: PortLike;
  readonly sent: unknown[];
  readonly inFlight: JobUnitMessage[];
  readonly maxInFlight: () => number;
  readonly disconnected: () => boolean;
  readonly listenerCount: () => number;
  emit(message: unknown): void;
  /**
   * Entrega a todo ouvinte já registrado, mesmo os removidos: simula uma
   * mensagem que já estava na fila de eventos quando o ouvinte saiu.
   */
  emitQueued(message: unknown): void;
  /** Responde a unidade em voo mais antiga com `ok: true`. */
  reply(translate: (text: string) => string): JobUnitMessage;
  /** Responde a unidade em voo mais antiga com `ok: false`. */
  replyError(error: string): JobUnitMessage;
  /** Responde até não haver unidade em voo. */
  runToEnd(translate: (text: string) => string): void;
  /** A porta cai do lado do service worker. */
  drop(): void;
}

function createFakePort(): FakePort {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const everMessageListeners: ((message: unknown) => void)[] = [];
  const sent: unknown[] = [];
  const inFlight: JobUnitMessage[] = [];
  let maxInFlight = 0;
  let disconnected = false;

  const port: PortLike = {
    name: PAGE_JOB_PORT_NAME,
    postMessage(message) {
      if (disconnected) throw new Error('Attempting to use a disconnected port object');
      sent.push(message);
      const record = message as { type?: unknown };
      if (record.type === 'job:unit') {
        inFlight.push(message as JobUnitMessage);
        maxInFlight = Math.max(maxInFlight, inFlight.length);
      }
    },
    disconnect() {
      disconnected = true;
    },
    onMessage: {
      addListener: (listener) => {
        everMessageListeners.push(listener);
        messageListeners.add(listener);
      },
      removeListener: (listener) => messageListeners.delete(listener),
    },
    onDisconnect: {
      addListener: (listener) => disconnectListeners.add(listener),
      removeListener: (listener) => disconnectListeners.delete(listener),
    },
  };

  const emit = (message: unknown): void => {
    for (const listener of [...messageListeners]) listener(message);
  };

  const take = (): JobUnitMessage => {
    const unit = inFlight.shift();
    if (unit === undefined) throw new Error('nenhuma unidade em voo');
    return unit;
  };

  const fake: FakePort = {
    port,
    sent,
    inFlight,
    maxInFlight: () => maxInFlight,
    disconnected: () => disconnected,
    listenerCount: () => messageListeners.size + disconnectListeners.size,
    emit,
    emitQueued(message) {
      for (const listener of [...everMessageListeners]) listener(message);
    },
    reply(translate) {
      const unit = take();
      emit({
        type: 'job:result',
        jobId: unit.jobId,
        unitId: unit.unitId,
        ok: true,
        text: translate(unit.text),
      });
      return unit;
    },
    replyError(error) {
      const unit = take();
      emit({
        type: 'job:result',
        jobId: unit.jobId,
        unitId: unit.unitId,
        ok: false,
        error,
        retryable: false,
      });
      return unit;
    },
    runToEnd(translate) {
      while (inFlight.length > 0) fake.reply(translate);
    },
    drop() {
      disconnected = true;
      for (const listener of [...disconnectListeners]) listener();
    },
  };
  return fake;
}

interface Harness {
  readonly runner: JobRunner;
  readonly ports: FakePort[];
  readonly states: JobState[];
  readonly port: () => FakePort;
}

/** `hook` roda dentro do `onState`, depois de registrar o estado (reentrância). */
function setup(document: Document, hook?: (state: JobState, runner: JobRunner) => void): Harness {
  const ports: FakePort[] = [];
  const states: JobState[] = [];
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
    onState: (state) => {
      states.push(state);
      hook?.(state, runner);
    },
  });
  return {
    runner,
    ports,
    states,
    port: () => {
      const last = ports[ports.length - 1];
      if (last === undefined) throw new Error('nenhuma porta aberta');
      return last;
    },
  };
}

const unitsOf = (fake: FakePort): JobUnitMessage[] =>
  fake.sent.filter(
    (message): message is JobUnitMessage => (message as JobUnitMessage).type === 'job:unit',
  );

const MIXED_PAGE =
  '<p>Plain sentence here.</p>' + '<p>Hello <b>bold</b> world.</p>' + '<p>Hello<!--x--> world</p>';

const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
let consoleSpies: MockInstance[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  consoleSpies = consoleMethods.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  planHook.transform = null;
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
  vi.useRealTimers();
});

describe('createJobRunner — fluxo completo', () => {
  it('traduz plain, markers e per_node, uma unidade por vez', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port, states } = setup(document);

    runner.start();
    expect(runner.getState()).toEqual({
      status: 'translating',
      view: 'translation',
      total: 3,
      done: 0,
      failed: 0,
      skipped: 0,
    });
    const fake = port();
    expect(fake.inFlight).toHaveLength(1);
    fake.runToEnd(upperCase);

    expect(fake.maxInFlight()).toBe(1);
    const unitIds = unitsOf(fake).map((unit) => unit.unitId);
    expect(unitIds).toHaveLength(4);
    expect(unitIds[0]).toMatch(/^seg-0#text@/);
    expect(unitIds[1]).toMatch(/^seg-1#markers@/);
    expect(unitIds[2]).toMatch(/^seg-2#node-0@/);
    expect(unitIds[3]).toMatch(/^seg-2#node-1@/);
    expect(unitsOf(fake).every((unit) => unit.jobId === JOB_IDS[0])).toBe(true);

    expect(bodyHtml(document)).toBe(
      '<p>PLAIN SENTENCE HERE.</p><p>HELLO <b>BOLD</b> WORLD.</p><p>HELLO<!--x--> WORLD</p>',
    );
    expect(runner.getState()).toEqual({
      status: 'translated',
      view: 'translation',
      total: 3,
      done: 3,
      failed: 0,
      skipped: 0,
    });
    expect(fake.disconnected()).toBe(true);
    expect(fake.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(states[0]?.status).toBe('translating');
    expect(states[states.length - 1]?.status).toBe('translated');
  });

  it('só envia a próxima unidade depois do resultado da anterior', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();
    for (let step = 0; step < 4; step += 1) {
      expect(fake.inFlight).toHaveLength(1);
      expect(unitsOf(fake)).toHaveLength(step + 1);
      fake.reply(upperCase);
    }
    expect(fake.inFlight).toHaveLength(0);
    expect(fake.maxInFlight()).toBe(1);
  });

  it('estados emitidos não carregam texto da página', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port, states } = setup(document);
    runner.start();
    port().runToEnd(upperCase);
    const keys = new Set(states.flatMap((state) => Object.keys(state)));
    expect([...keys].sort()).toEqual(['done', 'failed', 'skipped', 'status', 'total', 'view']);
    expect(JSON.stringify(states)).not.toMatch(/hello|plain|world/i);
  });

  it('página sem texto termina sem abrir porta', () => {
    const document = parse('<p>* * *</p>');
    const { runner, ports } = setup(document);
    runner.start();
    expect(ports).toHaveLength(0);
    expect(runner.getState()).toEqual({
      status: 'translated',
      view: 'translation',
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createJobRunner — validação de mensagens', () => {
  it('ignora resultado de jobId alheio, unitId não pendente e mensagens malformadas', () => {
    const document = parse(MIXED_PAGE);
    const before = serialize(document);
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();
    const pending = fake.inFlight[0] as JobUnitMessage;

    fake.emit({
      type: 'job:result',
      jobId: FOREIGN_JOB_ID,
      unitId: pending.unitId,
      ok: true,
      text: 'X',
    });
    fake.emit({
      type: 'job:result',
      jobId: pending.jobId,
      unitId: 'seg-1#markers@1',
      ok: true,
      text: 'X',
    });
    fake.emit({
      type: 'job:result',
      jobId: pending.jobId,
      unitId: pending.unitId,
      ok: true,
      text: 1,
    });
    fake.emit({ type: 'job:fatal', jobId: FOREIGN_JOB_ID, error: 'model_missing' });
    fake.emit({ type: 'job:fatal', jobId: pending.jobId, error: 'boom' });
    fake.emit('lixo');
    fake.emit({ type: 'job:progress', jobId: pending.jobId, unitId: pending.unitId, chars: 3 });

    expect(unitsOf(fake)).toHaveLength(1);
    expect(serialize(document)).toBe(before);
    expect(runner.getState().status).toBe('translating');

    fake.runToEnd(upperCase);
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 3 });
  });

  it('resultado repetido da mesma unidade não avança duas vezes', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();
    const first = fake.reply(upperCase);
    fake.emit({
      type: 'job:result',
      jobId: first.jobId,
      unitId: first.unitId,
      ok: true,
      text: 'OUTRO',
    });
    expect(unitsOf(fake)).toHaveLength(2);
    expect(fake.inFlight).toHaveLength(1);
  });

  it('reiniciar descarta o job antigo: porta fechada, DOM restaurado, novo jobId', () => {
    const document = parse(MIXED_PAGE);
    const before = serialize(document);
    const { runner, ports } = setup(document);
    runner.start();
    const old = ports[0] as FakePort;
    old.reply(upperCase);
    expect(serialize(document)).not.toBe(before);
    const stale = old.inFlight[0] as JobUnitMessage;

    runner.start();
    expect(old.disconnected()).toBe(true);
    expect(old.listenerCount()).toBe(0);
    expect(serialize(document)).toBe(before);
    const current = ports[1] as FakePort;
    expect((current.inFlight[0] as JobUnitMessage).jobId).toBe(JOB_IDS[1]);

    // Resultado tardio do job antigo, mesmo entregue pela porta nova.
    current.emit({
      type: 'job:result',
      jobId: stale.jobId,
      unitId: stale.unitId,
      ok: true,
      text: 'X',
    });
    expect(unitsOf(current)).toHaveLength(1);
    current.runToEnd(upperCase);
    expect(runner.getState()).toEqual({
      status: 'translated',
      view: 'translation',
      total: 3,
      done: 3,
      failed: 0,
      skipped: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createJobRunner — falhas de unidade e fallback', () => {
  it('marcadores inválidos enfileiram o fallback nó a nó logo em seguida', () => {
    const document = parse('<p>Hello <b>bold</b> world.</p><p>Last line.</p>');
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();
    const markers = fake.reply(dropMarkers);
    expect(markers.unitId).toMatch(/#markers@/);
    const fallbackIds: string[] = [];
    while ((fake.inFlight[0]?.unitId ?? '').startsWith('seg-0#node-')) {
      fallbackIds.push(fake.reply(upperCase).unitId);
    }
    expect(fallbackIds).toHaveLength(3);
    expect(fake.inFlight[0]?.unitId).toMatch(/^seg-1#text@/);
    fake.runToEnd(upperCase);

    expect(bodyHtml(document)).toBe('<p>HELLO <b>BOLD</b> WORLD.</p><p>LAST LINE.</p>');
    expect(runner.getState()).toEqual({
      status: 'translated',
      view: 'translation',
      total: 2,
      done: 2,
      failed: 0,
      skipped: 0,
    });
    expect(fake.maxInFlight()).toBe(1);
  });

  it('ok:false e busy viram falha do segmento, que fica no original', () => {
    const document = parse('<p>First line.</p><p>Hello<!--x--> world</p><p>Third line.</p>');
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();
    fake.replyError('timeout');
    fake.reply(upperCase);
    fake.replyError('busy');
    fake.runToEnd(upperCase);

    expect(bodyHtml(document)).toBe(
      '<p>First line.</p><p>Hello<!--x--> world</p><p>THIRD LINE.</p>',
    );
    expect(runner.getState()).toEqual({
      status: 'translated',
      view: 'translation',
      total: 3,
      done: 1,
      failed: 2,
      skipped: 0,
    });
    expect(unitsOf(fake)).toHaveLength(4);
  });

  it('isSendableUnit segue o contrato aceito pelo service worker', () => {
    expect(isSendableUnit({ unitId: 'seg-0#text@0', text: 'a'.repeat(MAX_UNIT_CHARS) })).toBe(true);
    expect(isSendableUnit({ unitId: 'seg-0#text@0', text: 'a'.repeat(MAX_UNIT_CHARS + 1) })).toBe(
      false,
    );
    expect(isSendableUnit({ unitId: 'seg 0', text: 'a' })).toBe(false);
    expect(isSendableUnit({ unitId: 'a'.repeat(MAX_UNIT_ID_CHARS + 1), text: 'a' })).toBe(false);
  });

  it('unidade fora do contrato não é enviada: segmento falha e o job segue', () => {
    planHook.transform = (plan) =>
      plan.segmentId !== 'seg-0'
        ? plan
        : {
            ...plan,
            units: plan.units.map((unit) => ({ ...unit, text: 'a'.repeat(MAX_UNIT_CHARS + 1) })),
          };
    const document = parse('<p>First line.</p><p>Second line.</p>');
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();

    expect(unitsOf(fake)).toHaveLength(1);
    expect(unitsOf(fake)[0]?.unitId).toMatch(/^seg-1#text@/);
    expect(runner.getState()).toMatchObject({ status: 'translating', failed: 1 });
    fake.runToEnd(upperCase);

    expect(unitsOf(fake).every((unit) => unit.text.length <= MAX_UNIT_CHARS)).toBe(true);
    expect(bodyHtml(document)).toBe('<p>First line.</p><p>SECOND LINE.</p>');
    expect(runner.getState()).toEqual({
      status: 'translated',
      view: 'translation',
      total: 2,
      done: 1,
      failed: 1,
      skipped: 0,
    });
  });

  it('unitId inválido não é enviado e um job só com ele termina sem esperar', () => {
    planHook.transform = (plan) => ({
      ...plan,
      units: plan.units.map((unit) => ({ ...unit, unitId: `${unit.unitId} inválido` })),
    });
    const document = parse('<p>Only line.</p>');
    const before = serialize(document);
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();

    expect(unitsOf(fake)).toHaveLength(0);
    expect(serialize(document)).toBe(before);
    expect(runner.getState()).toEqual({
      status: 'translated',
      view: 'translation',
      total: 1,
      done: 0,
      failed: 1,
      skipped: 0,
    });
    expect(fake.disconnected()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('conta segment_too_long em skipped sem enviar o texto', () => {
    const long = 'palavra '.repeat(800).trim();
    const document = parse(`<p>${long}</p><p>Short line.</p>`);
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();
    expect(runner.getState()).toEqual({
      status: 'translating',
      view: 'translation',
      total: 2,
      done: 0,
      failed: 0,
      skipped: 1,
    });
    fake.runToEnd(upperCase);
    expect(unitsOf(fake)).toHaveLength(1);
    expect(unitsOf(fake)[0]?.text).toBe('Short line.');
    expect(runner.getState()).toEqual({
      status: 'translated',
      view: 'translation',
      total: 2,
      done: 1,
      failed: 0,
      skipped: 1,
    });
  });
});

describe('createJobRunner — término anormal', () => {
  it('o erro do estado é só código fatal ou interrupted', () => {
    expectTypeOf<JobState['error']>().toEqualTypeOf<
      JobFatalErrorKind | 'interrupted' | undefined
    >();
  });

  it('job:fatal encerra com o código e deixa o restante no original', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();
    fake.reply(upperCase);
    const afterFirst = serialize(document);
    fake.emit({ type: 'job:fatal', jobId: JOB_IDS[0], error: 'model_missing' });

    expect(runner.getState()).toEqual({
      status: 'error',
      view: 'translation',
      error: 'model_missing',
      total: 3,
      done: 1,
      failed: 0,
      skipped: 0,
    });
    expect(fake.disconnected()).toBe(true);
    expect(fake.listenerCount()).toBe(0);
    expect(serialize(document)).toBe(afterFirst);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('desconexão inesperada → interrupted; o aplicado continua restaurável', () => {
    const document = parse(MIXED_PAGE);
    const before = serialize(document);
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();
    fake.reply(upperCase);
    fake.drop();

    expect(runner.getState()).toMatchObject({ status: 'error', error: 'interrupted', done: 1 });
    expect(vi.getTimerCount()).toBe(0);
    expect(bodyHtml(document)).toContain('PLAIN SENTENCE HERE.');
    runner.showOriginal();
    expect(serialize(document)).toBe(before);
    runner.showTranslation();
    expect(bodyHtml(document)).toContain('PLAIN SENTENCE HERE.');
  });

  it('falha ao enviar pela porta → interrupted', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();
    fake.port.disconnect();
    fake.reply(upperCase);
    expect(runner.getState()).toMatchObject({ status: 'error', error: 'interrupted', done: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel no meio: nada é aplicado depois, resultados tardios ignorados', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port, states } = setup(document);
    runner.start();
    const fake = port();
    fake.reply(upperCase);
    const pending = fake.inFlight[0] as JobUnitMessage;
    const afterFirst = serialize(document);

    runner.cancel();
    expect(fake.disconnected()).toBe(true);
    expect(fake.listenerCount()).toBe(0);
    expect(runner.getState()).toEqual({
      status: 'cancelled',
      view: 'translation',
      total: 3,
      done: 1,
      failed: 0,
      skipped: 0,
    });
    expect(vi.getTimerCount()).toBe(0);

    fake.emit({
      type: 'job:result',
      jobId: pending.jobId,
      unitId: pending.unitId,
      ok: true,
      text: 'X',
    });
    expect(serialize(document)).toBe(afterFirst);
    const count = states.length;
    runner.cancel();
    expect(states).toHaveLength(count);
  });
});

describe('createJobRunner — original e tradução', () => {
  it('showOriginal restaura byte a byte e showTranslation reaplica', () => {
    const document = parse(
      '<h1>Chapter <i>one</i></h1>\n<p>  Plain   sentence\n here. </p><p>Hello<!--x--> world&nbsp;!</p>',
    );
    const before = serialize(document);
    const { runner, port } = setup(document);
    runner.start();
    port().runToEnd(upperCase);
    const translated = serialize(document);
    expect(translated).not.toBe(before);

    runner.showOriginal();
    expect(serialize(document)).toBe(before);
    expect(runner.getState().status).toBe('translated');
    runner.showTranslation();
    expect(serialize(document)).toBe(translated);
    runner.showOriginal();
    expect(serialize(document)).toBe(before);
  });

  it('showOriginal durante o job cancela e restaura', () => {
    const document = parse(MIXED_PAGE);
    const before = serialize(document);
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();
    fake.reply(upperCase);
    runner.showOriginal();
    expect(runner.getState().status).toBe('cancelled');
    expect(fake.disconnected()).toBe(true);
    expect(serialize(document)).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createJobRunner — visualização', () => {
  it('começa em original; start passa a translation', () => {
    const document = parse(MIXED_PAGE);
    const { runner, states } = setup(document);
    expect(runner.getState()).toEqual({
      status: 'idle',
      view: 'original',
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    });
    runner.start();
    expect(states[0]).toMatchObject({ status: 'translating', view: 'translation' });
  });

  it('showOriginal e showTranslation emitem só quando a visualização muda', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port, states } = setup(document);
    runner.start();
    port().runToEnd(upperCase);
    const count = states.length;

    runner.showOriginal();
    expect(states).toHaveLength(count + 1);
    expect(states[count]).toMatchObject({ status: 'translated', view: 'original', done: 3 });
    runner.showOriginal();
    expect(states).toHaveLength(count + 1);

    runner.showTranslation();
    expect(states).toHaveLength(count + 2);
    expect(states[count + 1]).toMatchObject({ status: 'translated', view: 'translation' });
    runner.showTranslation();
    expect(states).toHaveLength(count + 2);
    expect(runner.getState().view).toBe('translation');
  });

  it('showOriginal durante o job emite um único estado cancelled/original', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port, states } = setup(document);
    runner.start();
    port().reply(upperCase);
    const count = states.length;
    runner.showOriginal();
    expect(states.slice(count)).toEqual([
      { status: 'cancelled', view: 'original', total: 3, done: 1, failed: 0, skipped: 0 },
    ]);
  });

  it('showTranslation em idle não faz nada', () => {
    const document = parse(MIXED_PAGE);
    const before = serialize(document);
    const { runner, states } = setup(document);
    runner.showTranslation();
    runner.showOriginal();
    expect(states).toHaveLength(0);
    expect(runner.getState()).toMatchObject({ status: 'idle', view: 'original' });
    expect(serialize(document)).toBe(before);
  });

  it('start a partir de original volta a translation e retraduz do original', () => {
    const document = parse('<p>Only line.</p>');
    const { runner, ports } = setup(document);
    runner.start();
    (ports[0] as FakePort).runToEnd(upperCase);
    runner.showOriginal();
    runner.start();
    expect(runner.getState()).toMatchObject({ status: 'translating', view: 'translation' });
    (ports[1] as FakePort).runToEnd(upperCase);
    expect(bodyHtml(document)).toBe('<p>ONLY LINE.</p>');
  });
});

describe('createJobRunner — dispose', () => {
  it('encerra o job sem emitir e limpa porta e timer', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port, states } = setup(document);
    runner.start();
    const fake = port();
    fake.reply(upperCase);
    const pending = fake.inFlight[0] as JobUnitMessage;
    const afterFirst = serialize(document);
    const count = states.length;

    runner.dispose();
    expect(states).toHaveLength(count);
    expect(fake.disconnected()).toBe(true);
    expect(fake.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(runner.getState()).toMatchObject({ status: 'cancelled', done: 1 });

    fake.emitQueued({
      type: 'job:result',
      jobId: pending.jobId,
      unitId: pending.unitId,
      ok: true,
      text: 'X',
    });
    expect(serialize(document)).toBe(afterFirst);
    expect(states).toHaveLength(count);
  });

  it('depois do dispose todo comando é no-op e o DOM fica como está', () => {
    const document = parse(MIXED_PAGE);
    const { runner, ports, states } = setup(document);
    runner.start();
    (ports[0] as FakePort).runToEnd(upperCase);
    const translated = serialize(document);
    const count = states.length;
    const last = runner.getState();

    runner.dispose();
    runner.showOriginal();
    runner.showTranslation();
    runner.cancel();
    runner.start();
    runner.dispose();

    expect(ports).toHaveLength(1);
    expect(states).toHaveLength(count);
    expect(serialize(document)).toBe(translated);
    expect(runner.getState()).toEqual(last);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose dentro do onState para o job sem exceção', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port, states } = setup(document, (state, self) => {
      if (state.done === 1) self.dispose();
    });
    runner.start();
    const fake = port();
    expect(() => fake.reply(upperCase)).not.toThrow();
    expect(unitsOf(fake)).toHaveLength(1);
    expect(fake.disconnected()).toBe(true);
    expect(states[states.length - 1]).toMatchObject({ status: 'translating', done: 1 });
    expect(runner.getState().status).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createJobRunner — ping', () => {
  it('envia job:ping a cada 20 s com unidade em voo e limpa o timer ao fim', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();
    const pings = (): unknown[] =>
      fake.sent.filter((message) => (message as { type: string }).type === 'job:ping');

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(PING_INTERVAL_MS - 1);
    expect(pings()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(pings()).toEqual([{ type: 'job:ping', jobId: JOB_IDS[0] }]);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(pings()).toHaveLength(2);

    fake.runToEnd(upperCase);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(PING_INTERVAL_MS * 3);
    expect(pings()).toHaveLength(2);
  });
});

describe('createJobRunner — sequências reais do service worker', () => {
  it('ok:false, depois job:fatal e desconexão: error coerente, nada aplicado depois', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port, states } = setup(document);
    runner.start();
    const fake = port();
    fake.reply(upperCase);
    // Ordem real do service worker: result (ok:false), fatal, disconnect.
    fake.replyError('model_missing');
    const pending = fake.inFlight[0] as JobUnitMessage;
    fake.emit({ type: 'job:fatal', jobId: JOB_IDS[0], error: 'model_missing' });
    const afterFatal = serialize(document);
    const count = states.length;
    fake.drop();
    fake.emitQueued({
      type: 'job:result',
      jobId: pending.jobId,
      unitId: pending.unitId,
      ok: true,
      text: 'X',
    });

    expect(runner.getState()).toEqual({
      status: 'error',
      view: 'translation',
      error: 'model_missing',
      total: 3,
      done: 1,
      failed: 1,
      skipped: 0,
    });
    expect(states).toHaveLength(count);
    expect(unitsOf(fake)).toHaveLength(3);
    expect(serialize(document)).toBe(afterFatal);
    expect(bodyHtml(document)).toBe(
      '<p>PLAIN SENTENCE HERE.</p><p>Hello <b>bold</b> world.</p><p>Hello<!--x--> world</p>',
    );
    expect(fake.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('job:fatal settings_unavailable depois do primeiro ping', () => {
    const document = parse(MIXED_PAGE);
    const before = serialize(document);
    const { runner, port } = setup(document);
    runner.start();
    const fake = port();
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(fake.sent).toContainEqual({ type: 'job:ping', jobId: JOB_IDS[0] });
    expect(unitsOf(fake)).toHaveLength(1);

    fake.emit({ type: 'job:fatal', jobId: JOB_IDS[0], error: 'settings_unavailable' });
    expect(runner.getState()).toEqual({
      status: 'error',
      view: 'translation',
      error: 'settings_unavailable',
      total: 3,
      done: 0,
      failed: 0,
      skipped: 0,
    });
    expect(serialize(document)).toBe(before);
    expect(fake.disconnected()).toBe(true);
    expect(fake.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const sent = fake.sent.length;
    vi.advanceTimersByTime(PING_INTERVAL_MS * 2);
    expect(fake.sent).toHaveLength(sent);
  });

  it('reinício: resultado assíncrono da porta antiga depois do restart é ignorado', async () => {
    const document = parse(MIXED_PAGE);
    const before = serialize(document);
    const { runner, ports } = setup(document);
    runner.start();
    const old = ports[0] as FakePort;
    const stale = old.inFlight[0] as JobUnitMessage;
    const lateResult = {
      type: 'job:result',
      jobId: stale.jobId,
      unitId: stale.unitId,
      ok: true,
      text: 'TARDIO',
    };
    // Entregas agendadas antes do restart e executadas depois dele.
    queueMicrotask(() => old.emitQueued(lateResult));
    setTimeout(() => old.emitQueued(lateResult), 10);

    runner.start();
    const current = ports[1] as FakePort;
    await vi.advanceTimersByTimeAsync(10);

    expect(serialize(document)).toBe(before);
    expect(unitsOf(old)).toHaveLength(1);
    expect(unitsOf(current)).toHaveLength(1);
    expect(runner.getState()).toEqual({
      status: 'translating',
      view: 'translation',
      total: 3,
      done: 0,
      failed: 0,
      skipped: 0,
    });
    current.runToEnd(upperCase);
    expect(bodyHtml(document)).not.toContain('TARDIO');
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 3 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('onState que chama cancel() dentro do emit: para sem exceção', () => {
    const document = parse(MIXED_PAGE);
    const { runner, port, states } = setup(document, (state, self) => {
      if (state.status === 'translating' && state.done === 1) self.cancel();
    });
    runner.start();
    const fake = port();
    expect(() => fake.reply(upperCase)).not.toThrow();

    expect(runner.getState()).toEqual({
      status: 'cancelled',
      view: 'translation',
      total: 3,
      done: 1,
      failed: 0,
      skipped: 0,
    });
    expect(states[states.length - 1]?.status).toBe('cancelled');
    expect(unitsOf(fake)).toHaveLength(1);
    expect(fake.disconnected()).toBe(true);
    expect(fake.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('onState que chama cancel() no translating inicial: nada é enviado', () => {
    const document = parse(MIXED_PAGE);
    const before = serialize(document);
    const { runner, ports } = setup(document, (state, self) => {
      if (state.status === 'translating') self.cancel();
    });
    expect(() => runner.start()).not.toThrow();
    const fake = ports[0] as FakePort;
    expect(unitsOf(fake)).toHaveLength(0);
    expect(runner.getState().status).toBe('cancelled');
    expect(serialize(document)).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('onState que chama start() dentro do emit: um job só, sem unidades duplicadas', () => {
    const document = parse(MIXED_PAGE);
    let restarted = false;
    const { runner, ports } = setup(document, (state, self) => {
      if (!restarted && state.done === 1) {
        restarted = true;
        self.start();
      }
    });
    runner.start();
    const old = ports[0] as FakePort;
    expect(() => old.reply(upperCase)).not.toThrow();

    expect(ports).toHaveLength(2);
    expect(old.disconnected()).toBe(true);
    expect(old.listenerCount()).toBe(0);
    expect(unitsOf(old)).toHaveLength(1);
    const current = ports[1] as FakePort;
    expect(current.inFlight).toHaveLength(1);
    expect(runner.getState()).toEqual({
      status: 'translating',
      view: 'translation',
      total: 3,
      done: 0,
      failed: 0,
      skipped: 0,
    });

    current.runToEnd(upperCase);
    const ids = unitsOf(current).map((unit) => unit.unitId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
    expect(unitsOf(current).every((unit) => unit.jobId === JOB_IDS[1])).toBe(true);
    expect(current.maxInFlight()).toBe(1);
    expect(bodyHtml(document)).toBe(
      '<p>PLAIN SENTENCE HERE.</p><p>HELLO <b>BOLD</b> WORLD.</p><p>HELLO<!--x--> WORLD</p>',
    );
    expect(runner.getState()).toEqual({
      status: 'translated',
      view: 'translation',
      total: 3,
      done: 3,
      failed: 0,
      skipped: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('onState que chama start() ao terminar: novo job limpo', () => {
    const document = parse('<p>Only line.</p>');
    let restarted = false;
    const { runner, ports } = setup(document, (state, self) => {
      if (!restarted && state.status === 'translated') {
        restarted = true;
        self.start();
      }
    });
    runner.start();
    expect(() => (ports[0] as FakePort).reply(upperCase)).not.toThrow();
    expect(ports).toHaveLength(2);
    expect(runner.getState()).toMatchObject({ status: 'translating', done: 0 });
    // O restart restaurou o original antes de replanejar.
    expect(bodyHtml(document)).toBe('<p>Only line.</p>');
    (ports[1] as FakePort).runToEnd(upperCase);
    expect(bodyHtml(document)).toBe('<p>ONLY LINE.</p>');
    expect(runner.getState()).toMatchObject({ status: 'translated', done: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
