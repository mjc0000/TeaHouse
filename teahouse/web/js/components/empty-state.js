/**
 * Empty states, so a panel with nothing in it explains itself instead of just
 * looking broken.
 */

import { el } from '../dom.js';

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.hint]
 * @param {{ label: string, onClick: () => void }} [options.action]
 */
export function emptyState(options) {
  return el('div', { class: 'empty-state' }, [
    el('div', { class: 'empty-mark', text: options.mark ?? '·' }),
    el('div', { class: 'empty-title', text: options.title }),
    options.hint ? el('div', { class: 'empty-hint', text: options.hint }) : null,
    options.action
      ? el('button', { class: 'primary', text: options.action.label, onclick: options.action.onClick })
      : null,
  ]);
}

/** A one-line placeholder for list bodies. */
export function emptyLine(text) {
  return el('li', { class: 'muted small', text });
}
