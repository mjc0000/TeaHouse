/**
 * Accent swatches: a row of colour choices, used by the corner button and by the
 * settings dialog so both look and behave the same.
 *
 * The swatch colour is the accent's own `--accent` (kept in `themes.js` as data for
 * the button's paint), and `test:web` checks that it matches the palette the CSS
 * actually applies — a swatch that lies about its colour is worse than no swatch.
 */

import { clear, el } from '../dom.js';
import { t } from '../i18n.js';
import { ACCENTS, applyAccent, readStoredAccent } from '../themes.js';

/**
 * @param {{ onChange?: (id: string) => void, compact?: boolean }} [options]
 * @returns {HTMLElement} a `radiogroup` of swatch buttons
 */
export function accentSwatches(options = {}) {
  const group = el('div', {
    class: `accent-swatches${options.compact ? ' compact' : ''}`,
    role: 'radiogroup',
    'aria-label': t('appearance.accentAria'),
  });

  function render() {
    const current = readStoredAccent();
    clear(group);
    for (const accent of ACCENTS) {
      const active = accent.id === current;
      group.append(
        el('button', {
          class: `accent-swatch${active ? ' active' : ''}`,
          type: 'button',
          role: 'radio',
          'aria-checked': active ? 'true' : 'false',
          'aria-label': t(accent.labelKey),
          title: t(accent.labelKey),
          dataset: { accent: accent.id },
          style: `--swatch: ${accent.swatch}`,
          onclick: () => {
            applyAccent(accent.id);
            render();
            options.onChange?.(accent.id);
          },
        }),
      );
    }
  }

  render();
  return group;
}
