import type { Page, Worker } from '@playwright/test';
import { MAX_UNITS_IN_FLIGHT } from '../../src/shared/page-messages';
import { EXTENSION_ORIGIN, expect, test } from './fixtures';
import { fakeTranslate, type MockOllama } from './mock-ollama';
import {
  LONG_FIXTURE_URL,
  openFixture,
  outerHtml,
  PageDriver,
  resetSettings,
  type FixtureTab,
} from './page-driver';

/**
 * Reordenação da fila pela rolagem (Fase 5, ADR-015) de ponta a ponta, com a
 * fixture longa: com o primeiro `POST /api/chat` retido no mock (e
 * `MAX_UNITS_IN_FLIGHT` vagas), a rolagem só reordena a fila; o pedido
 * seguinte, depois da liberação, mostra a ordem nova. Sem esperas fixas: só
 * `expect.poll`, quadros de animação da página e janelas de observação com
 * prazo.
 */

/** Seletor dos blocos do artigo (h1 e parágrafos `P01`…`P40`). */
const ARTICLE_BLOCKS = '#chapter > h1, #chapter > p';

/** Colapsa o espaço como o segmenter faz antes de enviar. */
const normalize = (text: string): string => text.replace(/[ \t\n\r\f]+/g, ' ').trim();

/** Janela em que nenhum pedido novo pode chegar. */
const QUIET_WINDOW_MS = 1_000;

async function setUp(
  context: Parameters<typeof PageDriver.open>[0],
  serviceWorker: Worker,
  extensionId: string,
  ollama: MockOllama,
): Promise<{ driver: PageDriver; fixture: FixtureTab }> {
  await ollama.configure({ allowedOrigins: [EXTENSION_ORIGIN] });
  await resetSettings(serviceWorker);
  const fixture = await openFixture(context, serviceWorker, LONG_FIXTURE_URL);
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

/**
 * Rola até o parágrafo `index` (0 = `P01`): o topo dele fica 12 px abaixo do
 * topo da viewport, dentro da margem entre parágrafos, para que a borda não
 * caia exatamente num limite de bloco.
 */
const scrollToParagraph = (page: Page, index: number): Promise<void> =>
  page.evaluate((i) => {
    const paragraph = document.querySelectorAll('#chapter > p')[i]!;
    scrollTo(0, scrollY + paragraph.getBoundingClientRect().top - 12);
  }, index);

/** Rola por uma sequência de parágrafos, um por quadro de animação. */
const scrollThrough = (page: Page, indexes: readonly number[]): Promise<void> =>
  page.evaluate(async (list) => {
    const paragraphs = document.querySelectorAll('#chapter > p');
    for (const i of list) {
      scrollTo(0, scrollY + paragraphs[i]!.getBoundingClientRect().top - 12);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, indexes);

/** Textos (normalizados) dos blocos do artigo que cruzam a viewport agora. */
const visibleTexts = (page: Page): Promise<string[]> =>
  page.evaluate((selector) => {
    return [...document.querySelectorAll(selector)]
      .filter((block) => {
        const rect = block.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0;
      })
      .map((block) => (block.textContent ?? '').replace(/[ \t\n\r\f]+/g, ' ').trim());
  }, ARTICLE_BLOCKS);

/** Texto (normalizado) do `POST /api/chat` de ordem `seq`, esperando o corpo chegar. */
async function chatTextAt(ollama: MockOllama, seq: number): Promise<string> {
  const find = (): string | null => {
    const chat = ollama.chatRequests().find((request) => request.seq === seq);
    return chat?.text ?? null;
  };
  await expect.poll(find, { timeout: 10_000 }).not.toBeNull();
  return normalize(find()!);
}

/**
 * Injeta, retém o chat e inicia no topo: espera o primeiro pedido ficar
 * aberto e dois quadros (o observador já informou as zonas iniciais).
 */
async function startHeldAtTop(
  driver: PageDriver,
  fixture: FixtureTab,
  ollama: MockOllama,
): Promise<{ initiallyVisible: string[] }> {
  const { page, tabId } = fixture;
  expect(await page.evaluate(() => scrollY)).toBe(0);
  const initiallyVisible = await visibleTexts(page);
  expect(initiallyVisible.length).toBeGreaterThan(1);
  expect(await driver.inject(tabId)).toEqual({ ok: true, documentId: expect.any(String) });
  ollama.holdChat();
  expect((await driver.state(tabId, 'start')).status).toBe('translating');
  await expect.poll(() => ollama.openChats, { timeout: 10_000 }).toBe(MAX_UNITS_IN_FLIGHT);
  // No topo, o primeiro pedido é um bloco visível (o h1).
  expect(initiallyVisible).toContain(await chatTextAt(ollama, 0));
  await frames(page);
  return { initiallyVisible };
}

/** Com o primeiro pedido retido, rola até o meio do artigo e devolve o que ficou visível. */
async function scrollToMiddleWhileHeld(
  driver: PageDriver,
  fixture: FixtureTab,
  ollama: MockOllama,
): Promise<string[]> {
  const { page } = fixture;
  const { initiallyVisible } = await startHeldAtTop(driver, fixture, ollama);
  await scrollToParagraph(page, 19);
  await frames(page);
  const visible = await visibleTexts(page);
  expect(visible.length).toBeGreaterThan(0);
  // O meio não tem nada em comum com o topo: o teste distingue as duas ordens.
  expect(visible.filter((text) => initiallyVisible.includes(text))).toEqual([]);
  // A rolagem só reordenou: nada além do pedido retido chegou.
  expect(ollama.chatRequests()).toHaveLength(1);
  return visible;
}

test.describe('reordenação por rolagem', () => {
  test('rolar até o meio com o pedido retido: o próximo pedido é um parágrafo visível', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver, fixture } = await setUp(context, serviceWorker, extensionId, ollama);
    const visible = await scrollToMiddleWhileHeld(driver, fixture, ollama);

    ollama.releaseChat();
    expect(visible).toContain(await chatTextAt(ollama, 1));
    // Os que entraram na tela vão juntos para o fim da classe 0: saem todos antes do resto.
    const next: string[] = [];
    for (let seq = 1; seq <= visible.length; seq += 1) next.push(await chatTextAt(ollama, seq));
    expect([...next].sort()).toEqual([...visible].sort());

    await expect.poll(statusOf(driver, fixture.tabId), { timeout: 20_000 }).toBe('translated');
    expect(await driver.state(fixture.tabId)).toMatchObject({ failed: 0, skipped: 0 });
  });

  test('rolar até A e depois até B: o próximo pedido é de B, não de A', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver, fixture } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;
    await startHeldAtTop(driver, fixture, ollama);

    await scrollToParagraph(page, 11);
    await frames(page);
    const atA = await visibleTexts(page);
    await scrollToParagraph(page, 33);
    await frames(page);
    const atB = await visibleTexts(page);
    expect(atA.length).toBeGreaterThan(0);
    expect(atB.length).toBeGreaterThan(0);
    expect(atB.filter((text) => atA.includes(text))).toEqual([]);
    expect(ollama.chatRequests()).toHaveLength(1);

    ollama.releaseChat();
    const next = await chatTextAt(ollama, 1);
    expect(atB).toContain(next);
    expect(atA).not.toContain(next);
    // A foi rebaixado: nenhum parágrafo de A sai antes dos de B.
    const following: string[] = [];
    for (let seq = 1; seq <= atB.length; seq += 1) following.push(await chatTextAt(ollama, seq));
    expect([...following].sort()).toEqual([...atB].sort());

    await expect.poll(statusOf(driver, tabId), { timeout: 20_000 }).toBe('translated');
    expect(await driver.state(tabId)).toMatchObject({ failed: 0, skipped: 0 });
  });

  test('rolar para baixo e para cima com pedidos retidos: sem rajada, no máximo uma interrupção', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    // Antes, a rolagem só reordenava e nenhum pedido extra podia chegar. Com a
    // interrupção pela classe atual, o h1 retido termina a rolagem acima da
    // tela (classe atual ≥ 2) enquanto um parágrafo visível espera mais que
    // PREEMPT_DEBOUNCE_MS: o h1 pode ser abortado uma vez e o visível sai. O
    // teste continua protegendo "rolar não gera rajada": no máximo um pedido
    // extra, só do que está visível no fim, e a janela nunca passa do limite.
    const { driver, fixture } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;
    await startHeldAtTop(driver, fixture, ollama);
    const heldText = await chatTextAt(ollama, 0);

    // ~30 parágrafos para baixo e de volta, um quadro por passo.
    const down = Array.from({ length: 31 }, (_, i) => i + 4);
    await scrollThrough(page, [...down, ...[...down].reverse()]);
    await frames(page);
    const visibleAtEnd = await visibleTexts(page);
    expect(visibleAtEnd.length).toBeGreaterThan(0);
    expect(visibleAtEnd).not.toContain(heldText);

    // Janela de observação: chega no máximo um pedido extra (a interrupção) e,
    // depois dele, mais nenhum.
    if (await ollama.waitForChatRequest(QUIET_WINDOW_MS)) {
      expect(await ollama.waitForChatRequest(QUIET_WINDOW_MS)).toBe(false);
    }
    const duringHold = ollama.chatRequests();
    expect(duringHold.length).toBeLessThanOrEqual(2);
    if (duringHold.length === 2) {
      // O extra é de um parágrafo visível agora, e o retido (o h1) foi abortado.
      expect(visibleAtEnd).toContain(await chatTextAt(ollama, 1));
      await expect
        .poll(() => ollama.chatRequests().find(({ seq }) => seq === 0)?.aborted)
        .toBe(true);
    }
    expect(ollama.openChats).toBe(MAX_UNITS_IN_FLIGHT);
    expect(ollama.peakOpen).toBeLessThanOrEqual(MAX_UNITS_IN_FLIGHT);
    expect(await driver.state(tabId)).toMatchObject({ status: 'translating', done: 0 });

    ollama.releaseChat();
    await expect.poll(statusOf(driver, tabId), { timeout: 20_000 }).toBe('translated');
    expect(await driver.state(tabId)).toMatchObject({ failed: 0, skipped: 0 });
    expect(ollama.peakOpen).toBeGreaterThanOrEqual(1);
    expect(ollama.peakOpen).toBeLessThanOrEqual(MAX_UNITS_IN_FLIGHT);

    const chats = ollama.chatRequests();
    // Só o h1 retido pode ter sido abortado, uma vez; nenhum outro pedido.
    const aborted = chats.filter((chat) => chat.aborted);
    expect(aborted.length).toBeLessThanOrEqual(1);
    for (const chat of aborted) {
      expect(chat.seq).toBe(0);
      expect(normalize(chat.text ?? '')).toBe(heldText);
    }
    // Cada texto é traduzido exatamente uma vez (o h1 pode ter um pedido
    // abortado a mais, seguido do reenvio): sem duplicata nem perda.
    const completed = chats.filter((chat) => !chat.aborted).map(({ text }) => text);
    expect(completed).not.toContain(null);
    expect(new Set(completed).size).toBe(completed.length);
    expect(chats.length).toBe(completed.length + aborted.length);
    if (aborted.length === 1) {
      expect(completed.map((text) => normalize(text!))).toContain(heldText);
      expect(chats.filter((chat) => normalize(chat.text ?? '') === heldText)).toHaveLength(2);
    }
  });

  test('rolando durante o job até o fim: periféricos traduzidos e ida e volta byte a byte', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver, fixture } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;
    const regions = ['body > nav', 'body > header', '#notes', 'body > footer'];
    const regionTexts = (): Promise<string[]> =>
      page.evaluate(
        (selectors) =>
          selectors.map((selector) =>
            (document.querySelector(selector)!.textContent ?? '')
              .replace(/[ \t\n\r\f]+/g, ' ')
              .trim(),
          ),
        regions,
      );
    const before = await regionTexts();
    const snapshot = await outerHtml(page);

    expect(await driver.inject(tabId)).toEqual({ ok: true, documentId: expect.any(String) });
    ollama.setChatDelay(5);
    expect((await driver.state(tabId, 'start')).status).toBe('translating');
    await expect.poll(() => ollama.chatRequests().length, { timeout: 10_000 }).toBeGreaterThan(0);
    await scrollThrough(page, [10, 20, 30, 39, 25, 15]);
    await frames(page);
    await expect.poll(statusOf(driver, tabId), { timeout: 20_000 }).toBe('translated');
    expect(await driver.state(tabId)).toMatchObject({ failed: 0, skipped: 0 });

    const after = await regionTexts();
    for (const [index, text] of before.entries()) {
      expect(text.length, regions[index]).toBeGreaterThan(0);
      expect(after[index], regions[index]).toBe(fakeTranslate(text));
    }

    const translated = await outerHtml(page);
    expect(translated).not.toBe(snapshot);
    expect((await driver.state(tabId, 'show-original')).view).toBe('original');
    expect(await outerHtml(page)).toBe(snapshot);
    expect((await driver.state(tabId, 'show-translation')).view).toBe('translation');
    expect(await outerHtml(page)).toBe(translated);
    expect((await driver.state(tabId, 'show-original')).view).toBe('original');
    expect(await outerHtml(page)).toBe(snapshot);
  });

  test('cancelar e rolar: nenhum pedido novo chega', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver, fixture } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;
    await startHeldAtTop(driver, fixture, ollama);

    expect((await driver.state(tabId, 'cancel')).status).toBe('cancelled');
    await expect
      .poll(() => ollama.chatRequests().map(({ aborted }) => aborted), { timeout: 10_000 })
      .toEqual([true]);

    await scrollThrough(page, [10, 20, 30, 20, 10, 0]);
    await frames(page);
    expect(await ollama.waitForChatRequest(QUIET_WINDOW_MS)).toBe(false);
    // Liberar o mock não ressuscita nada: o job cancelado não envia mais.
    ollama.releaseChat();
    await scrollThrough(page, [5, 15, 25]);
    expect(await ollama.waitForChatRequest(QUIET_WINDOW_MS)).toBe(false);
    expect(ollama.chatRequests()).toHaveLength(1);
    expect(await driver.state(tabId)).toMatchObject({ status: 'cancelled', done: 0 });
  });

  test('depois de rolar até o meio: get-state traz visibleLatency só com números', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver, fixture } = await setUp(context, serviceWorker, extensionId, ollama);
    const { tabId } = fixture;
    const visible = await scrollToMiddleWhileHeld(driver, fixture, ollama);

    ollama.releaseChat();
    await expect.poll(statusOf(driver, tabId), { timeout: 20_000 }).toBe('translated');
    const state = await driver.state(tabId);
    expect(state).toMatchObject({ failed: 0, skipped: 0 });
    const latency = state.visibleLatency;
    expect(latency).toBeDefined();
    expect(Object.keys(latency!).sort()).toEqual(['count', 'maxMs', 'medianMs']);
    expect(Number.isInteger(latency!.count)).toBe(true);
    expect(latency!.count).toBeGreaterThanOrEqual(1);
    expect(latency!.count).toBeLessThanOrEqual(visible.length);
    for (const value of [latency!.medianMs, latency!.maxMs]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(latency!.medianMs).toBeLessThanOrEqual(latency!.maxMs);
    // Nada de texto da página no estado emitido.
    const serialized = JSON.stringify(state);
    for (const text of visible) expect(serialized).not.toContain(text.slice(0, 12));
    expect(serialized).not.toMatch(/Ilsa|Chapter Seven/);
  });
});
