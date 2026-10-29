/**
 * Padrão de correspondência do Chrome para uma origem de loopback já
 * normalizada (`normalizeEndpoint`). A porta é SEMPRE explícita: `url.origin`
 * omite a porta padrão (80), e um padrão sem porta cobriria todas as portas
 * daquele host (verificado no Chromium; ADR-009).
 */
export function originMatchPattern(origin: string): string {
  const url = new URL(origin);
  const port = url.port === '' ? '80' : url.port;
  return `${url.protocol}//${url.hostname}:${port}/*`;
}
