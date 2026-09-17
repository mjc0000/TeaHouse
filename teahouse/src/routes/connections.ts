/**
 * Extra connections: named endpoints, mostly so a group member can speak
 * through a different provider or model than the rest of the chat.
 *
 * The API keys never leave the machine: `GET` masks every one the way
 * `/api/config` masks the main key, and a `PUT` that sends `***` back keeps the
 * stored value instead of writing the mask over it.
 */

import { badRequest, readJson, sendJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { coerceConnectionFile, maskConnections, type ConnectionFile } from '../engine/connections.ts';
import type { Store } from '../store/db.ts';

export function registerConnectionRoutes(router: Router, store: Store): void {
  router.add('GET', '/api/connections', ({ response }) => {
    sendJson(response, 200, maskConnections(store.loadConnections()));
  });

  router.add('PUT', '/api/connections', async ({ request, response }) => {
    const body = await readJson<unknown>(request);
    if (body === null || typeof body !== 'object') throw badRequest('a connection file is required');
    const { file, problems } = coerceConnectionFile(body, store.loadConnections().items);
    if (problems.length > 0) {
      sendJson(response, 400, { error: problems.join('；'), problems });
      return;
    }
    sendJson(response, 200, maskConnections(store.saveConnections(file as ConnectionFile)));
  });
}
