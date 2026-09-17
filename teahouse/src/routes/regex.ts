/**
 * Regex rules: stored as one file, replaced whole on save.
 *
 * Like quick replies, this is a short list the user edits as a unit — a
 * per-rule PATCH would only add ways for the two copies to drift. Rules that
 * cannot compile are rejected with reasons instead of stored, because the
 * prompt side would throw in the middle of an assembly.
 */

import { badRequest, readJson, sendJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { coerceRegexFile, tryRegexRule } from '../engine/regex-rules.ts';
import type { Store } from '../store/db.ts';

export function registerRegexRoutes(router: Router, store: Store): void {
  router.add('GET', '/api/regex', ({ response }) => {
    sendJson(response, 200, store.loadRegex());
  });

  router.add('PUT', '/api/regex', async ({ request, response }) => {
    const body = await readJson<unknown>(request);
    if (body === null || typeof body !== 'object') throw badRequest('a regex file is required');
    const { file, problems } = coerceRegexFile(body);
    if (problems.length > 0) {
      sendJson(response, 400, { error: problems.join('；'), problems });
      return;
    }
    sendJson(response, 200, store.saveRegex(file));
  });

  /** Tries one rule against one sample. Nothing is stored. */
  router.add('POST', '/api/regex/test', async ({ request, response }) => {
    const body = await readJson<{ pattern?: unknown; flags?: unknown; replacement?: unknown; text?: unknown }>(request);
    if (typeof body.pattern !== 'string' || typeof body.text !== 'string') {
      throw badRequest('pattern and text are required');
    }
    const flags = typeof body.flags === 'string' ? body.flags : '';
    const replacement = typeof body.replacement === 'string' ? body.replacement : '';
    try {
      sendJson(response, 200, tryRegexRule(body.pattern, flags, replacement, body.text));
    } catch (error) {
      sendJson(response, 400, { error: (error as Error).message });
    }
  });
}
