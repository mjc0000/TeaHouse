/**
 * Self-hosted fonts: files the user drops into `data/fonts/`.
 *
 * The repo ships no font binaries, so the binaries come from the user: put a
 * `.woff2`/`.woff`/`.ttf`/`.otf` in `data/fonts/` (or upload it from the
 * appearance page) and it is served back as `/fonts/<name>` for the
 * transcript's `@font-face`. Listing is one directory read; a missing
 * directory means "none yet", never an error.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { badRequest, notFound, readBody, sendJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { sanitizeId, type Store } from '../store/db.ts';

const EXTENSIONS: Record<string, { mime: string; format: string }> = {
  '.woff2': { mime: 'font/woff2', format: 'woff2' },
  '.woff': { mime: 'font/woff', format: 'woff' },
  '.ttf': { mime: 'font/ttf', format: 'truetype' },
  '.otf': { mime: 'font/otf', format: 'opentype' },
};

/** 20 MiB: a CJK woff2 is ~10 MiB; anything bigger is not a font upload. */
const MAX_BYTES = 20 * 1024 * 1024;

function fontsDir(store: Store): string {
  return join(store.root, 'fonts');
}

function familyOf(file: string): string {
  return file.replace(/\.[^.]+$/, '');
}

export function listFonts(store: Store): { name: string; family: string; url: string; format: string; bytes: number }[] {
  const dir = fontsDir(store);
  if (!existsSync(dir)) return [];
  const out: { name: string; family: string; url: string; format: string; bytes: number }[] = [];
  for (const name of readdirSync(dir)) {
    const lower = name.toLowerCase();
    const ext = Object.keys(EXTENSIONS).find((suffix) => lower.endsWith(suffix));
    if (!ext || name.includes('..') || name !== sanitizeId(name)) continue;
    try {
      out.push({
        name,
        family: familyOf(name),
        // Under /api/: the composition root only hands /api/* to the router;
        // anything else is a static file. A font-face URL works from anywhere.
        url: `/api/fonts/${encodeURIComponent(name)}/file`,
        format: EXTENSIONS[ext]!.format,
        bytes: statSync(join(dir, name)).size,
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function registerFontRoutes(router: Router, store: Store): void {
  router.add('GET', '/api/fonts', ({ response }) => {
    sendJson(response, 200, { files: listFonts(store) });
  });

  router.add('POST', '/api/fonts', async ({ request, url, response }) => {
    const raw = url.searchParams.get('name') ?? '';
    const name = sanitizeId(raw);
    const lower = name.toLowerCase();
    const ext = Object.keys(EXTENSIONS).find((suffix) => lower.endsWith(suffix));
    if (name === '' || name.includes('..') || !ext || name !== raw) {
      throw badRequest('name must be a plain font filename (.woff2/.woff/.ttf/.otf)');
    }
    const bytes = await readBody(request);
    if (bytes.length === 0) throw badRequest('empty upload');
    if (bytes.length > MAX_BYTES) throw badRequest('font is larger than 20 MiB');
    mkdirSync(fontsDir(store), { recursive: true });
    writeFileSync(join(fontsDir(store), name), bytes);
    sendJson(response, 200, { ok: true, files: listFonts(store) });
  });

  router.add('DELETE', '/api/fonts/:name', ({ params, response }) => {
    const name = sanitizeId(decodeURIComponent(params.name ?? ''));
    const target = join(fontsDir(store), name);
    if (name === '' || name.includes('..') || !existsSync(target)) throw notFound(`font not found: ${params.name}`);
    rmSync(target);
    sendJson(response, 200, { ok: true, files: listFonts(store) });
  });

  router.add('GET', '/api/fonts/:name/file', ({ params, response }) => {
    const name = sanitizeId(decodeURIComponent(params.name ?? ''));
    const lower = name.toLowerCase();
    const ext = Object.keys(EXTENSIONS).find((suffix) => lower.endsWith(suffix));
    const target = ext && !name.includes('..') ? join(fontsDir(store), name) : '';
    if (target === '' || !existsSync(target) || !statSync(target).isFile()) {
      throw notFound(`font not found: ${params.name}`);
    }
    const bytes = readFileSync(target);
    response.writeHead(200, {
      'Content-Type': EXTENSIONS[ext!]!.mime,
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store, must-revalidate',
    });
    response.end(bytes);
  });
}
