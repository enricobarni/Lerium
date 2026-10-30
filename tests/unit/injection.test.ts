import { describe, expect, it, vi } from 'vitest';
import {
  createInjectHandler,
  createInjectionRegistry,
  type InjectDeps,
} from '../../src/background/injection';
import type { TranslationSettings } from '../../src/core/types';
import type { PageInjectRequest } from '../../src/shared/page-control';

const SETTINGS: TranslationSettings = {
  schemaVersion: 1,
  endpoint: 'http://localhost:11434',
  model: 'translategemma:4b',
  sourceLanguage: 'en',
  targetLanguage: 'pt-BR',
};

const DOCUMENT_ID = '5D1A0F2C3B4E5F60718293A4B5C6D7E8';
const REQUEST: PageInjectRequest = { type: 'page:inject', tabId: 7 };

const setup = (overrides: Partial<InjectDeps> = {}) => {
  const registry = createInjectionRegistry();
  const deps = {
    getTabUrl: vi.fn(async (): Promise<string | null> => 'https://example.com/novel/1'),
    loadSettings: vi.fn(async (): Promise<TranslationSettings | null> => SETTINGS),
    hasOriginPermission: vi.fn(async () => true),
    executeScript: vi.fn(async (): Promise<{ documentId?: string } | null> => ({
      documentId: DOCUMENT_ID,
    })),
    registry,
    ...overrides,
  };
  return { deps, registry, inject: createInjectHandler(deps) };
};

describe('createInjectionRegistry', () => {
  it('registra por aba e documento', () => {
    const registry = createInjectionRegistry();
    registry.register(7, 'DOC-A');

    expect(registry.isInjected(7, 'DOC-A')).toBe(true);
    expect(registry.isInjected(7, 'DOC-B')).toBe(false);
    expect(registry.isInjected(8, 'DOC-A')).toBe(false);
  });

  it('mantém abas diferentes separadas', () => {
    const registry = createInjectionRegistry();
    registry.register(7, 'DOC-A');
    registry.register(8, 'DOC-B');

    expect(registry.isInjected(7, 'DOC-A')).toBe(true);
    expect(registry.isInjected(8, 'DOC-B')).toBe(true);
    expect(registry.isInjected(7, 'DOC-B')).toBe(false);
  });

  it('nova injeção na mesma aba substitui o documento anterior', () => {
    const registry = createInjectionRegistry();
    registry.register(7, 'DOC-A');
    registry.register(7, 'DOC-B');

    expect(registry.isInjected(7, 'DOC-A')).toBe(false);
    expect(registry.isInjected(7, 'DOC-B')).toBe(true);
  });

  it('forget esquece só a aba informada', () => {
    const registry = createInjectionRegistry();
    registry.register(7, 'DOC-A');
    registry.register(8, 'DOC-B');
    registry.forget(7);

    expect(registry.isInjected(7, 'DOC-A')).toBe(false);
    expect(registry.isInjected(8, 'DOC-B')).toBe(true);
    expect(() => registry.forget(99)).not.toThrow();
  });
});

describe('createInjectHandler: sucesso', () => {
  it('injeta, registra o documento e devolve o documentId', async () => {
    const { deps, registry, inject } = setup();

    await expect(inject(REQUEST)).resolves.toEqual({ ok: true, documentId: DOCUMENT_ID });
    expect(deps.getTabUrl).toHaveBeenCalledExactlyOnceWith(7);
    expect(deps.hasOriginPermission).toHaveBeenCalledExactlyOnceWith('http://localhost:11434/*');
    expect(deps.executeScript).toHaveBeenCalledExactlyOnceWith(7);
    expect(registry.isInjected(7, DOCUMENT_ID)).toBe(true);
  });

  it('aceita http e registra cada aba com seu documento', async () => {
    const { registry, inject } = setup({
      getTabUrl: async () => 'http://example.org/',
      executeScript: async (tabId) => ({ documentId: `DOC-${tabId}` }),
    });

    await inject({ type: 'page:inject', tabId: 7 });
    await inject({ type: 'page:inject', tabId: 8 });

    expect(registry.isInjected(7, 'DOC-7')).toBe(true);
    expect(registry.isInjected(8, 'DOC-8')).toBe(true);
    expect(registry.isInjected(7, 'DOC-8')).toBe(false);
  });

  it('consulta a permissão da origem exata de uma porta personalizada', async () => {
    const { deps, inject } = setup({
      loadSettings: async () => ({ ...SETTINGS, endpoint: 'http://127.0.0.1:8080' }),
    });

    await inject(REQUEST);

    expect(deps.hasOriginPermission).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:8080/*');
  });
});

describe('createInjectHandler: erros', () => {
  it.each([
    ['url ausente', null],
    ['chrome://', 'chrome://settings/'],
    ['página de extensão', 'chrome-extension://abc/x.html'],
    ['file://', 'file:///C:/livro.html'],
    ['url inválida', 'não é url'],
  ])('%s vira page_unsupported sem injetar', async (_label, url) => {
    const { deps, registry, inject } = setup({ getTabUrl: async () => url });

    await expect(inject(REQUEST)).resolves.toEqual({ ok: false, error: 'page_unsupported' });
    expect(deps.loadSettings).not.toHaveBeenCalled();
    expect(deps.executeScript).not.toHaveBeenCalled();
    expect(registry.isInjected(7, DOCUMENT_ID)).toBe(false);
  });

  it('falha ao ler a aba vira page_unsupported', async () => {
    const { deps, inject } = setup({
      getTabUrl: async () => {
        throw new Error('No tab with id: 7');
      },
    });

    await expect(inject(REQUEST)).resolves.toEqual({ ok: false, error: 'page_unsupported' });
    expect(deps.executeScript).not.toHaveBeenCalled();
  });

  it.each([
    ['null', async () => null],
    [
      'rejeição',
      async () => {
        throw new Error('storage');
      },
    ],
    ['endpoint inválido', async () => ({ ...SETTINGS, endpoint: 'http://example.com:11434' })],
  ])(
    'configurações indisponíveis (%s) viram settings_unavailable',
    async (_label, loadSettings) => {
      const { deps, inject } = setup({ loadSettings });

      await expect(inject(REQUEST)).resolves.toEqual({ ok: false, error: 'settings_unavailable' });
      expect(deps.hasOriginPermission).not.toHaveBeenCalled();
      expect(deps.executeScript).not.toHaveBeenCalled();
    },
  );

  it('sem permissão para o endpoint devolve permission_required', async () => {
    const { deps, inject } = setup({
      loadSettings: async () => ({ ...SETTINGS, endpoint: 'http://localhost:8080' }),
      hasOriginPermission: vi.fn(async () => false),
    });

    await expect(inject(REQUEST)).resolves.toEqual({ ok: false, error: 'permission_required' });
    expect(deps.executeScript).not.toHaveBeenCalled();
  });

  it('falha ao consultar a permissão também vira permission_required', async () => {
    const { deps, inject } = setup({
      hasOriginPermission: async () => {
        throw new Error('x');
      },
    });

    await expect(inject(REQUEST)).resolves.toEqual({ ok: false, error: 'permission_required' });
    expect(deps.executeScript).not.toHaveBeenCalled();
  });

  it('executeScript rejeitado vira page_unsupported sem registrar', async () => {
    const { registry, inject } = setup({
      executeScript: async () => {
        throw new Error('Cannot access contents of the page');
      },
    });

    await expect(inject(REQUEST)).resolves.toEqual({ ok: false, error: 'page_unsupported' });
    expect(registry.isInjected(7, DOCUMENT_ID)).toBe(false);
  });

  it.each([
    ['sem resultado', null],
    ['sem documentId', {}],
    ['documentId vazio', { documentId: '' }],
    ['documentId com espaço', { documentId: 'DOC 1' }],
    ['documentId longo demais', { documentId: 'A'.repeat(129) }],
  ])('%s vira injection_failed sem registrar', async (_label, result) => {
    const { registry, inject } = setup({ executeScript: async () => result });

    await expect(inject(REQUEST)).resolves.toEqual({ ok: false, error: 'injection_failed' });
    expect(registry.isInjected(7, '')).toBe(false);
    expect(registry.isInjected(7, 'DOC 1')).toBe(false);
  });
});
