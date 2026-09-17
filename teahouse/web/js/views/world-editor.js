/**
 * World book entry editor.
 *
 * The form is generated from `GET /api/worlds/fields`, the same metadata the
 * server validates patches with, so a new field needs no client change.
 *
 * The component owns its DOM (built once, lazily) instead of looking elements up
 * by id, which keeps dynamically created markup out of the global id space. The
 * dialog shell comes from components/modal.js so Escape and focus handling are
 * not reimplemented here.
 */

import { api, json, loadFieldMeta, loadWorlds, refreshPreview, resetFieldMeta, state } from '../api.js';
import { confirmDialog } from '../components/confirm.js';
import { createFieldRows, readFields } from '../components/form-field.js';
import { createModal } from '../components/modal.js';
import { toastError, toastOk } from '../components/toast.js';
import { append, clear, el } from '../dom.js';
import { onLocaleChange, t } from '../i18n.js';

let ui = null;
let world = null;
let fieldMeta = null;
let selectedUid = null;
let filterText = '';

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  const normalize = (value) => (value === undefined ? null : value);
  return normalize(a) === normalize(b);
}

// ---------------------------------------------------------------------------
// Component construction
// ---------------------------------------------------------------------------

function build() {
  const status = el('div', { class: 'editor-status small' });
  const bookForm = el('div', { class: 'book-settings' });
  const search = el('input', {
    type: 'text',
    placeholder: t('worldEditor.searchPlaceholder'),
    oninput: (event) => {
      filterText = event.target.value.trim().toLowerCase();
      renderList();
    },
  });
  const list = el('ul', { class: 'editor-list' });
  const form = el('div', { class: 'editor-form' });

  const modal = createModal({ title: t('worldEditor.title'), className: 'editor' });
  append(modal.body, [
    bookForm,
    el('div', { class: 'editor-columns' }, [
      el('div', { class: 'editor-column' }, [
        el('div', { class: 'row' }, [
          search,
          el('button', {
            class: 'primary',
            text: t('worldEditor.newEntry'),
            onclick: () => addEntry().catch((error) => setStatus(error.message, true)),
          }),
        ]),
        list,
      ]),
      el('div', { class: 'editor-column' }, [form]),
    ]),
    status,
  ]);

  ui = { modal, status, setStatus, bookForm, search, list, form, controls: new Map() };

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.className = `editor-status small ${isError ? 'bad' : 'muted'}`;
    if (!isError && text !== '') setTimeout(() => {
      if (status.textContent === text) status.textContent = '';
    }, 4000);
  }

  return ui;
}

function setStatus(text, isError = false) {
  ui?.setStatus(text, isError);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function matches(entry) {
  if (filterText === '') return true;
  const haystack = [entry.comment, entry.content, ...(entry.key ?? []), ...(entry.keysecondary ?? [])]
    .join('\n')
    .toLowerCase();
  return haystack.includes(filterText);
}

function hitInfo(uid) {
  return state.ui.hits?.byWorld?.get(world?.id)?.keys?.get(uid) ?? null;
}

function badges(entry) {
  const out = [];
  if (entry.constant) out.push(t('hitCard.constant'));
  if (entry.disable) out.push(t('worldEditor.badgeDisabled'));
  if (entry.useProbability && entry.probability !== 100) out.push(`${entry.probability}%`);
  if (entry.sticky) out.push(`sticky ${entry.sticky}`);
  if (entry.cooldown) out.push(`cd ${entry.cooldown}`);
  if (entry.delay) out.push(`delay ${entry.delay}`);
  if (entry.group) out.push(t('worldEditor.badgeGroup', { name: entry.group }));
  if (entry.vectorized) out.push(t('worldEditor.badgeVectorized'));
  return out;
}

function keyList(entry) {
  const info = hitInfo(entry.uid);
  if (!info) return el('div', { class: 'entry-keys', text: (entry.key ?? []).join(', ') || t('worldEditor.noKeys') });
  const matched = new Set(info.matched);
  const secondary = new Set(info.secondary);
  return el(
    'div',
    { class: 'entry-keys' },
    (entry.key ?? []).map((key) =>
      el('span', {
        class: `key-chip${matched.has(key) ? ' matched' : ''}`,
        text: key,
      }),
    ).concat(
      [...secondary].map((key) => el('span', { class: 'key-chip matched secondary', text: key, title: t('hitCard.secondaryKey') })),
    ),
  );
}

function renderList() {
  const list = ui.list;
  clear(list);

  const entries = world.entries.filter(matches);
  if (entries.length === 0) {
    list.append(
      el('li', {
        class: 'muted small',
        text: world.entries.length === 0 ? t('worldEditor.noEntries') : t('worldEditor.noMatches'),
      }),
    );
    return;
  }

  for (const entry of entries) {
    const hit = hitInfo(entry.uid) !== null;
    list.append(
      el(
        'li',
        {
          class: `${entry.uid === selectedUid ? 'active' : ''}${hit ? ' hit' : ''}`.trim(),
          dataset: { uid: String(entry.uid) },
          onclick: () => {
            selectedUid = entry.uid;
            renderList();
            renderForm();
          },
        },
        [
          el('div', { class: 'entry-main' }, [
            el('div', { class: 'entry-comment', text: entry.comment || `uid ${entry.uid}` }),
            keyList(entry),
          ]),
          el('div', { class: 'entry-meta' }, [
            t('worldEditor.orderPosition', { uid: entry.uid, order: entry.order, position: entry.position }),
            ...badges(entry).map((text) => el('span', { class: 'badge', text })),
            hit ? el('span', { class: 'badge hit-badge', text: t('worldEditor.hitThisTurn') }) : null,
          ]),
        ],
      ),
    );
  }
}

function renderForm() {
  const form = ui.form;
  clear(form);
  ui.controls.clear();

  const entry = world.entries.find((item) => item.uid === selectedUid);
  if (!entry) {
    form.append(el('p', { class: 'muted', text: t('worldEditor.selectEntry') }));
    return;
  }

  form.append(
    el('div', { class: 'editor-form-head' }, [
      el('strong', { text: entry.comment || `uid ${entry.uid}` }),
      el('span', { class: 'muted small', text: `uid ${entry.uid}` }),
    ]),
  );

  for (const group of fieldMeta.groups) {
    const specs = fieldMeta.fields.filter((spec) => spec.group === group.name);
    if (specs.length === 0) continue;

    const built = createFieldRows(specs, entry);
    for (const [key, field] of built.fields) ui.controls.set(key, field);

    form.append(
      el('details', { open: group.name === 'basic' || group.name === 'activation' }, [
        el('summary', { text: group.label }),
        el('div', { class: 'field-rows' }, built.rows),
      ]),
    );
  }

  form.append(
    el('div', { class: 'row' }, [
      el('button', {
        class: 'primary',
        text: t('worldEditor.saveEntry'),
        onclick: () => saveEntry().catch((error) => setStatus(error.message, true)),
      }),
      el('button', { class: 'ghost', text: t('worldEditor.duplicate'), onclick: () => duplicateEntry().catch((error) => setStatus(error.message, true)) }),
      el('button', { class: 'ghost danger', text: t('worldEditor.removeEntry'), onclick: () => removeEntry().catch((error) => setStatus(error.message, true)) }),
    ]),
  );
}

function renderBookForm() {
  const form = ui.bookForm;
  clear(form);

  const depth = el('input', { type: 'number', min: 0, placeholder: t('form.inherit') });
  depth.value = world.scanDepth ?? '';
  const budget = el('input', { type: 'number', min: 0, placeholder: t('form.inherit') });
  budget.value = world.tokenBudget ?? '';
  const recursive = el('select', {}, [
    el('option', { value: 'inherit', text: t('form.inherit') }),
    el('option', { value: 'true', text: t('form.yes') }),
    el('option', { value: 'false', text: t('form.no') }),
  ]);
  recursive.value =
    world.recursiveScanning === null || world.recursiveScanning === undefined
      ? 'inherit'
      : String(world.recursiveScanning);

  const attached = (state.meta?.worldRefs ?? []).includes(world.id);
  const hits = state.ui.hits?.byWorld?.get(world.id)?.count ?? 0;

  form.append(
    el('div', { class: 'book-row' }, [
      el('label', { class: 'field-row' }, [el('span', { class: 'field-label', text: t('worldEditor.bookScanDepth') }), depth]),
      el('label', { class: 'field-row' }, [el('span', { class: 'field-label', text: t('worldEditor.bookTokenBudget') }), budget]),
      el('label', { class: 'field-row' }, [el('span', { class: 'field-label', text: t('worldEditor.bookRecursive') }), recursive]),
      el('button', {
        class: 'ghost',
        text: t('worldEditor.bookSave'),
        onclick: async () => {
          try {
            await api(`/api/worlds/${encodeURIComponent(world.id)}`, json('PATCH', {
              scanDepth: depth.value === '' ? null : Number(depth.value),
              tokenBudget: budget.value === '' ? null : Number(budget.value),
              recursiveScanning: recursive.value === 'inherit' ? null : recursive.value === 'true',
            }));
            await reload();
            toastOk(t('worldEditor.bookSaved'));
          } catch (error) {
            setStatus(error.message, true);
          }
        },
      }),
      el('span', {
        class: attached ? 'badge' : 'muted small',
        text: attached ? t('worldEditor.bookAttached') : t('worldEditor.bookDetached'),
      }),
      hits > 0 ? el('span', { class: 'badge hit-badge', text: t('worldEditor.bookHits', { count: hits }) }) : null,
    ]),
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function saveEntry() {
  const entry = world.entries.find((item) => item.uid === selectedUid);
  if (!entry) return;

  const patch = {};
  const values = readFields(ui.controls);
  for (const [field, next] of Object.entries(values)) {
    const spec = fieldMeta.fields.find((item) => String(item.field) === field);
    if (spec?.readOnly) continue;
    if (!sameValue(next, entry[field])) patch[field] = next;
  }

  if (Object.keys(patch).length === 0) {
    setStatus(t('editor.noChanges'));
    return;
  }

  try {
    await api(
      `/api/worlds/${encodeURIComponent(world.id)}/entries/${selectedUid}`,
      json('PATCH', patch),
    );
    await reload();
    setStatus(t('editor.saved', { count: Object.keys(patch).length }));
  } catch (error) {
    const detail = Array.isArray(error.problems)
      ? error.problems
        .map((problem) => t('editor.problemLine', { field: problem.field, message: problem.message }))
        .join(t('editor.problemSeparator'))
      : error.message;
    setStatus(detail, true);
  }
}

async function addEntry() {
  const created = await api(
    `/api/worlds/${encodeURIComponent(world.id)}/entries`,
    json('POST', { comment: t('worldEditor.newEntryComment'), content: '', key: [], order: 100 }),
  );
  selectedUid = created.entry.uid;
  await reload();
  setStatus(t('worldEditor.added'));
}

async function duplicateEntry() {
  if (selectedUid === null) return;
  const created = await api(
    `/api/worlds/${encodeURIComponent(world.id)}/entries/${selectedUid}/duplicate`,
    json('POST', {}),
  );
  selectedUid = created.entry.uid;
  await reload();
  setStatus(t('worldEditor.duplicated'));
}

async function removeEntry() {
  if (selectedUid === null) return;
  const entry = world.entries.find((item) => item.uid === selectedUid);
  const ok = await confirmDialog({
    title: t('worldEditor.removeTitle', { name: entry?.comment || selectedUid }),
    message: t('worldEditor.removeMessage'),
    confirmLabel: t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  await api(
    `/api/worlds/${encodeURIComponent(world.id)}/entries/${selectedUid}`,
    { method: 'DELETE' },
  );
  selectedUid = null;
  await reload();
  setStatus(t('worldEditor.removed'));
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function scrollToFirstHit() {
  const bucket = state.ui.hits?.byWorld?.get(world.id);
  const first = bucket ? [...bucket.uids][0] : undefined;
  if (first === undefined) return;
  selectedUid = first;
  renderList();
  renderForm();
  ui.list.querySelector(`li[data-uid="${first}"]`)?.scrollIntoView({ block: 'center' });
}

async function reload() {
  // The labels come from the server in the interface language; refetch them if a
  // language switch dropped the cache.
  fieldMeta = fieldMeta ?? (await loadFieldMeta());
  world = await api(`/api/worlds/${encodeURIComponent(world.id ?? state.editingWorldId)}`);
  if (selectedUid !== null && !world.entries.some((entry) => entry.uid === selectedUid)) {
    selectedUid = null;
  }
  ui.modal.setTitle(world.name || world.id);
  ui.modal.setSubtitle(t('worldEditor.subtitle', { id: world.id, format: world.format, count: world.entries.length }));
  renderBookForm();
  renderList();
  renderForm();
  // The list's entry count, the hit badge and the scan preview all follow the
  // document, so they are refreshed after every mutation.
  await loadWorlds();
  if (state.chatId) await refreshPreview();
}

// The field metadata is served per language; a switch drops the cache and, if
// the editor is open, refetches and re-renders it in place.
onLocaleChange(() => {
  fieldMeta = null;
  resetFieldMeta();
  if (world && ui?.modal.isOpen) {
    void reload().catch((error) => setStatus(error.message, true));
  }
});

/**
 * @param {string} worldId
 * @param {{ scrollToHit?: boolean }} [options]
 */
export async function openWorldEditor(worldId, options = {}) {
  if (ui === null) build();
  state.editingWorldId = worldId;
  selectedUid = null;
  filterText = '';
  ui.search.value = '';
  // `reload` reads state.editingWorldId on the first call.
  world = { id: worldId, name: worldId, format: '?', entries: [] };
  ui.modal.open();
  await reload();
  if (options.scrollToHit) scrollToFirstHit();
  else ui.status.textContent = '';
}
