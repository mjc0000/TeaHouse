/**
 * Form controls built from a field spec.
 *
 * Shared by the settings dialog and the world book entry editor, so a control
 * type is implemented once. Both views use the vocabulary the server already
 * uses for entry fields, and this module normalises the two spellings of a
 * field's name (`key` on client schemas, `field` on the server's metadata):
 *
 *   line      single-line text input
 *   text      multi-line box (`rows` sizes it)
 *   text-list a list of multi-line boxes, added and removed in place
 *   number    numeric input (blank means null when `nullable`)
 *   boolean   checkbox, or a 继承全局/是/否 select when `nullable`
 *   enum      select of `options`
 *   keys      one-per-line textarea read back as a trimmed array
 *   triggers  checkbox group read back as an array
 *   password  single-line input, masked (client only)
 */

import { el } from '../dom.js';
import { t } from '../i18n.js';

/**
 * Resolves a spec's text. A `*Key` (translation key) wins; otherwise the literal
 * is used, which is how the world editor's server-supplied metadata keeps
 * working without going through the dictionary.
 */
function textOf(spec, name, fallback = '') {
  const key = spec[`${name}Key`];
  if (typeof key === 'string' && key !== '') return t(key);
  return spec[name] ?? fallback;
}

function normalize(spec) {
  const type = spec.type ?? 'line';
  const key = String(spec.key ?? spec.field);
  return {
    key,
    label: textOf(spec, 'label', key),
    type,
    hint: textOf(spec, 'hint'),
    placeholder: textOf(spec, 'placeholder'),
    nullable: spec.nullable === true,
    readOnly: spec.readOnly === true,
    options: (spec.options ?? []).map((option) => ({
      ...option,
      label: textOf(option, 'label', String(option.value)),
    })),
    min: spec.min,
    max: spec.max,
    step: spec.step,
    rows: spec.rows ?? (type === 'text' ? 6 : type === 'keys' ? 3 : undefined),
    control: spec.control,
  };
}

function numberReader(input, nullable) {
  return () => {
    if (input.value === '') return nullable ? null : 0;
    const parsed = Number(input.value);
    return Number.isFinite(parsed) ? parsed : nullable ? null : 0;
  };
}

/**
 * @param {object} rawSpec  field spec (see `normalize`)
 * @param {unknown} value   current value
 * @returns {{ key: string, node: HTMLElement, read: () => unknown, spec: object }}
 */
export function createField(rawSpec, value) {
  const spec = normalize(rawSpec);
  const disabled = spec.readOnly;

  if (spec.type === 'boolean') {
    if (spec.nullable) {
      const select = el(
        'select',
        { disabled },
        [
          el('option', { value: 'inherit', text: t('form.inherit') }),
          el('option', { value: 'true', text: t('form.yes') }),
          el('option', { value: 'false', text: t('form.no') }),
        ],
      );
      select.value = value === null || value === undefined ? 'inherit' : String(value);
      return {
        key: spec.key,
        spec,
        node: select,
        read: () => (select.value === 'inherit' ? null : select.value === 'true'),
      };
    }
    const box = el('input', { type: 'checkbox', checked: value === true, disabled });
    return { key: spec.key, spec, node: box, read: () => box.checked };
  }

  if (spec.type === 'enum') {
    const select = el(
      'select',
      { disabled },
      spec.options.map((option) => el('option', { value: String(option.value), text: option.label })),
    );
    select.value = String(value ?? spec.options[0]?.value ?? '');
    return {
      key: spec.key,
      spec,
      node: select,
      // Read back the option's declared value, not the DOM string: numeric
      // enums (a world book strategy) stay numbers, text ones stay text.
      read: () => {
        const chosen = spec.options.find((option) => String(option.value) === select.value);
        return chosen ? chosen.value : select.value;
      },
    };
  }

  if (spec.type === 'triggers') {
    const boxes = spec.options.map((option) => {
      const box = el('input', {
        type: 'checkbox',
        checked: Array.isArray(value) && value.includes(option.value),
        disabled,
      });
      return {
        value: option.value,
        box,
        node: el('label', { class: 'check' }, [box, el('span', { text: option.label })]),
      };
    });
    return {
      key: spec.key,
      spec,
      node: el('div', { class: 'trigger-group' }, boxes.map((item) => item.node)),
      read: () => boxes.filter((item) => item.box.checked).map((item) => item.value),
    };
  }

  if (spec.type === 'text-list') {
    // A list of long texts (a card's alternate greetings, say): one box each,
    // added and removed in place. Blank entries are dropped on read, matching
    // what the server keeps.
    const list = el('div', { class: 'text-list' });

    const addRow = (value) => {
      const area = el('textarea', {
        rows: spec.rows ?? 4,
        disabled,
        placeholder: spec.placeholder || '',
      });
      area.value = typeof value === 'string' ? value : '';
      const row = el('div', { class: 'text-list-row' }, [
        area,
        el('button', {
          class: 'ghost tiny',
          type: 'button',
          text: t('common.delete'),
          disabled,
          onclick: () => row.remove(),
        }),
      ]);
      list.append(row);
      return area;
    };

    for (const item of Array.isArray(value) ? value : []) addRow(item);

    return {
      key: spec.key,
      spec,
      node: el('div', { class: 'text-list-field' }, [
        list,
        el('button', {
          class: 'ghost tiny',
          type: 'button',
          text: t('form.addItem'),
          disabled,
          onclick: () => addRow('').focus(),
        }),
      ]),
      read: () =>
        list
          .querySelectorAll('textarea')
          .map((area) => area.value.trim())
          .filter((item) => item !== ''),
    };
  }

  if (spec.type === 'text' || spec.type === 'keys') {
    const area = el('textarea', {
      rows: spec.rows,
      disabled,
      placeholder: spec.placeholder || (spec.type === 'keys' ? t('form.keysPlaceholder') : ''),
    });
    area.value = Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : '';
    return {
      key: spec.key,
      spec,
      node: area,
      read: () =>
        spec.type === 'text'
          ? area.value
          : area.value.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
    };
  }

  const input = el('input', {
    type: spec.type === 'number' ? 'number' : spec.type === 'password' ? 'password' : 'text',
    disabled,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    placeholder: spec.placeholder || (spec.nullable ? t('form.inherit') : ''),
  });
  input.value = value === null || value === undefined ? '' : String(value);

  return {
    key: spec.key,
    spec,
    node: input,
    read: spec.type === 'number' ? numberReader(input, spec.nullable) : () => input.value,
  };
}

/**
 * A control plus its label, as one row.
 *
 * The row carries a class per control type (`field-row-text` for a box, say), so
 * a caller can lay out a whole page without matching on markup. `hint` chooses
 * between showing the field's explanation under its label or only as a tooltip:
 * a settings page has room for it, the entry editor's 41 fields do not.
 *
 * The bare control stays reachable as `control`, for the few callers that attach
 * listeners to it.
 *
 * @param {object} rawSpec
 * @param {unknown} value
 * @param {{ hint?: 'inline'|'title' }} [options]
 */
export function createFieldRow(rawSpec, value, options = {}) {
  const field = createField(rawSpec, value);
  const { spec } = field;

  const text = el('span', { class: 'field-text' }, [
    el('span', { class: 'field-label', text: spec.label }),
    options.hint === 'inline' && spec.hint
      ? el('span', { class: 'field-hint', text: spec.hint })
      : null,
  ]);

  const node = el(
    'label',
    { class: `field-row field-row-${spec.type}`, title: spec.hint },
    [text, field.node],
  );
  return { ...field, control: field.node, node, text };
}

/**
 * Builds rows for a list of specs and returns them with a lookup by key.
 *
 * @param {object[]} specs
 * @param {Record<string, unknown>} [values]
 * @param {{ hint?: 'inline'|'title' }} [options]
 */
export function createFieldRows(specs, values = {}, options = {}) {
  const fields = new Map();
  const rows = specs.map((spec) => {
    const row = createFieldRow(spec, values[String(spec.key ?? spec.field)], options);
    fields.set(row.key, row);
    return row.node;
  });
  return { rows, fields };
}

/** Current value of every field, keyed by field key. */
export function readFields(fields) {
  const out = {};
  for (const [key, field] of fields) out[key] = field.read();
  return out;
}
