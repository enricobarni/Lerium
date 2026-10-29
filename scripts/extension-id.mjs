// Imprime a origem da extensão derivada da `key` do manifesto (ADR-007),
// para configurar OLLAMA_ORIGINS. Uso: npm run extension-id
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ID_LENGTH = 32;
const CHAR_CODE_A = 'a'.charCodeAt(0);

/**
 * Calcula o ID da extensão como o Chrome: SHA-256 da chave pública (DER),
 * 32 primeiros dígitos hexadecimais, cada um mapeado de 0-f para a-p.
 * @param {string} base64Key chave pública SPKI em DER, codificada em base64
 * @returns {string}
 */
export function extensionIdFromKey(base64Key) {
  if (typeof base64Key !== 'string' || !BASE64.test(base64Key)) {
    throw new TypeError('A chave do manifesto deve ser um texto base64 não vazio.');
  }
  const hex = createHash('sha256')
    .update(Buffer.from(base64Key, 'base64'))
    .digest('hex')
    .slice(0, ID_LENGTH);
  return Array.from(hex, (digit) =>
    String.fromCharCode(CHAR_CODE_A + Number.parseInt(digit, 16)),
  ).join('');
}

function main() {
  const manifest = JSON.parse(
    readFileSync(`${import.meta.dirname}/../public/manifest.json`, 'utf8'),
  );
  process.stdout.write(`chrome-extension://${extensionIdFromKey(manifest.key)}\n`);
}

// Executa só quando chamado diretamente, não quando importado pelos testes.
if (process.argv[1] === import.meta.filename) {
  main();
}
