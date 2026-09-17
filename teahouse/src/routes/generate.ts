/**
 * Streaming generation over SSE.
 *
 * Event order: `prompt` (what was assembled and which world entries fired),
 * then `delta`/`reasoning`, then `usage`, then `saved` or `replaced`, then
 * `calibration`, then `done`. The `prompt` event comes first on purpose: the UI
 * can show the real request before a single token arrives.
 */

import { streamChat, streamCompletion, type LlmMessage, type StreamEvent } from '../llm/openai-compat.ts';
import { buildCompletionPrompt } from '../engine/completion.ts';
import { coercePromptStack } from '../engine/prompt-stack.ts';
import { badRequest, openEventStream, readJson, sendEvent } from '../http/respond.ts';
import { notice } from '../i18n.ts';
import type { Router } from '../http/router.ts';
import { assemble, chatMembers, collectEntries, collectWorlds, commitTimedEffects, effectiveModel, effectiveParams, entrySpeakerName, projectUsage } from '../pipeline.ts';
import { effectivePersona } from '../engine/personas.ts';
import { activateGroupSpeakers, pickSpeaker, type GroupMember } from '../engine/group.ts';
import { collectRetrieval } from '../engine/retrieval.ts';
import { agentSource, buildAgentCatalog, collectAgentDocs } from '../engine/agent.ts';
import { isContextOverflow, limitKey, parseContextFailure } from '../engine/limits.ts';
import { resolveConnection } from '../engine/connections.ts';
import { memoryProgress, memorySettings } from '../engine/memory.ts';
import { traceId } from '../engine/trace.ts';
import { messageWithImages, type ChatImageRef } from '../engine/images.ts';
import { readImageBytes } from './images.ts';
import { sanitizeId, type ChatEntry, type ChatMeta, type Store, type TeahouseConfig } from '../store/db.ts';

interface GenerateBody {
  chatId?: string;
  message?: string;
  /** Image ids (from `POST /api/images`) attached to the fresh user message. */
  imageIds?: unknown;
  /** Group turn answered by this member (`@Name` on the client resolves here). */
  speaker?: unknown;
  regenerate?: boolean;
  /** 'continue' appends to the trailing assistant reply; 'impersonate' writes a user turn. */
  mode?: string;
  trigger?: string;
  stack?: unknown;
  /** Retry from an existing message instead of appending a new one. */
  retryEntryId?: string;
}

export function registerGenerateRoutes(router: Router, store: Store): void {
  router.add('POST', '/api/generate', async ({ request, response }) => {
    const body = await readJson<GenerateBody>(request);
    const chatId = body.chatId;
    if (typeof chatId !== 'string' || chatId === '') throw badRequest('chatId is required');

    const config = store.loadConfig();

    // Retrying from a message rewinds to it first: an assistant reply is dropped
    // along with everything after it, a user turn is kept so it can be answered
    // again. Doing it here, rather than asking the client to truncate and then
    // generate, removes a window where a half-rewound chat is on disk.
    let retriedFrom: string | null = null;
    if (typeof body.retryEntryId === 'string' && body.retryEntryId !== '') {
      const entries = store.loadChat(chatId);
      const index = entries.findIndex((entry) => entry.id === body.retryEntryId);
      if (index === -1) throw badRequest(`retryEntryId not found: ${body.retryEntryId}`);
      const target = entries[index]!;
      store.writeChat(chatId, entries.slice(0, target.role === 'assistant' ? index : index + 1));
      retriedFrom = target.id;
    }

    // Continue/impersonate are their own paths, not modifiers on a send: they
    // cannot be combined with a fresh message, a regenerate or a retry rewind.
    const mode = body.mode === 'continue' || body.mode === 'impersonate' ? body.mode : null;
    if (mode !== null) {
      if (typeof body.message === 'string' && body.message !== '') {
        throw badRequest('mode cannot be combined with a message');
      }
      if (body.regenerate === true || (typeof body.retryEntryId === 'string' && body.retryEntryId !== '')) {
        throw badRequest('mode cannot be combined with regenerate or retryEntryId');
      }
    }

    if (mode === 'continue') {
      const tail = store.loadChat(chatId);
      const last = tail[tail.length - 1];
      if (!last || last.role !== 'assistant') {
        throw badRequest('nothing to continue: the last message is not an assistant reply');
      }
    }
    if (typeof body.message === 'string' && body.message !== '') {
      // Pictures ride the fresh user message and nothing else: an unknown id
      // fails fast instead of silently dropping someone's upload.
      let images: ChatImageRef[] = [];
      if (body.imageIds !== undefined) {
        if (!Array.isArray(body.imageIds)) throw badRequest('imageIds must be an array of image ids');
        if (body.imageIds.length > 10) throw badRequest('at most 10 images per message');
        images = [];
        for (const raw of body.imageIds as unknown[]) {
          // Either a bare id or `{ id, name }` (the upload answer, kept so the
          // transcript shows the original filename, not the stored one).
          const id = typeof raw === 'string' ? raw : (raw as { id?: unknown }).id;
          const name = typeof raw === 'string' ? raw : (raw as { name?: unknown }).name;
          if (typeof id !== 'string' || id === '') throw badRequest('imageIds must be an array of image ids');
          const found = readImageBytes(store, id);
          if (!found) throw badRequest(`image not found: ${id}`);
          images.push({
            id,
            name: typeof name === 'string' && name.trim() !== '' ? sanitizeId(name).slice(0, 96) : id,
            mime: found.mime,
            bytes: found.bytes.length,
          });
        }
      }
      const entries = store.loadChat(chatId);
      store.appendChat(chatId, {
        id: `m${entries.length}-${Date.now().toString(36)}`,
        parentId: entries.length > 0 ? entries[entries.length - 1]!.id : null,
        role: 'user',
        content: body.message,
        ...(images.length > 0 ? { images } : {}),
        createdAt: new Date().toISOString(),
      });
    }

    let meta = store.loadChatMeta(chatId);
    const members = chatMembers(store, meta);
    const group = members.length >= 2;
    const entries = store.loadChat(chatId);
    // Who answers this round. A group answers with an ordered *plan*: an explicit
    // pin (`@Name`, a retry or a regenerate of a reply) is a plan of one, and
    // otherwise the group's mode builds the list (`engine/group`). Only the first
    // name is spoken here — the client chains the rest, pinning each — so the
    // plan is what makes a round predictable. Solo chats carry no speaker, and
    // 替我说 speaks for the user, never for a member.
    let plan: GroupMember[] = [];
    if (group && mode !== 'impersonate') {
      const named = groupLineup(store, members);
      const pinned = typeof body.speaker === 'string' ? body.speaker : '';
      const reuseFrom = typeof body.retryEntryId === 'string' && body.retryEntryId !== ''
        ? entries.find((entry) => entry.id === body.retryEntryId)
        : body.regenerate === true
          ? [...entries].reverse().find((entry) => entry.role === 'assistant')
          : undefined;
      const reused = reuseFrom?.role === 'assistant' && reuseFrom.speaker && members.includes(reuseFrom.speaker)
        ? reuseFrom.speaker
        : null;
      if (pinned !== '' && members.includes(pinned)) {
        plan = [named.find((member) => member.id === pinned)!];
      } else if (reused !== null) {
        plan = [named.find((member) => member.id === reused)!];
      } else if (mode !== 'continue') {
        const groupMode = meta.groupMode ?? 'round';
        const lastId = lastSpeakerOf(entries, members);
        plan = activateGroupSpeakers({
          mode: groupMode,
          members: named,
          lastSpeaker: lastId,
          spokenSinceUser: spokenSinceUserOf(entries, members),
          input: typeof body.message === 'string' && body.message !== ''
            ? body.message
            : [...entries].reverse().find((entry) => entry.role !== 'system')?.content ?? '',
          userInput: typeof body.message === 'string' && body.message !== '',
          cap: meta.groupReplyLimit,
          // `round` is the one mode that still asks the model, and it does so on
          // the chat's own model: the speaker is not known until it answers.
          first: groupMode === 'round'
            ? await pickGroupSpeaker(store, config, meta, named, lastId)
            : null,
        });
      }
    }
    const speakerId = plan[0]?.id ?? null;

    // A plan can come back empty on purpose: in `manual` mode a message that
    // names nobody is meant to be the user's alone, so nobody answers. Say so
    // and stop, instead of spending a request on a reply nobody asked for.
    if (group && mode === null && plan.length === 0) {
      openEventStream(response);
      if (retriedFrom !== null) sendEvent(response, { type: 'truncated', retryEntryId: retriedFrom });
      sendEvent(response, {
        type: 'warning',
        message: '这轮没有人被点到，就没有回复',
        detail: '手动模式只让被 @ 到的人接话',
        code: 'generate.noGroupSpeaker',
        detailCode: 'generate.noGroupSpeakerDetail',
      });
      sendEvent(response, { type: 'done', failed: null, chars: 0, memory: null });
      response.end();
      return;
    }
    // Which endpoint and model this turn answers with. A group member may bring
    // its own connection (a different provider, a different model), so the
    // speaker decides it; everyone else follows the chat as before. The director
    // above ran on the chat's own model, because the speaker was not known yet.
    const chatModel = effectiveModel(config, meta);
    const connection = resolveConnection(
      config,
      store.loadConnections().items,
      meta.memberConnections?.[speakerId ?? meta.characterId],
      chatModel,
    );

    // Extra entries for this turn: the configured retrieval channel (none, all,
    // vector, model-picked, or the agent reading files). It may be a provider
    // call, so it cannot live inside the synchronous assembly; a failure only
    // costs that channel.
    const { card } = store.loadCharacter(meta.characterId);
    const worlds = collectWorlds(store, meta, card, members);
    const history = entries.filter((entry) => entry.role !== 'system');
    const model = connection.model;
    const retrieval = await collectRetrieval({
      store,
      config,
      meta,
      card,
      worlds,
      entries: collectEntries(worlds),
      messages: history,
      model,
      allowModel: true,
    });
    // Agent docs are a separate channel: they are not world entries, so they do
    // not ride `external`. The loop runs here, then assembly gets the documents.
    let agentDocs: { id: string; text: string }[] = [];
    if (retrieval.mode === 'agent') {
      const agentCards = [{ id: meta.characterId, card }];
      for (const id of members) {
        if (id === meta.characterId) continue;
        try {
          agentCards.push({ id, card: store.loadCharacter(id).card });
        } catch {
          continue;
        }
      }
      const agent = await collectAgentDocs({
        config,
        catalog: buildAgentCatalog(agentCards),
        source: agentSource(store, agentCards),
        messages: history,
        model,
        allowModel: true,
      });
      agentDocs = agent.docs.map((doc) => ({ id: doc.id, text: doc.text }));
      if (agent.warning) retrieval.warning = retrieval.warning === null ? agent.warning : `${retrieval.warning}；${agent.warning}`;
    }
    openEventStream(response);
    if (retriedFrom !== null) sendEvent(response, { type: 'truncated', retryEntryId: retriedFrom });

    // Instrumentation for the trajectory: measured here because only here is it
    // known when the request went out and when the first token came back.
    const startedAt = new Date();
    // The thinking channel is only forwarded (and only kept) while the setting is
    // on: it can be long, and with it off there is nothing to show or store.
    const keepReasoning = config.showReasoning !== false;

    interface Attempt {
      assembled: ReturnType<typeof assemble>;
      llmMessages: LlmMessage[];
      completionPrompt: string | null;
      promptTokens: number;
      imageTokens: number;
      text: string;
      reasoning: string;
      usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
      failed: string | null;
      firstTokenMs: number | null;
    }

    /**
     * One full attempt: assemble at `maxContext`, send the `prompt` frame, then
     * run the provider stream. Extracted so an overflow can be answered with a
     * second attempt at the corrected window — retrieval, the agent read loop
     * and the world scan already happened and are deliberately not redone.
     */
    async function runAttempt(maxContext: number): Promise<Attempt> {
      const attemptConfig = maxContext === config.maxContext ? config : { ...config, maxContext };
      const assembled = assemble(store, attemptConfig, chatId, {
        trigger: mode ?? (body.trigger as 'normal' | undefined) ?? (body.regenerate ? 'regenerate' : 'normal'),
        stack: coercePromptStack(body.stack),
        external: retrieval.hits,
        agentDocs,
        impersonate: mode === 'impersonate',
        asCharacterId: speakerId ?? undefined,
        model: connection.model,
      });
      if (retrieval.warning) assembled.built.warnings.push(retrieval.warning);
      // Persist any variables the world books set while assembling.
      meta.variables = assembled.built.variables;
      meta = store.saveChatMeta(meta);

      const llmMessages: LlmMessage[] = assembled.built.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(typeof message.name === 'string' && message.name !== '' ? { name: message.name } : {}),
      }));

      // Pictures go out on the newest user message only, as base64-inline blocks.
      // Everything else (history, preview, trace, calibration) keeps seeing text.
      // This runs before the `prompt` frame on purpose: a missing file must show
      // up in the warnings the client already received, not after them.
      let imageTokens = 0;
      if (assembled.images.length > 0) {
        const at = llmMessages.map((message) => message.role).lastIndexOf('user');
        if (at !== -1) {
          const inline: { mime: string; base64: string }[] = [];
          for (const image of assembled.images) {
            const found = readImageBytes(store, image.id);
            if (found) inline.push({ mime: found.mime, base64: found.bytes.toString('base64') });
            else assembled.built.warnings.push(notice('generate.imageMissing', `图片 ${image.name} 找不到了，本轮没发`, { name: image.name }));
          }
          if (inline.length > 0) {
            llmMessages[at] = {
              role: 'user',
              content: messageWithImages(String(llmMessages[at]!.content), inline),
              ...(llmMessages[at]!.name ? { name: llmMessages[at]!.name } : {}),
            };
            // The provider bills up to 1024 tokens per image; reported apart so
            // the text budget keeps adding up.
            imageTokens = inline.length * 1024;
          }
        }
      }

      const llmConfig = {
        // The speaker's own connection when it has one, else the chat endpoint.
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        model: connection.model,
        // The chat's own snapshot wins; without one the live defaults apply.
        ...effectiveParams(config, meta),
        // The knobs the settings dialog exposes have to reach the provider; the
        // client has always known how to send `stop`, but this route never
        // handed it over.
        stop: config.stop,
        requestUsage: config.requestUsage,
        disableThinking: config.disableThinking,
      };

      // One assembly, two last miles: chat completions take the messages, text
      // completion takes them flattened with an open reply line. This runs before
      // the `prompt` frame on purpose, so its token count is the real one.
      let completionPrompt: string | null = null;
      let source: AsyncGenerator<StreamEvent>;
      if (attemptConfig.textCompletion === true) {
        const flattened = buildCompletionPrompt(
          llmMessages.map((message) => ({
            role: message.role,
            content: Array.isArray(message.content)
              ? message.content.map((part) => part.type === 'text' ? part.text : '[图片]').join('\n')
              : message.content,
          })),
          assembled.card.name,
          assembled.persona.name,
          attemptConfig.stop ?? [],
        );
        completionPrompt = flattened.prompt;
        source = streamCompletion({ ...llmConfig, stop: flattened.stop }, flattened.prompt, flattened.stop);
      } else {
        source = streamChat(llmConfig, llmMessages);
      }
      const promptTokens = completionPrompt !== null
        ? assembled.counter.count(completionPrompt)
        : assembled.built.totalTokens;

      sendEvent(response, {
        type: 'prompt',
        totalTokens: promptTokens,
        /** The chat's effective model (override or global default). */
        model: assembled.model,
        /** Anchored on the previous request's provider usage, when there is one. */
        ...projectUsage(assembled.meta, promptTokens),
        itemization: assembled.built.itemization,
        worldHits: assembled.scan.hits.length,
        retrievalMode: retrieval.mode,
        /** Agent mode only: the file ids injected as a block this turn. */
        agentReads: agentDocs.map((doc) => doc.id),
        /**
         * Group chats only: the ordered members this round belongs to, the
         * first of which is being answered now. The client pins each of the
         * rest as it chains them, so the round cannot drift off the plan.
         */
        ...(group ? { groupPlan: plan.map((member) => member.id) } : {}),
        budget: assembled.scan.budget,
        worldTokens: assembled.scan.tokensUsed,
        mode: assembled.counter.mode,
        warnings: assembled.built.warnings,
        /** Pictures on this turn: names and bytes, never the base64. */
        images: assembled.images.map((image) => ({ name: image.name, bytes: image.bytes })),
        /** Provider-side estimate: up to 1024 tokens per image, apart from text. */
        imageTokens,
      });

      let text = '';
      let reasoning = '';
      let usage: Attempt['usage'] = null;
      let failed: string | null = null;
      let firstTokenMs: number | null = null;

      try {
        for await (const event of source) {
          if (event.type === 'delta') {
            // The thinking channel does not count: the wait a user feels ends with
            // the first visible character.
            if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt.getTime();
            text += event.text;
            sendEvent(response, { type: 'delta', text: event.text });
          } else if (event.type === 'reasoning') {
            if (keepReasoning) {
              reasoning += event.text;
              sendEvent(response, { type: 'reasoning', text: event.text });
            }
          } else if (event.type === 'usage') {
            usage = event.usage;
            sendEvent(response, { type: 'usage', usage: event.usage });
          } else if (event.type === 'error') {
            failed = event.message;
            sendEvent(response, { type: 'error', message: failed });
          }
        }
      } catch (error) {
        failed = (error as Error).message;
        sendEvent(response, { type: 'error', message: failed });
      }

      return { assembled, llmMessages, completionPrompt, promptTokens, imageTokens, text, reasoning, usage, failed, firstTokenMs };
    }

    let result = await runAttempt(config.maxContext ?? 0);

    // A context overflow is the one moment the window can be learned for free:
    // the provider rejected the request, so nothing was billed, and most vendors
    // name their limit in the message. Learn it, save it, and retry once with the
    // corrected window — the prompt stack then trims history to actually fit.
    if (result.failed !== null && isContextOverflow(result.failed)) {
      const learned = parseContextFailure(result.failed);
      const key = limitKey(config.baseUrl ?? '', result.assembled.model);
      if (learned.window !== null || learned.requested !== null) {
        store.recordModelLimit(key, {
          contextWindow: learned.window,
          source: 'overflow',
          detail: result.failed.slice(0, 300),
        });
      }
      // The provider's own count for the prompt we built is a free calibration
      // sample: it is exactly what a successful turn would have reported.
      if (learned.requested !== null && result.promptTokens > 0) {
        const anchored = store.loadChatMeta(chatId);
        anchored.usageAnchor = {
          promptTokens: learned.requested,
          heuristicTokens: result.promptTokens,
          at: new Date().toISOString(),
        };
        store.saveChatMeta(anchored);
      }

      let next: number | null = null;
      if (learned.window !== null) {
        // Scale our own count onto the provider's count: the failing attempt
        // built a prompt our counter called `promptTokens` and the provider
        // called `requested`. If that ratio holds, this is the window we can
        // actually use. Without the provider's count, the window itself is the
        // best (and only) number we have.
        const reserve = config.responseReserve ?? 512;
        next = learned.requested !== null && result.promptTokens > 0
          ? Math.min(learned.window, reserve + Math.floor((result.promptTokens * learned.window) / learned.requested))
          : learned.window;
      } else if (learned.requested !== null) {
        // No window named, but a count: shrink by our own measure and hope the
        // next attempt fits. One bounded retry, so a miss costs nothing more.
        next = Math.max(1024, Math.floor(result.promptTokens * 0.8));
      }

      if (next !== null && next > 0 && next !== config.maxContext) {
        store.saveConfig({ maxContext: next });
        const windowLabel = (learned.window ?? next).toLocaleString('en-US');
        sendEvent(response, {
          type: 'warning',
          message: learned.window !== null
            ? `上下文超了：这个模型的上限是 ${learned.window.toLocaleString('en-US')}，已把「上下文窗口」改成它并重试`
            : `上下文超了：已按服务商报的用量把「上下文窗口」缩小到 ${next.toLocaleString('en-US')} 并重试`,
          detail: learned.requested === null
            ? undefined
            : `服务商说这次请求用了 ${learned.requested.toLocaleString('en-US')} tokens`,
          code: learned.window !== null ? 'generate.overflowWindow' : 'generate.overflowShrunk',
          params: { window: windowLabel },
          detailCode: learned.requested === null ? undefined : 'generate.providerUsed',
          detailParams: learned.requested === null ? undefined : { tokens: learned.requested.toLocaleString('en-US') },
          maxContext: next,
        });
        result = await runAttempt(next);
      } else {
        sendEvent(response, {
          type: 'warning',
          message: '上下文可能超了，但服务商的报错里没有可用的数字',
          detail: '把「上下文窗口」调小一些，或清理一下历史',
          code: 'generate.overflowNoNumber',
          detailCode: 'generate.overflowNoNumberDetail',
          maxContext: config.maxContext ?? 0,
        });
      }
    }

    const { assembled, llmMessages, completionPrompt, promptTokens, imageTokens, text, reasoning, usage, failed, firstTokenMs } = result;

    if (text !== '') {
      if (mode === 'continue') {
        sendEvent(response, { type: 'continued', entry: appendContinuation(store, chatId, text, reasoning) ?? null });
      } else if (mode === 'impersonate') {
        sendEvent(response, { type: 'impersonated', entry: appendImpersonation(store, chatId, text) ?? null });
      } else {
        sendEvent(response, body.regenerate === true
          ? { type: 'replaced', entry: saveAsVariant(store, chatId, text, reasoning, speakerId ?? '') ?? null }
          : { type: 'saved', entry: appendReply(store, chatId, text, reasoning, speakerId ?? '') });
      }

      const freshMeta = store.loadChatMeta(chatId);
      commitTimedEffects(freshMeta, assembled.scan, assembled.entries, store.loadChat(chatId).length);
      store.saveChatMeta(freshMeta);

      if (usage) {
        const divergence = completionPrompt !== null
          ? assembled.counter.calibrate([{ role: 'user', content: completionPrompt }], usage.promptTokens)
          : assembled.counter.calibrate(assembled.built.messages, usage.promptTokens);
        sendEvent(response, { type: 'calibration', divergence, stats: assembled.counter.getStats() });

        // Persist the provider's real prompt size as this chat's anchor. The
        // in-memory counter is rebuilt for every request, so without this the
        // "calibrated" figure would reset on each turn; the anchor is what the
        // budget display actually needs.
        const anchored = store.loadChatMeta(chatId);
        anchored.usageAnchor = {
          promptTokens: usage.promptTokens,
          heuristicTokens: promptTokens,
          at: new Date().toISOString(),
        };
        store.saveChatMeta(anchored);
      }
    }

    // One row on the trajectory, whatever happened: a failed request is exactly
    // the thing a user wants to look back at, and it produced no message to hang
    // this off. Written after the reply is stored so the entry id is known.
    const entriesAfter = store.loadChat(chatId);
    const saved = text === '' ? null : entriesAfter[entriesAfter.length - 1] ?? null;
    const endedAt = new Date();
    store.appendTrace(chatId, {
      type: 'turn',
      id: traceId('turn', startedAt.getTime()),
      at: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      firstTokenMs,
      model: assembled.model,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      reasoningChars: reasoning.length,
      chars: text.length,
      entryId: saved?.id ?? null,
      trigger: mode ?? (body.regenerate === true ? 'regenerate' : body.retryEntryId ? 'retry' : 'normal'),
      // Who answered: the picked speaker, or the entry's own on paths (like
      // continue) that grow a message instead of starting one.
      ...(speakerId ?? saved?.speaker ? { speaker: speakerId ?? saved!.speaker! } : {}),
      worldHits: assembled.scan.hits.map((hit) => ({
        world: hit.world,
        uid: hit.uid,
        comment: hit.comment,
      })),
      trimmed: assembled.built.trimmed,
      failed,
      // The trace keeps text: image blocks travel as their names, so a
      // multi-megabyte data URL never lands in the instrumentation. A
      // completion turn keeps its flat prompt instead, for the same reason the
      // preview shows it: that is what was actually sent.
      messages: completionPrompt !== null
        ? [{ role: 'user', content: completionPrompt }]
        : llmMessages.map((message) => ({
          role: message.role,
          content: Array.isArray(message.content)
            ? message.content
              .map((part) => part.type === 'text' ? part.text : `[图片：${assembled.images.map((image) => image.name).join('、') || '未知'}]`)
              .join('\n')
            : message.content,
        })),
      images: assembled.images.map((image) => ({ name: image.name, bytes: image.bytes })),
    });

    // An empty turn used to be silent: nothing is saved, so the client just
    // re-rendered and the bubble vanished. With a reasoning model that is almost
    // always the thinking eating the whole budget, which the user cannot see.
    if (text === '' && failed === null) {
      sendEvent(response, {
        type: 'warning',
        message: '模型这一轮没有输出正文，多半是思考把 token 预算用光了',
        detail: '把设置里的「单次回复上限」填大一些，或者打开「关闭思考」再试',
        code: 'generate.emptyBody',
        detailCode: 'generate.emptyBodyDetail',
        maxContext: config.maxContext ?? 0,
      });
    }

    sendEvent(response, {
      type: 'done',
      failed,
      chars: text.length,
      // Whether this turn pushed the conversation past its memory interval. The
      // client summarises afterwards, so the reply never waits on a second model
      // call; with the feature off this is simply `due: false`.
      memory: text === ''
        ? null
        : memoryProgress(store.loadChat(chatId), store.loadChatMeta(chatId), memorySettings(config)),
    });
    response.end();
  });
}

/** Appends an assistant turn. */
function appendReply(store: Store, chatId: string, text: string, reasoning = '', speaker = ''): ChatEntry {
  const entries = store.loadChat(chatId);
  const entry: ChatEntry = {
    id: `m${entries.length}-${Date.now().toString(36)}`,
    parentId: entries.length > 0 ? entries[entries.length - 1]!.id : null,
    role: 'assistant',
    content: text,
    ...(reasoning !== '' ? { reasonings: [reasoning] } : {}),
    ...(speaker !== '' ? { speaker } : {}),
    createdAt: new Date().toISOString(),
  };
  store.appendChat(chatId, entry);
  return entry;
}

/** The lineup with display names and talkativeness, for the speaker policies. */
function groupLineup(store: Store, members: string[]): GroupMember[] {
  return members.map((id) => {
    // A deleted member keeps its id as a name: the lineup is stored on the chat,
    // and dropping someone from a round for a missing card would be worse.
    let name = id;
    let talkativeness = 50;
    try {
      name = store.loadCharacter(id).card.name;
    } catch {
      /* keep the id */
    }
    try {
      talkativeness = store.characterTalkativeness(id);
    } catch {
      /* keep the even default */
    }
    return { id, name, talkativeness };
  });
}

/** The member behind the newest assistant line, when it names a current one. */
function lastSpeakerOf(entries: ChatEntry[], members: string[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.role !== 'assistant') continue;
    return entry.speaker && members.includes(entry.speaker) ? entry.speaker : null;
  }
  return null;
}

/** Who already spoke since the newest user message (`pooled` prefers the rest). */
function spokenSinceUserOf(entries: ChatEntry[], members: string[]): string[] {
  const spoken: string[] = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.role === 'user') break;
    if (entry.role !== 'assistant') continue;
    if (entry.speaker && members.includes(entry.speaker)) spoken.push(entry.speaker);
  }
  return spoken;
}

/** The director call for a `round` turn: names, recent lines, last speaker. */
async function pickGroupSpeaker(
  store: Store,
  config: TeahouseConfig,
  meta: ChatMeta,
  named: GroupMember[],
  lastId: string | null,
): Promise<GroupMember> {
  const entries = store.loadChat(meta.id).filter((entry) => entry.role !== 'system').slice(-8);
  const persona = effectivePersona(store.loadPersonas(), meta.personaId, {
    name: config.personaName,
    description: config.personaDescription,
  });
  const recent = entries.map((entry) => ({
    speaker: entrySpeakerName(store, meta, entry, persona.name),
    text: entry.variants && entry.variants.length > 0
      ? (entry.variants[entry.activeVariant ?? 0] ?? entry.content)
      : entry.content,
  }));
  const picked = await pickSpeaker(
    {
      baseUrl: config.baseUrl ?? '',
      apiKey: config.apiKey ?? '',
      model: effectiveModel(config, meta),
    },
    named,
    recent,
    lastId,
  );
  return picked;
}

/** Adds the new text as another variant of the trailing assistant turn. */
function saveAsVariant(store: Store, chatId: string, text: string, reasoning = '', speaker = ''): ChatEntry | null {
  const entries = store.loadChat(chatId);
  const last = entries[entries.length - 1];
  if (!last || last.role !== 'assistant') return appendReply(store, chatId, text, reasoning, speaker);

  const candidates = last.variants ?? [last.content];
  // Thinking is index-aligned with the candidates: a reply generated before this
  // feature (or while it was off) simply has an empty slot.
  const reasonings = (last.reasonings ?? []).slice(0, candidates.length);
  while (reasonings.length < candidates.length) reasonings.push('');

  last.variants = [...candidates, text];
  last.reasonings = [...reasonings, reasoning];
  last.activeVariant = last.variants.length - 1;
  if (speaker !== '' && !last.speaker) last.speaker = speaker;
  store.writeChat(chatId, entries);
  return last;
}

/**
 * Appends the continuation to the trailing assistant reply in place.
 *
 * Like SillyTavern's continue, this grows the same message instead of starting
 * a new one. Variants stay aligned: the active candidate (and `content` when it
 * is variant 0) is extended. The reasoning prefix is deliberately not resent,
 * so continued thinking is appended to the same slot rather than replayed.
 */
function appendContinuation(store: Store, chatId: string, text: string, reasoning = ''): ChatEntry | null {
  const entries = store.loadChat(chatId);
  const last = entries[entries.length - 1];
  if (!last || last.role !== 'assistant') return null;
  if (last.variants && last.variants.length > 0) {
    const active = Math.max(0, Math.min(last.variants.length - 1, last.activeVariant ?? 0));
    last.variants[active] = (last.variants[active] ?? last.content) + text;
    if (active === 0) last.content = last.variants[active]!;
    if (reasoning !== '') {
      const reasonings = [...(last.reasonings ?? [])];
      while (reasonings.length <= active) reasonings.push('');
      const prior = reasonings[active] ?? '';
      reasonings[active] = prior === '' ? reasoning : `${prior}\n${reasoning}`;
      last.reasonings = reasonings;
    }
  } else {
    last.content += text;
    if (reasoning !== '') {
      const prior = last.reasonings?.[0] ?? '';
      last.reasonings = [prior === '' ? reasoning : `${prior}\n${reasoning}`];
    }
  }
  store.writeChat(chatId, entries);
  return last;
}

/** Saves model output as a user turn: speaking for the user, not replying to them. */
function appendImpersonation(store: Store, chatId: string, text: string): ChatEntry {
  const entries = store.loadChat(chatId);
  const entry: ChatEntry = {
    id: `m${entries.length}-${Date.now().toString(36)}`,
    parentId: entries.length > 0 ? entries[entries.length - 1]!.id : null,
    role: 'user',
    content: text,
    createdAt: new Date().toISOString(),
  };
  store.appendChat(chatId, entry);
  return entry;
}
