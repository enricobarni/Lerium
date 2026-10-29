import { describe, expect, it } from 'vitest';
import { originMatchPattern } from '../../src/shared/host-permission';

describe('originMatchPattern', () => {
  it.each([
    ['http://localhost:11434', 'http://localhost:11434/*'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/*'],
    // url.origin omite a porta padrão; sem ela o padrão cobriria TODAS as portas.
    ['http://localhost', 'http://localhost:80/*'],
    ['http://127.0.0.1', 'http://127.0.0.1:80/*'],
  ])('%s → %s', (origin, pattern) => {
    expect(originMatchPattern(origin)).toBe(pattern);
  });

  it('nunca gera padrão sem porta explícita', () => {
    for (const origin of ['http://localhost', 'http://localhost:1', 'http://127.0.0.1:65535']) {
      expect(originMatchPattern(origin)).toMatch(/^http:\/\/[^/]+:\d+\/\*$/);
    }
  });
});
