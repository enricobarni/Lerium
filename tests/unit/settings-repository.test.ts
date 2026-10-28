import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/core/constants';
import {
  SETTINGS_STORAGE_KEY,
  createSettingsRepository,
} from '../../src/storage/settings-repository';
import { FakeStorageArea } from '../mocks/fake-storage-area';

const VALID_INPUT = {
  endpoint: 'http://127.0.0.1:8080/',
  model: '  llama3.1:8b ',
  sourceLanguage: 'ja',
  targetLanguage: 'pt-BR',
};

const SAVED = {
  schemaVersion: 1,
  endpoint: 'http://127.0.0.1:8080',
  model: 'llama3.1:8b',
  sourceLanguage: 'ja',
  targetLanguage: 'pt-BR',
};

describe('settings-repository: load', () => {
  it('storage vazio devolve os padrões sem gravar', async () => {
    const area = new FakeStorageArea();
    const settings = await createSettingsRepository(area).load();

    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings).not.toBe(DEFAULT_SETTINGS);
    expect(area.setCalls).toBe(0);
    expect(area.snapshot()).toEqual({});
  });

  it('mescla configuração parcial com os padrões', async () => {
    const area = new FakeStorageArea({ settings: { schemaVersion: 1, model: 'qwen3:8b' } });
    const settings = await createSettingsRepository(area).load();

    expect(settings).toEqual({ ...DEFAULT_SETTINGS, model: 'qwen3:8b' });
    expect(area.setCalls).toBe(0);
  });

  it('campo inválido cai no padrão só em memória, sem regravar', async () => {
    const stored = {
      schemaVersion: 1,
      endpoint: 'https://evil.example.com',
      model: '',
      sourceLanguage: 'ko',
      targetLanguage: 'klingon',
    };
    const area = new FakeStorageArea({ settings: stored });
    const before = area.snapshot();

    const settings = await createSettingsRepository(area).load();

    expect(settings).toEqual({ ...DEFAULT_SETTINGS, sourceLanguage: 'ko' });
    expect(area.setCalls).toBe(0);
    expect(area.snapshot()).toEqual(before);
  });

  it('normaliza endpoint e modelo armazenados apenas em memória', async () => {
    const area = new FakeStorageArea({
      settings: { endpoint: ' http://LOCALHOST:11434/ ', model: ' qwen3:8b ' },
    });
    const before = area.snapshot();
    const settings = await createSettingsRepository(area).load();

    expect(settings.endpoint).toBe('http://localhost:11434');
    expect(settings.model).toBe('qwen3:8b');
    expect(area.setCalls).toBe(0);
    expect(area.snapshot()).toEqual(before);
  });

  it.each([['texto'], [null], [42], [true], [['http://localhost']]])(
    'valor não-objeto em settings (%j) devolve os padrões sem gravar',
    async (value) => {
      const area = new FakeStorageArea({ settings: value });
      const settings = await createSettingsRepository(area).load();

      expect(settings).toEqual(DEFAULT_SETTINGS);
      expect(area.setCalls).toBe(0);
    },
  );

  it('carregamentos repetidos (atualização da extensão) não alteram o storage', async () => {
    const area = new FakeStorageArea({
      settings: { ...SAVED, futureOption: { nested: true } },
      outraChave: 'intocada',
    });
    const before = area.snapshot();

    // Cada "atualização" recria o repositório, como um novo contexto da extensão.
    for (let i = 0; i < 3; i += 1) {
      expect(await createSettingsRepository(area).load()).toEqual(SAVED);
    }

    expect(area.setCalls).toBe(0);
    expect(area.snapshot()).toEqual(before);
  });

  it('devolve sempre a versão de schema atual', async () => {
    const area = new FakeStorageArea({ settings: { schemaVersion: 'x', model: 'qwen3:8b' } });
    const settings = await createSettingsRepository(area).load();

    expect(settings.schemaVersion).toBe(1);
  });

  it('não expõe chaves desconhecidas no objeto carregado', async () => {
    const area = new FakeStorageArea({ settings: { ...SAVED, futureOption: 1 } });
    const settings = await createSettingsRepository(area).load();

    expect(Object.keys(settings).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
});

describe('settings-repository: save', () => {
  it('persiste valores normalizados e load devolve o mesmo', async () => {
    const area = new FakeStorageArea();
    const repository = createSettingsRepository(area);

    const result = await repository.save(VALID_INPUT);

    expect(result).toEqual({ ok: true, settings: SAVED });
    expect(area.setCalls).toBe(1);
    expect(area.data.get(SETTINGS_STORAGE_KEY)).toEqual(SAVED);
    expect(await createSettingsRepository(area).load()).toEqual(SAVED);
  });

  it('entrada inválida não grava e devolve erros por campo', async () => {
    const area = new FakeStorageArea({ settings: SAVED });
    const before = area.snapshot();

    const result = await createSettingsRepository(area).save({
      endpoint: 'http://example.com',
      model: '   ',
      sourceLanguage: 'fr',
      targetLanguage: 'pt-BR',
    });

    expect(result).toEqual({
      ok: false,
      errors: { endpoint: 'host', model: 'empty', sourceLanguage: 'unsupported' },
    });
    expect(area.setCalls).toBe(0);
    expect(area.snapshot()).toEqual(before);
  });

  it('um único campo inválido já impede a gravação', async () => {
    const area = new FakeStorageArea();
    const result = await createSettingsRepository(area).save({
      ...VALID_INPUT,
      targetLanguage: undefined,
    });

    expect(result).toEqual({ ok: false, errors: { targetLanguage: 'invalid_type' } });
    expect(area.setCalls).toBe(0);
  });

  it('preserva chaves desconhecidas dentro de settings e outras chaves do storage', async () => {
    const area = new FakeStorageArea({
      settings: { schemaVersion: 1, model: 'antigo', futureOption: [1, 2], maxParallel: 3 },
      outraChave: 'intocada',
    });

    await createSettingsRepository(area).save(VALID_INPUT);

    expect(area.data.get(SETTINGS_STORAGE_KEY)).toEqual({
      ...SAVED,
      futureOption: [1, 2],
      maxParallel: 3,
    });
    expect(area.data.get('outraChave')).toBe('intocada');
  });

  it('não grava campos extras vindos da entrada', async () => {
    const area = new FakeStorageArea();
    const input: Record<string, unknown> = { ...VALID_INPUT, injected: 'x' };
    await createSettingsRepository(area).save(input as typeof VALID_INPUT);

    expect(area.data.get(SETTINGS_STORAGE_KEY)).toEqual(SAVED);
  });

  it.each([['texto'], [null], [42], [['a']]])(
    'substitui settings não-objeto (%j) por um objeto válido',
    async (value) => {
      const area = new FakeStorageArea({ settings: value });

      const result = await createSettingsRepository(area).save(VALID_INPUT);

      expect(result.ok).toBe(true);
      expect(area.data.get(SETTINGS_STORAGE_KEY)).toEqual(SAVED);
    },
  );

  it('grava schemaVersion 1 mesmo que o armazenado seja diferente', async () => {
    const area = new FakeStorageArea({ settings: { schemaVersion: 0 } });
    await createSettingsRepository(area).save(VALID_INPUT);

    expect(area.data.get(SETTINGS_STORAGE_KEY)).toMatchObject({ schemaVersion: 1 });
  });
});
