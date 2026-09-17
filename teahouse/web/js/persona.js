/**
 * Persona helpers for the client.
 *
 * DOM-free: the resolution mirrors the server's `effectivePersona` so the
 * speaker names the transcript shows are the ones the request was assembled
 * with. `test:web` runs both on the same inputs.
 */

export function effectivePersonaName(library, chatPersonaId, fallbackName) {
  return effectivePersona(library, chatPersonaId, { name: fallbackName, description: '' }).name;
}

/** Name and description together; mirrors the server's resolution. */
export function effectivePersona(library, chatPersonaId, fallback) {
  const items = Array.isArray(library?.items) ? library.items : [];
  if (typeof chatPersonaId === 'string' && chatPersonaId !== '') {
    const pinned = items.find((item) => item.id === chatPersonaId);
    if (pinned) return { name: pinned.name, description: pinned.description ?? '' };
  }
  if (typeof library?.activeId === 'string' && library.activeId !== '') {
    const active = items.find((item) => item.id === library.activeId);
    if (active) return { name: active.name, description: active.description ?? '' };
  }
  return { name: fallback.name, description: fallback.description ?? '' };
}

export function newPersonaId() {
  return `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
