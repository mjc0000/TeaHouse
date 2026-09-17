/**
 * Expression sprites (立绘): a portrait that follows the conversation.
 *
 * Zero configuration on purpose: files under `data/sprites/<characterId>/`
 * are the whole database, and each filename stem is its keyword (`开心.png`
 * fires on 开心). Files get there either by hand or through the upload
 * endpoint below (raw bytes like the chat image upload, `?emotion=` naming
 * the keyword); either way the listing only ever admits plain image files.
 * The newest few messages are scanned for those keywords; the longest match
 * wins, so `很开心` beats `开心` inside one turn. A file named `默认` (or
 * `default`/`neutral`) is the resting face when nothing matches, otherwise
 * the first file alphabetically.
 *
 * Nothing here touches the prompt: a portrait is furniture, not context.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { badRequest, notFound, readBody, sendJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { MAX_IMAGE_BYTES, sniffImage } from '../engine/images.ts';
import { sanitizeId, type Store } from '../store/db.ts';

const EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const DEFAULT_NAMES = ['默认', 'default', 'neutral'];

export interface SpriteFile {
  emotion: string;
  file: string;
  url: string;
}

function spritesDir(store: Store, characterId: string): string {
  return join(store.root, 'sprites', sanitizeId(characterId));
}

/** Every usable file for one character, alphabetically. */
export function listSprites(store: Store, characterId: string): SpriteFile[] {
  const dir = spritesDir(store, characterId);
  if (!existsSync(dir)) return [];
  const out: SpriteFile[] = [];
  for (const file of readdirSync(dir)) {
    const lower = file.toLowerCase();
    const ext = Object.keys(EXTENSIONS).find((suffix) => lower.endsWith(suffix));
    if (!ext || file.includes('..') || file !== sanitizeId(file)) continue;
    try {
      if (!statSync(join(dir, file)).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ emotion: file.slice(0, -ext.length), file, url: `/api/sprites/${encodeURIComponent(characterId)}/${encodeURIComponent(file)}` });
  }
  return out.sort((a, b) => a.emotion.localeCompare(b.emotion, 'zh'));
}

/**
 * Which portrait the conversation looks at right now: the longest keyword
 * found in the recent texts, else the resting face, else the first file.
 */
export function matchSprite(files: SpriteFile[], texts: string[]): SpriteFile | null {
  if (files.length === 0) return null;
  const haystack = texts.join('\n').toLowerCase();
  const ordered = [...files].sort((a, b) => b.emotion.length - a.emotion.length);
  for (const file of ordered) {
    if (file.emotion.trim() !== '' && haystack.includes(file.emotion.toLowerCase())) return file;
  }
  for (const name of DEFAULT_NAMES) {
    const resting = files.find((file) => file.emotion.toLowerCase() === name);
    if (resting) return resting;
  }
  return files[0]!;
}

/**
 * Plants a PNG card's own artwork as its resting face (`默认.png`) on import,
 * so a fresh character shows a portrait with no manual step. Never overwrites:
 * a resting face that is already there — uploaded, hand-dropped, or seeded by
 * an earlier import — stays exactly as it is.
 *
 * @returns true when a file was written, false when one already existed.
 */
export function seedDefaultSprite(store: Store, characterId: string, bytes: Buffer): boolean {
  const files = listSprites(store, characterId);
  if (files.some((file) => DEFAULT_NAMES.includes(file.emotion.toLowerCase()))) return false;
  const dir = spritesDir(store, characterId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '默认.png'), bytes);
  return true;
}

export function registerSpriteRoutes(router: Router, store: Store): void {
  /** The current portrait plus every emotion, for the panel and its selector. */
  router.add('GET', '/api/chats/:id/sprite', ({ params, response }) => {
    const meta = store.loadChatMeta(params.id!);
    const entries = store.loadChat(params.id!);
    const files = listSprites(store, meta.characterId);
    const texts = entries
      .filter((entry) => entry.role !== 'system')
      .slice(-3)
      .map((entry) => entry.content);
    const current = matchSprite(files, texts);
    sendJson(response, 200, {
      characterId: meta.characterId,
      files: files.map((file) => ({ emotion: file.emotion, file: file.file, url: file.url })),
      current: current ? { emotion: current.emotion, url: current.url } : null,
    });
  });

  router.add('GET', '/api/sprites/:character/:file', ({ params, response }) => {    const character = sanitizeId(decodeURIComponent(params.character ?? ''));
    const file = sanitizeId(decodeURIComponent(params.file ?? ''));
    const lower = file.toLowerCase();
    const ext = Object.keys(EXTENSIONS).find((suffix) => lower.endsWith(suffix));
    const target = ext && !file.includes('..') && character !== '' ? join(spritesDir(store, character), file) : '';
    if (target === '' || !existsSync(target) || !statSync(target).isFile()) {
      throw notFound(`sprite not found: ${params.character}/${params.file}`);
    }
    const bytes = readFileSync(target);
    response.writeHead(200, {
      'Content-Type': EXTENSIONS[ext!]!,
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store, must-revalidate',
    });
    response.end(bytes);
  });

  /** Uploads one expression image: raw bytes, `?emotion=` naming the keyword. */
  router.add('POST', '/api/chats/:id/sprite-files', async ({ params, request, response, url }) => {
    const meta = store.loadChatMeta(params.id!);
    const emotion = (url.searchParams.get('emotion') ?? '').trim();
    if (emotion === '' || emotion.length > 48 || sanitizeId(emotion) !== emotion) {
      throw badRequest('emotion must be a plain filename stem');
    }
    const bytes = await readBody(request);
    if (bytes.length === 0) throw badRequest('empty upload');
    if (bytes.length > MAX_IMAGE_BYTES) throw badRequest('image is larger than 32 MiB');
    const sniffed = sniffImage(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (!sniffed) throw badRequest('not a JPEG, PNG, GIF or WebP image');
    const dir = spritesDir(store, meta.characterId);
    mkdirSync(dir, { recursive: true });
    // Same emotion twice replaces the portrait instead of doubling it.
    const file = `${emotion}.${sniffed.ext}`;
    writeFileSync(join(dir, file), bytes);
    sendJson(response, 200, {
      emotion,
      file,
      url: `/api/sprites/${encodeURIComponent(meta.characterId)}/${encodeURIComponent(file)}`,
    });
  });

  /** Deletes one expression image; only a listed file can go. */
  router.add('DELETE', '/api/chats/:id/sprite-files', async ({ params, response, url }) => {
    const meta = store.loadChatMeta(params.id!);
    const file = url.searchParams.get('file') ?? '';
    const known = listSprites(store, meta.characterId).some((entry) => entry.file === file);
    if (!known) throw notFound(`sprite not found: ${file}`);
    unlinkSync(join(spritesDir(store, meta.characterId), file));
    sendJson(response, 200, { deleted: file });
  });
}
