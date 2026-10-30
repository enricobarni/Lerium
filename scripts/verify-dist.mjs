// Confere o resultado do build antes de carregar a extensão.
// Uso: node scripts/verify-dist.mjs [diretório]   (padrão: dist)
// Roda no fim de `npm run build`, também no CI. Sai com código 1 se falhar.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const distDir = resolve(process.argv[2] ?? 'dist');

// Teto do content script. O bundle atual tem ~18 KB; 200 KB dá folga ampla e
// ainda pega um engano grosseiro, como uma dependência pesada (ex.: jsdom)
// arrastada para dentro do script injetado em toda página traduzida.
const CONTENT_MAX_BYTES = 200 * 1024;

// APIs proibidas no content script: inserção de HTML (a saída do modelo entra
// só por textContent/nodeValue), rede e storage (ficam no service worker) e
// avaliação dinâmica de código.
const CONTENT_FORBIDDEN = [
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'fetch(',
  'chrome.storage',
  'eval(',
  'new Function',
];

const errors = [];
const fail = (message) => errors.push(message);

/** Lista os arquivos de `dir`, recursivamente. */
function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

/** Caminhos de arquivo referenciados pelo manifesto. */
function manifestFiles(manifest) {
  const files = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ];
  return [...new Set(files.filter((file) => typeof file === 'string'))];
}

function verifyContentScript() {
  const path = join(distDir, 'content.js');
  if (!existsSync(path)) {
    fail('content.js ausente: rode `vite build -c vite.content.config.ts`.');
    return;
  }
  const code = readFileSync(path, 'utf8');

  // executeScript injeta um script clássico: import/export não compilam aqui.
  try {
    new vm.Script(code, { filename: 'content.js' });
  } catch (error) {
    fail(`content.js não compila como script clássico (import/export?): ${error.message}`);
  }

  for (const token of CONTENT_FORBIDDEN) {
    if (code.includes(token)) fail(`content.js contém "${token}", proibido no content script.`);
  }

  const size = statSync(path).size;
  if (size > CONTENT_MAX_BYTES) {
    fail(`content.js tem ${size} bytes, acima do teto de ${CONTENT_MAX_BYTES} bytes.`);
  }
  return size;
}

function verifyNoJsdom(files) {
  // jsdom é só ambiente de teste (ADR-012); nunca pode ir para a extensão.
  for (const file of files) {
    if (readFileSync(file, 'utf8').includes('jsdom')) {
      fail(`${relative(distDir, file)} contém "jsdom", que é só ambiente de teste.`);
    }
  }
}

function verifyManifest() {
  const path = join(distDir, 'manifest.json');
  if (!existsSync(path)) {
    fail('manifest.json ausente.');
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`manifest.json inválido: ${error.message}`);
    return;
  }
  for (const file of manifestFiles(manifest)) {
    if (!existsSync(join(distDir, file))) fail(`manifest.json referencia "${file}", ausente.`);
  }
}

if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
  process.stderr.write(`verify-dist: diretório não encontrado: ${distDir}\n`);
  process.exit(1);
}

const size = verifyContentScript();
verifyNoJsdom(listFiles(distDir));
verifyManifest();

if (errors.length > 0) {
  process.stderr.write(`verify-dist: ${errors.length} problema(s) em ${distDir}\n`);
  for (const error of errors) process.stderr.write(`  - ${error}\n`);
  process.exit(1);
}
process.stdout.write(`verify-dist: ok (${distDir}; content.js com ${size} bytes)\n`);
