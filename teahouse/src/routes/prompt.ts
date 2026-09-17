/**
 * Inspection endpoints: the prompt stack, the assembled request, and the raw
 * world book scan. These are what make the engine debuggable from the UI.
 */

import {
  DEFAULT_LANGUAGE_INSTRUCTION,
  applyLanguage,
  applyStory,
  coercePromptStack,
  defaultPromptStack,
} from '../engine/prompt-stack.ts';
import { SUPPORTED_MACROS } from '../engine/macros.ts';
import { badRequest, readJson, sendJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { assemble, collectEntries, collectWorlds, effectiveModel, projectUsage } from '../pipeline.ts';
import { vectorSettings } from '../vectors.ts';
import { collectRetrieval } from '../engine/retrieval.ts';
import { buildCompletionPrompt } from '../engine/completion.ts';
import type { Store } from '../store/db.ts';

export function registerPromptRoutes(router: Router, store: Store): void {
  router.add('GET', '/api/prompt/stack', ({ response }) => {
    const config = store.loadConfig();
    // Rendered here as well as at assembly time, so the panel shows the real
    // instruction line before anything is generated.
    sendJson(response, 200, {
      blocks: applyStory(applyLanguage(defaultPromptStack(), config), config.contextTemplate),
      macros: SUPPORTED_MACROS,
      defaultLanguageInstruction: DEFAULT_LANGUAGE_INSTRUCTION,
    });
  });

  router.add('POST', '/api/prompt/preview', async ({ request, response }) => {
    const body = await readJson<{ chatId?: string; pendingUserMessage?: string; stack?: unknown }>(request);
    if (typeof body.chatId !== 'string' || body.chatId === '') throw badRequest('chatId is required');

    const config = store.loadConfig();
    // The vector search is an HTTP call, so it happens here and its result is
    // handed to the (synchronous) assembly. A failure is a warning on the
    // preview, never a failed request.
    const meta = store.loadChatMeta(body.chatId);
    const { card } = store.loadCharacter(meta.characterId);
    const chatEntries = store.loadChat(body.chatId);
    const history = [
      ...chatEntries
        .filter((entry) => entry.role !== 'system')
        .map((entry) => ({ role: entry.role, content: entry.content })),
      ...(body.pendingUserMessage ? [{ role: 'user' as const, content: body.pendingUserMessage }] : []),
    ];
    const worlds = collectWorlds(store, meta, card);
    const retrieval = await collectRetrieval({
      store,
      config,
      meta,
      card,
      worlds,
      entries: collectEntries(worlds),
      messages: history,
      model: effectiveModel(config, meta),
      // A preview must never spend a provider call, so `select` shows nothing
      // here; the real turn is where the model picks.
      allowModel: false,
    });
    const assembled = assemble(store, config, body.chatId, {
      pendingUserMessage: body.pendingUserMessage,
      stack: coercePromptStack(body.stack),
      external: retrieval.hits,
    });
    if (retrieval.warning) assembled.built.warnings.push(retrieval.warning);

    // Text completion shows the flat prompt instead of the message list: that
    // is what the provider will actually receive.
    const completion = config.textCompletion === true
      ? (() => {
        const flattened = buildCompletionPrompt(
          assembled.built.messages,
          assembled.card.name,
          assembled.persona.name,
          config.stop ?? [],
        );
        return {
          prompt: flattened.prompt,
          stop: flattened.stop,
          totalTokens: assembled.counter.count(flattened.prompt),
        };
      })()
      : null;

    sendJson(response, 200, {
      // The chat's effective model: its own override, else the global default.
      model: assembled.model,
      mode: assembled.counter.mode,
      retrievalMode: retrieval.mode,
      /** Counter statistics, so the UI can say how the number was produced. */
      counting: assembled.counter.getStats(),
      maxContext: config.maxContext,
      responseReserve: config.responseReserve,
      totalTokens: completion?.totalTokens ?? assembled.built.totalTokens,
      /** The flat prompt, only in text-completion mode. */
      ...(completion ? { completion } : {}),
      /** Provider-anchored prompt size, when a previous request reported usage. */
      ...projectUsage(assembled.meta, assembled.built.totalTokens),
      trimmed: assembled.built.trimmed,
      warnings: assembled.built.warnings,
      messages: assembled.built.messages,
      itemization: assembled.built.itemization,
      outlets: assembled.built.outlets,
      budget: assembled.scan.budget,
      worldTokens: assembled.scan.tokensUsed,
      overflowed: assembled.scan.overflowed,
      loops: assembled.scan.loops,
      /** Long-term memory: what this chat remembers, and whether more is due. */
      memory: assembled.memory,
      memoryState: assembled.memoryState,
      /** Vector storage: how long the search took, and whether it ran at all. */
      vectors: {
        enabled: vectorSettings(config).enabled,
        hits: retrieval.hits,
        ms: retrieval.ms,
        cached: retrieval.cached,
        warning: retrieval.warning,
      },
      /** Pictures on the newest user message: names and bytes, never base64. */
      images: assembled.images.map((image) => ({ name: image.name, bytes: image.bytes })),
      /** Provider-side estimate on top of the text total: up to 1024 tokens each. */
      imageTokens: assembled.images.length * 1024,
    });
  });

  router.add('POST', '/api/scan/debug', async ({ request, response }) => {
    const body = await readJson<{ chatId?: string; message?: string }>(request);
    if (typeof body.chatId !== 'string' || body.chatId === '') throw badRequest('chatId is required');

    const config = store.loadConfig();
    const assembled = assemble(store, config, body.chatId, {
      pendingUserMessage: body.message,
    });

    sendJson(response, 200, {
      budget: assembled.scan.budget,
      tokensUsed: assembled.scan.tokensUsed,
      overflowed: assembled.scan.overflowed,
      loops: assembled.scan.loops,
      hits: assembled.scan.hits,
      skipped: assembled.scan.skipped.slice(0, 200),
      entries: assembled.entries.length,
      worlds: assembled.worlds.map((world) => ({
        id: world.id,
        format: world.sourceFormat,
        entries: world.entries.length,
      })),
    });
  });
}
