/**
 * Context usage bar: used / total, remaining, and a collapsible breakdown of
 * what is filling the window.
 *
 * Rebuilt from a budget object (see token-budget.js) rather than reading state
 * itself, so the centre stats, this bar and the request preview always agree.
 * The breakdown replaces the old one-line "how the number was produced" note:
 * the same facts, but split per channel and only when asked for.
 */

import { el } from '../dom.js';
import { t } from '../i18n.js';
import { formatTokens } from '../token-budget.js';

/**
 * Whether the breakdown is expanded. Module-level because the bar is rebuilt on
 * every preview refresh, and a native `<details>` would otherwise snap shut
 * under the reader after any edit.
 */
let breakdownOpen = false;

function percentLabel(percent) {
  if (percent > 0 && percent < 0.1) return '<0.1%';
  return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`;
}

function breakdownRow(row) {
  const nodes = [
    el('div', { class: 'token-break-row' }, [
      el('span', { class: `token-break-dot seg-${row.key}` }),
      el('span', { class: 'token-break-name', text: row.label, title: row.sublabel ?? row.label }),
      el('span', { class: 'token-break-tokens tokens', text: `~${formatTokens(row.tokens)}` }),
      el('span', { class: 'token-break-percent muted small', text: percentLabel(row.percent) }),
    ]),
  ];
  for (const child of row.children ?? []) {
    nodes.push(
      el('div', { class: 'token-break-row token-break-child' }, [
        el('span', { class: 'token-break-dot' }),
        el('span', { class: 'token-break-name', text: child.label, title: child.label }),
        el('span', { class: 'token-break-tokens small', text: `~${formatTokens(child.tokens)}` }),
      ]),
    );
  }
  if (row.hidden > 0) {
    nodes.push(
      el('div', { class: 'token-break-row token-break-child muted small' }, [
        el('span', { class: 'token-break-dot' }),
        el('span', { class: 'token-break-name', text: t('budget.breakdown.more', { count: row.hidden }) }),
        el('span', { class: 'token-break-tokens', text: `~${formatTokens(row.hiddenTokens ?? 0)}` }),
      ]),
    );
  }
  return nodes;
}

function totalsRow(label, value, extra = '') {
  return el('div', { class: `token-break-row token-break-total ${extra}` }, [
    el('span', { class: 'token-break-dot seg-none' }),
    el('span', { class: 'token-break-name', text: label }),
    el('span', { class: 'token-break-tokens', text: formatTokens(value) }),
  ]);
}

/**
 * The collapsible panel: a stacked share bar, one row per channel with its
 * detail, then the window / usable / reserve / remaining totals.
 */
function breakdownNode(breakdown, mark) {
  const segments = el(
    'div',
    { class: 'token-segbar' },
    breakdown.segments.map((segment) =>
      el('span', {
        class: `token-seg seg-${segment.key}`,
        style: `width:${segment.percent}%`,
        title: `${segment.label} · ${formatTokens(segment.tokens)}`,
      })),
  );

  const rows = [];
  for (const row of breakdown.rows) rows.push(...breakdownRow(row));
  rows.push(
    el('div', { class: 'token-break-sep' }),
    totalsRow(t('budget.breakdown.usable'), breakdown.usable, 'muted small'),
    totalsRow(t('budget.breakdown.reserve'), breakdown.reserve, 'muted small'),
    totalsRow(t('budget.breakdown.remaining'), breakdown.remaining, 'muted small'),
  );

  // The counting mode and whether the total is provider-anchored used to live in
  // a full sentence under the bar; the same two facts are now a compact mark on
  // the summary line, so the panel does not spend three lines on provenance.
  const details = el('details', { class: 'token-breakdown' }, [
    el('summary', { class: 'token-breakdown-summary' }, [
      el('span', { class: 'token-breakdown-label', text: t('budget.breakdown.toggle') }),
      el('span', { class: 'token-breakdown-mark muted small', text: mark }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small', text: t('budget.breakdown.share', {
        used: formatTokens(breakdown.used),
        total: formatTokens(breakdown.window),
      }) }),
    ]),
    el('div', { class: 'token-breakdown-body' }, [segments, ...rows]),
  ]);
  details.open = breakdownOpen;
  details.addEventListener('toggle', () => {
    breakdownOpen = details.open;
  });
  return details;
}

export function tokenBar(budget, options = {}) {
  const fill = el('div', {
    class: `token-fill ${budget.level}`,
    style: `width:${budget.fillPercent}%`,
  });

  const node = el(
    'div',
    {
      class: `token-bar ${budget.level}`,
      title: `${budget.summary}\n${t('budget.usableTitle', { usable: budget.usableLabel, reserve: budget.reserve })}`,
    },
    [
      el('div', { class: 'token-track', role: 'progressbar', 'aria-valuenow': budget.percent, 'aria-valuemin': 0, 'aria-valuemax': 100 }, [fill]),
      el('div', { class: 'token-line' }, [
        el('span', { class: 'token-summary', text: budget.summary }),
        el('span', { class: `token-percent ${budget.level}`, text: `${budget.percent}%` }),
      ]),
    ],
  );

  if (budget.breakdown && budget.breakdown.rows.length > 0) {
    // The counting mode and whether the total is provider-anchored used to live
    // in a full sentence under the bar; the same two facts are now a compact mark
    // on the summary line, so three lines of provenance become one.
    const counting = budget.counting ?? {};
    const mark = counting.anchored === true
      ? `${counting.label ?? ''} · ${t('budget.breakdown.anchoredMark')}`
      : String(counting.label ?? '');
    node.append(breakdownNode(budget.breakdown, mark));
  }

  if (budget.trimmed > 0) {
    node.append(
      el('button', {
        class: 'link',
        text: t('budget.trimmed', { count: budget.trimmed }),
        title: t('budget.trimmedTitle'),
        onclick: options.onShowTrimmed,
      }),
    );
  }

  if (budget.level === 'over') {
    node.append(el('div', { class: 'token-alert small bad', text: t('budget.over') }));
  } else if (budget.level === 'warn') {
    node.append(el('div', { class: 'token-alert small warn', text: t('budget.warn') }));
  }

  return node;
}
