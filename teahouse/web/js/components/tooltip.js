/**
 * Floating tooltip.
 *
 * Native `title` is slow, unstyleable and mouse-only, which is why the list rows
 * explain their short labels (and their `id` / format codes) through one shared
 * layer instead. The layer is created the first time a tooltip is shown and taken
 * away when it hides, so pointing at nothing adds nothing to the document.
 *
 * It is deliberately passive: `mouseenter` / `focus` show, `mouseleave` / `blur`
 * hide, and it never steals the pointer or the keyboard.
 */

import { el } from '../dom.js';

let layer = null;
let current = null;

function ensureLayer() {
  if (!layer || !layer.isConnected) {
    layer = el('div', { class: 'tooltip-layer', role: 'tooltip' });
    document.body.append(layer);
  }
  return layer;
}

function place(anchor) {
  const node = ensureLayer();
  const rect = anchor.getBoundingClientRect?.() ?? { top: 0, bottom: 0, left: 0, width: 0 };
  const width = node.offsetWidth || 0;
  const height = node.offsetHeight || 0;
  const viewportWidth = window.innerWidth || 0;
  const viewportHeight = window.innerHeight || 0;

  let left = rect.left + rect.width / 2 - width / 2;
  let top = rect.bottom + 6;
  left = Math.max(8, Math.min(left, viewportWidth - width - 8));
  if (top + height > viewportHeight - 8) top = Math.max(8, rect.top - height - 6);

  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

function show(anchor, text) {
  if (!text) return;
  const node = ensureLayer();
  node.textContent = text;
  node.classList.add('visible');
  current = anchor;
  place(anchor);
}

function hide(anchor) {
  if (anchor && current !== anchor) return;
  current = null;
  layer?.classList.remove('visible');
  layer?.remove();
  layer = null;
}

/**
 * Explains an element on hover and on keyboard focus.
 *
 * @param {HTMLElement} anchor
 * @param {string | (() => string)} content
 * @returns {() => void} detaches the listeners again
 */
export function attachTooltip(anchor, content) {
  const text = typeof content === 'function' ? content : () => content;
  const onEnter = () => show(anchor, text());
  const onLeave = () => hide(anchor);

  anchor.addEventListener('mouseenter', onEnter);
  anchor.addEventListener('focus', onEnter);
  anchor.addEventListener('mouseleave', onLeave);
  anchor.addEventListener('blur', onLeave);

  return () => {
    anchor.removeEventListener('mouseenter', onEnter);
    anchor.removeEventListener('focus', onEnter);
    anchor.removeEventListener('mouseleave', onLeave);
    anchor.removeEventListener('blur', onLeave);
    hide(anchor);
  };
}
