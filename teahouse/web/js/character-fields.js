/**
 * The character card editor's form, in one declaration.
 *
 * Keys are the card model's own field names — the same ones the patch endpoint
 * writes and the importer round-trips — so nothing has to be translated on the
 * way in or out. Labels, hints and group headings are translation keys, resolved
 * by the shared field factory. `test:web` cross-checks this list against the
 * server's `EDITABLE_CARD_FIELDS`: a field offered here but not accepted there
 * (or the other way round) fails the suite instead of silently doing nothing.
 *
 * DOM-free on purpose, so that check can import it.
 */

/** @type {{key: string, labelKey: string, type: string, groupKey: string, rows?: number, hintKey?: string}[]} */
export const CHARACTER_FIELDS = [
  { key: 'name', labelKey: 'card.fields.name.label', type: 'line', groupKey: 'card.groups.basic', hintKey: 'card.fields.name.hint' },
  { key: 'creator', labelKey: 'card.fields.creator.label', type: 'line', groupKey: 'card.groups.basic', hintKey: 'card.fields.creator.hint' },
  { key: 'character_version', labelKey: 'card.fields.character_version.label', type: 'line', groupKey: 'card.groups.basic', hintKey: 'card.fields.character_version.hint' },
  { key: 'tags', labelKey: 'card.fields.tags.label', type: 'keys', groupKey: 'card.groups.basic', hintKey: 'card.fields.tags.hint' },

  {
    key: 'description',
    labelKey: 'card.fields.description.label',
    type: 'text',
    rows: 6,
    groupKey: 'card.groups.character',
    hintKey: 'card.fields.description.hint',
  },
  {
    key: 'personality',
    labelKey: 'card.fields.personality.label',
    type: 'text',
    rows: 3,
    groupKey: 'card.groups.character',
    hintKey: 'card.fields.personality.hint',
  },
  {
    key: 'scenario',
    labelKey: 'card.fields.scenario.label',
    type: 'text',
    rows: 3,
    groupKey: 'card.groups.character',
    hintKey: 'card.fields.scenario.hint',
  },

  {
    key: 'first_mes',
    labelKey: 'card.fields.first_mes.label',
    type: 'text',
    rows: 5,
    groupKey: 'card.groups.dialogue',
    hintKey: 'card.fields.first_mes.hint',
  },
  {
    key: 'alternate_greetings',
    labelKey: 'card.fields.alternate_greetings.label',
    type: 'text-list',
    rows: 4,
    groupKey: 'card.groups.dialogue',
    hintKey: 'card.fields.alternate_greetings.hint',
  },
  {
    key: 'mes_example',
    labelKey: 'card.fields.mes_example.label',
    type: 'text',
    rows: 6,
    groupKey: 'card.groups.dialogue',
    hintKey: 'card.fields.mes_example.hint',
  },

  {
    key: 'system_prompt',
    labelKey: 'card.fields.system_prompt.label',
    type: 'text',
    rows: 4,
    groupKey: 'card.groups.override',
    hintKey: 'card.fields.system_prompt.hint',
  },
  {
    key: 'post_history_instructions',
    labelKey: 'card.fields.post_history_instructions.label',
    type: 'text',
    rows: 3,
    groupKey: 'card.groups.override',
    hintKey: 'card.fields.post_history_instructions.hint',
  },
  {
    key: 'creator_notes',
    labelKey: 'card.fields.creator_notes.label',
    type: 'text',
    rows: 3,
    groupKey: 'card.groups.notes',
    hintKey: 'card.fields.creator_notes.hint',
  },
];
