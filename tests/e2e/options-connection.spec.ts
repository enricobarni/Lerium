import type { Page } from '@playwright/test';
import { EXTENSION_ORIGIN, expect, test, type LoggedMessage } from './fixtures';
import type { MockOllama } from './mock-ollama';

/**
 * Fluxo "Testar conexão" da página de opções no Chromium real (ADR-009): a
 * página pede ao service worker, que consulta o mock do Ollama na porta padrão.
 */

const CONNECTED = /Conectado\. \d+ modelo\(s\) encontrado\(s\)\./;
const FORBIDDEN = /HTTP 403.*OLLAMA_ORIGINS/;
const UNREACHABLE = /Não foi possível conectar ao Ollama/;
const NOT_OLLAMA = /não parece ser o Ollama/;

async function openOptions(page: Page, extensionId: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);
}

// Há três regiões role="status" sem nome acessível; o id distingue a da conexão.
const status = (page: Page) => page.locator('#connection-status[role="status"]');
const testButton = (page: Page) => page.getByRole('button', { name: 'Testar conexão' });
const originHelp = (page: Page) => page.getByRole('region', { name: 'Liberar o Lerium no Ollama' });
/** Seção pelo id: com `hidden` ela sai da árvore de acessibilidade e o role não a acharia. */
const originHelpSection = (page: Page) => page.locator('#origin-help');
const originHelpTitle = (page: Page) =>
  page.getByRole('heading', { level: 2, name: 'Liberar o Lerium no Ollama' });

/** Espera o teste automático ao abrir a página terminar e o botão voltar a ficar livre. */
async function waitAutoTest(page: Page, expected: RegExp): Promise<void> {
  await expect(status(page)).toHaveText(expected);
  await expect(testButton(page)).not.toHaveAttribute('aria-disabled', 'true');
}

async function clickTest(page: Page, expected: RegExp): Promise<void> {
  await testButton(page).click();
  await expect(status(page)).toHaveText(expected);
  await expect(testButton(page)).not.toHaveAttribute('aria-disabled', 'true');
}

function corsOrNoCorsMessages(messages: readonly LoggedMessage[]): LoggedMessage[] {
  return messages.filter(({ text }) => /no-cors|Access-Control-Allow-Origin/i.test(text));
}

function showRequests(ollama: MockOllama) {
  return ollama.requests.filter(({ method, path }) => method === 'POST' && path === '/api/show');
}

/** Cenário b: origem não liberada; teste automático revela, clique revela e foca. */
async function expectForbiddenFlow(page: Page, extensionId: string): Promise<void> {
  // Viewport baixo: a seção fica abaixo da dobra até o salto de foco.
  await page.setViewportSize({ width: 900, height: 480 });
  await openOptions(page, extensionId);

  await waitAutoTest(page, FORBIDDEN);
  await expect(originHelp(page)).toBeVisible();
  // O teste automático revela sem mover o foco nem rolar a página.
  await expect(originHelpTitle(page)).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await expect(originHelp(page)).not.toBeInViewport();

  await clickTest(page, FORBIDDEN);
  await expect(originHelp(page)).toBeVisible();
  await expect(originHelpTitle(page)).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('origin-help-title');
  await expect(originHelpTitle(page)).toHaveAttribute('aria-describedby', 'connection-status');
  await expect(originHelp(page)).toBeInViewport();
  await expect(originHelpTitle(page)).toBeInViewport();
  // Houve rolagem real (block: 'start' até onde o documento permite).
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
}

test.describe('opções: testar conexão', () => {
  test('a) sucesso: conectado, modelos listados, seção oculta e foco no botão', async ({
    page,
    ollama,
    extensionId,
  }) => {
    await ollama.configure({
      allowedOrigins: [EXTENSION_ORIGIN],
      models: ['llama3.2:3b', 'translategemma:4b'],
    });
    await openOptions(page, extensionId);
    await waitAutoTest(page, /Conectado\. 2 modelo\(s\) encontrado\(s\)\./);

    await clickTest(page, /Conectado\. 2 modelo\(s\) encontrado\(s\)\./);
    await expect(testButton(page)).toBeFocused();
    await expect(originHelpSection(page)).toBeHidden();
    await expect(originHelpSection(page)).toHaveAttribute('hidden', '');
    const installed = page.getByLabel('Modelos instalados');
    await expect(installed).toBeVisible();
    await expect(installed.locator('option')).toHaveText([
      'Escolha um modelo instalado',
      'llama3.2:3b',
      'translategemma:4b',
    ]);
    await expect(installed).toHaveValue('translategemma:4b');
    await expect(page.locator('#model-warning')).toHaveText('');
  });

  test('b) origem não liberada: 403 revela a seção e foca o título só no clique', async ({
    page,
    ollama,
    extensionId,
    consoleMessages,
  }) => {
    await expectForbiddenFlow(page, extensionId);

    const shows = showRequests(ollama);
    expect(shows.length).toBeGreaterThanOrEqual(2);
    for (const request of shows) expect(request.origin).toBe(EXTENSION_ORIGIN);
    // Com host_permissions o GET vai sem Origin (ADR-009); /api/tags passou.
    const tags = ollama.requests.filter(({ path }) => path === '/api/tags');
    expect(tags.length).toBeGreaterThanOrEqual(2);
    for (const request of tags) expect(request.origin).toBeUndefined();
    // Nenhum preflight: o POST JSON vai direto, com status legível (não opaco).
    expect(ollama.requests.some(({ method }) => method === 'OPTIONS')).toBe(false);
    expect(corsOrNoCorsMessages(consoleMessages)).toEqual([]);
  });

  test('c) servidor desligado: inacessível, seção oculta e foco fora dela', async ({
    page,
    ollama,
    extensionId,
  }) => {
    await ollama.configure({ mode: 'down' });
    await openOptions(page, extensionId);
    await waitAutoTest(page, UNREACHABLE);
    await expect(originHelpSection(page)).toBeHidden();

    await clickTest(page, UNREACHABLE);
    await expect(originHelpSection(page)).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('origin-help-title');
    await expect(testButton(page)).toBeFocused();
  });

  for (const mode of ['404', 'html'] as const) {
    test(`d) algo responde mas não é o Ollama (${mode}): mensagem própria e seção oculta`, async ({
      page,
      ollama,
      extensionId,
    }) => {
      await ollama.configure({ mode });
      await openOptions(page, extensionId);
      await waitAutoTest(page, NOT_OLLAMA);

      await clickTest(page, NOT_OLLAMA);
      await expect(status(page)).not.toHaveText(UNREACHABLE);
      await expect(originHelpSection(page)).toBeHidden();
      await expect(testButton(page)).toBeFocused();
      await expect(page.getByLabel('Modelos instalados')).toBeHidden();
    });
  }

  test('e) modelo ausente: conectado com aviso e seção oculta', async ({
    page,
    ollama,
    extensionId,
  }) => {
    await ollama.configure({ allowedOrigins: [EXTENSION_ORIGIN], models: ['llama3.2:3b'] });
    await openOptions(page, extensionId);
    await waitAutoTest(page, /Conectado\. 1 modelo\(s\) encontrado\(s\)\./);

    await clickTest(page, /Conectado\. 1 modelo\(s\) encontrado\(s\)\./);
    await expect(page.locator('#model-warning')).toHaveText(
      'O modelo "translategemma:4b" não está instalado no Ollama. Instale-o com: ollama pull translategemma:4b',
    );
    await expect(originHelpSection(page)).toBeHidden();
    const shows = showRequests(ollama);
    expect(shows.length).toBeGreaterThanOrEqual(1);
    for (const request of shows) expect(request.origin).toBe(EXTENSION_ORIGIN);
  });

  test.describe('com prefers-reduced-motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('f) a recusa ainda revela e foca a seção', async ({ page, extensionId }) => {
      await expectForbiddenFlow(page, extensionId);
      const reduced = await page.evaluate(
        () => matchMedia('(prefers-reduced-motion: reduce)').matches,
      );
      expect(reduced).toBe(true);
    });
  });

  test('g) após liberar a origem, novo teste conecta e esconde a seção', async ({
    page,
    ollama,
    extensionId,
  }) => {
    await expectForbiddenFlow(page, extensionId);

    await ollama.configure({ allowedOrigins: [EXTENSION_ORIGIN] });
    await testButton(page).click();
    await expect(status(page)).toHaveText(CONNECTED);
    await expect(originHelpSection(page)).toBeHidden();
    await expect(page.locator('#origin-help-title')).not.toHaveAttribute('aria-describedby');
    await expect(testButton(page)).toBeFocused();
  });
});
