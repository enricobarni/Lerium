import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Build do content script, separado do principal (vite.config.ts).
 *
 * `chrome.scripting.executeScript({ files })` injeta um script clássico: não
 * aceita `import`/`export` nem carrega chunks. Por isso a entrada vira um único
 * IIFE autocontido em `dist/content.js` (nome fixo, sem hash, referenciado pelo
 * service worker). Roda depois do build principal: não limpa `dist/` nem copia
 * `public/` de novo. `scripts/verify-dist.mjs` confere o resultado.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: fromRoot('./dist'),
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: fromRoot('./src/content/index.ts'),
      formats: ['iife'],
      name: 'LeriumContent',
      fileName: () => 'content.js',
    },
    // Sem rollupOptions: o formato iife já desliga a divisão em chunks
    // (`codeSplitting: false`), então todo o código fica inline.
  },
});
