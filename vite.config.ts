import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

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
});
