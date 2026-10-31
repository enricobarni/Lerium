import type { Page, Worker } from '@playwright/test';
import { EXTENSION_ORIGIN, expect, test } from './fixtures';
import { fakeTranslate, type MockOllama } from './mock-ollama';
import { openFixture, outerHtml, PageDriver, resetSettings, type FixtureTab } from './page-driver';

/**
 * Tradução de página de ponta a ponta (Fase 4): popup → service worker
 * (injeção) → content script (job) → service worker → mock do Ollama, que
 * "traduz" com ROT13 fora dos marcadores `<gN>`. Sem esperas fixas: só
 * `expect.poll` e esperas por evento com prazo.
 */

/** Parágrafo sem markup inline da fixture. */
const PLAIN_PARAGRAPH = '#chapter > p:nth-of-type(2)';
/** Parágrafo com `<em>` e `<strong>`. */
const INLINE_PARAGRAPH = '#chapter > p:nth-of-type(1)';

/** Trechos da fixture (e seus equivalentes em ROT13) que nunca podem ir para o console. */
const FIXTURE_SNIPPETS = ['Kael', 'Mirena', 'veilstone', 'Lantern', 'surveyor', 'compass'];

interface Setup {
  driver: PageDriver;
  fixture: FixtureTab;
  snapshot: string;
}

async function setUp(
  context: Parameters<typeof PageDriver.open>[0],
  serviceWorker: Worker,
  extensionId: string,
  ollama: MockOllama,
): Promise<Setup> {
  await ollama.configure({ allowedOrigins: [EXTENSION_ORIGIN] });
  await resetSettings(serviceWorker);
  const fixture = await openFixture(context, serviceWorker);
  const driver = await PageDriver.open(context, extensionId);
  const snapshot = await outerHtml(fixture.page);
  ollama.clearRequests();
  return { driver, fixture, snapshot };
}

async function injectOk(driver: PageDriver, tabId: number): Promise<string> {
  const response = await driver.inject(tabId);
  expect(response).toEqual({ ok: true, documentId: expect.any(String) });
  return (response as { documentId: string }).documentId;
}

const statusOf = (driver: PageDriver, tabId: number) => async () =>
  (await driver.state(tabId)).status;

async function translateAll(driver: PageDriver, tabId: number): Promise<void> {
  const started = await driver.state(tabId, 'start');
  expect(started.status).toBe('translating');
  await expect.poll(statusOf(driver, tabId), { timeout: 15_000 }).toBe('translated');
}

const textOf = (page: Page, selector: string): Promise<string> =>
  page.locator(selector).evaluate((element) => element.textContent ?? '');

const elementCount = (page: Page): Promise<number> =>
  page.evaluate(() => document.getElementsByTagName('*').length);

const hrefs = (page: Page): Promise<Array<string | null>> =>
  page.evaluate(() => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')));

test.describe('tradução de página', () => {
  test('ida e volta: traduz, restaura byte a byte e reaplica', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver, fixture, snapshot } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;
    const plainBefore = await textOf(page, PLAIN_PARAGRAPH);
    const codeBefore = await textOf(page, 'pre code');
    const textareaBefore = await page.locator('textarea').inputValue();
    const countBefore = await elementCount(page);
    const hrefsBefore = await hrefs(page);

    await injectOk(driver, tabId);
    await translateAll(driver, tabId);

    const state = await driver.state(tabId);
    expect(state).toMatchObject({ status: 'translated', view: 'translation', failed: 0 });
    expect(state.done).toBeGreaterThan(0);
    expect(state.done + state.failed + state.skipped).toBe(state.total);

    expect(await textOf(page, PLAIN_PARAGRAPH)).toBe(fakeTranslate(plainBefore));
    // Marcadores inline: cada elemento recebe o próprio trecho, sem `<gN>` vazando.
    await expect(page.locator(`${INLINE_PARAGRAPH} em`)).toHaveText(fakeTranslate('veilstone'));
    await expect(page.locator(`${INLINE_PARAGRAPH} strong`)).toHaveText(fakeTranslate('colder'));
    expect(await textOf(page, INLINE_PARAGRAPH)).not.toMatch(/<\/?g\d+>/);
    await expect(page.locator('nav a').first()).toHaveText(fakeTranslate('Chapter 3'));
    // Código e campos de formulário ficam fora da coleta.
    expect(await textOf(page, 'pre code')).toBe(codeBefore);
    expect(await page.locator('textarea').inputValue()).toBe(textareaBefore);
    expect(await elementCount(page)).toBe(countBefore);
    expect(await hrefs(page)).toEqual(hrefsBefore);

    const translated = await outerHtml(page);
    expect(translated).not.toBe(snapshot);

    expect((await driver.state(tabId, 'show-original')).view).toBe('original');
    expect(await outerHtml(page)).toBe(snapshot);

    expect((await driver.state(tabId, 'show-translation')).view).toBe('translation');
    expect(await outerHtml(page)).toBe(translated);

    expect((await driver.state(tabId, 'show-original')).view).toBe('original');
    expect(await outerHtml(page)).toBe(snapshot);

    // Uma requisição por unidade; nenhuma abortada nem pendurada.
    const chats = ollama.chatRequests();
    expect(chats.length).toBeGreaterThanOrEqual(state.done);
    for (const chat of chats) expect(chat).toMatchObject({ open: false, aborted: false });
  });

  test('Ollama fora: erro network e DOM intacto', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver, fixture, snapshot } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;
    await injectOk(driver, tabId);
    await ollama.configure({ mode: 'down' });

    await driver.state(tabId, 'start');
    await expect.poll(statusOf(driver, tabId), { timeout: 15_000 }).toBe('error');
    expect((await driver.state(tabId)).error).toBe('network');
    expect(await outerHtml(page)).toBe(snapshot);
    expect(ollama.chatRequests().length).toBeLessThanOrEqual(1);
  });

  test('cancelar no meio: aborta a requisição e não envia mais nada', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver, fixture, snapshot } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;
    await injectOk(driver, tabId);
    ollama.holdChat();

    await driver.state(tabId, 'start');
    await expect
      .poll(() => ollama.chatRequests().filter(({ open }) => open).length, { timeout: 10_000 })
      .toBe(1);

    expect((await driver.state(tabId, 'cancel')).status).toBe('cancelled');
    await expect
      .poll(() => ollama.chatRequests().map(({ aborted }) => aborted), { timeout: 10_000 })
      .toEqual([true]);

    const next = ollama.waitForChatRequest(1_500);
    ollama.releaseChat();
    expect((await driver.state(tabId, 'show-original')).status).toBe('cancelled');
    expect(await outerHtml(page)).toBe(snapshot);
    // Janela maior que a espera da nova tentativa interna do provedor (500 ms).
    expect(await next).toBe(false);
    expect(ollama.chatRequests()).toHaveLength(1);
    expect((await driver.state(tabId)).status).toBe('cancelled');
  });

  test('injeção dupla: um único job, mesmas requisições de uma injeção', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver, fixture } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;

    const first = await injectOk(driver, tabId);
    expect(await injectOk(driver, tabId)).toBe(first);
    await translateAll(driver, tabId);
    const doubled = ollama.chatRequests().length;

    // Documento novo, injeção única: a referência.
    await page.reload();
    ollama.clearRequests();
    expect(await injectOk(driver, tabId)).not.toBe(first);
    await translateAll(driver, tabId);
    const single = ollama.chatRequests().length;

    expect(single).toBeGreaterThan(0);
    expect(doubled).toBe(single);
  });

  test('página não suportada: injeção na página da extensão é recusada', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver } = await setUp(context, serviceWorker, extensionId, ollama);
    const ownTab = await driver.ownTabId();
    expect(await driver.inject(ownTab)).toEqual({ ok: false, error: 'page_unsupported' });
  });

  test('console: nenhum texto da página (original ou traduzido) é registrado', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
    consoleMessages,
  }) => {
    const { driver, fixture } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;
    await injectOk(driver, tabId);
    await translateAll(driver, tabId);
    await driver.state(tabId, 'show-original');
    await driver.state(tabId, 'show-translation');

    // Prova de que a captura funciona nos dois contextos.
    await page.evaluate(() => console.log('lerium-e2e-probe-page'));
    await serviceWorker.evaluate(() => console.log('lerium-e2e-probe-worker'));
    await expect
      .poll(() => consoleMessages.map(({ text }) => text).filter((text) => text.includes('probe')))
      .toEqual(expect.arrayContaining(['lerium-e2e-probe-page', 'lerium-e2e-probe-worker']));

    const forbidden = FIXTURE_SNIPPETS.flatMap((snippet) => [snippet, fakeTranslate(snippet)]).map(
      (snippet) => snippet.toLowerCase(),
    );
    const leaks = consoleMessages.filter(({ text }) =>
      forbidden.some((snippet) => text.toLowerCase().includes(snippet)),
    );
    expect(leaks).toEqual([]);
  });
});
