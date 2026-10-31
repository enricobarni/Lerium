import type { BrowserContext, Page } from '@playwright/test';
import { EXTENSION_ORIGIN, expect, test } from './fixtures';
import { openFixture, outerHtml, resetSettings } from './page-driver';

/**
 * Popup real (popup/index.html numa aba) no Chromium do Playwright. Numa aba,
 * a "aba ativa" do popup seria ele mesmo; para pilotar a fixture, um init
 * script do teste troca só `chrome.tabs.query` pela aba da fixture. O resto
 * (`runtime.sendMessage`, `tabs.sendMessage`, service worker, content script)
 * é o caminho de produção.
 */

/** Subconjunto de `chrome` usado no init script (tipado à mão). */
interface ChromeTabsLike {
  tabs: {
    query(info: unknown): Promise<unknown[]>;
    get(tabId: number): Promise<unknown>;
  };
}

async function openPopup(
  context: BrowserContext,
  extensionId: string,
  targetTabId?: number,
): Promise<Page> {
  const page = await context.newPage();
  if (targetTabId !== undefined) {
    await page.addInitScript((tabId) => {
      const { chrome } = globalThis as unknown as { chrome: ChromeTabsLike };
      chrome.tabs.query = async () => [await chrome.tabs.get(tabId)];
    }, targetTabId);
  }
  await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
  return page;
}

const message = (page: Page) => page.locator('#page-message');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test.describe('popup', () => {
  test('página da extensão: não suportada, sem Traduzir', async ({ context, extensionId }) => {
    const popup = await openPopup(context, extensionId);
    await expect(message(popup)).toHaveText(/Esta página não pode ser traduzida/);
    await expect(button(popup, 'Traduzir página')).toBeHidden();
    await expect(button(popup, 'Abrir configurações')).toBeVisible();
    await expect(popup.getByText('ainda não está disponível')).toHaveCount(0);
  });

  test('traduz, alterna o original e volta à tradução pelo teclado', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
    consoleMessages,
  }) => {
    await ollama.configure({ allowedOrigins: [EXTENSION_ORIGIN] });
    await resetSettings(serviceWorker);
    const fixture = await openFixture(context, serviceWorker);
    const snapshot = await outerHtml(fixture.page);
    const popup = await openPopup(context, extensionId, fixture.tabId);

    await expect(message(popup)).toHaveText('Pronto para traduzir esta página.');
    await expect(button(popup, 'Mostrar original')).toBeHidden();

    await button(popup, 'Traduzir página').focus();
    await popup.keyboard.press('Enter');
    // A fixture pode ter trechos pulados (longos demais): aceita o aviso parcial.
    await expect(message(popup)).toHaveText(/^Página traduzida\./, { timeout: 15_000 });
    const done = await message(popup).textContent();
    await expect(popup.locator('#page-status[role="status"]')).toHaveText(done ?? '');
    await expect(popup.getByRole('progressbar')).toBeHidden();
    // O foco seguiu Traduzir → Cancelar → Mostrar original.
    await expect(button(popup, 'Mostrar original')).toBeFocused();
    const translated = await outerHtml(fixture.page);
    expect(translated).not.toBe(snapshot);

    await popup.keyboard.press('Enter');
    await expect(message(popup)).toHaveText('Mostrando o texto original.');
    await expect(button(popup, 'Mostrar tradução')).toBeFocused();
    expect(await outerHtml(fixture.page)).toBe(snapshot);

    await popup.keyboard.press('Space');
    await expect(message(popup)).toHaveText(done ?? '');
    expect(await outerHtml(fixture.page)).toBe(translated);

    // Nada da página no console do popup nem do service worker.
    for (const { text } of consoleMessages) expect(text).not.toMatch(/Kael|Mirena|veilstone/);
  });

  test('Ollama recusa a origem: erro com "Abrir configurações" em destaque', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    await ollama.configure({ allowedOrigins: [] });
    await resetSettings(serviceWorker);
    const fixture = await openFixture(context, serviceWorker);
    const popup = await openPopup(context, extensionId, fixture.tabId);

    await button(popup, 'Traduzir página').click();
    await expect(message(popup)).toHaveText(/OLLAMA_ORIGINS/, { timeout: 15_000 });
    await expect(button(popup, 'Abrir configurações')).toHaveClass(/\bprimary\b/);
    await expect(button(popup, 'Traduzir página')).toHaveClass(/\bsecondary\b/);
  });
});
