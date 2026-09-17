/**
 * Quick replies: the snippet bar above the composer, plus its editor.
 *
 * A snippet is a button. Clicking inserts its text into the composer at the
 * caret (so it can be edited before sending); Ctrl/Cmd-clicking sends it right
 * away. The list lives on the server as a plain file, so it is editable by hand
 * and importable from SillyTavern's own quick reply JSON.
 *
 * The view owns its DOM and never touches the composer directly: it publishes
 * `quick-reply` and the chat view, which owns the input, does the rest.
 */

import { emit, importQuickReplies, loadQuickReplies, on, saveQuickReplies, state } from '../api.js';
import { createModal } from '../components/modal.js';
import { toastError, toastOk } from '../components/toast.js';
import { clear, el } from '../dom.js';
import { guard } from '../errors.js';
import { t } from '../i18n.js';

let editorUi = null;
/** Working copy inside the editor, so cancel really cancels. */
let draft = null;

// ---------------------------------------------------------------------------
// Helpers (mirrors quickReplyLabel on the server, for the same reason)
// ---------------------------------------------------------------------------

function labelOf(item) {
  if (item.label.trim() !== '') return item.label.trim();
  const line = String(item.mes).split('\n').find((part) => part.trim() !== '') ?? '';
  const text = line.trim();
  return text.length > 18 ? `${text.slice(0, 18)}…` : text || t('quickReplies.emptyLabel');
}

function newItem() {
  return { id: `qr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, label: '', mes: '', enabled: true };
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

function renderBar() {
  const mount = document.getElementById('quick-replies');
  clear(mount);

  const file = state.quickReplies ?? { enabled: true, items: [] };
  const visible = (file.items ?? []).filter((item) => item.enabled !== false);

  if (file.enabled === false || visible.length === 0) {
    // Nothing to show: leave one quiet way in rather than an empty strip.
    mount.classList.add('empty');
    mount.append(
      el('button', {
        class: 'ghost tiny',
        text: file.enabled === false ? t('quickReplies.hidden') : t('quickReplies.add'),
        title: t('quickReplies.addTitle'),
        onclick: () => openEditor(),
      }),
    );
    return;
  }

  mount.classList.remove('empty');
  for (const item of visible) {
    const button = el('button', {
      class: 'quick-reply',
      text: labelOf(item),
      title: t('quickReplies.buttonTitle', { label: labelOf(item) }),
      onclick: (event) =>
        emit(event.ctrlKey || event.metaKey ? 'send-message' : 'insert-composer', {
          text: item.mes,
        }),
    });
    mount.append(button);
  }
  mount.append(
    el('button', {
      class: 'ghost tiny quick-reply-edit',
      text: t('quickReplies.edit'),
      title: t('quickReplies.editTitle'),
      onclick: () => openEditor(),
    }),
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

function buildEditor() {
  const list = el('div', { class: 'quick-reply-list' });
  const status = el('span', { class: 'muted small editor-status', role: 'status' });
  const enabledBox = el('input', { type: 'checkbox' });
  const fileInput = el('input', { type: 'file', accept: '.json', hidden: true });

  const modal = createModal({ title: t('quickReplies.title'), className: 'quick-replies' });
  modal.headerActions.append(
    el('label', { class: 'file-button tiny' }, [t('quickReplies.importJson'), fileInput]),
  );
  modal.body.append(
    el('label', { class: 'field-row quick-reply-enable' }, [
      el('span', { class: 'field-text' }, [
        el('span', { class: 'field-label', text: t('quickReplies.showLabel') }),
        el('span', { class: 'field-hint', text: t('quickReplies.showHint') }),
      ]),
      enabledBox,
    ]),
    list,
    el('button', {
      class: 'ghost',
      type: 'button',
      text: t('form.addItem'),
      onclick: () => {
        draft.items.push(newItem());
        renderEditorList();
      },
    }),
  );

  const saveButton = el('button', {
    class: 'primary',
    type: 'button',
    text: t('common.save'),
    onclick: guard(t('quickReplies.guardSave'), () => saveDraft()),
  });
  modal.footer.append(
    status,
    el('button', {
      class: 'ghost',
      type: 'button',
      text: t('common.cancel'),
      onclick: () => modal.close(),
    }),
    saveButton,
  );

  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const result = await importQuickReplies(payload);
      draft = structuredClone(state.quickReplies);
      renderEditor();
      setEditorStatus(
        t('quickReplies.importedStatus', { count: result.imported })
        + (result.dropped > 0 ? t('quickReplies.importedSkipped', { dropped: result.dropped }) : ''),
      );
      toastOk(t('quickReplies.importedToast', { count: result.imported }));
    } catch (error) {
      setEditorStatus(t('quickReplies.importFailed', { error: error.message }), true);
    } finally {
      event.target.value = '';
    }
  });

  editorUi = { modal, list, status, enabledBox, saveButton };
  return editorUi;
}

function setEditorStatus(text, isError = false) {
  if (!editorUi) return;
  editorUi.status.textContent = text;
  editorUi.status.className = `small editor-status ${isError ? 'bad' : 'muted'}`;
}

/** One row per snippet: label, text, enabled, delete. */
function renderEditorList() {
  const list = editorUi.list;
  clear(list);

  if (draft.items.length === 0) {
    list.append(el('p', { class: 'muted small', text: t('quickReplies.emptyEditor') }));
    return;
  }

  draft.items.forEach((item, index) => {
    const label = el('input', { type: 'text', placeholder: t('quickReplies.labelPlaceholder'), value: item.label });
    label.addEventListener('input', () => {
      item.label = label.value;
    });
    const mes = el('textarea', { rows: 2, placeholder: t('quickReplies.mesPlaceholder') });
    mes.value = item.mes;
    mes.addEventListener('input', () => {
      item.mes = mes.value;
    });
    const enabled = el('input', { type: 'checkbox', checked: item.enabled !== false });
    enabled.addEventListener('change', () => {
      item.enabled = enabled.checked;
    });

    list.append(
      el('div', { class: 'quick-reply-row' }, [
        el('div', { class: 'quick-reply-row-head' }, [
          label,
          el('label', { class: 'check', title: t('quickReplies.showCheck') }, [enabled, el('span', { text: t('quickReplies.showCheckLabel') })]),
          el('button', {
            class: 'ghost tiny danger',
            type: 'button',
            text: t('common.delete'),
            onclick: () => {
              draft.items.splice(index, 1);
              renderEditorList();
            },
          }),
        ]),
        mes,
      ]),
    );
  });
}

function renderEditor() {
  editorUi.enabledBox.checked = draft.enabled !== false;
  renderEditorList();
  setEditorStatus('');
}

async function saveDraft() {
  editorUi.saveButton.disabled = true;
  setEditorStatus(t('editor.saving'));
  try {
    await saveQuickReplies(draft);
    setEditorStatus(t('quickReplies.saved', { count: draft.items.length }));
    toastOk(t('quickReplies.savedToast'));
  } catch (error) {
    setEditorStatus(t('quickReplies.saveFailed', { error: error.message }), true);
    toastError(t('quickReplies.saveFailedToast'), { detail: error.message });
  } finally {
    editorUi.saveButton.disabled = false;
  }
}

function openEditor() {
  if (editorUi === null) buildEditor();
  draft = structuredClone(state.quickReplies ?? { version: 1, enabled: true, items: [] });
  if (!Array.isArray(draft.items)) draft.items = [];
  editorUi.enabledBox.onchange = () => {
    draft.enabled = editorUi.enabledBox.checked;
  };
  renderEditor();
  editorUi.modal.open();
}

// ---------------------------------------------------------------------------

export async function initQuickReplyView() {
  await loadQuickReplies();
  renderBar();
  on('quick-replies', renderBar);
}
