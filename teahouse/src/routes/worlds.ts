/**
 * World books: import, inspect, delete, export, book-level settings, and entry
 * CRUD.
 *
 * Every mutation goes through the format layer and is then written back with
 * `writeWorldRaw`, so an edit lands in the source document in the source format
 * and unknown vocabulary survives untouched.
 */

import {
  addEntry,
  duplicateEntry,
  parseWorldInfo,
  removeEntry,
  serializeWorld,
  setBookField,
  toStNative,
  updateEntry,
} from '../formats/world-info.ts';
import { coerceEntryPatch } from '../formats/entry-fields.ts';
import { badRequest, notFound, readBody, readJson, sendBytes, sendJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { sanitizeId, type Store } from '../store/db.ts';
import type { World, WorldEntry } from '../formats/types.ts';

/** Entries as the API exposes them: the raw source object is not serialisable. */
function entryView(entry: WorldEntry) {
  return { ...entry, raw: undefined };
}

function worldView(world: World, warnings: unknown[] = []) {
  return {
    id: world.id,
    name: world.name,
    format: world.sourceFormat,
    scanDepth: world.scanDepth,
    tokenBudget: world.tokenBudget,
    recursiveScanning: world.recursiveScanning,
    entries: world.entries.map(entryView),
    warnings,
  };
}

export function registerWorldRoutes(router: Router, store: Store): void {
  const entryUid = (raw: string | undefined): number => {
    const uid = Number(raw);
    if (!Number.isInteger(uid) || uid < 0) throw badRequest(`invalid entry uid: ${raw}`);
    return uid;
  };

  const mutate = (id: string, fn: (world: World) => unknown): unknown => {
    const { world } = store.loadWorld(id);
    const result = fn(world);
    store.writeWorldRaw(id, world.raw);
    return result;
  };

  router.add('GET', '/api/worlds', ({ response }) => {
    sendJson(response, 200, store.listWorlds());
  });

  router.add('POST', '/api/worlds/import', async ({ request, url, response }) => {
    const name = sanitizeId(url.searchParams.get('name') ?? `world-${Date.now().toString(36)}`);
    const bytes = await readBody(request);
    try {
      const result = store.importWorld(name, bytes, url.searchParams.get('name') ?? undefined);
      sendJson(response, 200, {
        id: name,
        format: result.world.sourceFormat,
        entries: result.world.entries.length,
        warnings: result.warnings,
      });
    } catch (error) {
      // 400, not 500: the document was understood well enough to reject it, and
      // the message says what to do instead.
      throw badRequest((error as Error).message);
    }
  });

  router.add('GET', '/api/worlds/:id/raw', ({ params, response }) => {
    const { world } = store.loadWorld(params.id!);
    sendBytes(response, 200, serializeWorld(world), 'application/json; charset=utf-8');
  });

  router.add('PUT', '/api/worlds/:id/raw', async ({ request, params, response }) => {
    const id = params.id!;
    const raw = await readJson<unknown>(request);
    // Validate before writing so a bad document never overwrites a good one.
    try {
      parseWorldInfo(raw, { id });
    } catch (error) {
      throw badRequest((error as Error).message);
    }
    store.writeWorldRaw(id, raw);
    sendJson(response, 200, { ok: true });
  });

  router.add('GET', '/api/worlds/:id/st-native', ({ params, response }) => {
    const { world } = store.loadWorld(params.id!);
    sendJson(response, 200, toStNative(world));
  });

  router.add('GET', '/api/worlds/:id', ({ params, response }) => {
    const { world, warnings } = store.loadWorld(params.id!);
    sendJson(response, 200, worldView(world, warnings));
  });

  // Book-level settings: they override the global scan settings for this book.
  router.add('PATCH', '/api/worlds/:id', async ({ request, params, response }) => {
    const id = params.id!;
    const body = await readJson<Record<string, unknown>>(request);
    const applied: string[] = [];

    mutate(id, (world) => {
      for (const [field, value] of Object.entries(body)) {
        if (field === 'scanDepth' || field === 'tokenBudget') {
          const parsed = value === null ? null : Number(value);
          if (parsed !== null && !Number.isFinite(parsed)) {
            throw badRequest(`${field} must be a number or null`);
          }
          if (parsed !== null && parsed < 0) throw badRequest(`${field} must be >= 0`);
          setBookField(world, field, parsed);
          applied.push(field);
          continue;
        }
        if (field === 'recursiveScanning') {
          if (value !== null && typeof value !== 'boolean') {
            throw badRequest('recursiveScanning must be a boolean or null');
          }
          setBookField(world, field, value as boolean | null);
          applied.push(field);
          continue;
        }
        throw badRequest(`unknown book field: ${field}`);
      }
    });

    const { world } = store.loadWorld(id);
    sendJson(response, 200, { ok: true, applied, world: worldView(world) });
  });

  router.add('DELETE', '/api/worlds/:id', ({ params, response }) => {
    try {
      store.deleteWorld(params.id!);
    } catch (error) {
      throw notFound((error as Error).message);
    }
    sendJson(response, 200, { ok: true });
  });

  // --- entries -------------------------------------------------------------

  router.add('POST', '/api/worlds/:id/entries', async ({ request, params, response }) => {
    const id = params.id!;
    const patch = coerceEntryPatch(await readJson<Record<string, unknown>>(request));
    const created = mutate(id, (world) => addEntry(world, patch)) as WorldEntry;
    const { world } = store.loadWorld(id);
    sendJson(response, 200, { entry: entryView(created), entries: world.entries.length });
  });

  router.add('PATCH', '/api/worlds/:id/entries/:uid', async ({ request, params, response }) => {
    const id = params.id!;
    const uid = entryUid(params.uid);
    const patch = coerceEntryPatch(await readJson<Record<string, unknown>>(request));
    let updated: WorldEntry;
    try {
      updated = mutate(id, (world) => updateEntry(world, uid, patch)) as WorldEntry;
    } catch (error) {
      throw notFound((error as Error).message);
    }
    sendJson(response, 200, { entry: entryView(updated) });
  });

  router.add('POST', '/api/worlds/:id/entries/:uid/duplicate', async ({ request, params, response }) => {
    const id = params.id!;
    const uid = entryUid(params.uid);
    const body = await readJson<Record<string, unknown>>(request);
    const patch = coerceEntryPatch(body);
    let created: WorldEntry;
    try {
      created = mutate(id, (world) => duplicateEntry(world, uid, patch)) as WorldEntry;
    } catch (error) {
      throw notFound((error as Error).message);
    }
    const { world } = store.loadWorld(id);
    sendJson(response, 200, { entry: entryView(created), entries: world.entries.length });
  });

  router.add('DELETE', '/api/worlds/:id/entries/:uid', ({ params, response }) => {
    const id = params.id!;
    const uid = entryUid(params.uid);
    const removed = mutate(id, (world) => removeEntry(world, uid)) as boolean;
    if (!removed) throw notFound(`entry not found: uid ${uid}`);
    const { world } = store.loadWorld(id);
    sendJson(response, 200, { ok: true, entries: world.entries.length });
  });
}
