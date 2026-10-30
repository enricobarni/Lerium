/**
 * Guarda de idempotência da entrada do content script: a injeção sob demanda
 * (`chrome.scripting.executeScript`) pode rodar o mesmo arquivo mais de uma
 * vez no mesmo documento, e cada execução registraria ouvintes e um runner
 * novos. O `host` é o `globalThis` do mundo isolado da extensão, que a página
 * não enxerga.
 *
 * A marca é gravada antes de `install` rodar (não configurável, não
 * enumerável): uma execução reentrante ou uma falha no meio não instala duas
 * vezes. Devolve `true` se instalou agora.
 */
export function installOnce(host: object, key: symbol, install: () => void): boolean {
  if (Object.hasOwn(host, key)) return false;
  Object.defineProperty(host, key, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  install();
  return true;
}
