import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const publicDir = new URL('../../public/', import.meta.url);
const rawManifest = readFileSync(new URL('manifest.json', publicDir), 'utf8');
const manifest = JSON.parse(rawManifest) as Record<string, unknown> & {
  version: string;
  icons: Record<string, string>;
  action: { default_popup?: string; default_icon?: Record<string, string> };
  permissions: unknown[];
};
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const ICON_SIZES = ['16', '32', '48', '128'];
// Chrome aceita de 1 a 4 inteiros (0–65535) separados por ponto, sem zeros à esquerda.
const CHROME_VERSION = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;

describe('manifest.json', () => {
  it('usa Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('não solicita permissões nem acesso a sites', () => {
    expect(manifest.permissions).toEqual([]);
    expect(manifest).not.toHaveProperty('host_permissions');
    expect(manifest).not.toHaveProperty('optional_host_permissions');
    expect(manifest).not.toHaveProperty('content_scripts');
    expect(rawManifest).not.toContain('<all_urls>');
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
});
