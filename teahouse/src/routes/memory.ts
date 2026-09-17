/**
 * Long-term memory endpoints.
 *
 * The summary is stored on the chat (see `engine/memory.ts`) and injected as its
 * own prompt block, so this file only has to answer four questions: what does
 * this chat remember, change it by hand, summarise now, forget it.
 *
 * Summarising happens *here* rather than inside `/api/generate` on purpose: it is
 * a second model call, and a turn must never wait on it — or fail because of it.
 * The client asks for it after a reply has been saved, and the `done` frame tells
 * it when that is due.
 */

import { chatOnce } from '../llm/openai-compat.ts';
import { badRequest, readJson, sendJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import {
  buildSummaryMessages,
  cleanSummary,
  memoryProgress,
  memorySettings,
  pendingEntries,
  readMemoryRecord,
  renderMemoryPrompt,
  summarizeRecord,
  type MemoryRecord,
} from '../engine/memory.ts';
import { effectiveModel, counterFor } from '../pipeline.ts';
import { effectivePersona } from '../engine/personas.ts';
import { traceId } from '../engine/trace.ts';
import type { Store } from '../store/db.ts';

/**
 * What the editor needs: the record, the settings behind it, and how far the
 * conversation has moved past it.
 */
function memoryView(store: Store, chatId: string) {
  const config = store.loadConfig();
  const meta = store.loadChatMeta(chatId);
  const entries = store.loadChat(chatId);
  const settings = memorySettings(config);
  return {
    settings,
    record: readMemoryRecord(meta),
    progress: memoryProgress(entries, meta, settings),
    model: effectiveModel(config, meta),
  };
}

export function registerMemoryRoutes(router: Router, store: Store): void {
  router.add('GET', '/api/chats/:id/memory', ({ params, response }) => {
    sendJson(response, 200, memoryView(store, params.id!));
  });

  /**
   * Hand edits and the freeze switch. Editing the text does not touch what it
   * covers, so the interval counter stays where it was — the user asked for this
   * summary, not for another one.
   */
  router.add('PUT', '/api/chats/:id/memory', async ({ params, request, response }) => {
    const chatId = params.id!;
    const body = await readJson<{ text?: unknown; frozen?: unknown }>(request);
    const meta = store.loadChatMeta(chatId);
    const existing = readMemoryRecord(meta);
    const counter = counterFor(store.loadConfig());

    if (body.text !== undefined && typeof body.text !== 'string') {
      throw badRequest('text must be a string');
    }
    if (body.frozen !== undefined && typeof body.frozen !== 'boolean') {
      throw badRequest('frozen must be a boolean');
    }
    if (body.text === undefined && body.frozen === undefined) {
      throw badRequest('nothing to change: send text or frozen');
    }

    const text = body.text === undefined ? (existing?.text ?? '') : body.text;
    const frozen = body.frozen === undefined ? existing?.frozen === true : body.frozen;

    if (text.trim() === '') {
      // Clearing is DELETE's job; an empty PUT would leave a record that reads as
      // "no memory" while still holding an anchor.
      delete meta.memory;
    } else {
      meta.memory = {
        ...(existing ?? {
          upToEntryId: null,
          upToIndex: 0,
          updatedAt: new Date().toISOString(),
          model: '',
          tokens: 0,
        }),
        text,
        tokens: counter.count(text),
        frozen,
      };
    }
    store.saveChatMeta(meta);
    sendJson(response, 200, memoryView(store, chatId));
  });

  /**
   * Summarises now. `force` skips the interval check, which is what the
   * 「立即总结」 button sends; without it the same endpoint is the one the client
   * calls when a turn made the memory due.
   */
  router.add('POST', '/api/chats/:id/memory/summarize', async ({ params, request, response }) => {
    const chatId = params.id!;
    const body = await readJson<{ force?: unknown }>(request).catch(() => ({}) as { force?: unknown });
    const force = body.force === true;

    const config = store.loadConfig();
    const settings = memorySettings(config);
    if (!settings.enabled) throw badRequest('long-term memory is switched off');

    const meta = store.loadChatMeta(chatId);
    const entries = store.loadChat(chatId);
    const record = readMemoryRecord(meta);
    const pending = pendingEntries(entries, record);
    if (pending.length === 0) throw badRequest('there is nothing new to summarise');

    const progress = memoryProgress(entries, meta, settings);
    if (!force && record?.frozen === true) throw badRequest('the summary is frozen');

    const { card } = store.loadCharacter(meta.characterId);
    const model = settings.model === '' ? effectiveModel(config, meta) : settings.model;
    const speaker = effectivePersona(store.loadPersonas(), meta.personaId, {
      name: config.personaName,
      description: config.personaDescription,
    });
    const speakerNames: Record<string, string> = {};
    for (const entry of pending) {
      if (entry.role === 'assistant' && entry.speaker) {
        try {
          speakerNames[entry.id] = store.loadCharacter(entry.speaker).card.name;
        } catch {
          /* a deleted member falls back to the default name below */
        }
      }
    }
    const started = Date.now();
    const result = await chatOnce(
      {
        ...config,
        model,
        // The user's reply settings are for roleplay, not for this job: a low
        // temperature suits a factual summary, the stop strings could cut it off
        // mid-sentence, and a small `maxTokens` would truncate it.
        temperature: 0.3,
        maxTokens: 0,
        stop: [],
        // Nothing here may touch the chat's usage anchor: this prompt is not the
        // conversation's prompt, and mixing the two would corrupt the budget.
        requestUsage: false,
      },
      buildSummaryMessages({
        instruction: renderMemoryPrompt(settings.prompt, settings.words),
        previous: record?.text ?? '',
        entries: pending,
        names: { char: card.name, user: speaker.name },
        speakerNames,
      }),
    );

    const summary = cleanSummary(result.text);
    if (summary === '') throw badRequest('the model returned an empty summary');

    const covered = entries.filter((entry) => entry.role !== 'system' && entry.content.trim() !== '');
    const next = summarizeRecord({
      text: summary,
      covered,
      model,
      tokens: counterFor(config).count(summary),
      ...(result.usage
        ? {
            usage: {
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
            },
          }
        : {}),
      ...(record?.frozen === true ? { frozen: true } : {}),
    });
    meta.memory = next;
    store.saveChatMeta(meta);
    // …and on the trajectory: a memory update is not a message, so without this
    // row the timeline would show a summary appearing out of nowhere.
    store.appendTrace(chatId, {
      type: 'memory',
      id: traceId('memory'),
      at: new Date().toISOString(),
      label: `总结到第 ${pending.length} 条新消息，记忆 ~${next.tokens} tok`,
      detail: summary,
    });

    sendJson(response, 200, {
      ...memoryView(store, chatId),
      usage: result.usage,
      elapsedMs: Date.now() - started,
      summarized: pending.length,
    });
  });

  /** Forgetting is not deleting: the transcript is untouched. */
  router.add('DELETE', '/api/chats/:id/memory', ({ params, response }) => {
    const chatId = params.id!;
    const meta = store.loadChatMeta(chatId);
    delete meta.memory;
    store.saveChatMeta(meta);
    sendJson(response, 200, memoryView(store, chatId));
  });
}
