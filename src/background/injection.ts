import type { TranslationSettings } from '../core/types';
import { originMatchPattern } from '../shared/host-permission';
import {
  isDocumentId,
  type PageInjectRequest,
  type PageInjectResponse,
} from '../shared/page-control';
import { normalizeEndpoint } from '../shared/validation';

/**
 * Injeção do content script sob demanda (ADR-002, ADR-010). Módulo puro:
 * `chrome` entra por injeção, e só `index.ts` toca a API. Nenhum detalhe de
 * erro do Chrome é registrado ou repassado; a resposta carrega só códigos.
 */

/** Documentos em que o Lerium injetou o content script, por aba. */
export interface InjectionRegistry {
  register(tabId: number, documentId: string): void;
  isInjected(tabId: number, documentId: string): boolean;
  /** Esquece a aba inteira (aba fechada). */
  forget(tabId: number): void;
}

/**
 * Registro em memória com só o último documento injetado de cada aba
 * (tamanho limitado ao número de abas). Uma nova injeção na mesma aba
 * substitui o documento anterior; um documento antigo restaurado do bfcache
 * volta a ser aceito após nova injeção, que devolve o mesmo `documentId`.
 * Se o service worker for encerrado, o registro se perde e o job de página
 * é recusado até o popup injetar de novo (idempotente no content script).
 */
export function createInjectionRegistry(): InjectionRegistry {
  const documentByTab = new Map<number, string>();
  return {
    register(tabId, documentId) {
      documentByTab.set(tabId, documentId);
    },
    isInjected(tabId, documentId) {
      return documentByTab.get(tabId) === documentId;
    },
    forget(tabId) {
      documentByTab.delete(tabId);
    },
  };
}

export interface InjectDeps {
  /** URL da aba; `null` se o Chrome não a expõe (sem acesso à aba). */
  getTabUrl(tabId: number): Promise<string | null>;
  /** Lê as configurações; `null` (ou rejeição) = indisponíveis. */
  loadSettings(): Promise<TranslationSettings | null>;
  /** Envolve `chrome.permissions.contains({ origins: [pattern] })`. */
  hasOriginPermission(originPattern: string): Promise<boolean>;
  /** Injeta no frame principal; devolve o primeiro resultado ou `null`. */
  executeScript(tabId: number): Promise<{ documentId?: string } | null>;
  registry: InjectionRegistry;
}

function isHttpUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function createInjectHandler(
  deps: InjectDeps,
): (request: PageInjectRequest) => Promise<PageInjectResponse> {
  return async ({ tabId }) => {
    let url: string | null;
    try {
      url = await deps.getTabUrl(tabId);
    } catch {
      url = null;
    }
    if (!isHttpUrl(url)) return { ok: false, error: 'page_unsupported' };

    let settings: TranslationSettings | null;
    try {
      settings = await deps.loadSettings();
    } catch {
      settings = null;
    }
    // Revalida o endpoint: o padrão de permissão depende dele.
    const endpoint = settings === null ? null : normalizeEndpoint(settings.endpoint);
    if (endpoint === null || !endpoint.ok) return { ok: false, error: 'settings_unavailable' };

    // Mesma regra do teste de conexão: sem permissão para a origem exata do
    // endpoint, a tradução falharia. A porta padrão (11434) é concedida pelo
    // manifesto, então `contains` só recusa portas personalizadas.
    let granted: boolean;
    try {
      granted = await deps.hasOriginPermission(originMatchPattern(endpoint.value));
    } catch {
      granted = false;
    }
    if (!granted) return { ok: false, error: 'permission_required' };

    let result: { documentId?: string } | null;
    try {
      result = await deps.executeScript(tabId);
    } catch {
      // Página protegida (Web Store, chrome://, PDF...) ou aba fechada.
      return { ok: false, error: 'page_unsupported' };
    }
    const documentId = result?.documentId;
    if (!isDocumentId(documentId)) return { ok: false, error: 'injection_failed' };

    deps.registry.register(tabId, documentId);
    return { ok: true, documentId };
  };
}
