/**
 * Static file serving for the web UI.
 *
 * Only files under the web root are reachable, and the resolved path is checked
 * against that root so a crafted path cannot escape it.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createStaticHandler(webRoot: string) {
  const root = resolve(webRoot);

  return function serveStatic(response: ServerResponse, urlPath: string): boolean {
    const relative = normalize(urlPath).replace(/^([/\\])+/, '');
    const target = join(root, relative === '' ? 'index.html' : relative);
    if (target !== root && !target.startsWith(root + sep)) return false;
    if (!existsSync(target) || !statSync(target).isFile()) return false;

    const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
    const bytes = readFileSync(target);
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': bytes.length,
      // No caching. Without this the browser applies heuristic freshness per
      // file, so a refresh can pair a new index.html with a cached api.js — and
      // a half-updated client fails in ways that look like broken buttons.
      'Cache-Control': 'no-store, must-revalidate',
      Pragma: 'no-cache',
    });
    response.end(bytes);
    return true;
  };
}
