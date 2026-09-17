/**
 * Assembly pipeline: chat state -> scan -> prompt.
 *
 * Shared by `/api/prompt/preview`, `/api/scan/debug` and `/api/generate`, so the
 * preview a user sees is byte-for-byte the request that gets sent.
 */

import { existsSync } from 'node:fs';

import type { CharacterCard, World } from './formats/types.ts';
import { notice } from './i18n.ts';
import { memoryProgress, memorySettings, readMemoryRecord, type MemoryRecord } from './engine/memory.ts';
import { effectivePersona } from './engine/personas.ts';
import type { ChatImageRef } from './engine/images.ts';
import { buildPrompt, type BuiltPrompt, type PromptBlock } from './engine/prompt-stack.ts';
import { TokenCounter, loadTokenizer } from './engine/tokens.ts';
import {
  scanWorldInfo,
  type ExternalActivation,
  type ScanEntry,
  type ScanGlobalData,
  type ScanResult,
  type GenerationTrigger,
} from './engine/world-scan.ts';
import type { ChatMeta, Store, TeahouseConfig } from './store/db.ts';

export interface Assembled {
  config: TeahouseConfig;
  meta: ChatMeta;
  card: CharacterCard;
  worlds: World[];
  entries: ScanEntry[];
  scan: ScanResult;
  built: BuiltPrompt;
  counter: TokenCounter;
  /** The model this assembly is for: the chat override, else the global default. */
  model: string;
  /** Who "you" are this turn: the chat pin, the library default, else config. */
  persona: { name: string; description: string };
  history: { role: 'user' | 'assistant' | 'system'; content: string }[];
  /** The stored long-term memory, or null when this chat has none. */
  memory: MemoryRecord | null;
  /** Pictures travelling with this turn: the newest user message's attachments. */
  images: ChatImageRef[];
  /** How far the memory has come and whether another summary is due. */
  memoryState: { covered: number; since: number; due: boolean };
}

/** The model a chat actually uses: its own override, else the configured default. */export function effectiveModel(config: TeahouseConfig, meta: ChatMeta): string {
  const override = typeof meta.model === 'string' ? meta.model.trim() : '';
  return override !== '' ? override : (config.model ?? '');
}

/** The sampler knobs a chat actually uses: its own snapshot, else the configured defaults. */
export interface EffectiveParams {
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  maxTokens: number;
}

export function effectiveParams(config: TeahouseConfig, meta: ChatMeta): EffectiveParams {
  const over = meta.params ?? {};
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return {
    temperature: num(over.temperature, config.temperature ?? 1),
    topP: num(over.topP, config.topP ?? 1),
    frequencyPenalty: num(over.frequencyPenalty, config.frequencyPenalty ?? 0),
    presencePenalty: num(over.presencePenalty, config.presencePenalty ?? 0),
    maxTokens: num(over.maxTokens, config.maxTokens ?? 0),
  };
}

/** Character book first, then the books selected on the chat. */
export function collectWorlds(store: Store, meta: ChatMeta, card: CharacterCard, members?: string[]): World[] {
  const worlds: World[] = [...card.books];
  const seen = new Set(worlds.map((world) => world.id));
  // Every member brings their embedded book, so nobody in a group talks
  // without their lore. Duplicates (shared books) are read once.
  for (const id of members ?? []) {
    if (id === card.id) continue;
    try {
      for (const book of store.loadCharacter(id).card.books) {
        if (!seen.has(book.id)) {
          seen.add(book.id);
          worlds.push(book);
        }
      }
    } catch {
      continue;
    }
  }
  for (const id of meta.worldRefs) {
    try {
      worlds.push(store.loadWorld(id).world);
    } catch {
      continue;
    }
  }
  return worlds;
}

export function collectEntries(worlds: World[]): ScanEntry[] {
  const entries: ScanEntry[] = [];
  worlds.forEach((world, index) => {
    const fromCharacter = index === 0 && world.id.endsWith(':book');
    for (const entry of world.entries) {
      entries.push({ world: world.id, fromCharacter, entry });
    }
  });
  return entries;
}

export function globalScanData(
  card: CharacterCard,
  config: TeahouseConfig,
  persona?: { description: string },
): ScanGlobalData {
  return {
    personaDescription: persona?.description ?? config.personaDescription,
    characterDescription: card.description,
    characterPersonality: card.personality,
    characterDepthPrompt: card.depthPrompt?.prompt ?? '',
    scenario: card.scenario,
    creatorNotes: card.creator_notes,
  };
}

export function counterFor(config: TeahouseConfig): TokenCounter {
  if (config.tokenizerPath.trim() !== '' && existsSync(config.tokenizerPath)) {
    try {
      return new TokenCounter(loadTokenizer(config.tokenizerPath));
    } catch {
      return new TokenCounter(null);
    }
  }
  return new TokenCounter(null);
}

/**
 * Anchors the displayed prompt size to the provider's reported usage.
 *
 * The server's token counter is only ever an estimate (or an exact tokenizer
 * count, when one is configured), but the provider tells us the real prompt
 * size after every request. Keep the headline figure on that anchor and add the
 * meter's movement since it, so a compaction, an edit or a stack toggle still
 * moves the number immediately without pretending the composition is exact.
 */
export function projectUsage(
  meta: ChatMeta,
  heuristicTokens: number,
): {
  pressureTokens?: number;
  projectedTokens?: number;
  anchorAt?: string;
  anchorHeuristicTokens?: number;
} {
  const anchor = meta.usageAnchor;
  if (!anchor || !Number.isFinite(anchor.promptTokens)) return {};
  const delta = Math.max(0, heuristicTokens) - Math.max(0, anchor.heuristicTokens);
  return {
    pressureTokens: Math.max(0, Math.round(anchor.promptTokens)),
    projectedTokens: Math.max(0, Math.round(anchor.promptTokens + delta)),
    anchorAt: anchor.at,
    anchorHeuristicTokens: Math.max(0, Math.round(anchor.heuristicTokens)),
  };
}

/** Members in speaking order; a missing/empty field means a solo chat. */
export function chatMembers(store: Store, meta: ChatMeta): string[] {
  const ids = Array.isArray(meta.members) ? meta.members.filter((id) => typeof id === 'string' && id !== '') : [];
  const known = ids.filter((id) => {
    try {
      store.loadCharacter(id);
      return true;
    } catch {
      return false;
    }
  });
  return known.length > 0 ? known : [meta.characterId];
}

/** Display name of one entry: the persona for user turns, the speaker's card otherwise. */
export function entrySpeakerName(store: Store, meta: ChatMeta, entry: { role: string; speaker?: string }, personaName: string): string {
  if (entry.role === 'user') return personaName;
  const id = typeof entry.speaker === 'string' && entry.speaker !== '' ? entry.speaker : meta.characterId;
  try {
    return store.loadCharacter(id).card.name;
  } catch {
    return id;
  }
}

export interface AssembleOptions {
  stack?: PromptBlock[];
  trigger?: GenerationTrigger;
  /** Impersonation turn: the `impersonate` block is injected instead of forced off. */
  impersonate?: boolean;
  /** Extra text appended to the final user message (e.g. a fresh prompt). */
  pendingUserMessage?: string;
  /**
   * Group turn answered by this member: markers render from their card, and the
   * reply is saved under their name. Missing means the primary character.
   */
  asCharacterId?: string;
  /**
   * Entries another channel already activated (vector storage). Assembly stays
   * synchronous, so the caller does the HTTP work and passes the result in.
   */
  external?: ExternalActivation[];
  /**
   * Files the agent read this turn. Assembly stays synchronous, so the caller
   * runs the read loop and passes the documents in.
   */
  agentDocs?: { id: string; text: string }[];
  /**
   * The model this turn actually answers with, when it is not the chat default
   * — a group member's own connection names its model. Only the display and the
   * trace read it; the request itself is built by the caller from the same
   * resolution.
   */
  model?: string;
}

export function assemble(
  store: Store,
  config: TeahouseConfig,
  chatId: string,
  options: AssembleOptions = {},
): Assembled {
  const meta = store.loadChatMeta(chatId);
  // Markers render from the answering member's card in a group turn, from the
  // primary character otherwise. A deleted member falls back to the primary.
  let speakingId = typeof options.asCharacterId === 'string' && options.asCharacterId !== ''
    ? options.asCharacterId
    : meta.characterId;
  try {
    store.loadCharacter(speakingId);
  } catch {
    speakingId = meta.characterId;
  }
  const { card } = store.loadCharacter(speakingId);
  const members = chatMembers(store, meta);
  const worlds = collectWorlds(store, meta, card, members);
  const entries = collectEntries(worlds);
  const memory = readMemoryRecord(meta);
  const chatEntries = store.loadChat(chatId);

  const counter = counterFor(config);

  // Pictures travel with the newest user message only: history is text, because
  // every image burns up to 1024 tokens and re-sending old ones buys nothing.
  let images: ChatImageRef[] = [];
  for (const entry of chatEntries) {
    if (entry.role === 'user' && entry.images && entry.images.length > 0) images = entry.images;
  }

  // Who "you" are this turn: the conversation's pin wins, then the library
  // default, then the two global fields everything used to read.
  const persona = effectivePersona(store.loadPersonas(), meta.personaId, {
    name: config.personaName,
    description: config.personaDescription,
  });

  const history = chatEntries
    .filter((entry) => entry.role !== 'system')
    .map((entry) => {
      const variants = entry.variants && entry.variants.length > 0 ? entry.variants : null;
      const index = entry.activeVariant ?? 0;
      const content = variants ? (variants[index] ?? entry.content) : entry.content;
      // Assistant turns carry their speaker's name in a group, so the model
      // always knows who said what. Solo chats resolve to the one card name,
      // exactly as before.
      const name = entry.role === 'user' ? persona.name : entrySpeakerName(store, meta, entry, persona.name);
      return { role: entry.role, content, name };
    });

  if (options.pendingUserMessage !== undefined && options.pendingUserMessage !== '') {
    history.push({ role: 'user', content: options.pendingUserMessage, name: persona.name });
  }

  // ST expires timed effects at the start of every scan, before anything is read.
  expireTimedEffects(meta, entries, history.length);

  const scan = scanWorldInfo({
    entries,
    messages: history.map((message) => ({ name: message.name ?? message.role, content: message.content })),
    global: globalScanData(card, config, persona),
    settings: { ...config.scan, maxContext: config.maxContext },
    trigger: options.trigger ?? 'normal',
    timedEffects: meta.timedEffects,
    chatLength: history.length,
    tokenCount: (text) => counter.count(text),
    external: options.external,
  });

  const built = buildPrompt({
    card,
    persona: persona.description,
    personaName: persona.name,
    history,
    scan,
    stack: options.stack,
    tokenCounter: counter,
    maxContext: config.maxContext,
    responseReserve: config.responseReserve,
    variables: meta.variables,
    outputLanguage: config.outputLanguage,
    languageInstruction: config.languageInstruction,
    storyTemplate: config.contextTemplate,
    // Prompt-side regex is part of the assembly, so the preview the user sees
    // is byte-for-byte the request that gets sent — same rule as everything else.
    promptRegexes: store.loadRegex().rules.filter((rule) => rule.enabled && (rule.scope === 'prompt' || rule.scope === 'both')),
    // The summary belongs to the conversation, so it is read here rather than
    // passed in: one truth, and the preview cannot disagree with the request.
    memory: {
      ...memorySettings(config),
      text: memory?.text ?? '',
    },
    agentDocs: options.agentDocs,
    impersonate: options.impersonate === true,
  });

  // The same entry can legitimately be injected twice: a character card that
  // embeds a book, plus the same book attached as a standalone world. Say so
  // instead of letting the prompt silently double up.
  const byContent = new Map<string, string[]>();
  for (const hit of scan.hits) {
    const key = hit.content.trim();
    if (key === '') continue;
    byContent.set(key, [...(byContent.get(key) ?? []), `${hit.world}#${hit.uid}`]);
  }
  const duplicated = [...byContent.entries()].filter(([, sources]) => sources.length > 1);
  if (duplicated.length > 0) {
    const detail = duplicated
      .slice(0, 3)
      .map(([content, sources]) => `${sources.join(', ')} (${content.slice(0, 30)}…)`)
      .join('; ');
    built.warnings.push(notice(
      'pipeline.duplicate',
      `有 ${duplicated.length} 条世界书内容被重复注入，来自不同的书：${detail}`,
      { count: duplicated.length, detail },
    ));
  }

  return {
    config,
    meta,
    card,
    worlds,
    entries,
    scan,
    built,
    counter,
    model: typeof options.model === 'string' && options.model !== ''
      ? options.model
      : effectiveModel(config, meta),
    persona: { name: persona.name, description: persona.description },
    images,
    history,
    memory,
    memoryState: memoryProgress(chatEntries, meta, memorySettings(config)),
  };
}

/**
 * Expires timed effects that have run out, mirroring ST's `checkTimedEffects`,
 * which runs at the start of every scan. When a sticky window ends and the entry
 * also declares a cooldown, the cooldown starts immediately — ST does this in the
 * sticky end callback.
 */
export function expireTimedEffects(
  meta: ChatMeta,
  entries: ScanEntry[],
  chatLength: number,
): void {
  const byKey = new Map(entries.map((item) => [`${item.world}.${item.entry.uid}`, item.entry]));
  for (const [key, effect] of Object.entries(meta.timedEffects)) {
    if (effect.sticky && chatLength > effect.sticky.end) {
      delete effect.sticky;
      const source = byKey.get(key);
      if (source?.cooldown && source.cooldown > 0 && !effect.cooldown) {
        effect.cooldown = { start: chatLength, end: chatLength + source.cooldown };
      }
    }
    if (effect.cooldown && chatLength > effect.cooldown.end) delete effect.cooldown;
    if (Object.keys(effect).length === 0) delete meta.timedEffects[key];
  }
}

/**
 * Arms sticky/cooldown after a successful generation.
 *
 * ST only arms an effect that is not already present
 * (`if (!chat_metadata.timedWorldInfo[type][key])`). Re-arming on every turn
 * would keep a sticky entry alive forever, because each scan would push its end
 * further out.
 */
export function commitTimedEffects(
  meta: ChatMeta,
  scan: ScanResult,
  entries: ScanEntry[],
  chatLength: number,
): void {
  const byKey = new Map(entries.map((item) => [`${item.world}.${item.entry.uid}`, item.entry]));
  for (const hit of scan.hits) {
    // A vector hit is not a keyword event: arming a cooldown from it would block
    // the entry's own keywords later, which the user never asked for.
    if (hit.activatedBy === 'external') continue;
    const key = `${hit.world}.${hit.uid}`;
    const source = byKey.get(key);
    if (!source) continue;
    const effect = meta.timedEffects[key] ?? {};
    if (source.sticky && source.sticky > 0 && !effect.sticky) {
      effect.sticky = { start: chatLength, end: chatLength + source.sticky };
    }
    if (source.cooldown && source.cooldown > 0 && !effect.cooldown) {
      effect.cooldown = { start: chatLength, end: chatLength + source.cooldown };
    }
    meta.timedEffects[key] = effect;
  }
}
