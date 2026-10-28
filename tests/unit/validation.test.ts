import { describe, expect, it } from 'vitest';
import {
  MODEL_MAX_LENGTH,
  isLanguageCode,
  normalizeEndpoint,
  validateLanguage,
  validateModel,
} from '../../src/shared/validation';

describe('normalizeEndpoint', () => {
  it.each([
    ['http://localhost:11434', 'http://localhost:11434'],
    ['http://localhost:11434/', 'http://localhost:11434'],
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['http://localhost', 'http://localhost'],
    ['http://localhost:80', 'http://localhost'],
    ['http://localhost:1', 'http://localhost:1'],
    ['http://localhost:65535', 'http://localhost:65535'],
    // Maiúsculas no esquema e no host são normalizadas pelo URL.
    ['HTTP://LOCALHOST:11434', 'http://localhost:11434'],
    // Espaços nas pontas são removidos (colagem em formulário).
    ['  http://localhost:11434  ', 'http://localhost:11434'],
    // Formas IPv4 alternativas são canonizadas pelo URL para 127.0.0.1 exato;
    // aceitas porque o resultado devolvido é sempre a forma canônica.
    ['http://127.1:11434', 'http://127.0.0.1:11434'],
    ['http://0x7f.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['http://2130706433:11434', 'http://127.0.0.1:11434'],
    ['http://0177.0.0.1:11434', 'http://127.0.0.1:11434'],
    // Zeros à esquerda na porta são canonizados.
    ['http://localhost:011434', 'http://localhost:11434'],
    // Host com escape percentual: o URL decodifica e canoniza antes da lista de
    // hosts permitidos, e o valor devolvido é a origem canônica.
    ['http://%6cocalhost:11434', 'http://localhost:11434'],
    ['http://local%C2%ADhost:11434', 'http://localhost:11434'],
    // `/%2e` resolve para `/`; o resultado é só a origem.
    ['http://localhost/%2e', 'http://localhost'],
  ])('aceita %j como %j', (input, expected) => {
    expect(normalizeEndpoint(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['lixo', 'invalid_url'],
    ['http://', 'invalid_url'],
    ['http://local host:11434', 'invalid_characters'],
    ['http://localhost:11434 /', 'invalid_characters'],
    ['http://local\nhost:11434', 'invalid_characters'],
    ['http://local\thost:11434', 'invalid_characters'],
    ['http://ｌｏｃａｌｈｏｓｔ:11434', 'invalid_characters'],
    ['http://localhost­:11434', 'invalid_characters'],
    ['http://local​host:11434', 'invalid_characters'],
    ['http://localhost :11434', 'invalid_characters'],
    ['http://localhost　:11434', 'invalid_characters'],
    ['http://localhost:11434/caminhoé', 'invalid_characters'],
    // Autoridade vazia: o URL a aceitaria como localhost; exigimos o host
    // logo após `http://`, como já ocorre com `http:/localhost`.
    ['http:///localhost', 'invalid_url'],
    ['http:\\\\localhost:11434', 'invalid_url'],
    ['http://localhost\\@evil.com', 'invalid_url'],
    ['http:localhost:11434', 'invalid_url'],
    ['http:/localhost:11434', 'invalid_url'],
    ['localhost:11434', 'protocol'],
    ['https://localhost:11434', 'protocol'],
    ['ftp://localhost', 'protocol'],
    ['file:///etc/passwd', 'protocol'],
    ['javascript:alert(1)', 'protocol'],
    ['http://example.com', 'host'],
    ['http://192.168.0.10:11434', 'host'],
    ['http://localhost.evil.com', 'host'],
    ['http://evil.com#@localhost', 'hash'],
    ['http://localhost.:11434', 'host'],
    ['http://[::1]:11434', 'host'],
    ['http://127.0.0.2:11434', 'host'],
    ['http://0.0.0.0:11434', 'host'],
    ['http://user:pass@localhost:11434', 'credentials'],
    ['http://user@localhost:11434', 'credentials'],
    ['http://@localhost:11434', 'credentials'],
    ['http://localhost@evil.com', 'credentials'],
    ['http://localhost:0', 'port'],
    ['http://localhost:65536', 'port'],
    ['http://localhost:99999999999999999999', 'port'],
    ['http://localhost:abc', 'port'],
    ['http://user@localhost:70000', 'port'],
    ['http://127.0.0.1@evil.com', 'credentials'],
    ['http://127.0.0.1.nip.io', 'host'],
    ['http://[::ffff:127.0.0.1]', 'host'],
    ['http://localhost/%2e%2e/api', 'path'],
    ['http://localhost:11434/api', 'path'],
    ['http://localhost:11434/api/tags', 'path'],
    ['http://localhost:11434?x=1', 'query'],
    ['http://localhost:11434/?', 'query'],
    ['http://localhost:11434#frag', 'hash'],
    ['http://localhost:11434/#', 'hash'],
  ])('rejeita %j com motivo %j', (input, reason) => {
    expect(normalizeEndpoint(input)).toEqual({ ok: false, reason });
  });

  it('rejeita valores que não são string', () => {
    for (const value of [undefined, null, 11434, {}, ['http://localhost']]) {
      expect(normalizeEndpoint(value)).toEqual({ ok: false, reason: 'invalid_type' });
    }
  });
});

describe('validateModel', () => {
  it.each([
    ['translategemma:4b', 'translategemma:4b'],
    ['  llama3.1:8b  ', 'llama3.1:8b'],
    ['namespace/modelo:latest', 'namespace/modelo:latest'],
  ])('aceita %j como %j', (input, expected) => {
    expect(validateModel(input)).toEqual({ ok: true, value: expected });
  });

  it('aceita o tamanho máximo e rejeita acima dele', () => {
    const max = 'a'.repeat(MODEL_MAX_LENGTH);
    expect(validateModel(max)).toEqual({ ok: true, value: max });
    expect(validateModel(`${max}a`)).toEqual({ ok: false, reason: 'too_long' });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['modelo\u0000', 'invalid_characters'],
    ['mod\nelo', 'invalid_characters'],
    ['mod\u007felo', 'invalid_characters'],
    ['mod\u0085elo', 'invalid_characters'],
    ['meu modelo', 'invalid_characters'],
  ])('rejeita %j com motivo %j', (input, reason) => {
    expect(validateModel(input)).toEqual({ ok: false, reason });
  });

  it('rejeita valores que não são string', () => {
    for (const value of [undefined, null, 4, {}]) {
      expect(validateModel(value)).toEqual({ ok: false, reason: 'invalid_type' });
    }
  });
});

describe('isLanguageCode e validateLanguage', () => {
  it.each(['en', 'pt-BR', 'es', 'ja', 'ko', 'zh-CN'])('aceita %j', (code) => {
    expect(isLanguageCode(code)).toBe(true);
    expect(validateLanguage(code)).toEqual({ ok: true, value: code });
  });

  it.each(['', 'pt', 'pt-br', 'PT-BR', 'fr', ' en', 'zh', 'toString', '__proto__'])(
    'rejeita %j',
    (code) => {
      expect(isLanguageCode(code)).toBe(false);
      expect(validateLanguage(code)).toEqual({ ok: false, reason: 'unsupported' });
    },
  );

  it('rejeita valores que não são string', () => {
    for (const value of [undefined, null, 1, {}, ['en']]) {
      expect(isLanguageCode(value)).toBe(false);
      expect(validateLanguage(value)).toEqual({ ok: false, reason: 'invalid_type' });
    }
  });
});
