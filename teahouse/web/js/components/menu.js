/**
 * Floating action menu, anchored to an element or opened at a pointer.
 *
 * Used for the message action menu (button and right-click) and for the "more"
 * menu on character and world rows. Keyboard: arrows move, Enter activates,
 * Escape closes and returns focus.
 */

import { el } from '../dom.js';
import { focusableWithin } from '../focus.js';
import { pushEscapeLayer } from '../keys.js';

let activeMenu = null;

export function closeActiveMenu() {
  activeMenu?.close();
}

/**
 * @param {object} options
 * @param {HTMLElement} [options.anchor]  element to hang the menu off
 * @param {number} [options.x]            pointer position, when there is no anchor
 * @param {number} [options.y]
 * @param {Array<{label: string, onSelect?: () => void, disabled?: boolean,
 *                danger?: boolean, hint?: string, separatorBefore?: boolean}>} options.items
 * @returns {{ close: () => void }}
 */
export function openMenu(options) {
  closeActiveMenu();

  const items = options.items.filter(Boolean);
  const buttons = [];

  const list = el('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (item.separatorBefore) list.append(el('div', { class: 'menu-separator' }));
    const button = el('button', {
      class: `menu-item ${item.danger ? 'danger' : ''}`.trim(),
      role: 'menuitem',
      disabled: item.disabled === true,
      'aria-disabled': item.disabled === true ? 'true' : undefined,
      title: item.hint ?? '',
      onclick: () => {
        if (item.disabled) return;
        close();
        item.onSelect?.();
      },
    }, [
      el('span', { class: 'menu-label', text: item.label }),
      item.hint ? el('span', { class: 'menu-hint', text: item.hint }) : null,
    ]);
    buttons.push(button);
    list.append(button);
  }

  const root = el('div', { class: 'menu-layer' }, [list]);
  document.body.append(root);

  const enabled = buttons.filter((button) => !button.disabled);
  let releaseEscape = null;

  function close() {
    if (!root.isConnected) return;
    releaseEscape?.();
    releaseEscape = null;
    root.remove();
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
    if (activeMenu?.root === root) activeMenu = null;
    options.onClose?.();
  }

  function onOutside(event) {
    if (!root.contains(event.target)) close();
  }

  const move = (delta) => {
    if (enabled.length === 0) return;
    const current = enabled.indexOf(document.activeElement);
    const next = current === -1 ? 0 : (current + delta + enabled.length) % enabled.length;
    enabled[next].focus();
  };

  list.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Tab') {
      close();
    }
  });

  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);
  const releaseEscapeLayer = pushEscapeLayer(() => {
    close();
    options.anchor?.focus?.();
  });
  releaseEscape = releaseEscapeLayer;

  // Measure before placing so flipping decisions use the real size.
  root.style.visibility = 'hidden';
  const rect = list.getBoundingClientRect();
  const anchorRect = options.anchor?.getBoundingClientRect?.();
  const gap = 6;
  let left = options.x ?? (anchorRect ? anchorRect.left : 0);
  let top = options.y ?? (anchorRect ? anchorRect.bottom + gap : 0);

  if (anchorRect && options.y === undefined && top + rect.height > window.innerHeight - 8) {
    top = Math.max(8, anchorRect.top - rect.height - gap);
  }
  left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8));

  list.style.left = `${Math.round(left)}px`;
  list.style.top = `${Math.round(top)}px`;
  root.style.visibility = '';

  activeMenu = { root, close };
  const first = focusableWithin(list)[0];
  first?.focus();
  return { close };
}
