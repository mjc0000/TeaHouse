/**
 * Persona library: several named "who you are" presets with one default.
 *
 * The whole file is replaced on save — it is a short list a user edits as a
 * unit, like quick replies. Applying a preset to the current turn is a chat
 * concern (`PUT /api/chats/:id { personaId }`), not this file's: the library
 * only stores presets and names the default.
 */

import { badRequest, readJson, sendJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { coercePersonaFile } from '../engine/personas.ts';
import type { Store } from '../store/db.ts';

export function registerPersonaRoutes(router: Router, store: Store): void {
  router.add('GET', '/api/personas', ({ response }) => {
    sendJson(response, 200, store.loadPersonas());
  });

  router.add('PUT', '/api/personas', async ({ request, response }) => {
    const body = await readJson<unknown>(request);
    if (body === null || typeof body !== 'object') throw badRequest('a persona file is required');
    const { file, problems } = coercePersonaFile(body);
    if (problems.length > 0) {
      sendJson(response, 400, { error: problems.join('；'), problems });
      return;
    }
    sendJson(response, 200, store.savePersonas(file));
  });
}
