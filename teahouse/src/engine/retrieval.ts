/**
 * Retrieval channels.
 *
 * The keyword scan always runs; this decides what a turn adds on top of it:
 *
 *   keyword  nothing
 *   all      every enabled entry of the character's embedded book — the files a
 *            skill shipped with, injected wholesale
 *   vector   semantic top-N, from the vector index
 *   select   the model picks from a catalogue, one cheap call
 *
 * The mode is pinned per chat (`ChatMeta.retrievalMode`) or read from the config.
 * The preview runs this same code but must not spend a model call, so
 * `allowModel: false` turns `select` into "nothing".
 */

import type { CharacterCard, World } from '../formats/types.ts';
import type { Notice } from '../i18n.ts';
import {
  RETRIEVAL_MODES,
  type ChatMeta,
  type RetrievalMode,
  type Store,
  type TeahouseConfig,
} from '../store/db.ts';
import { retrieveExternal } from '../vectors.ts';
import { selectExternal } from './select.ts';
import type { ExternalActivation, ScanEntry } from './world-scan.ts';

export function isRetrievalMode(value: unknown): value is RetrievalMode {
  return typeof value === 'string' && (RETRIEVAL_MODES as readonly string[]).includes(value);
}

/** The chat's pin wins; otherwise the configured default. */
export function effectiveRetrievalMode(config: TeahouseConfig, meta: ChatMeta | null): RetrievalMode {
  const pinned = meta?.retrievalMode;
  if (isRetrievalMode(pinned)) return pinned;
  return isRetrievalMode(config.retrieval?.mode) ? config.retrieval.mode : 'keyword';
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * `all`: every enabled entry of the embedded book(s). An entry whose text also
 * exists in an attached world book is a conflict: dropped by default, and kept
 * when `forceOnConflict` is set. `includeWorlds` widens the dump to the attached
 * books as well.
 *
 * Only a *live* attached entry (enabled, non-empty) can shadow an embedded one:
 * a disabled duplicate never activates, so it must not cost the embedded copy.
 */
export function fullInjectionHits(
  card: CharacterCard,
  worlds: World[],
  includeWorlds: boolean,
  forceOnConflict: boolean,
): ExternalActivation[] {
  const attached = worlds.filter((world) => !world.id.endsWith(':book'));
  const attachedText = new Set<string>();
  if (!forceOnConflict) {
    for (const world of attached) {
      for (const entry of world.entries) {
        if (entry.disable || entry.content.trim() === '') continue;
        attachedText.add(normalize(entry.content));
      }
    }
  }

  const hits: ExternalActivation[] = [];
  const add = (worldId: string, uid: number) => {
    hits.push({ world: worldId, uid, source: 'full' });
  };

  for (const book of card.books) {
    for (const entry of book.entries) {
      if (entry.disable || entry.content.trim() === '') continue;
      if (!forceOnConflict && attachedText.has(normalize(entry.content))) continue;
      add(book.id, entry.uid);
    }
  }
  if (includeWorlds) {
    for (const world of attached) {
      for (const entry of world.entries) {
        if (entry.disable || entry.content.trim() === '') continue;
        add(world.id, entry.uid);
      }
    }
  }
  return hits;
}

export interface RetrievalInput {
  store: Store;
  config: TeahouseConfig;
  meta: ChatMeta;
  card: CharacterCard;
  /** `collectWorlds(...)`: embedded books plus every attached one. */
  worlds: World[];
  /** `collectEntries(worlds)`: the same entries the keyword scan sees. */
  entries: ScanEntry[];
  messages: { role: string; content: string }[];
  model: string;
  /** Preview passes false: never spend a provider call there. */
  allowModel: boolean;
}

export interface RetrievalResult {
  mode: RetrievalMode;
  hits: ExternalActivation[];
  warning: Notice | null;
  /** How long a network channel took; zero for the local ones. */
  ms: number;
  /** Whether the vector channel answered from its cache. */
  cached: boolean;
}

export async function collectRetrieval(input: RetrievalInput): Promise<RetrievalResult> {
  const mode = effectiveRetrievalMode(input.config, input.meta);

  if (mode === 'all') {
    return {
      mode,
      hits: fullInjectionHits(
        input.card,
        input.worlds,
        input.config.retrieval.fullIncludeWorlds,
        input.config.retrieval.fullForceOnConflict,
      ),
      warning: null,
      ms: 0,
      cached: false,
    };
  }
  if (mode === 'vector') {
    const result = await retrieveExternal(input.store, input.config, input.entries, input.messages);
    return { mode, hits: result.hits, warning: result.warning, ms: result.ms, cached: result.cached };
  }
  if (mode === 'select') {
    if (!input.allowModel) return { mode, hits: [], warning: null, ms: 0, cached: false };
    const result = await selectExternal(input.config, input.entries, input.messages, input.model);
    return { mode, hits: result.hits, warning: result.warning, ms: result.ms, cached: false };
  }
  if (mode === 'agent') {
    // Agent mode injects documents, not world entries, and its loop lives in
    // `agent.ts` because it needs the call to finish before assembly. Nothing to
    // do here: the caller runs it and passes the documents to `assemble`.
    return { mode, hits: [], warning: null, ms: 0, cached: false };
  }
  return { mode: 'keyword', hits: [], warning: null, ms: 0, cached: false };
}
