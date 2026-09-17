/**
 * HTTP plumbing shared by every route.
 *
 * Routes never call `response.writeHead` for JSON: they return a value or throw
 * an `HttpError`, and the dispatcher turns that into a response. That keeps each
 * route to the shape of its actual logic.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Notice } from '../i18n.ts';

const MAX_BODY = 64 * 1024 * 1024;

/** An error a route raises deliberately, with the status it should produce. */
export class HttpError extends Error {
  readonly status: number;
  /**
   * Optional machine-readable name and values. The client renders the notice in
   * its own language; `message` stays as the source-language fallback.
   */
  readonly notice?: Notice;

  constructor(status: number, message: string, code?: string, params?: Record<string, string | number>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (code !== undefined) this.notice = params === undefined ? { code } : { code, params };
  }
}

export const badRequest = (message: string, code?: string, params?: Record<string, string | number>): HttpError =>
  new HttpError(400, message, code, params);
export const notFound = (message: string, code?: string, params?: Record<string, string | number>): HttpError =>
  new HttpError(404, message, code, params);
export const conflict = (message: string, code?: string, params?: Record<string, string | number>): HttpError =>
  new HttpError(409, message, code, params);

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
}

export function sendBytes(
  response: ServerResponse,
  status: number,
  bytes: Buffer | string,
  contentType: string,
): void {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': buffer.length });
  response.end(buffer);
}

export function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        rejectPromise(new HttpError(413, 'request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolvePromise(Buffer.concat(chunks)));
    request.on('error', rejectPromise);
  });
}

export async function readJson<T>(request: IncomingMessage): Promise<T> {
  const body = await readBody(request);
  if (body.length === 0) return {} as T;
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch (error) {
    throw badRequest(`request body is not valid JSON: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

export function openEventStream(response: ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

export function sendEvent(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ---------------------------------------------------------------------------
// Coercion helpers used by request bodies
// ---------------------------------------------------------------------------

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${key} is required`);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`${key} must be a string`);
  return value;
}

export function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  throw badRequest(`${key} must be a boolean`);
}
