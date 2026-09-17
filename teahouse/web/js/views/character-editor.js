/**
 * Character card editor.
 *
 * The counterpart of the world book editor for the other half of the core: the
 * card itself. Until now a card could be renamed, re-keyed, exported or deleted,
 * but its content — description, personality, scenario, the greetings, the
 * example dialogue, the two prompt overrides — could only be changed by editing
 * JSON by hand.
 *
 * The form is generated from `character-fields.js`, the patch is validated
 * against the server's own field list, and the write goes back through the
 * importer's lossless path, so a PNG card stays a PNG and unknown fields survive.
 *
 * Like the world book editor: the dialog owns its DOM and takes its shell from
 * components/modal.js.
 */

import { api, json, loadCharacters, refreshPreview, state } from '../api.js';
import { CHARACTER_FIELDS } from '../character-fields.js';
import { createFieldRows, readFields } from '../components/form-field.js';
import { createModal } from '../components/modal.js';
import { toastError, toastOk } from '../components/toast.js';
import { append, clear, el } from '../dom.js';
import { t } from '../i18n.js';

let ui = null;
let character = null;
let loaded = {};
let fields = new Map();

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return (a ?? '') === (b ?? '');
}

function build() {
  const status = el('div', { class: 'editor-status small' });
  const form = el('div', { class: 'character-form' });

  const modal = createModal({ title: t('card.title'), className: 'editor character' });
  append(modal.body, [form, status]);

  const saveButton = el('button', {
    class: 'primary',
    text: t('common.save'),
    onclick: () => save().catch((error) => setStatus(error.message, true)),
  });
  modal.footer.append(
    status,
    el('button', { class: 'ghost', text: t('common.close'), onclick: () => modal.close() }),
    saveButton,
  );

  ui = { modal, form, status, saveButton };
  return ui;
}

function setStatus(text, isError = false) {
  if (!ui) return;
  ui.status.textContent = text;
  ui.status.className = `editor-status small ${isError ? 'bad' : 'muted'}`;
}

/** Rebuilds the form from the card that was just loaded. */
function renderForm() {
  const form = ui.form;
  clear(form);
  fields = new Map();

  const rows = [];
  let group = null;
  for (const spec of CHARACTER_FIELDS) {
    if (spec.groupKey !== group) {
      group = spec.groupKey;
      rows.push(el('h4', { class: 'field-group', text: t(group) }));
    }
    const built = createFieldRows([spec], loaded, { hint: 'inline' });
    for (const [key, field] of built.fields) fields.set(key, field);
    rows.push(...built.rows);
  }
  form.append(el('div', { class: 'field-rows' }, rows));

  form.addEventListener('input', () => setStatus(''));
  form.addEventListener('change', () => setStatus(''));
}

async function reload() {
  const detail = await api(`/api/characters/${encodeURIComponent(character.id)}`);
  character = { id: detail.id, name: detail.name, spec: detail.spec };
  loaded = { name: detail.name, ...detail.fields };

  ui.modal.setTitle(detail.name || detail.id);
  ui.modal.setSubtitle(
    t('card.subtitle', { id: detail.id, spec: detail.spec, books: detail.books.length }),
  );
  renderForm();
  setStatus('');
  return detail;
}

async function save() {
  const values = readFields(fields);
  const patch = {};
  for (const spec of CHARACTER_FIELDS) {
    if (!sameValue(values[spec.key], loaded[spec.key])) patch[spec.key] = values[spec.key];
  }
  if (Object.keys(patch).length === 0) {
    setStatus(t('editor.noChanges'));
    return;
  }

  ui.saveButton.disabled = true;
  setStatus(t('editor.saving'));
  try {
    await api(`/api/characters/${encodeURIComponent(character.id)}`, json('PATCH', patch));
    await reload();
    await loadCharacters();
    // The card feeds the prompt, so the preview and the budget follow it.
    if (state.chatId) await refreshPreview();
    setStatus(t('editor.saved', { count: Object.keys(patch).length }));
    toastOk(t('card.savedToast'));
  } catch (error) {
    const detail = Array.isArray(error.problems)
      ? error.problems
        .map((problem) => t('editor.problemLine', { field: problem.field, message: problem.message }))
        .join(t('editor.problemSeparator'))
      : error.message;
    setStatus(detail, true);
    toastError(t('card.saveFailedToast'), { detail });
  } finally {
    ui.saveButton.disabled = false;
  }
}

/**
 * @param {string} characterId
 */
export async function openCharacterEditor(characterId) {
  if (ui === null) build();
  character = { id: characterId };
  // Opened first so a slow disk still shows the dialog rather than nothing.
  ui.modal.open();
  ui.modal.setTitle(characterId);
  ui.modal.setSubtitle(t('card.loading'));
  await reload();
}
