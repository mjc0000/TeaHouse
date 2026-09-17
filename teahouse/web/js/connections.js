/**
 * Extra connections, on the client side.
 *
 * The file itself lives on the server (`data/connections.json`, keys masked on
 * the way out); this is only the shared vocabulary: a fresh id, a lookup, and
 * the one-line label used by the group picker and the conversation header.
 * Pure — no DOM, no state — so `test:web` can pin the lookup rules.
 */

/** A fresh id, in the same shape the persona library uses. */
export function newConnectionId() {
  return `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The items of a connection file, defensively. */
export function connectionItems(file) {
  return Array.isArray(file?.items) ? file.items : [];
}

export function connectionById(file, id) {
  if (typeof id !== 'string' || id === '') return null;
  return connectionItems(file).find((item) => item.id === id) ?? null;
}

/**
 * What to show for a member's connection: its label (falling back to the model
 * name, then the id), or `''` when the member follows the chat — and also when
 * the pinned connection has been deleted, so a stale pin reads as "follow" on
 * screen exactly as it resolves on the server.
 */
export function connectionLabel(file, id) {
  const found = connectionById(file, id);
  if (found === null) return '';
  return found.label.trim() || found.model.trim() || found.id;
}
