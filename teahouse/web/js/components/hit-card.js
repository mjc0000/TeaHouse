/**
 * A world book entry that fired this turn: what it was, where it went in, why it
 * fired, and which of its keys matched.
 */

import { el } from '../dom.js';
import { t } from '../i18n.js';

const ACTIVATION_KEYS = {
  key: 'hitCard.key',
  constant: 'hitCard.constant',
  sticky: 'hitCard.sticky',
  decorator: 'hitCard.decorator',
  external: 'hitCard.external',
};

const SLOT_KEYS = {
  worldInfoBefore: 'hitCard.slotBefore',
  worldInfoAfter: 'hitCard.slotAfter',
  worldInfoANTop: 'hitCard.slotANTop',
  worldInfoANBottom: 'hitCard.slotANBottom',
  worldInfoEMTop: 'hitCard.slotEMTop',
  worldInfoEMBottom: 'hitCard.slotEMBottom',
};

function keyChips(hit, entry) {
  const keys = entry?.key ?? [];
  const matched = new Set(hit.matchedKeys ?? []);
  const secondary = new Set(hit.matchedSecondaryKeys ?? []);

  if (keys.length === 0 && matched.size === 0) return null;

  const chips = keys.map((key) =>
    el('span', {
      class: `key-chip${matched.has(key) ? ' matched' : ''}`,
      text: key,
      title: matched.has(key) ? t('hitCard.matchedKey') : t('hitCard.unmatchedKey'),
    }),
  );

  // A constant entry has keys but needs none of them.
  if (chips.length === 0) {
    for (const key of matched) chips.push(el('span', { class: 'key-chip matched', text: key }));
  }

  for (const key of secondary) {
    chips.push(el('span', { class: 'key-chip matched secondary', text: key, title: t('hitCard.secondaryKey') }));
  }

  return el('div', { class: 'key-chips' }, chips);
}

export function hitCard(hit, options = {}) {
  const entry = options.entry;
  const slot = SLOT_KEYS[hit.slot] ? t(SLOT_KEYS[hit.slot]) : (hit.slot ?? '—');
  // A vector hit's reason is the score: "how close was it" is the only useful
  // thing to say, and it is what a user tunes the threshold with. A note the
  // model picked on its own has no score — say who chose it instead.
  const reason =
    hit.activatedBy === 'external'
      ? hit.source === 'model'
        ? t('hitCard.modelPicked')
        : hit.source === 'full'
          ? t('hitCard.fullInjection')
          : typeof hit.score === 'number'
            ? t('hitCard.vectorActivated', { score: hit.score.toFixed(3) })
            : t('hitCard.external')
      : ACTIVATION_KEYS[hit.activatedBy]
        ? t(ACTIVATION_KEYS[hit.activatedBy])
        : hit.activatedBy;

  return el('div', { class: `hit${options.highlight ? ' highlight' : ''}` }, [
    el('div', { class: 'hit-head' }, [
      el('span', { class: 'hit-title', text: hit.comment || `uid ${hit.uid}` }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'tokens', text: `~${hit.tokens} tok` }),
    ]),
    el('div', { class: 'hit-meta muted small' }, [
      `${slot} · ${reason}`,
      hit.loop > 1 ? t('hitCard.recursive', { loop: hit.loop }) : '',
      ` · ${hit.world}#${hit.uid}`,
    ]),
    keyChips(hit, entry),
  ]);
}
