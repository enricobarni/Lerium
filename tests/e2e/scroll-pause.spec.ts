import type { Page, Worker } from '@playwright/test';
import {
  classifySegments,
  PRIORITY_MAIN,
  type BlockRect,
} from '../../src/content/segment-priority';
import { MAX_UNITS_IN_FLIGHT } from '../../src/shared/page-messages';
import { EXTENSION_ORIGIN, expect, test } from './fixtures';
import type { MockOllama, RecordedRequest } from './mock-ollama';
import {
  LONG_PARAGRAPH_FIXTURE_URL,
  openFixture,
  PageDriver,
  resetSettings,
  type FixtureTab,
} from './page-driver';

/**
 * Reproduções da pausa de tradução observada ao rolar no Chrome real. Cada
 * teste descreve o comportamento CORRETO e hoje falha: está marcado com
 * `test.fail()` (o Playwright o reporta como "expected to fail" enquanto o
 * defeito existir). A anotação sai no commit da correção.
 *
 * Sem esperas fixas: só `expect.poll`, quadros de animação da página e
 * janelas de observação com prazo. Nada de texto da página em log ou
 * anotação: só marcadores das fixtures, contagens e tempos.
 */

/** Janela em que o próximo pedido deveria chegar. */
const NEXT_REQUEST_WINDOW_MS = 2_000;

async function setUp(
  context: Parameters<typeof PageDriver.open>[0],
  serviceWorker: Worker,
  extensionId: string,
  ollama: MockOllama,
  url: string,
): Promise<{ driver: PageDriver; fixture: FixtureTab }> {
  await ollama.configure({ allowedOrigins: [EXTENSION_ORIGIN] });
  await resetSettings(serviceWorker);
  const fixture = await openFixture(context, serviceWorker, url);
  const driver = await PageDriver.open(context, extensionId);
  // A aba da fixture fica em primeiro plano: o IntersectionObserver depende
  // dos quadros de renderização dela.
  await fixture.page.bringToFront();
  ollama.clearRequests();
  ollama.resetPeak();
  return { driver, fixture };
}

const statusOf = (driver: PageDriver, tabId: number) => async () =>
  (await driver.state(tabId)).status;

/** Espera `count` quadros de animação na página (entrega do IntersectionObserver). */
const frames = (page: Page, count = 2): Promise<void> =>
  page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n;
        const tick = (): void => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    count,
  );

/** `POST /api/chat` em ordem de chegada. */
const chatsInOrder = (ollama: MockOllama): RecordedRequest[] =>
  ollama.chatRequests().sort((a, b) => a.seq - b.seq);

/** Marcador inicial (`Q01`, `LONG`, `R20`…) do texto de um pedido, ou `null`. */
const markerOf = (text: string | null): string | null =>
  text === null ? null : (/^\s*(LONG|[QR]\d{2})\b/.exec(text)?.[1] ?? null);

/** Marcador do pedido de ordem `seq`, esperando o corpo chegar. */
async function markerAt(ollama: MockOllama, seq: number): Promise<string | null> {
  const find = (): string | null =>
    ollama.chatRequests().find((request) => request.seq === seq)?.text ?? null;
  await expect.poll(find, { timeout: 10_000 }).not.toBeNull();
  return markerOf(find());
}

/** Registra o `get-state` final (só números e códigos) no relatório e no console. */
function recordState(label: string, state: unknown): void {
  const description = JSON.stringify(state);
  test.info().annotations.push({ type: label, description });
  console.log(`[${label}] ${description}`);
}

/** Ancestralidade de um bloco, como o classificador a lê (`localName` e `role`). */
interface AncestorView {
  localName: string;
  role: string | null;
}

/**
 * Bloco de mentira com a mesma ancestralidade do bloco real: `classifySegments`
 * só lê `localName`, `getAttribute('role')` e `parentElement`.
 */
function stubBlock(ancestry: readonly AncestorView[]): Element {
  let element: object | null = null;
  for (const { localName, role } of [...ancestry].reverse()) {
    const parentElement: object | null = element;
    element = {
      localName,
      parentElement,
      getAttribute: (name: string) => (name === 'role' ? role : null),
    };
  }
  return element as unknown as Element;
}

// --- H1: unidade longa fora da tela ocupa a única vaga -----------------------

/** Marcadores dos parágrafos do artigo que cruzam a viewport, em ordem de documento. */
const visibleParagraphMarkers = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll('#chapter > p')]
      .filter((p) => {
        const rect = p.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0;
      })
      .map((p) => /^\s*(LONG|Q\d{2})\b/.exec(p.textContent ?? '')?.[1] ?? '?'),
  );

test.describe('pausa de tradução ao rolar', () => {
  test('H1: com uma unidade longa fora da tela em voo, o meio visível é pedido sem esperar por ela', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    // Documenta o defeito H1: com MAX_UNITS_IN_FLIGHT = 1 e nenhuma unidade em
    // voo interrompida, a unidade LONG (fora da tela quando saiu) ocupa a única
    // vaga, e os parágrafos que a rolagem tornou visíveis esperam ela terminar.
    // Hoje nenhum pedido chega na janela; a anotação sai no commit da correção.
    test.fail();

    const { driver, fixture } = await setUp(
      context,
      serviceWorker,
      extensionId,
      ollama,
      LONG_PARAGRAPH_FIXTURE_URL,
    );
    const { page, tabId } = fixture;
    expect(MAX_UNITS_IN_FLIGHT).toBe(1);
    expect(await page.evaluate(() => scrollY)).toBe(0);

    // Pré-condição: LONG é o primeiro parágrafo fora da tela, logo abaixo dela.
    const long = await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll('#chapter > p')].find((p) =>
        (p.textContent ?? '').trimStart().startsWith('LONG'),
      )!;
      const { top, bottom, width, height } = paragraph.getBoundingClientRect();
      const ancestry: Array<{ localName: string; role: string | null }> = [];
      for (let element: Element | null = paragraph; element; element = element.parentElement) {
        ancestry.push({ localName: element.localName, role: element.getAttribute('role') });
      }
      return {
        rect: { top, bottom, width, height },
        viewportHeight: innerHeight,
        ancestry,
        chars: (paragraph.textContent ?? '').replace(/[ \t\n\r\f]+/g, ' ').trim().length,
      };
    });
    expect(long.chars).toBeGreaterThan(1_200);
    expect(long.rect.top).toBeGreaterThanOrEqual(long.viewportHeight);
    expect(long.rect.top).toBeLessThan(long.viewportHeight + 48);
    const atTop = await visibleParagraphMarkers(page);
    expect(atTop.length).toBeGreaterThan(1);
    expect(atTop).not.toContain('LONG');
    expect(atTop.at(-1)).toBe('Q12');
    // A classificação do `start` o põe na classe de fora da tela.
    const rect: BlockRect = long.rect;
    const [classified] = classifySegments(
      [{ id: 'seg-0', block: stubBlock(long.ancestry), nodes: [], text: 'LONG' }],
      { measure: () => rect, viewportHeight: long.viewportHeight },
    );
    expect(classified!.priority).toBe(PRIORITY_MAIN);

    // Só o pedido LONG fica retido; os visíveis do topo saem antes dele.
    expect(await driver.inject(tabId)).toEqual({ ok: true, documentId: expect.any(String) });
    ollama.holdChatWhere((text) => markerOf(text) === 'LONG');
    expect((await driver.state(tabId, 'start')).status).toBe('translating');
    const longRequest = (): RecordedRequest | undefined =>
      ollama.chatRequests().find(({ text }) => markerOf(text) === 'LONG');
    await expect.poll(() => longRequest()?.open, { timeout: 10_000 }).toBe(true);
    expect(ollama.openChats).toBe(MAX_UNITS_IN_FLIGHT);
    const beforeLong = chatsInOrder(ollama)
      .filter(({ seq }) => seq < longRequest()!.seq)
      .map(({ text }) => markerOf(text));
    // O h1 (sem marcador) e todos os parágrafos visíveis do topo, nada além.
    expect(beforeLong).toEqual([null, ...atTop]);

    // Com LONG em voo, rola até o meio do artigo.
    await frames(page);
    await page.evaluate(() => {
      const target = [...document.querySelectorAll('#chapter > p')].find((p) =>
        (p.textContent ?? '').trimStart().startsWith('Q20'),
      )!;
      scrollTo(0, scrollY + target.getBoundingClientRect().top - 12);
    });
    await frames(page);
    const middle = await visibleParagraphMarkers(page);
    expect(middle).toContain('Q20');
    expect(middle).not.toContain('LONG');
    expect(middle.filter((marker) => atTop.includes(marker))).toEqual([]);
    const longSeq = longRequest()!.seq;
    expect(chatsInOrder(ollama).at(-1)!.seq).toBe(longSeq);

    // Comportamento correto: um parágrafo visível do meio é pedido sem esperar LONG.
    const arrived = await ollama.waitForChatRequest(NEXT_REQUEST_WINDOW_MS);
    const longStillHeld = longRequest()!.open;
    const nextDuringHold = arrived ? await markerAt(ollama, longSeq + 1) : null;

    ollama.releaseChat();
    await expect.poll(statusOf(driver, tabId), { timeout: 20_000 }).toBe('translated');
    const state = await driver.state(tabId);
    expect(state).toMatchObject({ failed: 0, skipped: 0 });
    recordState('H1 get-state final', state);
    recordState('H1 janela', { arrived, longStillHeld, windowMs: NEXT_REQUEST_WINDOW_MS });

    expect(
      arrived,
      `nenhum pedido em ${NEXT_REQUEST_WINDOW_MS} ms com LONG em voo: o meio visível esperou LONG`,
    ).toBe(true);
    expect(middle).toContain(nextDuringHold);
  });
});
