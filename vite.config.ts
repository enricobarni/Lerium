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
      },
    },
  },
  test: {
    // Os testes ficam fora de src/, então a raiz do Vitest é a do repositório.
    root: fromRoot('.'),
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
  },
});
