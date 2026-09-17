/**
 * A tiny pattern router.
 *
 * Routes are declared as `METHOD /path/with/:params`, so adding an endpoint is
 * one line instead of another branch in a chain of `if`s. Static segments always
 * win over parameter segments, regardless of registration order, so
 * `/api/worlds/import` can never be swallowed by `/api/worlds/:id`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { HttpError } from './respond.ts';

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  /** Query string of the request. */
  url: URL;
  /** Values captured from `:name` segments. */
  params: Record<string, string>;
}

export interface RouteMatch extends RouteContext {}

export type RouteHandler = (ctx: RouteMatch) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  paramCount: number;
  handler: RouteHandler;
}

export interface Router {
  add(method: string, pattern: string, handler: RouteHandler): void;
  /** Returns true when a route handled the request. */
  handle(ctx: RouteContext): Promise<boolean>;
}

function parsePattern(pattern: string): string[] {
  return pattern.split('/').filter((part) => part !== '');
}

/**
 * Splits and decodes a request path. `URL.pathname` keeps percent-encoding, so
 * ids containing spaces or non-ASCII text must be decoded here; missing this once
 * turned a DELETE into a no-op that still answered 200.
 */
export function splitPath(pathname: string): string[] {
  let segments: string[];
  try {
    segments = pathname
      .split('/')
      .filter((part) => part !== '')
      .map((part) => decodeURIComponent(part));
  } catch {
    throw new HttpError(400, 'malformed percent-encoding in the request path');
  }
  return segments;
}

export function createRouter(): Router {
  const routes: Route[] = [];

  const add = (method: string, pattern: string, handler: RouteHandler): void => {
    const segments = parsePattern(pattern);
    routes.push({
      method: method.toUpperCase(),
      segments,
      paramCount: segments.filter((segment) => segment.startsWith(':')).length,
      handler,
    });
  };

  const handle = async (ctx: RouteContext): Promise<boolean> => {
    const method = (ctx.request.method ?? 'GET').toUpperCase();
    // HEAD is served by the GET handler; the response body is dropped by Node.
    const effective = method === 'HEAD' ? 'GET' : method;
    const segments = splitPath(ctx.url.pathname);

    const candidates: { route: Route; params: Record<string, string> }[] = [];
    for (const route of routes) {
      if (route.method !== effective) continue;
      if (route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const pattern = route.segments[i]!;
        const actual = segments[i]!;
        if (pattern.startsWith(':')) {
          params[pattern.slice(1)] = actual;
        } else if (pattern !== actual) {
          ok = false;
          break;
        }
      }
      if (ok) candidates.push({ route, params });
    }

    if (candidates.length === 0) return false;
    // Fewest parameters first, then declaration order: static beats dynamic.
    candidates.sort((a, b) => a.route.paramCount - b.route.paramCount);
    await candidates[0]!.route.handler({ ...ctx, params: candidates[0]!.params });
    return true;
  };

  return { add, handle };
}
