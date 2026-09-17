/**
 * A collapsible group of prompt-stack blocks.
 *
 * Uses native <details>/<summary> so collapse and keyboard activation work
 * without extra code; the collapsed state is passed in so the view can persist
 * it.
 */

import { el } from '../dom.js';
import { t } from '../i18n.js';

const KIND_LABELS = {
  static: 'text',
  marker: 'marker',
  injection: 'inject',
  history: 'history',
};

export function stackGroup(group, options) {
  const blocks = group.blocks;
  const enabledCount = blocks.filter((block) => block.enabled).length;
  const tokens = group.tokens;

  const statusClass = () => {
    if (enabledCount === 0) return 'off';
    if (blocks.some((block) => block.skippedReason === 'empty')) return 'partial';
    if (enabledCount < blocks.length) return 'partial';
    return 'on';
  };

  const rows = blocks.map((block) => {
    const item = options.itemization?.find((entry) => entry.identifier === block.identifier);
    const tokensForBlock = item?.tokens ?? 0;
    const reason = item?.skippedReason;
    return el(
      'div',
      {
        class: `stack-row${block.enabled ? '' : ' off'}${reason ? ' skipped' : ''}`,
        title: reason ? t('stack.skipped', { reason }) : block.content || block.marker || block.name,
      },
      [
        el('button', {
          class: `switch${block.enabled ? ' on' : ''}`,
          role: 'switch',
          'aria-checked': block.enabled ? 'true' : 'false',
          'aria-label': t(block.enabled ? 'stack.switchOff' : 'stack.switchOn', { name: block.name }),
          onclick: () => options.onToggleBlock(block.identifier),
        }),
        el('span', { class: 'stack-name', text: block.name }),
        el('span', { class: 'kind', text: KIND_LABELS[item?.kind ?? (block.marker ? 'marker' : 'static')] ?? 'text' }),
        el('span', { class: 'tokens', text: block.enabled ? `~${tokensForBlock}` : 'off' }),
      ],
    );
  });

  const details = el(
    'details',
    { class: `stack-group ${statusClass()}`, open: !options.collapsed },
    [
      el('summary', { class: 'stack-summary' }, [
        el('span', { class: 'stack-dot' }),
        el('span', { class: 'stack-title', text: t(group.labelKey) }),
        el('span', { class: 'stack-count muted small', text: `${enabledCount}/${blocks.length}` }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'stack-total tokens', text: `~${tokens}` }),
      ]),
      el('div', { class: 'stack-rows' }, rows),
    ],
  );

  details.addEventListener('toggle', () => options.onToggleGroup(group.id, !details.open));
  return details;
}

/**
 * Groups a stack by identifier, using the mapping the design settled on.
 * Unknown identifiers land in whichever group claims them, else in "dialogue".
 */
export const STACK_GROUP_DEFS = [
  {
    id: 'system',
    labelKey: 'stack.groupSystem',
    identifiers: ['main', 'language', 'enhanceDefinitions', 'nsfw'],
  },
  {
    id: 'persona',
    labelKey: 'stack.groupPersona',
    identifiers: [
      'personaDescription',
      'charDescription',
      'charPersonality',
      'scenario',
      'story',
      'worldInfoBefore',
      'worldInfoAfter',
      'worldInfoANTop',
      'worldInfoANBottom',
      'worldInfoEMTop',
      'worldInfoEMBottom',
    ],
  },
  {
    id: 'dialogue',
    labelKey: 'stack.groupDialogue',
    identifiers: ['dialogueExamples', 'impersonate', 'chatHistory', 'jailbreak'],
  },
  {
    id: 'injection',
    labelKey: 'stack.groupInjection',
    identifiers: [],
  },
];

export function groupStack(blocks, itemization) {
  const claimed = new Set();
  const groups = STACK_GROUP_DEFS.map((definition) => {
    const members = blocks.filter((block) => {
      if (claimed.has(block.identifier)) return false;
      const belongs =
        definition.id === 'injection'
          ? block.injection_position === 1
          : definition.identifiers.includes(block.identifier);
      if (belongs) claimed.add(block.identifier);
      return belongs;
    });
    const tokens = members.reduce(
      (sum, block) => sum + (itemization?.find((item) => item.identifier === block.identifier)?.tokens ?? 0),
      0,
    );
    return { ...definition, blocks: members, tokens };
  });

  return groups.filter((group) => group.blocks.length > 0);
}
