/**
 * Trajectory: what actually happened, per turn.
 *
 * The chat transcript records *what was said*; a trace records *what the program
 * did about it* — when the request started, how long the first token took, what
 * the provider charged, which world book entries fired, whether the prompt had to
 * be trimmed. Nothing here changes behaviour: it is instrumentation, stored
 * beside the chat as one JSON line per event.
 *
 * It is an append-only log rather than a field on each message because the
 * interesting events are not all messages: a deleted message is gone from the
 * transcript, a memory update is not a message at all, and a failed request
 * produced no message to hang anything off.
 *
 * The exact request body is the bulky part (tens of KB per turn), so only the
 * most recent `TRACE_BODY_TURNS` turns keep theirs; older turns keep their
 * numbers. Pure logic here — `Store` does the reading and writing.
 */

/** How many recent turns keep the exact messages that were sent. */
export const TRACE_BODY_TURNS = 20;

export type TraceTrigger = 'normal' | 'regenerate' | 'retry' | 'continue' | 'impersonate';

/** One provider request, successful or not. */
export interface TraceTurnEvent {
  type: 'turn';
  id: string;
  /** When the request was sent. */
  at: string;
  endedAt: string;
  durationMs: number;
  /** Time from sending to the first visible token, or null when nothing came. */
  firstTokenMs: number | null;
  model: string;
  /** Provider-reported usage; both are 0 when the provider sent none. */
  promptTokens: number;
  completionTokens: number;
  /** Thinking arrived as its own channel; we only know its size, not its tokens. */
  reasoningChars: number;
  /** Length of the visible reply that was saved. */
  chars: number;
  /** The message this turn produced, when it produced one. */
  entryId: string | null;
  trigger: TraceTrigger;
  /** World book entries that fired for this request. */
  worldHits: { world: string; uid: number; comment: string }[];
  /** The prompt had to be trimmed to fit the window. */
  trimmed: boolean;
  /** The request failed; the value is what the provider said. */
  failed: string | null;
  /** The exact messages sent, kept only for the most recent turns. */
  messages?: { role: string; content: string }[];
  /** Pictures on this turn (names and bytes), when there were any. */
  images?: { name: string; bytes: number }[];
  /** Group chat speaker: who answered this turn, when anyone did. */
  speaker?: string;
}

/** Everything else worth a row on the timeline. */
export type TraceNoteKind =
  | 'memory'
  | 'edit'
  | 'delete'
  | 'truncate'
  | 'fork'
  | 'import'
  | 'swipe';

export interface TraceNoteEvent {
  type: TraceNoteKind;
  id: string;
  at: string;
  /** One line for the timeline, already in the user's language. */
  label: string;
  entryId?: string;
  /** Longer text: the new summary, the edited excerpt, the fork's name. */
  detail?: string;
}

export type TraceEvent = TraceTurnEvent | TraceNoteEvent;

export interface TraceStats {
  turns: number;
  calls: number;
  failures: number;
  trimmed: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  /** Turns per the provider's own count, so the chart can be honest about gaps. */
  countedTurns: number;
}

export function traceStats(events: TraceEvent[]): TraceStats {
  const turns = events.filter((event): event is TraceTurnEvent => event.type === 'turn');
  const counted = turns.filter((turn) => turn.promptTokens > 0 || turn.completionTokens > 0);
  return {
    turns: turns.length,
    calls: turns.length,
    failures: turns.filter((turn) => turn.failed !== null).length,
    trimmed: turns.filter((turn) => turn.trimmed).length,
    durationMs: turns.reduce((sum, turn) => sum + turn.durationMs, 0),
    promptTokens: counted.reduce((sum, turn) => sum + turn.promptTokens, 0),
    completionTokens: counted.reduce((sum, turn) => sum + turn.completionTokens, 0),
    countedTurns: counted.length,
  };
}

/**
 * Drops the stored request bodies of everything but the newest `keep` turns, so
 * a long conversation does not turn its own instrumentation into the biggest file
 * on disk. Returns the events unchanged when there is nothing to drop.
 */
export function pruneTraceBodies(events: TraceEvent[], keep = TRACE_BODY_TURNS): TraceEvent[] {
  const turns = events.filter((event): event is TraceTurnEvent => event.type === 'turn');
  const withBody = turns.filter((turn) => turn.messages !== undefined);
  if (withBody.length <= keep) return events;

  const keepIds = new Set(withBody.slice(-keep).map((turn) => turn.id));
  return events.map((event) => {
    if (event.type !== 'turn' || event.messages === undefined || keepIds.has(event.id)) return event;
    const { messages: _messages, ...rest } = event;
    return rest;
  });
}

/** A new event id: unique within a chat, stable across reloads. */
export function traceId(prefix: string, at: number = Date.now()): string {
  return `${prefix}-${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Validates one parsed line; a hand-edited file may hold anything. */
export function coerceTraceEvent(raw: unknown): TraceEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.at !== 'string') return null;
  const type = typeof item.type === 'string' ? item.type : '';
  if (type === 'turn') {
    const messages = Array.isArray(item.messages)
      ? item.messages
          .filter(
            (message): message is { role: string; content: string } =>
              typeof message === 'object' &&
              message !== null &&
              typeof (message as Record<string, unknown>).content === 'string',
          )
          .map((message) => ({ role: String(message.role ?? 'user'), content: message.content }))
      : undefined;
    return {
      type: 'turn',
      id: item.id,
      at: item.at,
      endedAt: typeof item.endedAt === 'string' ? item.endedAt : item.at,
      durationMs: number(item.durationMs),
      firstTokenMs: item.firstTokenMs === null ? null : number(item.firstTokenMs),
      model: typeof item.model === 'string' ? item.model : '',
      promptTokens: number(item.promptTokens),
      completionTokens: number(item.completionTokens),
      reasoningChars: number(item.reasoningChars),
      chars: number(item.chars),
      entryId: typeof item.entryId === 'string' ? item.entryId : null,
      trigger:
        item.trigger === 'regenerate' || item.trigger === 'retry' || item.trigger === 'continue' || item.trigger === 'impersonate'
          ? item.trigger
          : 'normal',
      worldHits: Array.isArray(item.worldHits)
        ? item.worldHits
            .filter((hit): hit is Record<string, unknown> => typeof hit === 'object' && hit !== null)
            .map((hit) => ({
              world: String(hit.world ?? ''),
              uid: number(hit.uid),
              comment: String(hit.comment ?? ''),
            }))
        : [],
      trimmed: item.trimmed === true,
      failed: typeof item.failed === 'string' ? item.failed : null,
      ...(messages ? { messages } : {}),
      ...(Array.isArray(item.images)
        ? {
            images: (item.images as unknown[])
              .filter((image): image is Record<string, unknown> => typeof image === 'object' && image !== null)
              .map((image) => ({ name: String(image.name ?? ''), bytes: number(image.bytes) })),
          }
        : {}),
      ...(typeof item.speaker === 'string' && item.speaker !== '' ? { speaker: item.speaker } : {}),
    };
  }
  if (['memory', 'edit', 'delete', 'truncate', 'fork', 'import', 'swipe'].includes(type)) {
    return {
      type: type as TraceNoteKind,
      id: item.id,
      at: item.at,
      label: typeof item.label === 'string' ? item.label : type,
      ...(typeof item.entryId === 'string' ? { entryId: item.entryId } : {}),
      ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
    };
  }
  return null;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
