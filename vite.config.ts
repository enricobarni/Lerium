import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: fromRoot('./src'),
  publicDir: fromRoot('./public'),
  build: {
    outDir: fromRoot('./dist'),
    emptyOutDir: true,
    // Chrome suporta modulepreload nativamente; o polyfill só adicionaria fetch desnecessário.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup: fromRoot('./src/popup/index.html'),
        options: fromRoot('./src/options/index.html'),
        background: fromRoot('./src/background/index.ts'),
      },
      output: {
        // O manifesto referencia o service worker por nome fixo, na raiz de
        // dist; os demais bundles mantêm hash para evitar cache antigo.
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  test: {
    // Os testes ficam fora de src/, então a raiz do Vitest é a do repositório.
    root: fromRoot('.'),
    // Só unitários: os E2E (tests/e2e, *.spec.ts) rodam no Playwright.
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
  },
});
