import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OLLAMA_ORIGINS,
  describeConnectionResult,
  hostPermissionPattern,
  type ConnectionResult,
} from '../../src/options/connection-view';
import {
  connectedMessage,
  connectionErrorMessage,
  missingModelMessage,
  permissionDeniedMessage,
  type ConnectionErrorKind,
} from '../../src/options/messages';

const ERRORS: ConnectionErrorKind[] = [
  'invalid_endpoint',
  'invalid_model',
  'network',
  'timeout',
  'forbidden',
  'not_found',
  'http_error',
  'invalid_response',
  'permission_required',
  'invalid_request',
  'extension_error',
];

const NOT_FORBIDDEN = ERRORS.filter((error) => error !== 'forbidden');

const failure = (error: ConnectionErrorKind): ConnectionResult =>
  ({ ok: false, error }) as ConnectionResult;

const cases = ERRORS.flatMap(
  (error) =>
    [
      [error, true],
      [error, false],
    ] as const,
);

describe('describeConnectionResult: erros', () => {
  it.each(cases)('"%s" (userInitiated=%s) usa a mensagem do código', (error, userInitiated) => {
    const view = describeConnectionResult(failure(error), { userInitiated });
    expect(view.message).toBe(connectionErrorMessage(error));
    expect(view.modelWarning).toBeUndefined();
  });

  it('forbidden revela a seção no teste automático, sem focar', () => {
    const view = describeConnectionResult(failure('forbidden'), { userInitiated: false });
    expect(view).toMatchObject({ tone: 'error', revealOriginHelp: true, focusOriginHelp: false });
  });

  it('forbidden revela e foca a seção no teste manual', () => {
    const view = describeConnectionResult(failure('forbidden'), { userInitiated: true });
    expect(view).toMatchObject({ tone: 'error', revealOriginHelp: true, focusOriginHelp: true });
  });

  it.each(
    NOT_FORBIDDEN.flatMap(
      (error) =>
        [
          [error, true],
          [error, false],
        ] as const,
    ),
  )('"%s" (userInitiated=%s) não revela nem foca a seção', (error, userInitiated) => {
    const view = describeConnectionResult(failure(error), { userInitiated });
    expect(view.revealOriginHelp).toBe(false);
    expect(view.focusOriginHelp).toBe(false);
  });

  it('permission_required é aviso; os demais erros são erro', () => {
    for (const error of ERRORS) {
      const view = describeConnectionResult(failure(error), { userInitiated: true });
      expect(view.tone).toBe(error === 'permission_required' ? 'warning' : 'error');
    }
  });

  it('http_error cita o status', () => {
    const view = describeConnectionResult(
      { ok: false, error: 'http_error', status: 500 },
      { userInitiated: true },
    );
    expect(view.message).toMatch(/500/);
  });
});

describe('describeConnectionResult: sucesso', () => {
  it.each([true, false])('modelo instalado (userInitiated=%s) não avisa', (userInitiated) => {
    const view = describeConnectionResult(
      { ok: true, models: ['a:1', 'b:2'], modelInstalled: true },
      { userInitiated, model: 'a:1' },
    );
    expect(view).toEqual({
      message: connectedMessage(2),
      tone: 'success',
      revealOriginHelp: false,
      focusOriginHelp: false,
    });
  });

  it.each([true, false])('modelo ausente (userInitiated=%s) avisa', (userInitiated) => {
    const view = describeConnectionResult(
      { ok: true, models: [], modelInstalled: false },
      { userInitiated, model: 'qwen3:8b' },
    );
    expect(view).toMatchObject({
      tone: 'success',
      revealOriginHelp: false,
      focusOriginHelp: false,
    });
    expect(view.modelWarning).toBe(missingModelMessage('qwen3:8b'));
  });
});

describe('hostPermissionPattern', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../public/manifest.json', import.meta.url)), 'utf8'),
  ) as { optional_host_permissions: string[] };

  // Padrão de manifesto sem porta cobre todas as portas do host.
  const coveredByOptional = (pattern: string): boolean => {
    const host = new URL(pattern.replace('/*', '/')).hostname;
    return manifest.optional_host_permissions.includes(`http://${host}/*`);
  };

  it.each(['http://localhost:11434', 'http://127.0.0.1:11434'])(
    'porta padrão %s não pede permissão',
    (origin) => {
      expect(DEFAULT_OLLAMA_ORIGINS.has(origin)).toBe(true);
      expect(hostPermissionPattern(origin)).toBeUndefined();
    },
  );

  it.each(['http://localhost:8080', 'http://127.0.0.1:11435', 'http://localhost'])(
    'porta personalizada %s pede só a origem exata',
    (origin) => {
      const pattern = hostPermissionPattern(origin);
      expect(pattern).toBe(`${origin}/*`);
      expect(coveredByOptional(pattern as string)).toBe(true);
    },
  );

  it('negação cita a origem e não sugere curinga', () => {
    const message = permissionDeniedMessage('http://localhost:8080');
    expect(message).toBe(
      'Sem permissão para acessar http://localhost:8080, o Lerium não consegue falar com o Ollama nessa porta.',
    );
    expect(message).not.toContain('*');
  });
});
