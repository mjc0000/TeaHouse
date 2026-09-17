/**
 * Vector retrieval: the part that talks to the embedding endpoint and hands the
 * result to the scanner.
 *
 * Kept out of `pipeline.ts` because `assemble()` is synchronous and this needs an
 * HTTP call: the routes await this first and pass the result in as `external`
 * activations, which keeps assembly pure, testable and identical whether or not
 * vector storage is on.
 *
 * Nothing here is allowed to break a turn. Any failure returns no hits plus a
 * warning for the prompt preview, which is the honest outcome: the reply still
 * happens, and the user is told why the books were not searched by meaning.
 */

import { embedTexts } from './llm/embeddings.ts';
import { notice, type Notice } from './i18n.ts';
import {
  cosine,
  decodeVector,
  hashText,
  indexStatus,
  queryTextOf,
  rankItems,
  type VectorIndex,
  type VectorStatus,
} from './engine/vectors.ts';
import type { Store, TeahouseConfig } from './store/db.ts';
import type { ExternalActivation, ScanEntry } from './engine/world-scan.ts';

export interface VectorSettings {
  enabled: boolean;
  mode: 'local' | 'remote';
  baseUrl: string;
  apiKey: string;
  model: string;
  threshold: number;
  maxEntries: number;
  queryMessages: number;
  allEntries: boolean;
  batchSize: number;
}

/** The endpoint the settings currently point at, with its defaults applied. */
export function vectorSettings(config: TeahouseConfig): VectorSettings {
  const raw = config.vector;
  const chosen = raw.mode === 'remote' ? raw.remote : raw.local;
  return {
    enabled: raw.enabled === true,
    mode: raw.mode === 'remote' ? 'remote' : 'local',
    baseUrl: (chosen?.baseUrl ?? '').trim(),
    apiKey: chosen?.apiKey ?? '',
    model: (chosen?.model ?? '').trim(),
    threshold: Number.isFinite(raw.threshold) ? raw.threshold : 0.25,
    maxEntries: Number.isFinite(raw.maxEntries) ? Math.max(0, Math.floor(raw.maxEntries)) : 5,
    queryMessages: Number.isFinite(raw.queryMessages) ? Math.max(1, Math.floor(raw.queryMessages)) : 2,
    allEntries: raw.allEntries === true,
    batchSize: Number.isFinite(raw.batchSize) ? Math.max(1, Math.floor(raw.batchSize)) : 64,
  };
}

export interface VectorRetrieval {
  hits: ExternalActivation[];
  /** Present when the search could not run; the caller surfaces it. */
  warning: Notice | null;
  /** Seconds of embedding call, for the trace and the preview. */
  ms: number;
  /** True when a cached query vector was reused. */
  cached: boolean;
}

/**
 * Query vectors are cached by text and model: the prompt preview refreshes on
 * every edit, and re-embedding the same two messages each time would be both slow
 * and, on a paid endpoint, wasteful.
 */
const queryCache = new Map<string, Float32Array>();
const QUERY_CACHE_LIMIT = 32;

function cachedQuery(key: string): Float32Array | null {
  const found = queryCache.get(key);
  if (!found) return null;
  // Refresh recency, so a chat being used keeps its slot.
  queryCache.delete(key);
  queryCache.set(key, found);
  return found;
}

function storeQuery(key: string, vector: Float32Array): void {
  queryCache.set(key, vector);
  while (queryCache.size > QUERY_CACHE_LIMIT) {
    const oldest = queryCache.keys().next().value;
    if (oldest === undefined) break;
    queryCache.delete(oldest);
  }
}

/** Test seam: the cache is process-wide, and tests must not inherit state. */
export function clearQueryCache(): void {
  queryCache.clear();
}

/** Which books have something to search, and how far behind they are. */
export function vectorOverview(
  store: Store,
  config: TeahouseConfig,
): { settings: VectorSettings; books: (VectorStatus & { id: string; name: string })[] } {
  const settings = vectorSettings(config);
  const books = store.listWorlds().map((summary) => {
    let entries: ScanEntry[] = [];
    try {
      const { world } = store.loadWorld(summary.id);
      entries = world.entries.map((entry) => ({ world: summary.id, entry }));
    } catch {
      /* an unreadable book simply has nothing to search */
    }
    const status = indexStatus(
      entries.map((item) => ({
        uid: item.entry.uid,
        content: item.entry.content,
        disabled: item.entry.disable,
        vectorized: item.entry.vectorized,
      })),
      store.loadVectorIndex(summary.id),
      settings.allEntries,
      settings.model,
    );
    return { id: summary.id, name: summary.name, ...status };
  });
  return { settings, books };
}

/**
 * The entries this turn should activate by meaning. Reads every attached book's
 * index, embeds the query once, and ranks per book so one large book cannot
 * crowd out a small one.
 */
export async function retrieveExternal(
  store: Store,
  config: TeahouseConfig,
  entries: ScanEntry[],
  messages: { role: string; content: string }[],
): Promise<VectorRetrieval> {
  const settings = vectorSettings(config);
  // The retrieval *mode* is the gate now (`retrieval.mode === 'vector'`), so the
  // legacy `vector.enabled` switch no longer short-circuits here; it survives
  // only as a display flag and as the input to the one-time config migration.
  if (settings.model === '') {
    return {
      hits: [],
      warning: notice('vector.noModelRun', '向量检索已选中，但没有配置 embedding 模型'),
      ms: 0,
      cached: false,
    };
  }

  const query = queryTextOf(messages, settings.queryMessages);
  if (query === '') return { hits: [], warning: null, ms: 0, cached: false };

  // Group the attached entries by book; only books with an index can answer.
  const byWorld = new Map<string, VectorIndex>();
  for (const item of entries) {
    if (byWorld.has(item.world)) continue;
    const index = store.loadVectorIndex(item.world);
    if (index && index.items.length > 0) byWorld.set(item.world, index);
  }
  if (byWorld.size === 0) {
    return {
      hits: [],
      warning: store.listWorlds().length > 0
        ? notice('vector.notIndexed', '向量检索已选中，但本会话挂载的世界书还没有建索引（设置 → 世界书 → 向量检索）')
        : null,
      ms: 0,
      cached: false,
    };
  }

  const cacheKey = `${settings.mode}:${settings.baseUrl}:${settings.model}:${hashText(query)}`;
  const cached = cachedQuery(cacheKey);
  const started = Date.now();
  try {
    let vector = cached;
    if (!vector) {
      const embedded = await embedTexts(
        {
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: settings.model,
          batchSize: 1,
        },
        [query],
      );
      vector = Float32Array.from(embedded.vectors[0] ?? []);
      storeQuery(cacheKey, vector);
      // A brand-new query is the slow path; the elapsed time is worth reporting.
      if (vector.length === 0) {
        return {
          hits: [],
          warning: notice('vector.empty', '向量服务返回了空向量，本轮不做向量检索'),
          ms: Date.now() - started,
          cached: false,
        };
      }
    }

    // Per book first, then the best across books, so the cap is not a lottery.
    const perBook = Math.max(1, settings.maxEntries);
    const hits: ExternalActivation[] = [];
    for (const [world, index] of byWorld) {
      if (index.dims !== 0 && index.dims !== vector.length) {
        // Vectors from another model cannot be compared; say so instead of
        // returning numbers that mean nothing.
        return {
          hits: [],
          warning: notice(
            'vector.modelMismatch',
            `「${world}」的向量是 ${index.model || '另一个模型'}（${index.dims} 维）建的，当前模型是 ${settings.model}（${vector.length} 维），需要重建索引`,
            {
              world,
              indexModel: index.model || '',
              indexDims: index.dims,
              model: settings.model,
              dims: vector.length,
            },
          ),
          ms: Date.now() - started,
          cached: cached !== null,
        };
      }
      for (const hit of rankItems(index, vector, settings.threshold, perBook)) {
        hits.push({ world, uid: hit.uid, score: hit.score, source: 'vector' });
      }
    }
    hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return {
      hits: hits.slice(0, Math.max(0, settings.maxEntries)),
      warning: null,
      ms: Date.now() - started,
      cached: cached !== null,
    };
  } catch (error) {
    // Worst case the turn is a normal keyword turn, and the preview explains it.
    const message = (error as Error).message;
    return {
      hits: [],
      warning: notice('vector.failed', `向量检索失败：${message}`, { error: message }),
      ms: Date.now() - started,
      cached: false,
    };
  }
}

/** One-off similarity probe for the settings dialog and the "test this" button. */
export async function probeVectorQuery(
  store: Store,
  config: TeahouseConfig,
  text: string,
): Promise<{ ok: boolean; error?: string; hits: { world: string; uid: number; comment: string; score: number }[] }> {
  const settings = vectorSettings(config);
  try {
    const embedded = await embedTexts(
      { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, batchSize: 1 },
      [text],
    );
    const query = Float32Array.from(embedded.vectors[0] ?? []);
    const hits: { world: string; uid: number; comment: string; score: number }[] = [];
    for (const summary of store.listWorlds()) {
      const index = store.loadVectorIndex(summary.id);
      if (!index || index.items.length === 0) continue;
      if (index.dims !== 0 && query.length !== 0 && index.dims !== query.length) continue;
      // The comment comes from the book, never from the index: the index only
      // holds uids, hashes and vectors.
      const comments = new Map<number, string>();
      try {
        const { world } = store.loadWorld(summary.id);
        for (const entry of world.entries) comments.set(entry.uid, entry.comment);
      } catch {
        /* an unreadable book still answers, just without comments */
      }
      for (const hit of rankItems(index, query, settings.threshold, 20)) {
        hits.push({
          world: summary.name,
          uid: hit.uid,
          comment: comments.get(hit.uid) ?? '',
          score: hit.score,
        });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return { ok: true, hits: hits.slice(0, 20) };
  } catch (error) {
    return { ok: false, error: (error as Error).message, hits: [] };
  }
}
