/**
 * Quick replies: the snippets shown above the composer.
 *
 * The whole file is replaced on save — it is a short list a user edits as a
 * unit, and a per-item PATCH would only add ways for the two copies to drift.
 * `POST /import` accepts SillyTavern's extension shape as well, appending what
 * it finds, because that is where existing snippets live.
 */

import { badRequest, readJson, sendJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import {
  coerceQuickReplyFile,
  normalizeQuickReplies,
  toSillyTavernQuickReplies,
} from '../formats/quick-replies.ts';
import type { Store } from '../store/db.ts';

export function registerQuickReplyRoutes(router: Router, store: Store): void {
  router.add('GET', '/api/quick-replies', ({ response }) => {
    sendJson(response, 200, store.loadQuickReplies());
  });

  router.add('PUT', '/api/quick-replies', async ({ request, response }) => {
    const body = await readJson<unknown>(request);
    if (body === null || typeof body !== 'object') {
      throw badRequest('a quick reply file is required');
    }
    const file = coerceQuickReplyFile(body);
    sendJson(response, 200, store.saveQuickReplies(file));
  });

  /** Appends the snippets found in an uploaded file (any of the accepted shapes). */
  router.add('POST', '/api/quick-replies/import', async ({ request, response }) => {
    const body = await readJson<unknown>(request);
    const parsed = normalizeQuickReplies(body);
    if (parsed.file.items.length === 0) {
      throw badRequest(
        'no quick replies found: expected an array, `{ items }`, or SillyTavern\'s `{ quickReplySlots }`',
      );
    }

    const current = store.loadQuickReplies();
    const saved = store.saveQuickReplies({
      ...current,
      items: [...current.items, ...parsed.file.items],
    });
    sendJson(response, 200, {
      imported: parsed.file.items.length,
      dropped: parsed.dropped,
      total: saved.items.length,
    });
  });

  /** SillyTavern's shape, for going back the other way. */
  router.add('GET', '/api/quick-replies/export', ({ response }) => {
    sendJson(response, 200, toSillyTavernQuickReplies(store.loadQuickReplies()));
  });
}
