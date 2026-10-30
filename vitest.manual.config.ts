import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Testes manuais opt-in com o modelo real no Ollama local. Fora do
 * `npm test`: rode `npm run test:manual` com `LERIUM_MANUAL_OLLAMA=1`.
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['tests/manual/**/*.manual.test.ts'],
    environment: 'node',
    // Modelos locais em hardware modesto podem levar minutos por fixture.
    testTimeout: 600_000,
    passWithNoTests: false,
    // Os metadados de cada execução (console.log) são a evidência do teste
    // manual: exibidos também quando o teste passa. `silent: 'passed-only'`
    // os esconderia; o reporter `verbose` lista cada (fixture, execução).
    silent: false,
    reporters: ['verbose'],
  },
});
