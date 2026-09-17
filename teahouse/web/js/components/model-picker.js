/**
 * Themed model dropdown.
 *
 * The settings field originally used a native `<datalist>`, whose suggestion
 * popup is drawn by the browser and cannot be styled — a white rectangle in the
 * middle of a dark UI. This builds a real dark popover instead, reusing the
 * shared floating menu (`components/menu.js`) and its keyboard handling, so the
 * topbar and the settings page look and behave the same.
 *
 * The component is presentational: the caller supplies the the items at open
 * time (so they always reflect live state) and owns what selecting one does.
 */

import { el } from '../dom.js';
import { t } from '../i18n.js';
import { openMenu } from './menu.js';

/**
 * @param {object} options
 * @param {string} [options.fallback]   label shown before any model is known
 * @param {string} [options.className]  extra class for size/placement
 * @param {string} [options.title]
 * @param {() => Array<object>} options.items  menu items, built at click time
 * @returns {{ node: HTMLButtonElement, setLabel: (text: string) => void }}
 */
export function createModelPicker(options) {
  const label = el('span', {
    class: 'model-picker-label',
    text: options.fallback ?? 'no model',
  });

  const button = el(
    'button',
    {
      class: ['model-picker', options.className].filter(Boolean).join(' '),
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-label': options.title ?? t('modelPicker.select'),
      title: options.title ?? t('modelPicker.select'),
      onclick: (event) => {
        event.stopPropagation();
        openMenu({ anchor: button, items: options.items() });
      },
    },
    [
      label,
      el('span', { class: 'model-picker-caret', text: '▾', 'aria-hidden': 'true' }),
    ],
  );

  return {
    node: button,
    setLabel(text) {
      label.textContent = text;
    },
  };
}
