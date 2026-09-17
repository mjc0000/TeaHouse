/**
 * Non-blocking feedback. Replaces window.alert, which is modal, unstyleable and
 * blocks the whole page.
 */

import { el } from '../dom.js';
import { t } from '../i18n.js';

let host = null;

function ensureHost() {
  if (host && document.contains(host)) return host;
  host = el('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
  document.body.append(host);
  return host;
}

/**
 * @param {string} message
 * @param {{ type?: 'info'|'ok'|'error', duration?: number, detail?: string }} [options]
 */
export function toast(message, options = {}) {
  const type = options.type ?? 'info';
  const duration = options.duration ?? (type === 'error' ? 7000 : 3200);

  const node = el('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, [
    el('span', { class: 'toast-message', text: message }),
    options.detail ? el('span', { class: 'toast-detail', text: options.detail }) : null,
    el('button', { class: 'toast-close', text: '×', 'aria-label': t('common.close'), onclick: () => dismiss() }),
  ]);

  const dismiss = () => {
    if (!node.isConnected) return;
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 160);
  };

  ensureHost().append(node);
  if (duration > 0) setTimeout(dismiss, duration);
  return dismiss;
}

export const toastOk = (message, options) => toast(message, { ...options, type: 'ok' });
export const toastError = (message, options) => toast(message, { ...options, type: 'error' });
