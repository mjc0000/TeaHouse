/**
 * One row of the request preview: a summary line that expands to the full body.
 *
 * Expansion is per row and held by the view, so re-rendering does not lose which
 * rows were open.
 */

import { el } from '../dom.js';
import { t } from '../i18n.js';

export function previewItem(options) {
  const { index, message, tokens, expanded } = options;

  const toggle = () => options.onToggle(index);
  const summary = message.content.replace(/\s+/g, ' ').slice(0, 90);

  const row = el('div', { class: `preview-row${expanded ? ' expanded' : ''}` }, [
    el(
      'div',
      {
        class: 'preview-head',
        role: 'button',
        tabindex: '0',
        'aria-expanded': expanded ? 'true' : 'false',
        onclick: toggle,
        onkeydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        },
      },
      [
        el('span', { class: 'preview-caret', text: expanded ? '▾' : '▸' }),
        el('span', {
          class: `preview-index ${message.role}`,
          text: `#${index} ${message.role}${message.name ? ` · ${message.name}` : ''}`,
        }),
        el('span', { class: 'preview-tokens tokens', text: `~${tokens} tok` }),
        el('span', { class: 'preview-summary muted', text: summary }),
      ],
    ),
  ]);

  const actions = el('div', { class: 'preview-actions' }, [
    el('button', {
      class: 'ghost tiny',
      text: t('preview.copy'),
      title: t('preview.copyTitle'),
      onclick: (event) => {
        event.stopPropagation();
        options.onCopy(index);
      },
    }),
  ]);
  row.querySelector('.preview-head')?.append(actions);

  if (expanded) row.append(el('pre', { class: 'preview-body', text: message.content }));
  return row;
}
