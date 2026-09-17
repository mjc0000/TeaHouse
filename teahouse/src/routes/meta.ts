/**
 * Health, configuration, provider models, and the world-entry field metadata the
 * editor renders its form from.
 */

import { listModels } from '../llm/openai-compat.ts';
import { providersPayload } from '../llm/providers.ts';
import { sendJson, readJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import type { Store, TeahouseConfig } from '../store/db.ts';
import { localizedEntryFields } from '../formats/entry-fields.ts';
import { requestedLanguage } from '../i18n.ts';
import { SUPPORTED_MACROS } from '../engine/macros.ts';

export function registerMetaRoutes(router: Router, store: Store): void {
  router.add('GET', '/api/health', ({ response }) => {
    sendJson(response, 200, { ok: true });
  });

  router.add('GET', '/api/config', ({ response }) => {
    const config = store.loadConfig();
    // Never echo API keys back in full — the chat key or the speech one.
    sendJson(response, 200, {
      ...config,
      apiKey: config.apiKey === '' ? '' : '***',
      tts: { ...config.tts, apiKey: config.tts.apiKey === '' ? '' : '***' },
    });
  });

  router.add('PUT', '/api/config', async ({ request, response }) => {
    const patch = await readJson<Partial<TeahouseConfig>>(request);
    if (patch.apiKey === '***') delete patch.apiKey;
    if (patch.tts?.apiKey === '***') delete patch.tts.apiKey;
    sendJson(response, 200, store.saveConfig(patch));
  });

  // Static data, but served rather than duplicated in the client so the preset
  // table and the URL matching live in one place and can be tested over HTTP.
  // `?baseUrl=&model=` asks about values the dialog has not saved yet, which is
  // what makes the preset row update the moment a provider is picked.
  router.add('GET', '/api/providers', ({ response, url }) => {
    const config = store.loadConfig();
    const baseUrl = url.searchParams.get('baseUrl') ?? config.baseUrl ?? '';
    const model = url.searchParams.get('model') ?? config.model ?? '';
    const lang = requestedLanguage(url.searchParams.get('lang'));
    sendJson(response, 200, providersPayload(baseUrl, model, store.loadModelLimits(), lang));
  });

  router.add('POST', '/api/models', async ({ response }) => {
    const config = store.loadConfig();
    try {
      const models = await listModels({
        baseUrl: config.baseUrl ?? '',
        apiKey: config.apiKey ?? '',
        model: config.model ?? '',
      });
      sendJson(response, 200, { models });
    } catch (error) {
      sendJson(response, 502, { error: (error as Error).message });
    }
  });

  /**
   * Connection test for the settings dialog. Answers 200 either way: a failed
   * connection is a result to display, not a server fault. The provider's own
   * message is passed through rather than paraphrased.
   */
  router.add('POST', '/api/config/test', async ({ response }) => {
    const config = store.loadConfig();
    const started = Date.now();
    try {
      const models = await listModels({
        baseUrl: config.baseUrl ?? '',
        apiKey: config.apiKey ?? '',
        model: config.model ?? '',
      });
      const model = config.model ?? '';
      sendJson(response, 200, {
        ok: true,
        elapsedMs: Date.now() - started,
        modelCount: models.length,
        modelKnown: model === '' ? null : models.includes(model),
        models: models.slice(0, 50),
      });
    } catch (error) {
      sendJson(response, 200, {
        ok: false,
        elapsedMs: Date.now() - started,
        error: (error as Error).message,
      });
    }
  });

  // Declared before `/api/worlds/:id` by the router's static-first rule, so this
  // is never mistaken for a world named "fields".
  // The world entry field metadata the editor renders its form from, in the
  // interface language the client asks for (`?lang=`, source language by default).
  router.add('GET', '/api/worlds/fields', ({ response, url }) => {
    const lang = requestedLanguage(url.searchParams.get('lang'));
    sendJson(response, 200, { ...localizedEntryFields(lang), macros: SUPPORTED_MACROS });
  });
}
