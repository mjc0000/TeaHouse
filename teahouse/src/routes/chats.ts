/**
 * Chats: transcripts, world attachment, swipes and truncation.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { badRequest, notFound, readBody, readJson, sendJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { cardGreetings } from '../formats/character-card.ts';
import { parseChatLog, toSillyTavernJSONL } from '../formats/chat-log.ts';
import { counterFor, effectiveModel } from '../pipeline.ts';
import { effectivePersona } from '../engine/personas.ts';
import { isRetrievalMode } from '../engine/retrieval.ts';
import { isGroupMode } from '../engine/group.ts';
import { buildTranslationPrompt } from '../engine/translate.ts';
import { chatOnce } from '../llm/openai-compat.ts';
import { traceId } from '../engine/trace.ts';
import { sanitizeId, type ChatEntry, type ChatParams, type GroupMode, type Store, type TeahouseConfig } from '../store/db.ts';

/** The sampler defaults, frozen for one new conversation. */
function snapshotParams(config: TeahouseConfig): ChatParams {
  return {
    temperature: config.temperature ?? 1,
    topP: config.topP ?? 1,
    frequencyPenalty: config.frequencyPenalty ?? 0,
    presencePenalty: config.presencePenalty ?? 0,
    maxTokens: config.maxTokens ?? 0,
  };
}

const PARAM_RANGES: Record<keyof Required<ChatParams>, { min: number; max: number; label: string; code: string; minExclusive?: boolean }> = {
  temperature: { min: 0, max: 2, label: '温度', code: 'temperature' },
  topP: { min: 0, max: 1, label: 'Top P', code: 'topP', minExclusive: true },
  frequencyPenalty: { min: -2, max: 2, label: '频率惩罚', code: 'frequencyPenalty' },
  presencePenalty: { min: -2, max: 2, label: '存在惩罚', code: 'presencePenalty' },
  maxTokens: { min: 0, max: Number.MAX_SAFE_INTEGER, label: '单次回复上限', code: 'maxTokens' },
};

/** Merges a params patch after range-checking it; `null` follows the defaults again. */
function applyParamsPatch(meta: { params?: ChatParams }, patch: unknown): void {
  if (patch === null) {
    delete meta.params;
    return;
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw badRequest('params must be an object or null');
  }
  const next: ChatParams = { ...(meta.params ?? {}) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const range = PARAM_RANGES[key as keyof ChatParams];
    if (!range) throw badRequest(`unknown sampler knob: ${key}`);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw badRequest(`${range.label}需要是数字`, `chats.param.${range.code}.notNumber`);
    }
    const below = range.minExclusive ? value <= range.min : value < range.min;
    if (below || value > range.max) {
      const min = range.minExclusive ? `(${range.min}` : range.min;
      throw badRequest(
        `${range.label}需要在 ${min} 到 ${range.max} 之间`,
        `chats.param.${range.code}.range`,
        { min, max: range.max },
      );
    }
    (next as Record<string, number>)[key] = value;
  }
  meta.params = next;
}

function newEntry(entries: ChatEntry[], role: ChatEntry['role'], content: string): ChatEntry {
  return {
    id: `m${entries.length}-${Date.now().toString(36)}`,
    parentId: entries.length > 0 ? entries[entries.length - 1]!.id : null,
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

/** The text a translation would be made from: the active variant, or the body. */
function visibleSource(entry: ChatEntry): { source: string; active: number } {
  const active = entry.variants && entry.variants.length > 0
    ? Math.max(0, Math.min(entry.variants.length - 1, entry.activeVariant ?? 0))
    : 0;
  const source = entry.variants && entry.variants.length > 0
    ? (entry.variants[active] ?? entry.content)
    : entry.content;
  return { source, active };
}

/**
 * A stored translation is fresh for exactly the text and target it was made
 * from: anything that moves the source (an edit, a swipe, another preset
 * language) makes it stale and it is translated again.
 */
function translationIsFresh(entry: ChatEntry, source: string, active: number, lang: string): boolean {
  const cached = entry.translation;
  return Boolean(cached && cached.lang === lang && cached.ofVariant === active &&
    cached.ofLength === source.length && cached.ofHead === source.slice(0, 128));
}

function translationPatch(source: string, active: number, lang: string, text: string) {
  return { lang, text, ofVariant: active, ofHead: source.slice(0, 128), ofLength: source.length };
}

/**
 * One translation call, shared by the single and the batch route.
 *
 * A translation wants the boring answer: low temperature, no stop strings to
 * trip on, no usage bookkeeping (this prompt is not the conversation's prompt,
 * the same rule as the summariser).
 */
async function translateText(config: TeahouseConfig, model: string, source: string, lang: string): Promise<string> {
  const prompt = buildTranslationPrompt(source, lang);
  const result = await chatOnce(
    { ...config, model, temperature: 0.3, maxTokens: 0, stop: [], requestUsage: false },
    [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
  );
  return result.text.trim();
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving order.
 *
 * Translation is where the model latency lives, so a few calls run together;
 * the chat file itself is written once, after every call has returned.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** How many translation calls a batch keeps in flight. Small: providers rate-limit. */
const TRANSLATE_CONCURRENCY = 3;

export function registerChatRoutes(router: Router, store: Store): void {
  router.add('GET', '/api/chats', ({ response }) => {
    sendJson(response, 200, store.listChats());
  });

  router.add('POST', '/api/chats', async ({ request, response }) => {
    const body = await readJson<{
      characterId?: string;
      name?: string;
      worldRefs?: string[];
      greeting?: number;
      members?: unknown;
      memberConnections?: unknown;
      groupReplyLimit?: unknown;
      groupMode?: unknown;
    }>(request);
    if (typeof body.characterId !== 'string' || body.characterId === '') {
      throw badRequest('characterId is required');
    }

    // The greeting is resolved here, from the card, so a caller cannot seed a
    // transcript with arbitrary text: `greeting` is an index into the card's own
    // list, and `-1` asks for an empty chat — which is what every chat used to
    // be before greetings existed.
    const index = body.greeting === undefined ? 0 : body.greeting;
    if (!Number.isInteger(index) || index < -1) {
      throw badRequest('greeting must be an integer >= -1');
    }
    let greeting = '';
    if (index >= 0) {
      let card;
      try {
        card = store.loadCharacter(body.characterId).card;
      } catch {
        throw notFound(`character not found: ${body.characterId}`);
      }
      const greetings = cardGreetings(card);
      // A card with no greetings (a skill, or an unfinished draft) simply starts
      // empty: asking for the first of none is not an error, it is "nothing to
      // seed". An index past the end of a card that *does* have greetings is
      // still a caller mistake.
      if (greetings.length > 0) {
        if (index >= greetings.length) {
          throw badRequest(`this card has ${greetings.length} greeting(s); ${index} is out of range`);
        }
        greeting = greetings[index] ?? '';
      }
    }

    sendJson(response, 200, store.createChat({
      characterId: body.characterId,
      name: body.name,
      worldRefs: Array.isArray(body.worldRefs) ? body.worldRefs.filter((x) => typeof x === 'string') : [],
      // Snapshot the global default: this conversation now owns its model.
      model: store.loadConfig().model,
      // And its sampler knobs: later default changes do not move it.
      params: snapshotParams(store.loadConfig()),
      // And its persona: later changes of the library default do not move it.
      personaId: store.loadPersonas().activeId || undefined,
      members: coerceMembers(store, body.members),
      memberConnections: coerceMemberConnections(store, body.memberConnections),
      groupReplyLimit: coerceGroupReplyLimit(body.groupReplyLimit) ?? undefined,
      groupMode: coerceGroupMode(body.groupMode) ?? undefined,
      greeting,
    }));
  });

  /**
   * Group membership, in speaking order. An empty list means a solo chat with
   * `characterId`; two or more members make it a group, and the model picks
   * who answers each turn (`@Name` pins one).
   */
  router.add('POST', '/api/chats/:id/members', async ({ request, params, response }) => {
    const body = await readJson<{ members?: unknown; memberConnections?: unknown; groupReplyLimit?: unknown; groupMode?: unknown }>(request);
    const meta = store.loadChatMeta(params.id!);
    // `characterId` stays put on purpose: greetings, fallbacks and the delete
    // cascade all key off the primary, whatever the current lineup is.
    meta.members = coerceMembers(store, body.members);
    const connections = coerceMemberConnections(store, body.memberConnections);
    if (Object.keys(connections).length === 0) delete meta.memberConnections;
    else meta.memberConnections = connections;
    const replyLimit = coerceGroupReplyLimit(body.groupReplyLimit);
    if (replyLimit !== null) {
      if (replyLimit === 1) delete meta.groupReplyLimit;
      else meta.groupReplyLimit = replyLimit;
    }
    const groupMode = coerceGroupMode(body.groupMode);
    if (groupMode !== null) {
      if (groupMode === 'round') delete meta.groupMode;
      else meta.groupMode = groupMode;
    }
    sendJson(response, 200, store.saveChatMeta(meta));
  });

  /** Member ids must name characters that exist; order is speaking order. */
  function coerceMembers(store: Store, value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw badRequest('members must be an array of character ids');
    const ids = value.filter((id): id is string => typeof id === 'string' && id !== '');
    for (const id of ids) {
      if (!store.characterExists(id)) throw notFound(`character not found: ${id}`);
    }
    return [...new Set(ids)];
  }

  /**
   * How many members may answer one user message: 1 is the default (one
   * speaker), 0 means every member in turn. Anything else is a caller mistake —
   * a silently clamped number would be worse than a 400 here.
   */
  function coerceGroupReplyLimit(value: unknown): number | null {
    if (value === undefined || value === null) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw badRequest('groupReplyLimit must be a non-negative integer');
    }
    return parsed;
  }

  /**
   * How a group picks its speakers. `null`/missing means "leave it alone" (or,
   * at creation, "use the default"), and an unknown name is refused: a typo
   * there would silently change who answers, which is worse than a 400.
   */
  function coerceGroupMode(value: unknown): GroupMode | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw badRequest('groupMode must be a string');
    const mode = value.trim();
    if (mode === '') return null;
    if (!isGroupMode(mode)) throw badRequest(`unknown group mode: ${mode}`);
    return mode;
  }

  /**
   * Per-member connections: `{ characterId: connectionId }`. An entry for a
   * character who is not currently in the lineup is kept, so re-adding them
   * restores their connection; a connection id that does not exist is refused,
   * because a typo there would silently send turns to the default endpoint.
   */
  function coerceMemberConnections(store: Store, value: unknown): Record<string, string> {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw badRequest('memberConnections must be an object of characterId -> connectionId');
    }
    const known = new Set(store.loadConnections().items.map((item) => item.id));
    const out: Record<string, string> = {};
    for (const [characterId, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw !== 'string' || raw === '') continue;
      if (!known.has(raw)) throw badRequest(`connection not found: ${raw}`);
      out[characterId] = raw;
    }
    return out;
  }

  /**
   * Transcript export in SillyTavern's own JSONL, so a chat can be taken to the
   * other tool (and back — the importer below reads it).
   */
  router.add('GET', '/api/chats/:id/export', ({ params, response }) => {
    const id = params.id!;
    const meta = store.loadChatMeta(id);
    const entries = store.loadChat(id);
    let characterName = meta.characterId;
    try {
      characterName = store.loadCharacter(meta.characterId).card.name;
    } catch {
      /* a deleted card leaves the id as the name; the log is still valid */
    }
    const config = store.loadConfig();
    const speaker = effectivePersona(store.loadPersonas(), meta.personaId, {
      name: config.personaName ?? 'You',
      description: config.personaDescription ?? '',
    });
    const speakerNames: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.role === 'assistant' && entry.speaker) {
        try {
          speakerNames[entry.id] = store.loadCharacter(entry.speaker).card.name;
        } catch {
          /* a deleted member falls back to the default name below */
        }
      }
    }
    const body = toSillyTavernJSONL(meta, entries, characterName, speaker.name, speakerNames);
    response.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  });

  /**
   * Transcript import. Takes the bytes of a JSONL file — either SillyTavern's or
   * one of ours — and creates a chat from it on the given character.
   */
  router.add('POST', '/api/chats/import', async ({ request, url, response }) => {
    const characterId = url.searchParams.get('characterId') ?? '';
    if (characterId === '') throw badRequest('characterId is required');
    if (!store.characterExists(characterId)) throw notFound(`character not found: ${characterId}`);

    const text = (await readBody(request)).toString('utf8');
    const parsed = parseChatLog(text);
    if (parsed.entries.length === 0) {
      throw badRequest(
        parsed.warnings.length > 0
          ? `nothing to import: ${parsed.warnings.slice(0, 3).join('; ')}`
          : 'nothing to import: the file holds no messages',
      );
    }

    const name = sanitizeId(url.searchParams.get('name') ?? parsed.characterName ?? `imported-${Date.now().toString(36)}`);
    const meta = store.createChat({
      characterId,
      name,
      worldRefs: [],
      model: store.loadConfig().model,
      params: snapshotParams(store.loadConfig()),
      personaId: store.loadPersonas().activeId || undefined,
      greeting: '',
    });
    store.writeChat(meta.id, parsed.entries);

    // A SillyTavern log can carry the Memory extension's summary on one of its
    // messages; adopt it, anchored to the message it covered, so the next summary
    // continues from there instead of starting the story over.
    if (parsed.memory) {
      const anchor = parsed.entries[parsed.memory.entryIndex];
      const withMemory = store.loadChatMeta(meta.id);
      withMemory.memory = {
        text: parsed.memory.text,
        upToEntryId: anchor?.id ?? null,
        upToIndex: parsed.memory.entryIndex + 1,
        updatedAt: new Date().toISOString(),
        model: '',
        tokens: counterFor(store.loadConfig()).count(parsed.memory.text),
      };
      store.saveChatMeta(withMemory);
      meta.memory = withMemory.memory;
    }

    store.appendTrace(meta.id, {
      type: 'import',
      id: traceId('import'),
      at: new Date().toISOString(),
      label: `导入聊天记录：${parsed.entries.length} 条（${parsed.format}）`,
      detail: parsed.warnings.length > 0 ? parsed.warnings.slice(0, 3).join('; ') : undefined,
    });

    sendJson(response, 200, {
      id: meta.id,
      name: meta.name,
      characterId,
      format: parsed.format,
      entries: parsed.entries.length,
      memory: meta.memory?.text ?? null,
      warnings: parsed.warnings,
    });
  });

  /**
   * Branches a transcript: a new chat holding the messages up to `entryId`
   * (inclusive), with the original left untouched.
   *
   * This is how SillyTavern branches too — a branch there is a separate chat
   * file, not a tree inside one transcript. It gives "keep this path, try
   * another" without a destructive rewind, and the copy is an ordinary chat you
   * can rename, export or delete like any other.
   */
  router.add('POST', '/api/chats/:id/fork', async ({ request, params, response }) => {
    const id = params.id!;
    const body = await readJson<{ entryId?: string; name?: string }>(request);
    const meta = store.loadChatMeta(id);
    const entries = store.loadChat(id);

    let prefix = entries;
    if (body.entryId !== undefined) {
      const index = entries.findIndex((entry) => entry.id === body.entryId);
      if (index === -1) throw notFound(`entry not found: ${body.entryId}`);
      prefix = entries.slice(0, index + 1);
    }

    const fork = store.createChat({
      characterId: meta.characterId,
      name: sanitizeId(body.name ?? `${meta.name} · 分支`),
      // The branch continues the same conversation, so it keeps its books, its
      // model, its sampler snapshot, its persona and its lineup; variables and
      // timed effects are runtime state and start over.
      worldRefs: meta.worldRefs,
      model: meta.model,
      params: meta.params ? { ...meta.params } : undefined,
      personaId: meta.personaId,
      members: meta.members,
      memberConnections: meta.memberConnections,
      groupReplyLimit: meta.groupReplyLimit,
      groupMode: meta.groupMode,
      greeting: '',
    });
    store.writeChat(fork.id, prefix);
    // The branch starts with a clean trajectory of its own, but says where it came
    // from: "why does this chat begin mid-scene" is exactly what a trace is for.
    store.appendTrace(fork.id, {
      type: 'fork',
      id: traceId('fork'),
      at: new Date().toISOString(),
      label: `从「${meta.name}」分叉，带过来 ${prefix.length} 条`,
    });
    sendJson(response, 200, { id: fork.id, name: fork.name, entries: prefix.length });
  });

  router.add('GET', '/api/chats/:id', ({ params, response }) => {
    sendJson(response, 200, {
      meta: store.loadChatMeta(params.id!),
      entries: store.loadChat(params.id!),
    });
  });

  router.add('PUT', '/api/chats/:id', async ({ request, params, response }) => {
    const patch = await readJson<Record<string, unknown>>(request);
    const meta = store.loadChatMeta(params.id!);
    if (typeof patch.name === 'string') meta.name = patch.name;
    // `null` (or a blank string) clears the override and follows the default
    // again; a non-empty string pins this conversation to that model.
    if (patch.model === null) delete meta.model;
    else if (typeof patch.model === 'string') {
      const model = patch.model.trim();
      if (model === '') delete meta.model;
      else meta.model = model;
    }
    // The persona pin works the same way, but the id must name a preset that
    // exists — pinning a deleted name would silently change who "you" are.
    if (patch.personaId === null) delete meta.personaId;
    else if (typeof patch.personaId === 'string') {
      const id = patch.personaId.trim();
      if (id === '') delete meta.personaId;
      else {
        if (!store.loadPersonas().items.some((item) => item.id === id)) {
          throw badRequest(`persona not found: ${id}`);
        }
        meta.personaId = id;
      }
    }
    if (Array.isArray(patch.worldRefs)) {
      meta.worldRefs = patch.worldRefs.filter((x): x is string => typeof x === 'string');
    }
    // The retrieval-mode pin: `null` (or blank) follows the configured default
    // again, a known mode name pins this conversation.
    if (patch.retrievalMode === null) delete meta.retrievalMode;
    else if (typeof patch.retrievalMode === 'string') {
      const mode = patch.retrievalMode.trim();
      if (mode === '') delete meta.retrievalMode;
      else if (!isRetrievalMode(mode)) throw badRequest(`unknown retrieval mode: ${mode}`);
      else meta.retrievalMode = mode;
    }
    // The group mode pin, same split: `null` (or blank) follows `round` again.
    if (patch.groupMode === null) delete meta.groupMode;
    else if (patch.groupMode !== undefined) {
      const mode = coerceGroupMode(patch.groupMode);
      if (mode !== null) {
        if (mode === 'round') delete meta.groupMode;
        else meta.groupMode = mode;
      }
    }
    // Sampler knobs, same follow/override split as the model: an object merges
    // per key, `null` drops the snapshot and follows the defaults again.
    if ('params' in patch) applyParamsPatch(meta, patch.params);
    if (patch.variables && typeof patch.variables === 'object') {
      meta.variables = patch.variables as Record<string, string>;
    }
    sendJson(response, 200, store.saveChatMeta(meta));
  });

  router.add('DELETE', '/api/chats/:id', ({ params, response }) => {
    store.deleteChat(params.id!);
    sendJson(response, 200, { ok: true });
  });

  /**
   * Attaching or detaching a world mutates the stored list on the server, so a
   * client with a stale view cannot clobber the other attachments by echoing an
   * old array back.
   */
  router.add('POST', '/api/chats/:id/worlds', async ({ request, params, response }) => {
    const body = await readJson<{ worldId?: string; attached?: boolean }>(request);
    if (typeof body.worldId !== 'string' || body.worldId === '') {
      throw badRequest('worldId is required');
    }
    if (body.attached === true && !existsSync(join(store.worldsDir, `${sanitizeId(body.worldId)}.json`))) {
      throw notFound(`world not found: ${body.worldId}`);
    }
    const meta = store.loadChatMeta(params.id!);
    const refs = new Set(meta.worldRefs);
    if (body.attached === false) refs.delete(body.worldId);
    else refs.add(body.worldId);
    meta.worldRefs = [...refs];
    sendJson(response, 200, store.saveChatMeta(meta));
  });

  router.add('POST', '/api/chats/:id/message', async ({ request, params, response }) => {
    const body = await readJson<{ content?: string; role?: ChatEntry['role'] }>(request);
    if (typeof body.content !== 'string' || body.content === '') {
      throw badRequest('content is required');
    }
    const id = params.id!;
    const entry = newEntry(store.loadChat(id), body.role ?? 'user', body.content);
    store.appendChat(id, entry);
    sendJson(response, 200, entry);
  });

  router.add('POST', '/api/chats/:id/variant', async ({ request, params, response }) => {
    const body = await readJson<{ entryId?: string; index?: number; content?: string }>(request);
    const id = params.id!;
    const entries = store.loadChat(id);
    const entry = entries.find((item) => item.id === body.entryId);
    if (!entry) throw notFound('entry not found');

    if (typeof body.content === 'string') {
      entry.variants = [...(entry.variants ?? [entry.content]), body.content];
      entry.activeVariant = entry.variants.length - 1;
      store.appendTrace(id, {
        type: 'swipe',
        id: traceId('swipe'),
        at: new Date().toISOString(),
        label: `新增一个候选回复（共 ${entry.variants.length} 个）`,
        entryId: entry.id,
        detail: body.content.slice(0, 400),
      });
    } else if (typeof body.index === 'number') {
      entry.activeVariant = Math.max(0, Math.min((entry.variants?.length ?? 1) - 1, body.index));
    } else {
      throw badRequest('either content or index is required');
    }
    store.writeChat(id, entries);
    sendJson(response, 200, entry);
  });

  router.add('POST', '/api/chats/:id/truncate', async ({ request, params, response }) => {
    const body = await readJson<{ entryId?: string }>(request);
    const id = params.id!;
    const entries = store.loadChat(id);
    const index = entries.findIndex((item) => item.id === body.entryId);
    if (index === -1) throw notFound('entry not found');
    // Trace first: after the write there is nothing left to describe.
    store.appendTrace(id, {
      type: 'truncate',
      id: traceId('truncate'),
      at: new Date().toISOString(),
      label: `从这里重开：删掉 ${entries.length - index} 条`,
      entryId: body.entryId,
    });
    store.writeChat(id, entries.slice(0, index));
    sendJson(response, 200, { ok: true, remaining: index });
  });

  /**
   * Edits one message in place.
   *
   * A reply with swipes is edited as the *active variant*: the other candidates
   * stay untouched, so "edit this reply" does not silently discard them. Variant
   * 0 is kept in sync with `content` because that is what `regenerate` treats as
   * the original.
   */
  router.add('PATCH', '/api/chats/:id/entries/:entryId', async ({ request, params, response }) => {
    const body = await readJson<{ content?: unknown }>(request);
    if (typeof body.content !== 'string' || body.content.trim() === '') {
      throw badRequest('content must be a non-empty string');
    }
    const entries = store.loadChat(params.id!);
    const entry = entries.find((item) => item.id === params.entryId);
    if (!entry) throw notFound(`entry not found: ${params.entryId}`);
    if (entry.role === 'system') throw badRequest('system entries are not editable');

    if (entry.variants && entry.variants.length > 0) {
      const active = Math.max(0, Math.min(entry.variants.length - 1, entry.activeVariant ?? 0));
      entry.variants[active] = body.content;
      if (active === 0) entry.content = body.content;
    } else {
      entry.content = body.content;
    }

    store.writeChat(params.id!, entries);
    store.appendTrace(params.id!, {
      type: 'edit',
      id: traceId('edit'),
      at: new Date().toISOString(),
      label: `编辑了一条${entry.role === 'assistant' ? '回复' : '消息'}`,
      entryId: entry.id,
      detail: body.content.slice(0, 400),
    });
    sendJson(response, 200, { entry });
  });

  /**
   * Translates one message into the reply language (or an explicit `lang`).
   *
   * The original stays the transcript: the translation is cached on the entry
   * beside what it was made from, so a second call for the same text answers
   * without spending another model call. Anything that moves the source — an
   * edit, a swipe, another preset language — translates again.
   */
  router.add('POST', '/api/chats/:id/entries/:entryId/translate', async ({ request, params, response }) => {
    const body = await readJson<{ lang?: unknown }>(request);
    const config = store.loadConfig();
    const lang = (typeof body.lang === 'string' ? body.lang : '').trim() || config.outputLanguage.trim();
    if (lang === '') throw badRequest('no target language: set a reply language or pass lang');

    const entries = store.loadChat(params.id!);
    const entry = entries.find((item) => item.id === params.entryId);
    if (!entry) throw notFound(`entry not found: ${params.entryId}`);
    if (entry.role === 'system') throw badRequest('system entries are not translated');

    const { source, active } = visibleSource(entry);
    if (source.trim() === '') throw badRequest('nothing to translate');
    if (translationIsFresh(entry, source, active, lang)) {
      sendJson(response, 200, { entry, cached: true });
      return;
    }

    const text = await translateText(config, effectiveModel(config, store.loadChatMeta(params.id!)), source, lang);
    if (text === '') throw badRequest('the model returned an empty translation');
    entry.translation = translationPatch(source, active, lang, text);
    store.writeChat(params.id!, entries);
    sendJson(response, 200, { entry, cached: false });
  });

  /**
   * The same translation over a whole list, for the automatic path.
   *
   * The transcript decides locally which messages need it and asks once; the
   * server keeps a few calls in flight (the model latency is the cost) and
   * writes the chat once at the end, onto a fresh read — so no two model calls
   * rewrite the file, and a concurrent append is not clobbered. Missing,
   * system, empty and already-fresh entries are skipped, not failures.
   */
  router.add('POST', '/api/chats/:id/translate', async ({ request, params, response }) => {
    const body = await readJson<{ entryIds?: unknown; lang?: unknown }>(request);
    const config = store.loadConfig();
    const lang = (typeof body.lang === 'string' ? body.lang : '').trim() || config.outputLanguage.trim();
    if (lang === '') throw badRequest('no target language: set a reply language or pass lang');
    const wanted = Array.isArray(body.entryIds)
      ? [...new Set(body.entryIds.filter((id): id is string => typeof id === 'string' && id !== ''))]
      : [];
    if (wanted.length === 0) {
      sendJson(response, 200, { translated: [], cached: [], failed: [] });
      return;
    }

    const entries = store.loadChat(params.id!);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const model = effectiveModel(config, store.loadChatMeta(params.id!));
    const cached: string[] = [];
    const jobs: { id: string; source: string; active: number }[] = [];
    for (const id of wanted) {
      const entry = byId.get(id);
      if (!entry || entry.role === 'system') continue;
      const { source, active } = visibleSource(entry);
      if (source.trim() === '') continue;
      if (translationIsFresh(entry, source, active, lang)) {
        cached.push(id);
        continue;
      }
      jobs.push({ id, source, active });
    }

    type BatchResult = { id: string; error: string | null; patch: ChatEntry['translation'] | null };
    const results = await mapWithConcurrency(jobs, TRANSLATE_CONCURRENCY, async (job): Promise<BatchResult> => {
      try {
        const text = await translateText(config, model, job.source, lang);
        if (text === '') return { id: job.id, error: 'the model returned an empty translation', patch: null };
        return { id: job.id, error: null, patch: translationPatch(job.source, job.active, lang, text) };
      } catch (error) {
        return { id: job.id, error: error instanceof Error ? error.message : String(error), patch: null };
      }
    });

    const fresh = store.loadChat(params.id!);
    const byFresh = new Map(fresh.map((entry) => [entry.id, entry]));
    const translated: string[] = [];
    const failed: { entryId: string; error: string }[] = [];
    for (const result of results) {
      if (result.patch === null) {
        failed.push({ entryId: result.id, error: result.error ?? 'translation failed' });
        continue;
      }
      const entry = byFresh.get(result.id);
      if (!entry) {
        failed.push({ entryId: result.id, error: 'entry no longer exists' });
        continue;
      }
      entry.translation = result.patch;
      translated.push(result.id);
    }
    if (translated.length > 0) store.writeChat(params.id!, fresh);
    sendJson(response, 200, { translated, cached, failed });
  });

  /**
   * Deletes a single message and re-parents its children onto its own parent, so
   * the rest of the transcript survives. This is what makes "delete" different
   * from "start over from here".
   */
  router.add('DELETE', '/api/chats/:id/entries/:entryId', ({ params, response }) => {
    const entries = store.loadChat(params.id!);
    const index = entries.findIndex((item) => item.id === params.entryId);
    if (index === -1) throw notFound(`entry not found: ${params.entryId}`);

    const [removed] = entries.splice(index, 1);
    let reparented = 0;
    for (const entry of entries) {
      if (entry.parentId === removed!.id) {
        entry.parentId = removed!.parentId;
        reparented++;
      }
    }

    store.writeChat(params.id!, entries);
    store.appendTrace(params.id!, {
      type: 'delete',
      id: traceId('delete'),
      at: new Date().toISOString(),
      label: `删除了一条${removed!.role === 'assistant' ? '回复' : '消息'}`,
      entryId: removed!.id,
      detail: removed!.content.slice(0, 400),
    });
    sendJson(response, 200, { ok: true, removed: removed!.id, reparented, remaining: entries.length });
  });
}
