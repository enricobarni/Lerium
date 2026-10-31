// Confere o resultado do build antes de carregar a extensão.
// Uso: node scripts/verify-dist.mjs [diretório]   (padrão: dist)
// Roda no fim de `npm run build`, também no CI. Sai com código 1 se falhar.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const distDir = resolve(process.argv[2] ?? 'dist');

// Teto do content script. O bundle atual tem ~18 KB; 200 KB dá folga ampla e
// ainda pega um engano grosseiro, como uma dependência pesada (ex.: jsdom)
// arrastada para dentro do script injetado em toda página traduzida.
const CONTENT_MAX_BYTES = 200 * 1024;

// Tokens proibidos no pacote. É uma heurística sobre o texto do bundle, não
// uma análise de fluxo: um alias (`const h = 'inner' + 'HTML'`) passa. Serve
// de defesa em profundidade, somada ao lint, à revisão e aos testes, e pega o
// caso comum de alguém usar a API diretamente. Os padrões casam texto bruto,
// inclusive dentro de strings e comentários; um falso positivo deve ser
// resolvido mudando o código, não afrouxando a lista.
//
// Todos os .js: inserção de HTML (a saída do modelo entra só por
// textContent/nodeValue) e avaliação dinâmica de código.
const FORBIDDEN_ALL_JS = [
  ['innerHTML', /innerHTML/],
  ['outerHTML', /outerHTML/],
  ['insertAdjacentHTML', /insertAdjacentHTML/],
  ['document.write', /document\.write/],
  ['createContextualFragment', /createContextualFragment/],
  ['setHTMLUnsafe', /setHTMLUnsafe/],
  ['eval(', /(?<![\w$])eval\s*\(/],
  ['new Function', /new\s+Function\b/],
  // `Function(` solto, sem pegar `isFunction(`, `obj.Function(` etc.
  ['Function(', /(?<![\w$.])Function\s*\(/],
];

// Só content.js, além da lista geral: rede, storage, import dinâmico e log
// ficam fora do script injetado na página (rede e storage são do service
// worker; nenhum texto da página vai para log). `fetch(` é legítimo no
// background, por isso esta lista não vale para os demais arquivos.
const FORBIDDEN_CONTENT_ONLY = [
  ['fetch(', /(?<![\w$])fetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /WebSocket/],
  ['sendBeacon', /sendBeacon/],
  ['EventSource', /EventSource/],
  ['chrome.storage', /chrome\.storage/],
  ['localStorage', /localStorage/],
  ['sessionStorage', /sessionStorage/],
  ['import(', /(?<![\w$])import\s*\(/],
  ['console.', /(?<![\w$])console\s*\./],
];

// Arquivos de texto em que se procura "jsdom" (PNG e outros binários não).
const TEXT_EXTENSIONS = ['.js', '.mjs', '.html', '.css', '.json', '.map'];
const isTextFile = (file) => TEXT_EXTENSIONS.includes(extname(file));

// Manifesto do pacote: privilégio mínimo (PLAN.md §8).
const EXPECTED_PERMISSIONS = ['activeTab', 'scripting', 'storage'];
// Só loopback em http, com porta opcional; `localhost.evil.com` não passa.
const LOOPBACK_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/.*$/;
const FORBIDDEN_MANIFEST_KEYS = [
  'content_scripts',
  'web_accessible_resources',
  'externally_connectable',
  'optional_permissions',
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

  for (const [label, pattern] of FORBIDDEN_CONTENT_ONLY) {
    if (pattern.test(code)) fail(`content.js contém "${label}", proibido no content script.`);
  }

  const size = statSync(path).size;
  if (size > CONTENT_MAX_BYTES) {
    fail(`content.js tem ${size} bytes, acima do teto de ${CONTENT_MAX_BYTES} bytes.`);
  }
  return size;
}

function verifyJavaScript(files) {
  for (const file of files.filter((path) => extname(path) === '.js')) {
    const code = readFileSync(file, 'utf8');
    for (const [label, pattern] of FORBIDDEN_ALL_JS) {
      if (pattern.test(code))
        fail(`${relative(distDir, file)} contém "${label}", proibido no pacote.`);
    }
  }
}

function verifyNoSourceMaps(files) {
  // Source maps expõem o código-fonte e não são necessários para rodar.
  for (const file of files) {
    if (extname(file) === '.map') fail(`${relative(distDir, file)}: source map no pacote.`);
    else if (isTextFile(file) && readFileSync(file, 'utf8').includes('sourceMappingURL')) {
      fail(`${relative(distDir, file)} contém "sourceMappingURL".`);
    }
  }
}

function verifyNoJsdom(files) {
  // jsdom é só ambiente de teste (ADR-012); nunca pode ir para a extensão.
  for (const file of files.filter(isTextFile)) {
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
  verifyManifestPrivileges(manifest);
}

function verifyManifestPrivileges(manifest) {
  const permissions = manifest.permissions;
  const sameSet =
    Array.isArray(permissions) &&
    permissions.length === EXPECTED_PERMISSIONS.length &&
    EXPECTED_PERMISSIONS.every((permission) => permissions.includes(permission));
  if (!sameSet) {
    fail(
      `manifest.json: permissions deve ser exatamente ${JSON.stringify(EXPECTED_PERMISSIONS)}, ` +
        `recebido ${JSON.stringify(permissions)}.`,
    );
  }

  for (const key of ['host_permissions', 'optional_host_permissions']) {
    const origins = manifest[key] ?? [];
    if (!Array.isArray(origins)) {
      fail(`manifest.json: ${key} deve ser uma lista.`);
      continue;
    }
    for (const origin of origins) {
      if (typeof origin !== 'string' || !LOOPBACK_PATTERN.test(origin)) {
        fail(`manifest.json: ${key} contém ${JSON.stringify(origin)}, fora de loopback http.`);
      }
    }
  }

  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (Object.hasOwn(manifest, key)) fail(`manifest.json não deve declarar "${key}".`);
  }

  // Redundante com as checagens acima, mas pega `<all_urls>` em qualquer chave.
  if (JSON.stringify(manifest).includes('<all_urls>')) {
    fail('manifest.json contém "<all_urls>".');
  }
}

if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
  process.stderr.write(`verify-dist: diretório não encontrado: ${distDir}\n`);
  process.exit(1);
}

const files = listFiles(distDir);
const size = verifyContentScript();
verifyJavaScript(files);
verifyNoSourceMaps(files);
verifyNoJsdom(files);
verifyManifest();

if (errors.length > 0) {
  process.stderr.write(`verify-dist: ${errors.length} problema(s) em ${distDir}\n`);
  for (const error of errors) process.stderr.write(`  - ${error}\n`);
  process.exit(1);
}
process.stdout.write(`verify-dist: ok (${distDir}; content.js com ${size} bytes)\n`);
