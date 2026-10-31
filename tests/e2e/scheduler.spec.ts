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
 * Fila de prioridades do job de página (Fase 5) de ponta a ponta, com a
 * fixture longa (`tests/fixtures/long-chapter.html`): cada parágrafo do
 * artigo começa com um marcador estável (`P01`…`P40`), e o mock registra o
 * texto de cada `POST /api/chat` na ordem de chegada. Sem esperas fixas: só
 * `expect.poll` e janelas de observação com prazo.
 */

/** Título do capítulo (`<h1>` do artigo). */
const H1_PREFIX = 'Chapter Seven:';
const MARKER = /^\s*(P\d{2})\b/;
/** Texto de unidade que pertence ao artigo (h1 ou parágrafo marcado). */
const isArticleText = (text: string): boolean =>
  MARKER.test(text) || text.trimStart().startsWith(H1_PREFIX);
const markerOf = (text: string): string | null => MARKER.exec(text)?.[1] ?? null;

/** Trechos de cada região periférica da fixture (nav, header, aside, footer). */
const PERIPHERAL_SNIPPETS = ['Home', 'Serial fiction', 'Reader notes', 'fictional site'];

const ALL_MARKERS = Array.from({ length: 40 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`);

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
  ollama.clearRequests();
  ollama.resetPeak();
  return { driver, fixture };
}

async function injectOk(driver: PageDriver, tabId: number): Promise<void> {
  expect(await driver.inject(tabId)).toEqual({ ok: true, documentId: expect.any(String) });
}

const statusOf = (driver: PageDriver, tabId: number) => async () =>
  (await driver.state(tabId)).status;

async function translateAll(driver: PageDriver, tabId: number): Promise<void> {
  expect((await driver.state(tabId, 'start')).status).toBe('translating');
  await expect.poll(statusOf(driver, tabId), { timeout: 20_000 }).toBe('translated');
  expect(await driver.state(tabId)).toMatchObject({ failed: 0, skipped: 0 });
}

/** Textos dos `POST /api/chat`, na ordem de chegada. */
function chatTexts(ollama: MockOllama): string[] {
  const chats = ollama.chatRequests().sort((a, b) => a.seq - b.seq);
  const texts = chats.map(({ text }) => text);
  expect(texts).not.toContain(null);
  return texts as string[];
}

/** Marcadores dos parágrafos do artigo que cruzam a viewport, em ordem de documento. */
const visibleMarkers = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll('#chapter > p')]
      .filter((p) => {
        const rect = p.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0;
      })
      .map((p) => (p.textContent ?? '').trim().slice(0, 3)),
  );

const isH1Visible = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const rect = document.querySelector('#chapter > h1')!.getBoundingClientRect();
    return rect.top < innerHeight && rect.bottom > 0;
  });

/** Ordem esperada: tudo do artigo antes de qualquer periférico, que inclui as quatro regiões. */
function expectArticleBeforePeripheral(texts: string[]): string[] {
  const article = texts.filter(isArticleText);
  const peripheral = texts.filter((text) => !isArticleText(text));
  expect(peripheral.length).toBeGreaterThan(0);
  expect(texts.slice(0, article.length)).toEqual(article);
  for (const snippet of PERIPHERAL_SNIPPETS) {
    expect(
      peripheral.some((text) => text.includes(snippet)),
      snippet,
    ).toBe(true);
  }
  return article;
}

test.describe('fila de prioridades', () => {
  test('no topo: o artigo visível sai primeiro e nav/header/aside/footer por último', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver, fixture } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;
    // A fixture só prova algo se for bem mais alta que a viewport.
    expect(await page.evaluate(() => document.documentElement.scrollHeight > 3 * innerHeight)).toBe(
      true,
    );
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(await isH1Visible(page)).toBe(true);

    await injectOk(driver, tabId);
    await translateAll(driver, tabId);

    const texts = chatTexts(ollama);
    // Nav e header do site estão visíveis no topo, mas são periféricos.
    expect(texts[0]!.trimStart().startsWith(H1_PREFIX)).toBe(true);
    const article = expectArticleBeforePeripheral(texts);
    // Nada acima da viewport: visível e abaixo dela, ambos em ordem de documento.
    expect(article.slice(1).map(markerOf)).toEqual(ALL_MARKERS);
  });

  test('depois de rolar: o meio visível sai primeiro, depois abaixo, depois acima', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver, fixture } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;
    await page.evaluate(() => {
      const rect = document.querySelector('#chapter')!.getBoundingClientRect();
      scrollTo(0, scrollY + rect.top + rect.height / 2 - innerHeight / 2);
    });
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    const visible = await visibleMarkers(page);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible).not.toContain('P01');
    expect(await isH1Visible(page)).toBe(false);

    await injectOk(driver, tabId);
    await translateAll(driver, tabId);

    const texts = chatTexts(ollama);
    expect(markerOf(texts[0]!)).toBe(visible[0]);
    const article = expectArticleBeforePeripheral(texts);
    const first = ALL_MARKERS.indexOf(visible[0]!);
    const last = ALL_MARKERS.indexOf(visible[visible.length - 1]!);
    const expected = [
      ...visible,
      ...ALL_MARKERS.slice(last + 1),
      // Acima da viewport: do mais próximo para o mais distante; o h1 é o mais distante.
      ...ALL_MARKERS.slice(0, first).reverse(),
      null,
    ];
    expect(article.map(markerOf)).toEqual(expected);
    expect(article.at(-1)!.trimStart().startsWith(H1_PREFIX)).toBe(true);
  });

  test('duas abas ao mesmo tempo: nunca mais que MAX_UNITS_IN_FLIGHT no Ollama', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    test.setTimeout(60_000);
    const { driver, fixture: first } = await setUp(context, serviceWorker, extensionId, ollama);
    const second = await openFixture(context, serviceWorker, LONG_FIXTURE_URL, [first.tabId]);
    ollama.clearRequests();
    ollama.resetPeak();
    await injectOk(driver, first.tabId);
    await injectOk(driver, second.tabId);

    // Com o mock retido, as duas abas disputam o semáforo global ao mesmo tempo.
    ollama.holdChat();
    expect((await driver.state(first.tabId, 'start')).status).toBe('translating');
    expect((await driver.state(second.tabId, 'start')).status).toBe('translating');
    await expect.poll(() => ollama.openChats, { timeout: 10_000 }).toBe(MAX_UNITS_IN_FLIGHT);
    // Cada aba quer MAX_UNITS_IN_FLIGHT; juntas pedem o dobro, e nada além do limite chega.
    expect(await ollama.waitForChatRequest(1_000)).toBe(false);
    expect(ollama.openChats).toBe(MAX_UNITS_IN_FLIGHT);
    expect((await driver.state(first.tabId)).status).toBe('translating');
    expect((await driver.state(second.tabId)).status).toBe('translating');

    ollama.setChatDelay(25);
    ollama.releaseChat();
    await expect.poll(statusOf(driver, first.tabId), { timeout: 40_000 }).toBe('translated');
    await expect.poll(statusOf(driver, second.tabId), { timeout: 40_000 }).toBe('translated');
    expect(await driver.state(first.tabId)).toMatchObject({ failed: 0 });
    expect(await driver.state(second.tabId)).toMatchObject({ failed: 0 });

    expect(ollama.peakOpen).toBeGreaterThanOrEqual(1);
    expect(ollama.peakOpen).toBeLessThanOrEqual(MAX_UNITS_IN_FLIGHT);
    // As duas abas pediram tudo, cada texto exatamente uma vez por aba.
    const counts = new Map<string, number>();
    for (const text of chatTexts(ollama)) counts.set(text, (counts.get(text) ?? 0) + 1);
    expect(counts.size).toBeGreaterThan(ALL_MARKERS.length);
    expect([...counts.values()].every((count) => count === 2)).toBe(true);
    for (const chat of ollama.chatRequests()) expect(chat).toMatchObject({ aborted: false });
  });

  test('ida e volta byte a byte na fixture longa', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver, fixture } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;
    const snapshot = await outerHtml(page);
    const lastParagraph = '#chapter > p:last-of-type';
    // O segmenter colapsa o espaço interno (quebras de linha do HTML) antes de enviar.
    const paragraphText = (): Promise<string> =>
      page
        .locator(lastParagraph)
        .evaluate((p) => (p.textContent ?? '').replace(/[ \t\n\r\f]+/g, ' ').trim());
    const before = await paragraphText();

    await injectOk(driver, tabId);
    await translateAll(driver, tabId);

    const translated = await outerHtml(page);
    expect(translated).not.toBe(snapshot);
    expect(await paragraphText()).toBe(fakeTranslate(before));

    expect((await driver.state(tabId, 'show-original')).view).toBe('original');
    expect(await outerHtml(page)).toBe(snapshot);
    expect((await driver.state(tabId, 'show-translation')).view).toBe('translation');
    expect(await outerHtml(page)).toBe(translated);
    expect((await driver.state(tabId, 'show-original')).view).toBe('original');
    expect(await outerHtml(page)).toBe(snapshot);
  });
});
