import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';

/**
 * Mock do Ollama em 127.0.0.1:11434 (porta padrão, já coberta por
 * `host_permissions`). Reproduz o comportamento medido no Ollama 0.40.12
 * (ADR-007/ADR-009): requisição sem `Origin` passa; com `Origin` fora de
 * `allowedOrigins` recebe 403 SEM cabeçalhos CORS.
 */
export const MOCK_HOST = '127.0.0.1';
export const MOCK_PORT = 11434;

/**
 * - `ollama`: API compatível (`GET /api/tags`, `POST /api/show`).
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
}

export interface MockOllama {
  readonly requests: readonly RecordedRequest[];
  /** Aplica um cenário parcial; liga ou desliga o servidor conforme `mode`. */
  configure(scenario: Partial<MockScenario>): Promise<void>;
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

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', `http://${MOCK_HOST}`).pathname;
    const origin = req.headers.origin;
    requests.push({ method: req.method ?? '', path, origin });
    const body = await readBody(req);

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
      return requests;
    },
    async configure(partial) {
      scenario = { ...scenario, ...partial };
      if (scenario.mode === 'down') await stop();
      else if (!server) await listen();
    },
    clearRequests() {
      requests.length = 0;
    },
    close: stop,
  };
}
