/**
 * Chat log interchange.
 *
 * SillyTavern keeps a transcript as JSONL: one JSON object per line, the first
 * one a header (`chat_metadata` / `user_name` / `character_name`) and the rest
 * messages (`mes`, `is_user`, `send_date`, `swipes`, `swipe_id`, `extra`). This
 * module converts between that and our own entry shape, both ways, so a
 * transcript can move between the two tools instead of being stranded.
 *
 * `parseChatLog` also accepts our own JSONL (what `data/chats/*.jsonl` holds),
 * which makes an export/import round trip lossless for our side as well.
 */

import type { ChatEntry, ChatMeta } from '../store/db.ts';

/** One line of SillyTavern's transcript format. */
export interface StChatLine {
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  mes?: string;
  send_date?: string;
  swipes?: string[];
  swipe_id?: number;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StChatHeader {
  chat_metadata: Record<string, unknown>;
  user_name: string;
  character_name: string;
}

/** ST writes `June 1, 2024 3:04pm`; keep the same look so files travel well. */
export function formatSendDate(date: Date): string {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const hours = date.getHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const suffix = hours < 12 ? 'am' : 'pm';
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${hour12}:${minutes}${suffix}`;
}

/** Best effort: ST's own format, ISO, or anything `Date` understands. */
function parseSendDate(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * @param meta          the chat's metadata (for the header's provenance)
 * @param entries       the transcript, in order
 * @param characterName what ST calls `character_name`
 * @param userName      what ST calls `user_name` (the persona)
 * @param speakerNames  group speakers by entry id; missing means the default above
 */
export function toSillyTavernJSONL(
  meta: ChatMeta,
  entries: ChatEntry[],
  characterName: string,
  userName: string,
  speakerNames: Record<string, string> = {},
): string {
  const header: StChatHeader = {
    chat_metadata: {
      tavern: {
        chatId: meta.id,
        characterId: meta.characterId,
        model: meta.model ?? null,
        worldRefs: meta.worldRefs,
        exportedAt: new Date().toISOString(),
      },
    },
    user_name: userName,
    character_name: characterName,
  };

  // SillyTavern's Memory extension keeps its summary in `extra.memory` on one of
  // the messages, so write ours back where its UI will find it. The message the
  // summary covered is the natural home; if that one is gone, the last line.
  const memoryText = (meta.memory?.text ?? '').trim();
  const anchorId = meta.memory?.upToEntryId ?? null;
  const anchorIndex = anchorId === null ? -1 : entries.findIndex((entry) => entry.id === anchorId);
  const memoryIndex = memoryText === '' ? -1 : anchorIndex === -1 ? entries.length - 1 : anchorIndex;

  const lines = [JSON.stringify(header)];
  for (const [index, entry] of entries.entries()) {
    const variants = entry.variants ?? [];
    const active = entry.activeVariant ?? 0;
    const line: StChatLine = {
      name: entry.role === 'user' ? userName : (speakerNames[entry.id] ?? characterName),
      is_user: entry.role === 'user',
      ...(entry.role === 'system' ? { is_system: true } : {}),
      send_date: formatSendDate(new Date(entry.createdAt)),
      mes: variants.length > 0 ? (variants[active] ?? entry.content) : entry.content,
      extra: index === memoryIndex ? { memory: memoryText } : {},
      ...(entry.reasonings?.[active] ? { reasoning: entry.reasonings[active] } : {}),
      ...(variants.length > 1 ? { swipes: variants, swipe_id: active } : {}),
    };
    lines.push(JSON.stringify(line));
  }
  return `${lines.join('\n')}\n`;
}

export interface ParsedChatLog {
  /** Entries with fresh ids and parent links, ready to be written. */
  entries: ChatEntry[];
  format: 'sillytavern' | 'tavern';
  /** Names found in an ST header, when there was one. */
  characterName: string;
  userName: string;
  /**
   * `extra.memory` — SillyTavern's Memory extension stores its running summary on
   * one of the messages. The last one wins, and `entryIndex` is the message it sat
   * on, which becomes the anchor our own record continues from.
   */
  memory: { text: string; entryIndex: number } | null;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads either format. Lines that carry neither `mes` nor `content` are counted
 * as warnings rather than aborting the whole import: a transcript with one odd
 * line is still worth having.
 */
export function parseChatLog(text: string): ParsedChatLog {
  const warnings: string[] = [];
  const lines = text
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const raw: Record<string, unknown>[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error('not an object');
      raw.push(parsed);
    } catch (error) {
      warnings.push(`line ${index + 1}: ${(error as Error).message}`);
    }
  }

  const stLike = raw.some((item) => typeof item.mes === 'string');
  const entries: ChatEntry[] = [];
  let characterName = '';
  let userName = '';
  let memory: ParsedChatLog['memory'] = null;

  for (const [index, item] of raw.entries()) {
    // The ST header line: names plus metadata, no message.
    if (typeof item.mes !== 'string' && typeof item.content !== 'string') {
      if (typeof item.character_name === 'string') characterName = item.character_name;
      if (typeof item.user_name === 'string' && item.user_name !== 'unused') userName = item.user_name;
      if (stLike) continue;
      warnings.push(`line ${index + 1}: skipped (no message text)`);
      continue;
    }

    const content = typeof item.mes === 'string' ? item.mes : String(item.content ?? '');
    const role: ChatEntry['role'] = item.is_system === true
      ? 'system'
      : item.is_user === true
        ? 'user'
        : typeof item.role === 'string' && ['user', 'assistant', 'system'].includes(item.role)
          ? (item.role as ChatEntry['role'])
          : 'assistant';

    const swipes = Array.isArray(item.swipes)
      ? (item.swipes as unknown[]).filter((value): value is string => typeof value === 'string')
      : [];
    // ST calls the alternatives `swipes`; our own JSONL calls them `variants`.
    const listed = swipes.length > 0
      ? swipes
      : Array.isArray(item.variants)
        ? (item.variants as unknown[]).filter((value): value is string => typeof value === 'string')
        : [];
    // ST stores the alternatives separately from the visible text; our shape
    // keeps the visible one in `content` as well, so both tools read the same.
    const variants = listed.length > 0 ? listed : undefined;
    // `swipe_id` is ST's name for the active candidate; `activeVariant` is ours.
    const active = Number.isInteger(item.swipe_id)
      ? (item.swipe_id as number)
      : Number.isInteger(item.activeVariant)
        ? (item.activeVariant as number)
        : 0;
    const activeVariant = Math.max(0, Math.min(active, (variants?.length ?? 1) - 1));

    entries.push({
      id: `m${entries.length}-${Date.now().toString(36)}${entries.length}`,
      parentId: entries.length > 0 ? entries[entries.length - 1]!.id : null,
      role,
      content: variants !== undefined ? (variants[activeVariant] ?? content) : content,
      ...(typeof item.reasoning === 'string' && item.reasoning !== ''
        ? { reasonings: variants !== undefined ? variants.map(() => item.reasoning as string) : [item.reasoning] }
        : {}),
      ...(variants !== undefined ? { variants, activeVariant } : {}),
      createdAt: parseSendDate(item.send_date ?? item.createdAt),
    });

    // SillyTavern's Memory extension keeps its summary here; take the last one,
    // which is the most recent state of it.
    const extra = item.extra;
    if (isRecord(extra) && typeof extra.memory === 'string' && extra.memory.trim() !== '') {
      memory = { text: extra.memory.trim(), entryIndex: entries.length - 1 };
    }
  }

  return {
    entries,
    format: stLike ? 'sillytavern' : 'tavern',
    characterName,
    userName,
    memory,
    warnings,
  };
}
