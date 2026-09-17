/**
 * Quick replies: reusable snippets that sit above the composer.
 *
 * Our own file is a plain list, but an import accepts SillyTavern's shape too —
 * `{ quickReplyEnabled, quickReplySlots: [{ label, mes, enabled }] }` — because
 * that is where a user's existing snippets live. Export writes our shape, which
 * SillyTavern's own importer reads as well (it tolerates a bare list of slots).
 */

export interface QuickReply {
  id: string;
  /** Button text; empty falls back to a trimmed preview of `mes`. */
  label: string;
  /** The text that gets inserted, or sent. */
  mes: string;
  enabled: boolean;
}

export interface QuickReplyFile {
  version: number;
  /** Whether the bar is shown above the composer at all. */
  enabled: boolean;
  items: QuickReply[];
}

export const EMPTY_QUICK_REPLIES: QuickReplyFile = { version: 1, enabled: true, items: [] };

/** A stable-enough id: the file is small and edited by hand as often as by us. */
function newId(): string {
  return `qr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceItem(raw: unknown): QuickReply | null {
  if (!isRecord(raw)) return null;
  const mes = typeof raw.mes === 'string' ? raw.mes : '';
  const label = typeof raw.label === 'string' ? raw.label : '';
  // A snippet with no text is nothing to reply with, so it is dropped rather
  // than shown as a dead button.
  if (mes.trim() === '' && label.trim() === '') return null;
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId(),
    label: label.trim(),
    mes,
    enabled: raw.enabled !== false,
  };
}

/**
 * Reads any of the accepted shapes into our file shape.
 *
 * @returns the normalised file plus how many entries were dropped
 */
export function normalizeQuickReplies(raw: unknown): { file: QuickReplyFile; dropped: number } {
  let enabled = true;
  let list: unknown[] = [];
  let dropped = 0;

  if (Array.isArray(raw)) {
    list = raw;
  } else if (isRecord(raw)) {
    enabled = raw.enabled !== false && raw.quickReplyEnabled !== false;
    if (Array.isArray(raw.items)) list = raw.items;
    else if (Array.isArray(raw.quickReplySlots)) list = raw.quickReplySlots;
  }

  const items: QuickReply[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const item = coerceItem(entry);
    if (item === null) {
      dropped++;
      continue;
    }
    // Ids must be unique or the editor would edit the wrong row.
    if (seen.has(item.id)) item.id = newId();
    seen.add(item.id);
    items.push(item);
  }

  return { file: { version: 1, enabled, items }, dropped };
}

/** Validates a client-supplied file without inventing anything. */
export function coerceQuickReplyFile(raw: unknown): QuickReplyFile {
  return normalizeQuickReplies(raw).file;
}

/** The button text: the label, or the first line of the snippet. */
export function quickReplyLabel(item: QuickReply): string {
  if (item.label.trim() !== '') return item.label.trim();
  const line = item.mes.split('\n').find((part) => part.trim() !== '') ?? '';
  const text = line.trim();
  return text.length > 18 ? `${text.slice(0, 18)}…` : text || '(空)';
}

/** SillyTavern's extension shape, so the list can go back the other way. */
export function toSillyTavernQuickReplies(file: QuickReplyFile): Record<string, unknown> {
  return {
    quickReplyEnabled: file.enabled,
    numberOfSlots: file.items.length,
    quickReplySlots: file.items.map((item) => ({
      mes: item.mes,
      label: item.label,
      enabled: item.enabled,
    })),
  };
}
