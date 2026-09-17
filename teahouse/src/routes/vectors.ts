/**
 * Vector storage endpoints: connection test, per-book indexing, status, probing.
 *
 * Indexing is an explicit action, never a side effect of saving a world book: it
 * costs money or CPU, it can be slow, and a user who edits an entry should not
 * silently trigger a paid request. The state of every book is reported so the UI
 * can say "this one is behind" and offer the button.
 */

import { probeEmbeddings, embedTexts } from '../llm/embeddings.ts';
import { badRequest, readJson, sendJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { probeVectorQuery, vectorOverview, vectorSettings } from '../vectors.ts';
import {
  entryText,
  hashText,
  encodeVector,
  indexStatus,
  isCandidate,
  orphanUids,
  staleUids,
  withEmbedded,
  withoutUids,
  emptyIndex,
  type VectorEntry,
} from '../engine/vectors.ts';
import type { Store } from '../store/db.ts';
import type { ScanEntry } from '../engine/world-scan.ts';

function entriesOf(store: Store, id: string): VectorEntry[] {
  const { world } = store.loadWorld(id);
  return world.entries.map((entry) => ({
    uid: entry.uid,
    content: entry.content,
    disabled: entry.disable,
    vectorized: entry.vectorized,
  }));
}

/**
 * Embeds whatever is missing or outdated in one book and merges it in. Returns
 * counts rather than the index: the caller (and the UI) wants "12 embedded, 3
 * skipped", not a megabyte of vectors.
 */
async function indexWorld(store: Store, id: string) {
  const config = store.loadConfig();
  const settings = vectorSettings(config);
  if (!settings.enabled) throw badRequest('向量存储没有开启', 'vector.disabled');
  if (settings.model === '') throw badRequest('没有配置 embedding 模型', 'vector.noModel');

  const all = entriesOf(store, id);
  const existing = store.loadVectorIndex(id);
  const modelChanged = existing !== null && existing.model !== '' && existing.model !== settings.model;
  const base = modelChanged ? emptyIndex(settings.model, 0) : existing ?? emptyIndex(settings.model, 0);
  const stale = new Set(staleUids(all, modelChanged ? null : existing, settings.allEntries));
  const orphans = orphanUids(all, base, settings.allEntries);

  const pending = all.filter((entry) => stale.has(entry.uid) && isCandidate(entry, settings.allEntries));
  let embedded = 0;
  let dims = base.dims;
  let model = settings.model;
  let requests = 0;
  let singles = 0;
  const started = Date.now();

  if (pending.length > 0) {
    const result = await embedTexts(
      {
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        batchSize: settings.batchSize,
      },
      pending.map((entry) => entryText(entry)),
    );
    embedded = result.vectors.length;
    dims = result.dims;
    model = result.model;
    requests = result.requests;
    singles = result.singles;
    const items = pending.map((entry, index) => ({
      uid: entry.uid,
      hash: hashText(entryText(entry)),
      vector: encodeVector(result.vectors[index] ?? []),
    }));
    store.saveVectorIndex(id, withEmbedded(base, items, model, dims));
  } else if (modelChanged && existing) {
    // Nothing to embed means every candidate was somehow already there; keep the
    // reported model in step with the vectors we actually hold.
    store.saveVectorIndex(id, base);
  }

  if (orphans.length > 0) {
    store.saveVectorIndex(id, withoutUids(store.loadVectorIndex(id) ?? base, orphans));
  }

  const after = store.loadVectorIndex(id);
  return {
    id,
    embedded,
    skipped: all.length - pending.length,
    orphans: orphans.length,
    dims: after?.dims ?? dims,
    model: after?.model ?? model,
    requests,
    singles,
    ms: Date.now() - started,
    status: indexStatus(all, after, settings.allEntries, settings.model),
  };
}

export function registerVectorRoutes(router: Router, store: Store): void {
  router.add('GET', '/api/vectors', ({ response }) => {
    sendJson(response, 200, vectorOverview(store, store.loadConfig()));
  });

  /**
   * Answers 200 either way, like the chat connection test: a service that is not
   * there is a result to show, not a server fault.
   */
  router.add('POST', '/api/vectors/test', async ({ request, response }) => {
    const body = await readJson<{ text?: unknown; mode?: unknown }>(request).catch(() => ({}) as { text?: unknown; mode?: unknown });
    const config = store.loadConfig();
    const settings = vectorSettings(config);
    const override = body.mode === 'local' || body.mode === 'remote' ? body.mode : settings.mode;
    const chosen = override === 'remote' ? config.vector.remote : config.vector.local;
    const result = await probeEmbeddings({
      baseUrl: chosen.baseUrl,
      apiKey: chosen.apiKey,
      model: chosen.model,
      batchSize: 1,
    });
    sendJson(response, 200, { ...result, mode: override, model: chosen.model || result.model });
  });

  /** What a query text would activate right now — the threshold's tuning tool. */
  router.add('POST', '/api/vectors/query', async ({ request, response }) => {
    const body = await readJson<{ text?: unknown }>(request);
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      throw badRequest('text is required');
    }
    sendJson(response, 200, await probeVectorQuery(store, store.loadConfig(), body.text.trim()));
  });

  router.add('POST', '/api/worlds/:id/vectorize', async ({ params, response }) => {
    if (!store.worldExists(params.id!)) throw badRequest(`world not found: ${params.id}`);
    sendJson(response, 200, await indexWorld(store, params.id!));
  });

  /** Every book at once, for the first run after switching endpoints. */
  router.add('POST', '/api/vectors/rebuild', async ({ response }) => {
    const books = [];
    for (const summary of store.listWorlds()) {
      try {
        books.push(await indexWorld(store, summary.id));
      } catch (error) {
        books.push({ id: summary.id, error: (error as Error).message });
      }
    }
    sendJson(response, 200, { books, overview: vectorOverview(store, store.loadConfig()) });
  });

  /** Forgetting an index never touches the book itself. */
  router.add('DELETE', '/api/worlds/:id/vectors', ({ params, response }) => {
    store.deleteVectorIndex(params.id!);
    sendJson(response, 200, vectorOverview(store, store.loadConfig()));
  });
}

/** Re-exported for the routes that need to assemble a scan with vector hits. */
export type { ScanEntry };
