/**
 * Long-term memory: a rolling summary of the conversation, injected as its own
 * prompt block.
 *
 * The shape follows SillyTavern's Memory extension
 * (`public/scripts/extensions/memory/index.js`): summarise every N messages,
 * hand the previous summary to the model as the base for the next one, inject the
 * result as a system message at a depth, and let the user edit or freeze it.
 * Deliberate differences:
 *
 *   - The record lives in the chat's own meta file, not in `extra.memory` on an
 *     arbitrary message. One truth per fact, and deleting a message can never take
 *     the memory with it. `formats/chat-log.ts` writes it back on export, so a
 *     SillyTavern log still round-trips.
 *   - Nothing in the transcript is rewritten. The summary only adds a block;
 *     trimming stays the only thing that removes messages from the prompt, so a
 *     summary can never silently delete history.
 *
 * Pure logic and no IO: the caller reads the chat, calls the provider, stores the
 * result.
 */

import type { ChatEntry, ChatMeta, TeahouseConfig } from '../store/db.ts';

/** SillyTavern's default instruction, `{{words}}` and all. */
export const DEFAULT_MEMORY_PROMPT =
  'Ignore previous instructions. Summarize the most important facts and events in the story so far. If a summary already exists in your memory, use that as a base and expand with new facts. Limit the summary to {{words}} words or less. Your response should include nothing but the summary.';

/** SillyTavern's default block wording. */
export const DEFAULT_MEMORY_TEMPLATE = '[Summary: {{summary}}]';

export const DEFAULT_MEMORY_INTERVAL = 10;
export const DEFAULT_MEMORY_WORDS = 200;
/** SillyTavern injects memory two messages from the end. */
export const DEFAULT_MEMORY_DEPTH = 2;

export type MemoryRole = 'system' | 'user' | 'assistant';

/** The stored summary for one conversation. */
export interface MemoryRecord {
  text: string;
  /** Entry the summary has already covered; the next one continues after it. */
  upToEntryId: string | null;
  /** How many messages it covered, so the counter survives a lost anchor id. */
  upToIndex: number;
  updatedAt: string;
  /** Which model wrote it, shown in the editor. */
  model: string;
  tokens: number;
  /** Auto-updates stop while true; manual edits still work. */
  frozen?: boolean;
  /** What the summarising call cost, when the provider reported it. */
  usage?: { promptTokens: number; completionTokens: number };
}

export interface MemorySettings {
  enabled: boolean;
  interval: number;
  words: number;
  prompt: string;
  template: string;
  depth: number;
  role: MemoryRole;
  /** '' follows the model this conversation uses. */
  model: string;
}

/** Reads the config section, clamped, with the defaults filled in. */
export function memorySettings(config: TeahouseConfig): MemorySettings {
  const raw = config.memory ?? {};
  const interval = Number.isFinite(raw.interval) ? Math.max(1, Math.floor(raw.interval)) : DEFAULT_MEMORY_INTERVAL;
  const words = Number.isFinite(raw.words) ? Math.max(20, Math.floor(raw.words)) : DEFAULT_MEMORY_WORDS;
  const depth = Number.isFinite(raw.depth) ? Math.max(0, Math.floor(raw.depth)) : DEFAULT_MEMORY_DEPTH;
  return {
    enabled: raw.enabled === true,
    interval,
    words,
    prompt: (raw.prompt ?? '').trim() === '' ? DEFAULT_MEMORY_PROMPT : raw.prompt!,
    template: (raw.template ?? '').trim() === '' ? DEFAULT_MEMORY_TEMPLATE : raw.template!,
    depth,
    role: raw.role === 'user' || raw.role === 'assistant' ? raw.role : 'system',
    model: (raw.model ?? '').trim(),
  };
}

/** `[Summary: …]` — the block's wording; `{{summary}}` is replaced. */
export function renderMemoryText(template: string, text: string): string {
  const body = text.trim();
  if (body === '') return '';
  return template.replaceAll('{{summary}}', body);
}

/** The instruction with the target length filled in. */
export function renderMemoryPrompt(prompt: string, words: number): string {
  return prompt.replaceAll('{{words}}', String(words));
}

/** A message worth summarising: real content, not a system note. */
function isMemoryCandidate(entry: ChatEntry): boolean {
  return entry.role !== 'system' && entry.content.trim() !== '';
}

/** The stored record, or null when a chat has none (or has a broken one). */
export function readMemoryRecord(meta: ChatMeta | null | undefined): MemoryRecord | null {
  const raw = meta?.memory;
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (text.trim() === '') return null;
  return {
    text,
    upToEntryId: typeof raw.upToEntryId === 'string' ? raw.upToEntryId : null,
    upToIndex: Number.isFinite(raw.upToIndex) ? Number(raw.upToIndex) : 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    tokens: Number.isFinite(raw.tokens) ? Number(raw.tokens) : 0,
    frozen: raw.frozen === true,
    usage: raw.usage,
  };
}

/**
 * How far the summary has come, and whether another one is due.
 *
 * A missing anchor (deleted message, imported log, first run) makes every message
 * count as new: the old summary is then handed back to the model as the base, so
 * nothing is lost — the same thing SillyTavern does when its marker is gone.
 */
export function memoryProgress(
  entries: ChatEntry[],
  meta: ChatMeta | null | undefined,
  settings: MemorySettings,
): { covered: number; since: number; due: boolean } {
  const candidates = entries.filter(isMemoryCandidate);
  const record = readMemoryRecord(meta);
  const anchor =
    record?.upToEntryId != null ? candidates.findIndex((entry) => entry.id === record.upToEntryId) : -1;
  const since = anchor === -1 ? candidates.length : candidates.length - anchor - 1;
  const covered =
    anchor !== -1 ? anchor + 1 : record ? Math.min(record.upToIndex, candidates.length) : 0;
  const due = settings.enabled && record?.frozen !== true && since >= settings.interval;
  return { covered, since, due };
}

/** The messages a new summary has to cover. */
export function pendingEntries(entries: ChatEntry[], record: MemoryRecord | null): ChatEntry[] {
  const candidates = entries.filter(isMemoryCandidate);
  if (record?.upToEntryId == null) return candidates;
  const anchor = candidates.findIndex((entry) => entry.id === record.upToEntryId);
  return anchor === -1 ? candidates : candidates.slice(anchor + 1);
}

/**
 * The messages for the summarising call.
 *
 * The speaker is written in front of every line: SillyTavern feeds the raw text,
 * but a name costs two tokens and removes the guess about who did what.
 */
export function buildSummaryMessages(options: {
  instruction: string;
  previous: string;
    entries: ChatEntry[];
    names: { char: string; user: string };
    /** Group speaker names by entry id; missing means the default above. */
    speakerNames?: Record<string, string>;
  }): { role: 'system' | 'user'; content: string }[] {
    const speaker = (entry: ChatEntry): string => {
      if (entry.role === 'user') return options.names.user;
      if (entry.role === 'assistant') {
        return (entry.id && options.speakerNames?.[entry.id]) || options.names.char;
      }
      return 'system';
    };
  const lines = options.entries
    .map((entry) => `${speaker(entry)}: ${entry.content.trim()}`)
    .join('\n');
  const previous = options.previous.trim();
  const body =
    previous === ''
      ? lines
      : `[Existing summary]\n${previous}\n\n[New messages]\n${lines}`;
  return [
    { role: 'system', content: options.instruction },
    { role: 'user', content: body },
  ];
}

/**
 * Tidies what the model sent back. Models like to wrap a summary in the block
 * template or in quotes; both would end up inside the injected block otherwise.
 */
export function cleanSummary(raw: string): string {
  let text = raw.trim();
  const wrapped = /^\[summary:\s*([\s\S]*?)\]$/i.exec(text);
  if (wrapped) text = wrapped[1]!.trim();
  const quoted =
    text.length > 1 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”')));
  if (quoted) text = text.slice(1, -1).trim();
  return text;
}

/** The record a fresh summary should be stored as. */
export function summarizeRecord(options: {
  text: string;
  covered: ChatEntry[];
  model: string;
  tokens: number;
  usage?: { promptTokens: number; completionTokens: number };
  frozen?: boolean;
}): MemoryRecord {
  const last = options.covered[options.covered.length - 1];
  return {
    text: options.text,
    upToEntryId: last?.id ?? null,
    upToIndex: options.covered.length,
    updatedAt: new Date().toISOString(),
    model: options.model,
    tokens: options.tokens,
    ...(options.frozen === true ? { frozen: true } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
  };
}
