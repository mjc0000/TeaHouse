/**
 * Vector storage: which world book entries a turn should activate by meaning
 * rather than by keyword.
 *
 * The shape follows SillyTavern's vector extension: one collection per world book,
 * the unit is a whole entry (no chunking), membership is decided by a content
 * hash so an edit re-embeds only that entry, and the collection is invalidated by
 * a change of model. Hits are then handed to the ordinary world book scanner as
 * *forced activations* — the same thing ST does with `WORLDINFO_FORCE_ACTIVATE` —
 * so position, depth, insertion strategy, budget and recursion keep working the
 * way they already do.
 *
 * Pure logic and no IO: `Store` reads and writes the side file, the routes call
 * the embedding endpoint. Vectors are stored as base64 Float32 so a JSON file
 * stays a text file a user can back up, diff and hand-edit.
 */

import { createHash } from 'node:crypto';

export const VECTOR_VERSION = 1;

/** One entry's vector. `hash` is of the text that was embedded, not of the vector. */
export interface VectorItem {
  uid: number;
  hash: string;
  vector: string;
}

/** One world book's collection. */
export interface VectorIndex {
  version: number;
  /** The embedding model that produced these vectors. */
  model: string;
  /** Vector length; a mismatch means the model changed. */
  dims: number;
  updatedAt: string;
  items: VectorItem[];
}

/** The parts of a world book entry this module cares about. */
export interface VectorEntry {
  uid: number;
  content: string;
  disabled?: boolean;
  vectorized?: boolean;
}

export function emptyIndex(model = '', dims = 0): VectorIndex {
  return { version: VECTOR_VERSION, model, dims, updatedAt: new Date().toISOString(), items: [] };
}

/**
 * A short, stable hash of the text that gets embedded. Twelve hex characters is
 * plenty for "did this entry change" and keeps the file readable.
 */
export function hashText(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** What gets embedded: the entry body, exactly like SillyTavern. */
export function entryText(entry: VectorEntry): string {
  return entry.content.trim();
}

/** An entry is a candidate when it is enabled and either marked or "all entries". */
export function isCandidate(entry: VectorEntry, allEntries: boolean): boolean {
  if (entry.disabled === true) return false;
  if (entryText(entry) === '') return false;
  return allEntries || entry.vectorized === true;
}

/** Base64 of the little-endian Float32 view, so the file stays JSON text. */
export function encodeVector(values: number[]): string {
  const floats = Float32Array.from(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
}

export function decodeVector(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

/** Cosine similarity; 0 when either side has no length. */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index++) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface VectorHit {
  uid: number;
  score: number;
}

/**
 * The best `max` entries above `threshold`, best first. Ties are broken by uid so
 * the same query always activates the same entries in the same order — a preview
 * that reshuffles itself between two identical requests would be useless.
 */
export function rankItems(
  index: VectorIndex,
  query: Float32Array | number[],
  threshold: number,
  max: number,
): VectorHit[] {
  const scored: VectorHit[] = [];
  for (const item of index.items) {
    const vector = decodeVector(item.vector);
    if (vector.length !== query.length) continue;
    const score = cosine(query, vector);
    if (score < threshold) continue;
    scored.push({ uid: item.uid, score });
  }
  scored.sort((a, b) => b.score - a.score || a.uid - b.uid);
  return scored.slice(0, Math.max(0, max));
}

/** uids whose vector is missing or no longer matches the entry's text. */
export function staleUids(entries: VectorEntry[], index: VectorIndex | null, allEntries: boolean): number[] {
  const candidates = entries.filter((entry) => isCandidate(entry, allEntries));
  if (!index) return candidates.map((entry) => entry.uid);
  const known = new Map(index.items.map((item) => [item.uid, item.hash]));
  return candidates
    .filter((entry) => known.get(entry.uid) !== hashText(entryText(entry)))
    .map((entry) => entry.uid);
}

/** uids in the index that are no longer candidates: a disabled or deleted entry. */
export function orphanUids(entries: VectorEntry[], index: VectorIndex | null, allEntries: boolean): number[] {
  if (!index) return [];
  const candidates = new Set(entries.filter((entry) => isCandidate(entry, allEntries)).map((entry) => entry.uid));
  return index.items.filter((item) => !candidates.has(item.uid)).map((item) => item.uid);
}

export interface VectorStatus {
  /** Entries that should have a vector. */
  marked: number;
  /** Entries with a usable vector right now. */
  indexed: number;
  /** Entries needing (re-)embedding. */
  stale: number;
  model: string;
  dims: number;
  updatedAt: string;
  /** True when the index was built by another model and cannot be reused. */
  outdated: boolean;
  /** Entries in the index that no longer belong there. */
  orphans: number;
}

/**
 * What the UI shows per book. `model` is the one the *current* settings ask for:
 * when it differs from the stored index, everything has to be embedded again, and
 * saying so is better than silently returning hits from a foreign vector space.
 */
export function indexStatus(
  entries: VectorEntry[],
  index: VectorIndex | null,
  allEntries: boolean,
  model: string,
): VectorStatus {
  const candidates = entries.filter((entry) => isCandidate(entry, allEntries));
  const outdated = index !== null && index.model !== '' && model !== '' && index.model !== model;
  const stale = outdated ? candidates.length : staleUids(entries, index, allEntries).length;
  return {
    marked: candidates.length,
    indexed: outdated ? 0 : Math.max(0, candidates.length - stale),
    stale,
    model: index?.model ?? '',
    dims: index?.dims ?? 0,
    updatedAt: index?.updatedAt ?? '',
    outdated,
    orphans: orphanUids(entries, index, allEntries).length,
  };
}

/** Merges freshly embedded entries into an index, replacing those uids. */
export function withEmbedded(
  index: VectorIndex,
  embedded: { uid: number; hash: string; vector: string }[],
  model: string,
  dims: number,
): VectorIndex {
  const replaced = new Set(embedded.map((item) => item.uid));
  return {
    version: VECTOR_VERSION,
    model,
    dims: dims > 0 ? dims : index.dims,
    updatedAt: new Date().toISOString(),
    items: [...index.items.filter((item) => !replaced.has(item.uid)), ...embedded],
  };
}

/** Drops items the book no longer offers, keeping the file from growing forever. */
export function withoutUids(index: VectorIndex, uids: number[]): VectorIndex {
  const drop = new Set(uids);
  if (drop.size === 0) return index;
  return {
    ...index,
    updatedAt: new Date().toISOString(),
    items: index.items.filter((item) => !drop.has(item.uid)),
  };
}

/** Validates a parsed side file; a hand-edited or truncated file must not crash. */
export function coerceVectorIndex(raw: unknown): VectorIndex | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (!Array.isArray(item.items)) return null;
  const items: VectorItem[] = [];
  for (const candidate of item.items) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const entry = candidate as Record<string, unknown>;
    if (!Number.isFinite(entry.uid) || typeof entry.vector !== 'string' || entry.vector === '') continue;
    items.push({
      uid: Number(entry.uid),
      hash: typeof entry.hash === 'string' ? entry.hash : '',
      vector: entry.vector,
    });
  }
  return {
    version: Number.isFinite(item.version) ? Number(item.version) : VECTOR_VERSION,
    model: typeof item.model === 'string' ? item.model : '',
    dims: Number.isFinite(item.dims) ? Number(item.dims) : 0,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    items,
  };
}

/**
 * The text a turn is matched with: the last few messages, oldest first, the way
 * SillyTavern builds its query. Empty when there is nothing to match on.
 */
export function queryTextOf(messages: { role: string; content: string }[], count: number): string {
  const usable = messages.filter((message) => message.role !== 'system' && message.content.trim() !== '');
  return usable
    .slice(-Math.max(1, count))
    .map((message) => message.content.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
