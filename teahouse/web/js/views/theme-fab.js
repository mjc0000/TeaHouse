/**
 * The corner button: appearance without opening the settings dialog.
 *
 * A small floating control in the bottom-right corner of the window — the place a
 * user reaches for when they want to change how the app looks, without leaving the
 * conversation. It opens a popover with the accents (the second axis) and the three
 * appearance modes, all through the same `themes.js` the settings dialog uses, so
 * the two can never disagree.
 *
 * It owns its DOM: the button and the popover are appended to `<body>`, like a
 * dialog, because a floating control cannot live inside a panel that may collapse.
 */

import { accentSwatches } from '../components/accent-swatches.js';
import { icon } from '../components/icon.js';
import { t, onLocaleChange } from '../i18n.js';
import { pushEscapeLayer } from '../keys.js';
import { clear, el } from '../dom.js';
import { THEMES, applyTheme, readStoredTheme } from '../themes.js';

let button = null;
let popover = null;
let releaseEscape = null;

function close() {
  if (!popover || popover.classList.contains('hidden')) return;
  popover.classList.add('hidden');
  button?.setAttribute('aria-expanded', 'false');
  releaseEscape?.();
  releaseEscape = null;
}

function open() {
  if (!popover) build();
  popover.classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true');
  // Escape closes the popover and nothing else: the layer stack is what makes one
  // press close exactly one thing.
  releaseEscape = pushEscapeLayer(() => close());
  render();
}

function toggle() {
  if (popover && !popover.classList.contains('hidden')) close();
  else open();
}

function modeChips() {
  const row = el('div', { class: 'appearance-chips', role: 'radiogroup', 'aria-label': t('appearance.modeAria') });
  const current = readStoredTheme();
  for (const theme of THEMES) {
    row.append(
      el(
        'button',
        {
          class: `appearance-chip${theme.id === current ? ' active' : ''}`,
          type: 'button',
          role: 'radio',
          'aria-checked': theme.id === current ? 'true' : 'false',
          title: t(theme.labelKey),
          onclick: () => {
            applyTheme(theme.id);
            // The popover is a quick switcher: any choice gets out of the way, the
            // same way a colour does.
            close();
            render();
          },
        },
        [icon(theme.icon, { size: 15 }), el('span', { text: t(theme.labelKey) })],
      ),
    );
  }
  return row;
}

function render() {
  if (!popover) return;
  clear(popover);
  popover.append(
    el('div', { class: 'appearance-title muted small', text: t('appearance.accentAria') }),
    accentSwatches({ compact: true, onChange: () => close() }),
    el('div', { class: 'appearance-title muted small', text: t('appearance.modeAria') }),
    modeChips(),
    el('div', {
      class: 'appearance-foot muted small',
      text: t('appearance.fabNote'),
    }),
  );
}

function build() {
  popover = el('div', {
    class: 'appearance-popover hidden',
    role: 'dialog',
    'aria-label': t('appearance.fabAria'),
  });
  document.body.append(popover);
  // A click anywhere else closes it; the button's own click is handled by toggle().
  document.addEventListener('mousedown', (event) => {
    if (!popover || popover.classList.contains('hidden')) return;
    if (popover.contains(event.target) || button.contains(event.target)) return;
    close();
  });
}

export function initThemeFab() {
  button = el(
    'button',
    {
      class: 'appearance-fab',
      type: 'button',
      title: t('appearance.fabTitle'),
      'aria-label': t('appearance.fabAria'),
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      onclick: (event) => {
        event.stopPropagation();
        toggle();
      },
    },
    [icon('palette', { size: 18 })],
  );
  document.body.append(button);
  build();
  render();
  // The corner button is always present; re-translate its chrome on a switch.
  onLocaleChange(() => {
    button.title = t('appearance.fabTitle');
    button.setAttribute('aria-label', t('appearance.fabAria'));
    popover?.setAttribute('aria-label', t('appearance.fabAria'));
    if (popover && !popover.classList.contains('hidden')) render();
  });
}
