/**
 * Chat images, stored.
 *
 * Uploads arrive as raw bytes (`?name=` carries the original filename, the
 * same shape as the font upload); the format is sniffed from the content and
 * anything that is not JPEG/PNG/GIF/WebP or is over the provider's 32 MiB
 * per-image ceiling is refused. Files land as `data/images/<generated>.<ext>`
 * and messages only carry references — the transcript stays small, and a
 * picture is deletable with one file removal.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { badRequest, notFound, readBody, sendJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { MAX_IMAGE_BYTES, sniffImage, type ChatImageRef } from '../engine/images.ts';
import { sanitizeId, type Store } from '../store/db.ts';

function imagesDir(store: Store): string {
  return join(store.root, 'images');
}

function newImageId(ext: string): string {
  return `img-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${ext}`;
}

export function readImageBytes(store: Store, id: string): { bytes: Buffer; mime: string } | null {
  const name = sanitizeId(id);
  if (name === '' || name.includes('..') || name !== id) return null;
  const target = join(imagesDir(store), name);
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  const bytes = readFileSync(target);
  const sniffed = sniffImage(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (!sniffed) return null;
  return { bytes, mime: sniffed.mime };
}

export function registerImageRoutes(router: Router, store: Store): void {
  router.add('POST', '/api/images', async ({ request, url, response }) => {
    const original = url.searchParams.get('name') ?? 'image';
    const bytes = await readBody(request);
    if (bytes.length === 0) throw badRequest('empty upload');
    if (bytes.length > MAX_IMAGE_BYTES) throw badRequest('image is larger than 32 MiB');
    const sniffed = sniffImage(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (!sniffed) throw badRequest('not a JPEG, PNG, GIF or WebP image');
    mkdirSync(imagesDir(store), { recursive: true });
    const id = newImageId(sniffed.ext);
    writeFileSync(join(imagesDir(store), id), bytes);
    const ref: ChatImageRef = { id, name: sanitizeId(original).slice(0, 96) || id, mime: sniffed.mime, bytes: bytes.length };
    sendJson(response, 200, ref);
  });

  router.add('GET', '/api/images/:name', ({ params, response }) => {
    const found = readImageBytes(store, decodeURIComponent(params.name ?? ''));
    if (!found) throw notFound(`image not found: ${params.name}`);
    response.writeHead(200, {
      'Content-Type': found.mime,
      'Content-Length': found.bytes.length,
      'Cache-Control': 'no-store, must-revalidate',
    });
    response.end(found.bytes);
  });
}
