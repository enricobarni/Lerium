import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extensionIdFromKey } from '../../scripts/extension-id.mjs';

const publicDir = new URL('../../public/', import.meta.url);
const rawManifest = readFileSync(new URL('manifest.json', publicDir), 'utf8');
const manifest = JSON.parse(rawManifest) as Record<string, unknown> & {
  version: string;
  key: unknown;
  icons: Record<string, string>;
  action: { default_popup?: string; default_icon?: Record<string, string> };
  options_ui?: { page?: string; open_in_tab?: boolean };
  permissions: unknown[];
};
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const ICON_SIZES = ['16', '32', '48', '128'];
// Toda chave nova no manifesto exige decisão explícita (ver ADR-002 em docs/DECISIONS.md).
const ALLOWED_KEYS = [
  'action',
  'background',
  'description',
  'host_permissions',
  'icons',
  'key',
  'manifest_version',
  'name',
  'optional_host_permissions',
  'options_ui',
  'permissions',
  'version',
];
// ID derivado da `key` (ADR-007). Mudar a chave muda o ID e exige que o
// usuário atualize OLLAMA_ORIGINS; este valor detecta troca acidental.
const EXPECTED_EXTENSION_ID = 'mjkoppimccgajnabfeheglepjapkchlk';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// Chrome aceita de 1 a 4 inteiros (0–65535) separados por ponto, sem zeros à esquerda.
const CHROME_VERSION = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;

describe('manifest.json', () => {
  it('usa Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('contém apenas chaves aprovadas', () => {
    expect(Object.keys(manifest).sort()).toEqual(ALLOWED_KEYS);
  });

  it('solicita apenas a permissão storage, sem content scripts nem <all_urls>', () => {
    // storage: preferências em chrome.storage.local (ADR-008).
    expect(manifest.permissions).toEqual(['storage']);
    expect(manifest).not.toHaveProperty('content_scripts');
    expect(rawManifest).not.toContain('<all_urls>');
  });

  it('acessa só o Ollama em loopback na porta padrão (ADR-009)', () => {
    expect(manifest.host_permissions).toEqual([
      'http://localhost:11434/*',
      'http://127.0.0.1:11434/*',
    ]);
  });

  it('pede outras portas de loopback só como permissão opcional (ADR-009)', () => {
    expect(manifest.optional_host_permissions).toEqual([
      'http://localhost/*',
      'http://127.0.0.1/*',
    ]);
  });

  it('registra o service worker como módulo em background.js', () => {
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
  });

  it('tem versão válida para o Chrome e igual à do package.json', () => {
    expect(manifest.version).toMatch(CHROME_VERSION);
    expect(manifest.version).toBe(pkg.version);
  });

  it.each(ICON_SIZES)('declara o ícone %s px e o arquivo existe', (size) => {
    const icon = manifest.icons[size];
    expect(icon).toBe(`icons/icon-${size}.png`);
    expect(existsSync(new URL(icon ?? '', publicDir))).toBe(true);
    expect(manifest.action.default_icon?.[size]).toBe(icon);
  });

  it('aponta o popup para popup/index.html', () => {
    expect(manifest.action.default_popup).toBe('popup/index.html');
  });

  it('abre as configurações em options/index.html, em nova aba', () => {
    expect(manifest.options_ui?.page).toBe('options/index.html');
    expect(manifest.options_ui?.open_in_tab).toBe(true);
  });

  it('fixa o ID com uma chave pública em base64 (ADR-007)', () => {
    expect(typeof manifest.key).toBe('string');
    const key = manifest.key as string;
    expect(key).toMatch(BASE64);
    expect(Buffer.from(key, 'base64').toString('base64')).toBe(key);
    expect(rawManifest).not.toContain('PRIVATE KEY');
  });

  it('deriva o ID esperado da chave do manifesto', () => {
    expect(extensionIdFromKey(manifest.key as string)).toBe(EXPECTED_EXTENSION_ID);
  });
});

describe('extensionIdFromKey', () => {
  it('mapeia os 32 primeiros dígitos hex do SHA-256 para a-p', () => {
    // SHA-256 de "abc" = ba7816bf8f01cfea414140de5dae2223...
    const key = Buffer.from('abc').toString('base64');
    expect(extensionIdFromKey(key)).toBe('lkhibglpipabmpokebebeanofnkocccd');
  });

  it('rejeita chave vazia ou fora de base64', () => {
    expect(() => extensionIdFromKey('')).toThrow();
    expect(() => extensionIdFromKey('não é base64!')).toThrow();
  });
});
