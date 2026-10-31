import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { buildChatRequest } from '../../src/core/prompt-builder';
import type { LanguageCode } from '../../src/core/types';

/**
 * Mock do Ollama em 127.0.0.1:11434 (porta padrão, já coberta por
 * `host_permissions`). Reproduz o comportamento medido no Ollama 0.40.12
 * (ADR-007/ADR-009): requisição sem `Origin` passa; com `Origin` fora de
 * `allowedOrigins` recebe 403 SEM cabeçalhos CORS.
 *
 * Também serve a fixture de capítulo em `GET /fixture/novel-chapter.html`:
 * a origem já está em `host_permissions`, então `executeScript` funciona sem
 * gesto do usuário. `POST /api/chat` "traduz" com ROT13 (ver `fakeTranslate`).
 */
export const MOCK_HOST = '127.0.0.1';
export const MOCK_PORT = 11434;

export const FIXTURE_PATH = '/fixture/novel-chapter.html';
const FIXTURE_FILE = fileURLToPath(new URL('../fixtures/novel-chapter.html', import.meta.url));

/** Par de idiomas que o mock espera no prompt (o mesmo gravado pelos testes). */
export const CHAT_SOURCE: LanguageCode = 'en';
export const CHAT_TARGET: LanguageCode = 'pt-BR';

/** Tamanho (em bytes) dos pedaços em que o corpo NDJSON é escrito. */
const CHAT_WRITE_BYTES = 64;
/** Caracteres de conteúdo por linha NDJSON (um "token"). */
const CHAT_TOKEN_CHARS = 5;

const MARKER = /(<\/?g\d+>)/;

const rot13Char = (char: string): string => {
  const code = char.charCodeAt(0);
  const base = code >= 97 ? 97 : 65;
  return String.fromCharCode(((code - base + 13) % 26) + base);
};

/** ROT13 só em `[A-Za-z]`, fora dos marcadores `<gN>`/`</gN>` (que voltam intactos). */
export function fakeTranslate(text: string): string {
  return text
    .split(MARKER)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/[A-Za-z]/g, rot13Char)))
    .join('');
}

/**
 * Prefixo fixo do prompt v1 para o par esperado, derivado do próprio
 * `buildChatRequest` (o texto da página entra uma única vez, ao final).
 */
function promptPrefix(): string {
  const probe = 'x';
  const built = buildChatRequest({
    text: probe,
    source: CHAT_SOURCE,
    target: CHAT_TARGET,
    model: 'translategemma:4b',
  });
  if (!built.ok) throw new Error(`buildChatRequest falhou no mock: ${built.error}`);
  const content = built.request.messages[0].content;
  return content.slice(0, content.length - probe.length);
}

const PROMPT_PREFIX = promptPrefix();

/** Texto do usuário dentro do corpo de `/api/chat`, ou `null` se o formato não bate. */
export function extractUserText(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length !== 1) return null;
  const content = (messages[0] as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.startsWith(PROMPT_PREFIX)) return null;
  return content.slice(PROMPT_PREFIX.length);
}

/** Linhas NDJSON do chat: vários tokens e a linha final `done: true`. */
function chatLines(model: string, output: string): string {
  const chars = Array.from(output);
  const lines: string[] = [];
  const createdAt = new Date().toISOString();
  for (let i = 0; i < chars.length; i += CHAT_TOKEN_CHARS) {
    const content = chars.slice(i, i + CHAT_TOKEN_CHARS).join('');
    lines.push(
      JSON.stringify({
        model,
        created_at: createdAt,
        message: { role: 'assistant', content },
        done: false,
      }),
    );
  }
  lines.push(
    JSON.stringify({
      model,
      created_at: createdAt,
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      eval_count: chars.length,
    }),
  );
  return lines.map((line) => `${line}\n`).join('');
}

/**
 * Pontos de corte do corpo: a cada `CHAT_WRITE_BYTES` e, para todo caractere
 * UTF-8 multibyte, logo após o primeiro byte (o decodificador do cliente tem
 * de juntar o caractere entre dois pedaços).
 */
function splitBytes(bytes: Buffer): Buffer[] {
  const cuts = new Set<number>();
  for (let i = CHAT_WRITE_BYTES; i < bytes.length; i += CHAT_WRITE_BYTES) cuts.add(i);
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i]! >= 0xc0 && i + 1 < bytes.length) cuts.add(i + 1);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const pieces: Buffer[] = [];
  let start = 0;
  for (const cut of sorted) {
    pieces.push(bytes.subarray(start, cut));
    start = cut;
  }
  pieces.push(bytes.subarray(start));
  return pieces;
}

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * - `ollama`: API compatível (`GET /api/tags`, `POST /api/show`, `POST /api/chat`).
 * - `404`: algo que responde 404 a tudo (não é o Ollama).
 * - `html`: algo que responde 200 com HTML a tudo (não é o Ollama).
 * - `down`: nada escutando na porta.
 */
export type MockMode = 'ollama' | '404' | 'html' | 'down';

export interface MockScenario {
  mode: MockMode;
  /** Valores aceitos no cabeçalho `Origin` (equivale a `OLLAMA_ORIGINS`). */
  allowedOrigins: string[];
  /** Nomes devolvidos por `/api/tags` e aceitos por `/api/show`. */
  models: string[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  /** `undefined` quando o navegador não enviou o cabeçalho. */
  origin: string | undefined;
  /** A conexão ainda não fechou (a resposta não terminou nem foi abortada). */
  open: boolean;
  /** O cliente fechou a conexão antes do fim da resposta. */
  aborted: boolean;
}

export interface MockOllama {
  /** Cópias do estado atual de cada requisição recebida. */
  readonly requests: readonly RecordedRequest[];
  /** Só as requisições `POST /api/chat`. */
  chatRequests(): RecordedRequest[];
  /** Aplica um cenário parcial; liga ou desliga o servidor conforme `mode`. */
  configure(scenario: Partial<MockScenario>): Promise<void>;
  /** Novas e atuais requisições de chat esperam (sem cabeçalhos) até `releaseChat`. */
  holdChat(): void;
  /** Libera as requisições de chat retidas; as abortadas no meio-tempo não recebem nada. */
  releaseChat(): void;
  /**
   * Resolve `true` assim que chegar um novo `POST /api/chat`, ou `false` se
   * nenhum chegar em `timeoutMs` (janela de observação, não espera fixa).
   */
  waitForChatRequest(timeoutMs: number): Promise<boolean>;
  clearRequests(): void;
  close(): Promise<void>;
}

export const DEFAULT_SCENARIO: Readonly<MockScenario> = Object.freeze({
  mode: 'ollama',
  allowedOrigins: [],
  models: ['translategemma:4b'],
});

const withLatest = (name: string): string => (name.includes(':') ? name : `${name}:latest`);

function sendJson(res: ServerResponse, status: number, body: unknown, origin?: string): void {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  if (origin !== undefined) headers['access-control-allow-origin'] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Falha cedo se outro processo (ex.: o Ollama real) já atende na porta. */
async function assertPortFree(): Promise<void> {
  const inUse = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: MOCK_HOST, port: MOCK_PORT });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
  if (inUse) throw portBusyError();
}

function portBusyError(): Error {
  return new Error(
    `A porta ${MOCK_PORT} em ${MOCK_HOST} já está em uso (provavelmente o Ollama real). ` +
      'Feche o Ollama (ícone da bandeja → Sair) antes de rodar os testes E2E: o mock precisa ' +
      'da porta padrão, a única coberta por host_permissions sem diálogo de permissão.',
  );
}

export async function startMockOllama(initial: Partial<MockScenario> = {}): Promise<MockOllama> {
  await assertPortFree();

  let scenario: MockScenario = { ...DEFAULT_SCENARIO, ...initial };
  const requests: RecordedRequest[] = [];
  let server: Server | undefined;
  let held = false;
  let releaseHeld: (() => void) | undefined;
  let heldGate: Promise<void> = Promise.resolve();

  const holdChat = (): void => {
    if (held) return;
    held = true;
    heldGate = new Promise((resolve) => {
      releaseHeld = resolve;
    });
  };
  const releaseChat = (): void => {
    held = false;
    releaseHeld?.();
    releaseHeld = undefined;
  };

  /** Avisados a cada `POST /api/chat` recebido. */
  const chatListeners = new Set<() => void>();

  const waitForChatRequest = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const onChat = (): void => {
        clearTimeout(timer);
        chatListeners.delete(onChat);
        resolve(true);
      };
      const timer = setTimeout(() => {
        chatListeners.delete(onChat);
        resolve(false);
      }, timeoutMs);
      chatListeners.add(onChat);
    });

  const handleChat = async (
    body: string,
    res: ServerResponse,
    record: RecordedRequest,
    origin: string | undefined,
  ): Promise<void> => {
    let model: unknown;
    try {
      model = (JSON.parse(body) as { model?: unknown }).model;
    } catch {
      model = undefined;
    }
    const text = extractUserText(body);
    if (typeof model !== 'string' || text === null) {
      sendJson(res, 400, { error: 'unexpected chat request' }, origin);
      return;
    }
    if (!scenario.models.some((name) => withLatest(name) === withLatest(model))) {
      sendJson(res, 404, { error: `model '${model}' not found` }, origin);
      return;
    }
    if (held) await heldGate;
    if (!record.open) return;

    const headers: Record<string, string> = { 'content-type': 'application/x-ndjson' };
    if (origin !== undefined) headers['access-control-allow-origin'] = origin;
    res.writeHead(200, headers);
    for (const piece of splitBytes(Buffer.from(chatLines(model, fakeTranslate(text)), 'utf8'))) {
      if (!record.open) return;
      res.write(piece);
      await nextTick();
    }
    res.end();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', `http://${MOCK_HOST}`).pathname;
    const origin = req.headers.origin;
    const record: RecordedRequest = {
      method: req.method ?? '',
      path,
      origin,
      open: true,
      aborted: false,
    };
    requests.push(record);
    if (record.method === 'POST' && path === '/api/chat') {
      for (const listener of [...chatListeners]) listener();
    }
    res.once('close', () => {
      record.open = false;
      if (!res.writableFinished) record.aborted = true;
    });
    const body = await readBody(req);

    if (req.method === 'GET' && path === FIXTURE_PATH) {
      const html = await readFile(FIXTURE_FILE);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(html);
      return;
    }

    if (scenario.mode === '404') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 page not found');
      return;
    }
    if (scenario.mode === 'html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>Outro servidor</h1></body></html>');
      return;
    }

    // Regra do Ollama: Origin presente e não liberada → 403 sem CORS (inclui OPTIONS).
    if (origin !== undefined && !scenario.allowedOrigins.includes(origin)) {
      res.writeHead(403);
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/api/tags') {
      sendJson(
        res,
        200,
        { models: scenario.models.map((name) => ({ name, model: name })) },
        origin,
      );
      return;
    }
    if (req.method === 'POST' && path === '/api/show') {
      let model: unknown;
      try {
        model = (JSON.parse(body) as { model?: unknown }).model;
      } catch {
        model = undefined;
      }
      if (typeof model !== 'string') {
        sendJson(res, 400, { error: 'model is required' }, origin);
        return;
      }
      const installed = scenario.models.some((name) => withLatest(name) === withLatest(model));
      if (installed) sendJson(res, 200, { modelfile: '', parameters: '', template: '' }, origin);
      else sendJson(res, 404, { error: `model '${model}' not found` }, origin);
      return;
    }
    if (req.method === 'POST' && path === '/api/chat') {
      await handleChat(body, res, record, origin);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 page not found');
  };

  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const next = createServer((req, res) => {
        handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      next.once('error', (error: NodeJS.ErrnoException) => {
        reject(error.code === 'EADDRINUSE' ? portBusyError() : error);
      });
      next.listen(MOCK_PORT, MOCK_HOST, () => {
        server = next;
        resolve();
      });
    });

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      const current = server;
      server = undefined;
      if (!current) return resolve();
      // Conexões keep-alive do Chromium impediriam o close de terminar.
      current.closeAllConnections();
      current.close(() => resolve());
    });

  if (scenario.mode !== 'down') await listen();

  return {
    get requests() {
      return requests.map((request) => ({ ...request }));
    },
    chatRequests() {
      return requests
        .filter(({ method, path }) => method === 'POST' && path === '/api/chat')
        .map((request) => ({ ...request }));
    },
    async configure(partial) {
      scenario = { ...scenario, ...partial };
      if (scenario.mode === 'down') await stop();
      else if (!server) await listen();
    },
    holdChat,
    releaseChat,
    waitForChatRequest,
    clearRequests() {
      requests.length = 0;
    },
    async close() {
      await stop();
      // Nenhum handler fica esperando a liberação depois do teardown.
      releaseChat();
    },
  };
}
