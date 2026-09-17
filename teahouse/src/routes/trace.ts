/**
 * Trajectory endpoints.
 *
 * Read and forget only: the events are written where they happen (`/api/generate`
 * for turns, the memory and chat routes for the rest), because a route that has
 * to be told what happened is a route that can be forgotten. See `engine/trace.ts`.
 */

import { sendJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { traceStats } from '../engine/trace.ts';
import type { Store } from '../store/db.ts';

export function registerTraceRoutes(router: Router, store: Store): void {
  router.add('GET', '/api/chats/:id/trace', ({ params, response }) => {
    const events = store.loadTrace(params.id!);
    sendJson(response, 200, {
      chatId: params.id,
      events,
      stats: traceStats(events),
      /** How many recent turns still carry the exact messages they sent. */
      bodyTurns: events.filter((event) => event.type === 'turn' && event.messages !== undefined).length,
    });
  });

  /**
   * Forgetting the instrumentation never touches the conversation: the transcript
   * and the memory stay exactly as they are.
   */
  router.add('DELETE', '/api/chats/:id/trace', ({ params, response }) => {
    store.clearTrace(params.id!);
    sendJson(response, 200, { chatId: params.id, events: [], stats: traceStats([]), bodyTurns: 0 });
  });
}
