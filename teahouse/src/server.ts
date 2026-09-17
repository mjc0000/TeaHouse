/**
 * Composition root: static files, the API router, and error mapping.
 *
 * There is deliberately no endpoint logic here. Routes live in `src/routes/`,
 * HTTP plumbing in `src/http/`; this file only wires them together and decides
 * what an unhandled error turns into.
 *
 * Run with `npm start`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EntryPatchError } from './formats/entry-fields.ts';
import { createRouter } from './http/router.ts';
import { createStaticHandler } from './http/static.ts';
import { HttpError, sendJson } from './http/respond.ts';
import { registerRoutes } from './routes/index.ts';
import { Store } from './store/db.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..', 'web');

export interface ServerOptions {
  dataDir: string;
  port: number;
  host: string;
}

/** Domain errors carry their own status; anything else is a 500. */
function statusAndPayload(error: unknown): { status: number; payload: unknown } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      payload: {
        error: error.message,
        ...(error.notice ? { code: error.notice.code, params: error.notice.params } : {}),
      },
    };
  }
  if (error instanceof EntryPatchError) {
    return { status: 400, payload: { error: error.message, problems: error.problems } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, payload: { error: message } };
}

export function createTeahouseServer(options: ServerOptions) {
  const store = new Store(options.dataDir);
  store.ensure();

  const router = createRouter();
  registerRoutes(router, store);
  const serveStatic = createStaticHandler(webRoot);

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = (request.method ?? 'GET').toUpperCase();

    if (!url.pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(response, 405, { error: 'method not allowed' });
        return;
      }
      if (serveStatic(response, url.pathname)) return;
      sendJson(response, 404, { error: `not found: ${url.pathname}` });
      return;
    }

    const handled = await router.handle({ request, response, url, params: {} });
    if (!handled) sendJson(response, 404, { error: `unknown api route: ${url.pathname}` });
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const { status, payload } = statusAndPayload(error);
      // A stream may already be open (generation); then there is no way to
      // change the status, so the error is reported as an event instead.
      if (response.headersSent) {
        try {
          response.write(`data: ${JSON.stringify({ type: 'error', ...(payload as object) })}\n\n`);
        } catch {
          /* the client is gone */
        }
        response.end();
        return;
      }
      sendJson(response, status, payload);
    });
  });

  return {
    server,
    store,
    listen: () =>
      new Promise<string>((resolvePromise) => {
        server.listen(options.port, options.host, () => {
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : options.port;
          resolvePromise(`http://${options.host}:${port}`);
        });
      }),
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const dataDir = process.env.TEAHOUSE_DATA ?? resolve(here, '..', 'data');
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  const app = createTeahouseServer({ dataDir, port, host });
  const url = await app.listen();
  console.log(`teahouse listening on ${url}`);
  console.log(`data directory: ${dataDir}`);
}
