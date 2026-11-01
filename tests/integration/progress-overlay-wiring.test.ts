import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePageHide, toPageStateView } from '../../src/content/controller';
import { collectTextNodes, LERIUM_UI_ATTRIBUTE } from '../../src/content/dom-collector';
import { createJobRunner, type JobRunner } from '../../src/content/job-runner';
import { createProgressOverlay, type ProgressOverlay } from '../../src/content/progress-overlay';
import { segmentTextNodes } from '../../src/content/segmenter';
import { PAGE_JOB_PORT_NAME, type JobUnitMessage } from '../../src/shared/page-messages';
import { TRANSLATED_MESSAGE, translatingMessage } from '../../src/shared/page-status-text';
import type { PortLike } from '../../src/shared/port-like';

/**
 * Executor real e indicador real ligados como em `src/content/index.ts`
 * (`onState` → `update(toPageStateView(state))`; `pagehide` definitivo →
 * `dispose`). A porta é falsa e responde quando o teste manda; tempo e
 * quadros são manuais. O indicador não pode mudar o que a coleta, a
 * segmentação, a aplicação e a restauração fazem com a página.
 */

const PARAGRAPHS = ['The rain fell softly.', 'She closed the book.', 'Night came early.'];

const upperCase = (text: string): string => text.toUpperCase();

interface Harness {
  runner: JobRunner;
  overlay: ProgressOverlay;
  inFlight: JobUnitMessage[];
  timers: Map<number, () => void>;
  frames: Map<number, () => void>;
  flush(): void;
  replyAll(): void;
  replyOne(): void;
  hosts(): Element[];
  pageHide(event: { isTrusted: boolean; persisted: boolean }): void;
}

function setup(): Harness {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  const frames = new Map<number, () => void>();
  const inFlight: JobUnitMessage[] = [];
  const listeners = new Set<(message: unknown) => void>();
  let jobs = 0;

  const overlay = createProgressOverlay({
    doc: document,
    setTimeout: (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id as number),
    requestFrame: (cb) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (id) => frames.delete(id as number),
  });

  const port: PortLike = {
    name: PAGE_JOB_PORT_NAME,
    postMessage(message) {
      const record = message as { type?: unknown };
      if (record.type === 'job:unit') inFlight.push(message as JobUnitMessage);
    },
    disconnect() {},
    onMessage: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
    onDisconnect: { addListener() {}, removeListener() {} },
  };

  /** Responde a unidade em voo mais antiga (o executor pode enviar a próxima na hora). */
  const reply = (): void => {
    const unit = inFlight.shift();
    if (unit === undefined) throw new Error('nenhuma unidade em voo');
    for (const listener of [...listeners]) {
      listener({
        type: 'job:result',
        jobId: unit.jobId,
        unitId: unit.unitId,
        ok: true,
        text: upperCase(unit.text),
      });
    }
  };

  const runner = createJobRunner({
    root: document,
    connect: () => port,
    randomUUID: () => `00000000-0000-4000-8000-00000000000${String(++jobs)}`,
    setInterval: () => 0,
    clearInterval: () => undefined,
    measure: () => ({ top: 0, bottom: 20, width: 100, height: 20 }),
    viewportHeight: () => 600,
    clock: () => Number.NaN,
    onState: (state) => overlay.update(toPageStateView(state)),
  });

  const controller = {
    onPageHide(persisted: boolean) {
      if (persisted) runner.cancel();
      else runner.dispose();
      if (!persisted) overlay.dispose();
    },
  };

  return {
    runner,
    overlay,
    inFlight,
    timers,
    frames,
    flush() {
      for (let guard = 0; frames.size > 0 && guard < 10; guard += 1) {
        const pending = [...frames.values()];
        frames.clear();
        for (const cb of pending) cb();
      }
    },
    replyAll() {
      while (inFlight.length > 0) reply();
    },
    replyOne: () => reply(),
    hosts: () => [...document.querySelectorAll(`[${LERIUM_UI_ATTRIBUTE}]`)],
    pageHide: (event) => handlePageHide(event, controller),
  };
}

const bodyText = (): string[] =>
  [...document.body.querySelectorAll('p')].map((p) => p.textContent ?? '');

let originalBody: string;
/** Shadow roots fechados capturados na criação, para ler o indicador. */
let roots: ShadowRoot[];

const overlayMessage = (): string | null =>
  roots.at(-1)?.querySelector('.message')?.textContent ?? null;

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  roots = [];
  const original = HTMLElement.prototype.attachShadow;
  vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (
    this: HTMLElement,
    init: ShadowRootInit,
  ) {
    const root = original.call(this, init);
    roots.push(root);
    return root;
  });
  document.documentElement.replaceChildren(
    document.createElement('head'),
    document.createElement('body'),
  );
  for (const text of PARAGRAPHS) {
    const p = document.createElement('p');
    p.textContent = text;
    document.body.append(p);
  }
  originalBody = new XMLSerializer().serializeToString(document.body);
});

describe('indicador ligado ao job', () => {
  it('acompanha o job do início ao fim sem tocar na página', () => {
    const t = setup();
    const segmentsBefore = segmentTextNodes(collectTextNodes(document)).length;

    t.runner.start();
    t.flush();
    expect(t.hosts()).toHaveLength(1);
    expect(t.hosts()[0]?.parentElement).toBe(document.documentElement);

    t.replyAll();
    t.flush();
    expect(bodyText()).toEqual(PARAGRAPHS.map(upperCase));
    expect(t.runner.getState().status).toBe('translated');
    expect(t.hosts()).toHaveLength(1);

    // Coleta e segmentação continuam vendo só a página.
    expect(collectTextNodes(document).map((node) => node.data)).toEqual(PARAGRAPHS.map(upperCase));
    expect(segmentTextNodes(collectTextNodes(document))).toHaveLength(segmentsBefore);

    // Um novo job com o indicador na tela conta os mesmos trechos.
    t.runner.start();
    expect(t.runner.getState().total).toBe(segmentsBefore);
    t.replyAll();

    t.runner.showOriginal();
    t.flush();
    expect(new XMLSerializer().serializeToString(document.body)).toBe(originalBody);
    expect(t.hosts()).toEqual([]);
  });

  it('o sucesso some sozinho; o job e a tradução ficam', () => {
    const t = setup();
    t.runner.start();
    t.replyAll();
    t.flush();
    expect(t.timers.size).toBe(1);
    for (const fn of [...t.timers.values()]) fn();
    expect(t.hosts()).toEqual([]);
    expect(bodyText()).toEqual(PARAGRAPHS.map(upperCase));
  });

  it('mostra a contagem durante o job e o sucesso no fim', () => {
    const t = setup();
    t.runner.start();
    t.flush();
    const total = t.runner.getState().total;
    expect(total).toBe(PARAGRAPHS.length);
    expect(overlayMessage()).toBe(translatingMessage(0, total));

    t.replyOne();
    t.flush();
    expect(t.runner.getState().done).toBe(1);
    expect(overlayMessage()).toBe(translatingMessage(1, total));

    t.replyAll();
    t.flush();
    expect(overlayMessage()).toBe(TRANSLATED_MESSAGE);
  });

  it('cancelar esconde o indicador e não restaura nada', () => {
    const t = setup();
    t.runner.start();
    t.flush();
    t.runner.cancel();
    t.flush();
    expect(t.hosts()).toEqual([]);
    expect(new XMLSerializer().serializeToString(document.body)).toBe(originalBody);
  });

  it('pagehide sintético é ignorado; o definitivo descarta o indicador', () => {
    const t = setup();
    t.runner.start();
    t.flush();
    t.pageHide({ isTrusted: false, persisted: false });
    expect(t.hosts()).toHaveLength(1);

    t.pageHide({ isTrusted: true, persisted: false });
    expect(t.hosts()).toEqual([]);
    expect(t.frames.size).toBe(0);
    expect(t.timers.size).toBe(0);
    // O runner descartado não emite; nada volta.
    t.runner.start();
    t.flush();
    expect(t.hosts()).toEqual([]);
  });

  it('pagehide para o bfcache cancela, e o indicador some pelo estado', () => {
    const t = setup();
    t.runner.start();
    t.flush();
    t.pageHide({ isTrusted: true, persisted: true });
    t.flush();
    expect(t.runner.getState().status).toBe('cancelled');
    expect(t.hosts()).toEqual([]);
  });
});
