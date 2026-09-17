/**
 * Topbar connection badge.
 *
 * The result lives in `state.ui.connection` (api.js), which the settings dialog
 * also reads, so the badge and the settings page can never disagree. The badge
 * only renders that result and, on click, asks for a fresh test.
 */

import { el } from '../dom.js';
import { t } from '../i18n.js';

const DOT_CLASS = { idle: '', testing: 'warn', ok: 'ok', error: 'bad' };

function label(status) {
  if (status.status === 'testing') return t('connection.testing');
  if (status.status === 'ok') {
    const known = status.modelKnown === false ? t('connection.modelUnknown') : '';
    return t('connection.connected', { count: status.modelCount }) + known;
  }
  if (status.status === 'error') return t('connection.failed', { error: status.error });
  return t('connection.test');
}

function tooltip(status) {
  if (status.status === 'ok') return t('connection.tooltipOk', { count: status.modelCount, ms: status.elapsedMs });
  if (status.status === 'error') return String(status.error);
  return t('connection.tooltipHint');
}

/**
 * @param {{ status: string } & Record<string, unknown>} connection
 * @param {{ onTest?: () => void }} [options]
 * @returns {HTMLButtonElement}
 */
export function connectionStatus(connection, options = {}) {
  const status = connection ?? { status: 'idle' };
  return el(
    'button',
    {
      class: `ghost small connection-status ${DOT_CLASS[status.status] ?? ''}`.trim(),
      type: 'button',
      disabled: status.status === 'testing',
      title: tooltip(status),
      onclick: () => options.onTest?.(),
    },
    [
      el('span', { class: 'conn-dot' }),
      el('span', { class: 'conn-label', text: label(status) }),
    ],
  );
}
