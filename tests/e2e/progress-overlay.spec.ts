import type { BrowserContext, CDPSession, Page, Worker } from '@playwright/test';
import { AUTO_HIDE_MS } from '../../src/content/progress-overlay';
import {
  STATE_ERROR_MESSAGES,
  TRANSLATED_MESSAGE,
  TRANSLATING_ANNOUNCE,
} from '../../src/shared/page-status-text';
import { EXTENSION_ORIGIN, expect, test } from './fixtures';
import { CSP_FIXTURE_POLICY, type MockOllama } from './mock-ollama';
import {
  CSP_FIXTURE_URL,
  FIXTURE_URL,
  fullOuterHtml,
  openFixture,
  outerHtml,
  overlayHosts,
  PageDriver,
  resetSettings,
  type FixtureTab,
} from './page-driver';

/**
 * Indicador de progresso na página, de ponta a ponta. O indicador vive num
 * shadow root FECHADO: nem a página nem os locators do Playwright o alcançam.
 * Ele é lido pelo CDP (`DOM.getDocument` com `pierce`, que inclui raízes
 * fechadas) e as mudanças no shadow são acompanhadas pelos eventos
 * `DOM.childNodeInserted`/`DOM.childNodeRemoved`. Sem esperas fixas: só
 * `expect.poll` e esperas por evento com prazo.
 */

/** Nó do `DOM.getDocument` (só os campos usados). */
interface CdpNode {
  nodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  shadowRootType?: string;
}

/** Evento de mutação do DOM visto pelo CDP, na ordem de chegada. */
type DomEvent =
  | { kind: 'inserted'; parentNodeId: number; node: CdpNode }
  | { kind: 'removed'; parentNodeId: number; nodeId: number };

/** O indicador como está agora, lido pelo CDP. */
interface OverlaySnapshot {
  hostId: number;
  shadowRootType: string | undefined;
  pillId: number;
  messageId: number;
  statusId: number;
  closeId: number;
  message: string;
  status: string;
  close: string;
}

const attribute = (node: CdpNode, name: string): string | undefined => {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === name) return attrs[i + 1];
  return undefined;
};

/** Filhos, inclusive as raízes de shadow (onde o indicador guarda tudo). */
const childrenOf = (node: CdpNode): CdpNode[] => [
  ...(node.shadowRoots ?? []),
  ...(node.children ?? []),
];

function find(node: CdpNode, match: (node: CdpNode) => boolean): CdpNode | undefined {
  if (match(node)) return node;
  for (const child of childrenOf(node)) {
    const found = find(child, match);
    if (found !== undefined) return found;
  }
  return undefined;
}

const textOf = (node: CdpNode): string =>
  node.nodeType === 3 ? node.nodeValue : childrenOf(node).map(textOf).join('');

const isHost = (node: CdpNode): boolean => attribute(node, 'data-lerium-ui') !== undefined;

function required(node: CdpNode | undefined, what: string): CdpNode {
  if (node === undefined) throw new Error(`Indicador sem ${what}.`);
  return node;
}

/** Leitura do indicador pelo CDP e registro das mutações do DOM. */
class OverlayProbe {
  readonly events: DomEvent[] = [];

  private constructor(private readonly cdp: CDPSession) {
    cdp.on('DOM.childNodeInserted', ({ parentNodeId, node }) =>
      this.events.push({ kind: 'inserted', parentNodeId, node: node as CdpNode }),
    );
    cdp.on('DOM.childNodeRemoved', ({ parentNodeId, nodeId }) =>
      this.events.push({ kind: 'removed', parentNodeId, nodeId }),
    );
  }

  static async attach(context: BrowserContext, page: Page): Promise<OverlayProbe> {
    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable');
    return new OverlayProbe(cdp);
  }

  /**
   * Relê o documento inteiro, perfurando shadow roots. Os ids de nó anteriores
   * deixam de valer e os eventos seguintes usam os novos.
   */
  async snapshot(): Promise<OverlaySnapshot | null> {
    const { root } = await this.cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const html = (root as CdpNode).children?.find((node) => node.nodeName === 'HTML');
    // Só filhos diretos de documentElement: um host em outro lugar não conta.
    const host = html?.children?.find(isHost);
    if (host === undefined) return null;
    const shadow = required(host.shadowRoots?.[0], 'shadow root');
    const byClass = (name: string) => (node: CdpNode) =>
      (attribute(node, 'class') ?? '').split(' ').includes(name);
    const pill = required(find(shadow, byClass('pill')), 'pílula');
    const message = required(find(pill, byClass('message')), 'mensagem');
    const status = required(
      find(pill, (node) => attribute(node, 'role') === 'status'),
      'região status',
    );
    const close = required(find(pill, byClass('close')), 'botão Fechar');
    return {
      hostId: host.nodeId,
      shadowRootType: shadow.shadowRootType,
      pillId: pill.nodeId,
      messageId: message.nodeId,
      statusId: status.nodeId,
      closeId: close.nodeId,
      message: textOf(message),
      status: textOf(status),
      close: textOf(close),
    };
  }

  /** Caixa de borda do nó, em pixels CSS da viewport. */
  async box(nodeId: number): Promise<{ x: number; y: number; width: number; height: number }> {
    const { model } = await this.cdp.send('DOM.getBoxModel', { nodeId });
    // Quad de 8 números: x1, y1, x2, y2, x3, y3, x4, y4.
    const quad = model.border;
    if (quad.length !== 8) throw new Error(`Caixa inesperada: ${quad.length} números.`);
    const xs = quad.filter((_, index) => index % 2 === 0);
    const ys = quad.filter((_, index) => index % 2 === 1);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  /**
   * Resolve `true` quando o nó sair do DOM, ou `false` se não sair em
   * `timeoutMs` (janela de observação, não espera fixa). Vale para ids do
   * último `snapshot`.
   */
  waitForRemoval(nodeId: number, timeoutMs: number): Promise<boolean> {
    const removed = () =>
      this.events.some((event) => event.kind === 'removed' && event.nodeId === nodeId);
    return new Promise((resolve) => {
      if (removed()) return resolve(true);
      const onRemoved = ({ nodeId: id }: { nodeId: number }): void => {
        if (id !== nodeId) return;
        clearTimeout(timer);
        this.cdp.off('DOM.childNodeRemoved', onRemoved);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.cdp.off('DOM.childNodeRemoved', onRemoved);
        resolve(false);
      }, timeoutMs);
      this.cdp.on('DOM.childNodeRemoved', onRemoved);
    });
  }
}

interface Setup {
  driver: PageDriver;
  fixture: FixtureTab;
  probe: OverlayProbe;
  /** `outerHTML` completo antes de qualquer injeção. */
  pristine: string;
}

async function setUp(
  context: BrowserContext,
  serviceWorker: Worker,
  extensionId: string,
  ollama: MockOllama,
  url: string = FIXTURE_URL,
): Promise<Setup> {
  await ollama.configure({ allowedOrigins: [EXTENSION_ORIGIN] });
  await resetSettings(serviceWorker);
  const fixture = await openFixture(context, serviceWorker, url);
  const driver = await PageDriver.open(context, extensionId);
  const probe = await OverlayProbe.attach(context, fixture.page);
  const pristine = await fullOuterHtml(fixture.page);
  const injected = await driver.inject(fixture.tabId);
  expect(injected).toEqual({ ok: true, documentId: expect.any(String) });
  ollama.clearRequests();
  return { driver, fixture, probe, pristine };
}

const statusOf = (driver: PageDriver, tabId: number) => async () =>
  (await driver.state(tabId)).status;

/** Poll até o indicador existir e satisfazer `ready`. */
async function overlayWhen(
  probe: OverlayProbe,
  ready: (snapshot: OverlaySnapshot) => boolean,
  timeout = 15_000,
): Promise<OverlaySnapshot> {
  let last: OverlaySnapshot | null = null;
  await expect
    .poll(
      async () => {
        last = await probe.snapshot();
        return last !== null && ready(last);
      },
      { timeout },
    )
    .toBe(true);
  return last as unknown as OverlaySnapshot;
}

const TRANSLATING = /^Traduzindo… (\d+) de (\d+) trechos?\.$/;

/** Textos do indicador que nunca podem ir para o modelo. */
const OVERLAY_TEXTS = [
  'Traduzindo',
  TRANSLATING_ANNOUNCE,
  TRANSLATED_MESSAGE,
  'Fechar',
  'Progresso da tradução',
  STATE_ERROR_MESSAGES.network,
];

test.describe('indicador de progresso', () => {
  test('a) aparece durante a tradução, conta o progresso e anuncia uma vez só', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const { driver, fixture, probe } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;
    // MAX_UNITS_IN_FLIGHT = 1: com atraso por pedido, cada contagem fica na tela.
    ollama.setChatDelay(150);

    expect((await driver.state(tabId, 'start')).status).toBe('translating');
    // Linha de base: o anúncio de "traduzindo" já foi feito.
    const base = await overlayWhen(
      probe,
      (snapshot) => TRANSLATING.test(snapshot.message) && snapshot.status === TRANSLATING_ANNOUNCE,
    );
    expect(base.shadowRootType).toBe('closed');
    expect(base.close).toBe('Fechar');
    expect(await overlayHosts(page)).toEqual({ count: 1, allDirectChildren: true });
    // A página não alcança o shadow root fechado.
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('[data-lerium-ui]')].map(
          (host) => (host as Element).shadowRoot,
        ),
      ),
    ).toEqual([null]);
    const { total } = await driver.state(tabId);
    expect(total).toBeGreaterThan(2);
    const firstEvent = probe.events.length;

    // Sem `snapshot` até o fim: os ids da linha de base continuam valendo.
    await expect.poll(statusOf(driver, tabId), { timeout: 15_000 }).toBe('translated');
    await expect
      .poll(() =>
        probe.events
          .slice(firstEvent)
          .some(
            (event) =>
              event.kind === 'inserted' &&
              event.parentNodeId === base.messageId &&
              event.node.nodeValue === TRANSLATED_MESSAGE,
          ),
      )
      .toBe(true);

    // Eventos da linha de base até a mensagem de sucesso aparecer.
    const window: DomEvent[] = [];
    for (const event of probe.events.slice(firstEvent)) {
      if (
        event.kind === 'inserted' &&
        event.parentNodeId === base.messageId &&
        event.node.nodeValue === TRANSLATED_MESSAGE
      ) {
        break;
      }
      window.push(event);
    }
    const counts = [
      base.message,
      ...window.flatMap((event) =>
        event.kind === 'inserted' && event.parentNodeId === base.messageId
          ? [event.node.nodeValue]
          : [],
      ),
    ].map((message) => {
      const match = TRANSLATING.exec(message);
      expect(match, `mensagem fora do formato: ${message}`).not.toBeNull();
      expect(Number(match![2])).toBe(total);
      return Number(match![1]);
    });
    // x cresce (sem voltar) e a tela mostrou várias contagens.
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(new Set(counts).size).toBeGreaterThanOrEqual(3);
    expect(Math.max(...counts)).toBeLessThanOrEqual(total);
    // A região viva não foi limpa nem reescrita a cada contagem.
    expect(
      window.filter((event) => event.parentNodeId === base.statusId),
      'mutações na região status durante a tradução',
    ).toEqual([]);
  });

  test('b) sucesso: mostra "Página traduzida.", some sozinho e não deixa rastro', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    test.setTimeout(45_000);
    const { driver, fixture, probe, pristine } = await setUp(
      context,
      serviceWorker,
      extensionId,
      ollama,
    );
    const { page, tabId } = fixture;

    expect((await driver.state(tabId, 'start')).status).toBe('translating');
    await expect.poll(statusOf(driver, tabId), { timeout: 15_000 }).toBe('translated');
    const success = await overlayWhen(
      probe,
      (snapshot) =>
        snapshot.message === TRANSLATED_MESSAGE && snapshot.status === TRANSLATED_MESSAGE,
    );
    const seenAt = Date.now();
    expect(await overlayHosts(page)).toEqual({ count: 1, allDirectChildren: true });

    expect(await probe.waitForRemoval(success.hostId, AUTO_HIDE_MS + 5_000)).toBe(true);
    // Visto depois do render que armou o prazo: o tempo medido só pode ser menor.
    expect(Date.now() - seenAt).toBeGreaterThanOrEqual(AUTO_HIDE_MS - 1_000);
    await expect.poll(() => overlayHosts(page)).toEqual({ count: 0, allDirectChildren: true });
    expect((await driver.state(tabId)).status).toBe('translated');

    // Nada sobra: o documento inteiro, sem exclusão, volta ao de antes.
    expect((await driver.state(tabId, 'show-original')).view).toBe('original');
    expect(await fullOuterHtml(page)).toBe(pristine);
    // Alternar a visão depois do fim não traz o indicador de volta.
    expect((await driver.state(tabId, 'show-translation')).view).toBe('translation');
    expect(await overlayHosts(page)).toEqual({ count: 0, allDirectChildren: true });
  });

  for (const scenario of [
    { error: 'network', setUpError: (ollama: MockOllama) => ollama.configure({ mode: 'down' }) },
    {
      error: 'model_missing',
      setUpError: (ollama: MockOllama) => ollama.configure({ models: ['outro-modelo:1b'] }),
    },
  ] as const) {
    test(`c) erro ${scenario.error}: a mensagem persiste e "Fechar" remove o indicador`, async ({
      context,
      serviceWorker,
      extensionId,
      ollama,
    }) => {
      test.setTimeout(45_000);
      const { driver, fixture, probe, pristine } = await setUp(
        context,
        serviceWorker,
        extensionId,
        ollama,
      );
      const { page, tabId } = fixture;
      await scenario.setUpError(ollama);

      expect((await driver.state(tabId, 'start')).status).toBe('translating');
      await expect.poll(statusOf(driver, tabId), { timeout: 15_000 }).toBe('error');
      expect((await driver.state(tabId)).error).toBe(scenario.error);
      const expected = STATE_ERROR_MESSAGES[scenario.error];
      const shown = await overlayWhen(
        probe,
        (snapshot) => snapshot.message === expected && snapshot.status === expected,
      );

      // Janela maior que o prazo do sucesso: o erro não some sozinho.
      expect(await probe.waitForRemoval(shown.hostId, AUTO_HIDE_MS + 1_000)).toBe(false);
      const still = await probe.snapshot();
      if (still === null) throw new Error('Indicador sumiu depois do erro.');
      expect(still.message).toBe(expected);
      expect(await overlayHosts(page)).toEqual({ count: 1, allDirectChildren: true });

      // Clique real (confiável) no centro do botão, que só o CDP enxerga.
      const close = await probe.box(still.closeId);
      expect(close.width).toBeGreaterThan(0);
      expect(close.height).toBeGreaterThan(0);
      await page.mouse.click(close.x + close.width / 2, close.y + close.height / 2);
      await expect.poll(() => overlayHosts(page)).toEqual({ count: 0, allDirectChildren: true });
      // Fechar não mexe no job nem no documento.
      expect((await driver.state(tabId)).status).toBe('error');
      expect(await fullOuterHtml(page)).toBe(pristine);
    });
  }

  test('d) o texto do indicador nunca vai para o Ollama, nem ao recomeçar com ele na tela', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    test.setTimeout(45_000);
    const { driver, fixture, probe } = await setUp(context, serviceWorker, extensionId, ollama);
    const { page, tabId } = fixture;

    // 1) Erro: o indicador fica na tela com a mensagem de erro.
    await ollama.configure({ mode: 'down' });
    await driver.state(tabId, 'start');
    await expect.poll(statusOf(driver, tabId), { timeout: 15_000 }).toBe('error');
    await overlayWhen(probe, (snapshot) => snapshot.message === STATE_ERROR_MESSAGES.network);

    // 2) Recomeça com o erro na tela; a coleta roda com o host presente.
    await ollama.configure({ mode: 'ollama' });
    expect(await overlayHosts(page)).toEqual({ count: 1, allDirectChildren: true });
    expect((await driver.state(tabId, 'start')).status).toBe('translating');
    await expect.poll(statusOf(driver, tabId), { timeout: 15_000 }).toBe('translated');
    await overlayWhen(probe, (snapshot) => snapshot.message === TRANSLATED_MESSAGE);

    // 3) Recomeça com "Página traduzida." na tela (antes de sumir sozinho).
    expect(await overlayHosts(page)).toEqual({ count: 1, allDirectChildren: true });
    expect((await driver.state(tabId, 'start')).status).toBe('translating');
    await expect.poll(statusOf(driver, tabId), { timeout: 15_000 }).toBe('translated');

    const chats = ollama.chatRequests();
    const texts = chats.map(({ text }) => text);
    // Prova de que os pedidos foram lidos: as duas traduções completas chegaram.
    const { done } = await driver.state(tabId);
    expect(done).toBeGreaterThan(0);
    expect(texts.filter((text) => text !== null).length).toBeGreaterThanOrEqual(2 * done);
    const leaks = texts.filter(
      (text) => text === null || OVERLAY_TEXTS.some((snippet) => text.includes(snippet)),
    );
    expect(leaks).toEqual([]);
  });

  test('e) sob CSP estrita (style-src none) o indicador continua estilizado', async ({
    context,
    serviceWorker,
    extensionId,
    ollama,
  }) => {
    const response = await context.request.get(CSP_FIXTURE_URL);
    expect(response.headers()['content-security-policy']).toBe(CSP_FIXTURE_POLICY);

    const { driver, fixture, probe } = await setUp(
      context,
      serviceWorker,
      extensionId,
      ollama,
      CSP_FIXTURE_URL,
    );
    const { page, tabId } = fixture;
    // Controle: a CSP vale de fato (a `<style>` da própria fixture foi bloqueada).
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).not.toBe('serif');
    // MAX_UNITS_IN_FLIGHT = 1: o indicador fica na tela enquanto o pedido está retido.
    ollama.holdChat();

    expect((await driver.state(tabId, 'start')).status).toBe('translating');
    const shown = await overlayWhen(probe, (snapshot) => TRANSLATING.test(snapshot.message));

    const host = await page.evaluate(() => {
      const element = document.querySelector('[data-lerium-ui]');
      if (element === null) return null;
      const style = getComputedStyle(element);
      return { position: style.position, zIndex: style.zIndex };
    });
    expect(host).toEqual({ position: 'fixed', zIndex: '2147483647' });

    const pill = await probe.box(shown.pillId);
    expect(pill.width).toBeGreaterThan(0);
    expect(pill.height).toBeGreaterThan(0);
    // Regras da folha do indicador: `min-width: 200px` e canto inferior direito (16px).
    expect(pill.width).toBeGreaterThanOrEqual(200);
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    expect(pill.x + pill.width).toBeCloseTo(viewport!.width - 16, 0);
    // A entrada anima `translateY(4px)` → 0 (o box model do CDP inclui o
    // transform): espera a pílula assentar a 16px da borda inferior.
    await expect
      .poll(async () => {
        const settled = await probe.box(shown.pillId);
        return Math.round(settled.y + settled.height);
      })
      .toBe(viewport!.height - 16);

    ollama.releaseChat();
    await expect.poll(statusOf(driver, tabId), { timeout: 15_000 }).toBe('translated');
    expect(await outerHtml(page)).not.toBe('');
  });
});
