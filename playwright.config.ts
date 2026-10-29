import { defineConfig } from '@playwright/test';

/**
 * E2E no Chromium do Playwright com a extensão de `dist/` carregada. O build
 * não é feito aqui: rode `npm run build` antes de `npm run test:e2e`.
 * Um único worker: o mock do Ollama ocupa a porta padrão 11434.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  timeout: 30_000,
  use: {
    trace: 'on-first-retry',
  },
});
