import {
  parsePageCommandResponse,
  parsePageInjectResponse,
  type PageCommandName,
} from '../shared/page-control';
import { describePage, type PageViewInput, type PageViewModel } from './page-view';

/**
 * Controlador do popup: consulta e comanda o job da aba ativa. Módulo sem
 * `chrome` nem DOM; tudo entra por `PopupDeps` e só `index.ts` liga a API.
 * Respostas são sempre validadas pelos parsers do contrato; nada do que volta
 * vai para log.
 */

export const POLL_INTERVAL_MS = 1000;

/**
 * Prazo para o service worker ou o content script responderem. Sem ele, uma
 * mensagem que nunca volta deixaria o popup preso em "Preparando a página…".
 */
export const RESPONSE_TIMEOUT_MS = 10_000;

/** Resultado de uma espera que estourou o prazo. */
const TIMED_OUT: unique symbol = Symbol('timed-out');

export interface ActiveTab {
  id: number;
  url?: string;
}

export interface PopupDeps {
  /** Aba ativa da janela atual; `null` se não houver. */
  getActiveTab(): Promise<ActiveTab | null>;
  /** `page:inject` ao service worker; devolve a resposta crua. */
  sendInject(tabId: number): Promise<unknown>;
  /** `page:command` ao frame principal; rejeita quando não há content script. */
  sendCommand(tabId: number, command: PageCommandName): Promise<unknown>;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  /** Prazo das respostas (`RESPONSE_TIMEOUT_MS`); injetado para os testes. */
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  render(view: PageViewModel): void;
}

export interface PopupController {
  open(): Promise<void>;
  translate(): Promise<void>;
  cancel(): Promise<void>;
  showOriginal(): Promise<void>;
  showTranslation(): Promise<void>;
  /** Popup fechando: para o polling e ignora respostas pendentes. */
  dispose(): void;
}

/**
 * Só `http:`/`https:` podem ser traduzidas. URL ausente não decide nada: o
 * service worker revalida na injeção e responde `page_unsupported`.
 */
function isUnsupportedUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const { protocol } = new URL(url);
    return protocol !== 'http:' && protocol !== 'https:';
  } catch {
    return true;
  }
}

export function createPopupController(deps: PopupDeps): PopupController {
  let tabId: number | null = null;
  let disposed = false;
  /** Ação do usuário em andamento: novas ações e o polling esperam. */
  let acting = false;
  let polling: unknown = null;
  let pollInFlight = false;
  /** Cada ação invalida consultas anteriores ainda pendentes. */
  let generation = 0;
  /** Prazos em andamento; o `dispose` limpa os que sobrarem. */
  const deadlines = new Set<unknown>();

  function stopPolling(): void {
    if (polling === null) return;
    deps.clearInterval(polling);
    polling = null;
  }

  /**
   * Espera `request` por até `RESPONSE_TIMEOUT_MS`. Estourado o prazo, resolve
   * com `TIMED_OUT`; a resposta tardia é ignorada. O timer é limpo em todo
   * caminho (resposta, rejeição, exceção síncrona ou prazo).
   */
  function withDeadline<T>(request: () => Promise<T>): Promise<T | typeof TIMED_OUT> {
    return new Promise((resolve, reject) => {
      const timer = deps.setTimeout(() => {
        deadlines.delete(timer);
        resolve(TIMED_OUT);
      }, RESPONSE_TIMEOUT_MS);
      deadlines.add(timer);
      const release = (): void => {
        if (deadlines.delete(timer)) deps.clearTimeout(timer);
      };
      let pending: Promise<T>;
      try {
        pending = request();
      } catch (error) {
        release();
        reject(error);
        return;
      }
      pending.then(
        (value) => {
          release();
          resolve(value);
        },
        (error: unknown) => {
          release();
          reject(error);
        },
      );
    });
  }

  function show(input: PageViewInput): void {
    if (disposed) return;
    deps.render(describePage(input));
    const translating = input.kind === 'state' && input.state.status === 'translating';
    if (!translating) stopPolling();
    else if (polling === null) polling = deps.setInterval(poll, POLL_INTERVAL_MS);
  }

  /** Envia o comando e converte a resposta (ou a falta dela) em entrada da view. */
  async function runCommand(id: number, command: PageCommandName): Promise<PageViewInput> {
    let raw: unknown;
    try {
      raw = await withDeadline(() => deps.sendCommand(id, command));
    } catch {
      // Sem content script: página nova, recarregada ou nunca injetada.
      return { kind: 'not_injected' };
    }
    // Há quem responda, mas a resposta não serve (ou não veio): falha de
    // comando, não de preparo da página.
    if (raw === TIMED_OUT) return { kind: 'command_error' };
    const response = parsePageCommandResponse(raw);
    if (response === null || !response.ok) return { kind: 'command_error' };
    return { kind: 'state', state: response.state };
  }

  function poll(): void {
    if (disposed || acting || pollInFlight || tabId === null) return;
    const id = tabId;
    const ticket = generation;
    pollInFlight = true;
    void runCommand(id, 'get-state').then((input) => {
      pollInFlight = false;
      if (ticket === generation) show(input);
    });
  }

  /** Executa uma ação exclusiva; resultados de consultas anteriores são descartados. */
  async function act(work: (id: number) => Promise<PageViewInput>): Promise<void> {
    if (disposed || acting || tabId === null) return;
    const id = tabId;
    acting = true;
    generation += 1;
    try {
      show(await work(id));
    } finally {
      acting = false;
    }
  }

  async function inject(id: number): Promise<PageViewInput | null> {
    let raw: unknown;
    try {
      raw = await withDeadline(() => deps.sendInject(id));
    } catch {
      return { kind: 'inject_error', error: 'injection_failed' };
    }
    if (raw === TIMED_OUT) return { kind: 'inject_error', error: 'injection_failed' };
    const response = parsePageInjectResponse(raw);
    if (response === null) return { kind: 'inject_error', error: 'invalid_request' };
    if (!response.ok) return { kind: 'inject_error', error: response.error };
    return null;
  }

  return {
    async open() {
      let tab: ActiveTab | null;
      try {
        tab = await deps.getActiveTab();
      } catch {
        tab = null;
      }
      if (tab === null || isUnsupportedUrl(tab.url)) {
        show({ kind: 'unsupported' });
        return;
      }
      tabId = tab.id;
      await act((id) => runCommand(id, 'get-state'));
    },

    translate() {
      return act(async (id) => {
        show({ kind: 'busy' });
        // Contrato (page-control.ts): `page:inject` imediatamente antes de
        // todo `start`, pois o registro do service worker pode ter sumido.
        const failure = await inject(id);
        if (failure !== null) return failure;
        const input = await runCommand(id, 'start');
        // Injeção acabou de dar certo: sem resposta aqui, a preparação falhou.
        return input.kind === 'not_injected'
          ? { kind: 'inject_error', error: 'injection_failed' }
          : input;
      });
    },

    cancel: () => act((id) => runCommand(id, 'cancel')),
    showOriginal: () => act((id) => runCommand(id, 'show-original')),
    showTranslation: () => act((id) => runCommand(id, 'show-translation')),

    dispose() {
      disposed = true;
      stopPolling();
      for (const timer of deadlines) deps.clearTimeout(timer);
      deadlines.clear();
    },
  };
}
