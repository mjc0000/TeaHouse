/**
 * Long-term memory: the editor, and the turn that keeps the summary fresh.
 *
 * Nothing here runs *inside* a generation. The chat view tells us when a reply has
 * been saved, and only then may a second model call be spent on the summary — so a
 * slow or failing provider can never delay or break the reply itself. A failure is
 * a toast and keeps the previous summary.
 */

import { api, json, loadChat, on, state } from '../api.js';
import { createFieldRows } from '../components/form-field.js';
import { createModal } from '../components/modal.js';
import { toastError, toastOk } from '../components/toast.js';
import { el } from '../dom.js';
import { t } from '../i18n.js';
import { formatTokens } from '../token-budget.js';

let busy = false;
let editorOpen = false;

function currentChatId() {
  if (!state.chatId) throw new Error(t('app.pickChat'));
  return state.chatId;
}

function memoryUrl(chatId) {
  return `/api/chats/${encodeURIComponent(chatId)}/memory`;
}

/**
 * Summarises now and pulls the chat back in, so the header badge and the prompt
 * panel show the new block without a refresh.
 */
async function summarize(chatId, force) {
  const result = await api(`${memoryUrl(chatId)}/summarize`, json('POST', { force }));
  await loadChat(chatId);
  return result;
}

function describeUsage(usage) {
  if (!usage) return '';
  return t('memoryView.usage', {
    prompt: formatTokens(usage.promptTokens),
    completion: formatTokens(usage.completionTokens),
  });
}

/** The automatic path: quiet on success, a toast when the provider refuses. */
async function autoSummarize(info) {
  if (busy || editorOpen || state.streaming) return;
  const chatId = state.chatId;
  if (!chatId) return;
  busy = true;
  try {
    const result = await summarize(chatId, false);
    toastOk(t('memoryView.updated', { count: result.summarized, usage: describeUsage(result.usage) }));
  } catch (error) {
    toastError(t('memoryView.autoFailed', { error: error.message }));
  } finally {
    busy = false;
  }
}

export async function openMemoryEditor() {
  let chatId;
  try {
    chatId = currentChatId();
  } catch (error) {
    toastError(error.message);
    return;
  }

  let view;
  try {
    view = await api(memoryUrl(chatId));
  } catch (error) {
    toastError(t('memoryView.readFailed', { error: error.message }));
    return;
  }

  const note = el('div', { class: 'memory-note muted small' });
  const status = el('div', { class: 'memory-status muted small' });
  const fields = createFieldRows(
    [
      {
        key: 'memoryText',
        labelKey: 'memoryView.fieldLabel',
        type: 'text',
        rows: 9,
        hintKey: 'memoryView.fieldHint',
      },
    ],
    { memoryText: view.record?.text ?? '' },
    { hint: 'inline' },
  );
  const textarea = fields.fields.get('memoryText');

  const summaryButton = el('button', {
    text: t('memoryView.summarizeNow'),
    onclick: () =>
      void run(
        () => summarize(chatId, true),
        (result) => t('memoryView.summarized', { count: result.summarized, usage: describeUsage(result.usage) }),
        true,
      ),
  });
  const freezeButton = el('button', { class: 'ghost' });
  const clearButton = el('button', { class: 'ghost danger' });

  const modal = createModal({
      className: 'memory',
      removeOnClose: true,
    title: t('memoryView.title'),
    subtitle: t('memoryView.subtitle'),
    onClose: () => {
      editorOpen = false;
    },
  });
  modal.body.append(note, status, ...fields.rows);

  /**
   * Runs one action, then re-reads the chat so the badge, the prompt panel and
   * the status line all agree. `syncText` refreshes the textarea — only for the
   * actions that change the summary itself, so unfreezing does not throw away an
   * edit the user is in the middle of.
   */
  async function run(action, success, syncText = false) {
    busy = true;
    render();
    try {
      const result = await action();
      if (result) view = result;
      await loadChat(chatId);
      if (syncText) textarea.control.value = view.record?.text ?? '';
      render();
      if (success) toastOk(typeof success === 'function' ? success(result) : success);
    } catch (error) {
      toastError(t('memoryView.actionFailed', { error: error.message }));
      render();
    } finally {
      busy = false;
    }
  }

  function render() {
    const record = view.record;
    const { settings, progress } = view;
    note.textContent = settings.enabled
      ? record?.frozen === true
        ? t('memoryView.frozenNote')
        : t('memoryView.enabledNote', {
          interval: settings.interval,
          covered: progress.covered,
          until: Math.max(0, settings.interval - progress.since),
        })
      : t('memoryView.disabledNote');

    const parts = [
      t('memoryView.model', { model: record?.model || view.model || t('memoryView.noModelRecord') }),
      record ? t('memoryView.tokens', { tokens: formatTokens(record.tokens) }) : t('memoryView.noSummary'),
      record?.updatedAt ? t('memoryView.updatedAt', { date: new Date(record.updatedAt).toLocaleString() }) : '',
      record?.usage
        ? t('memoryView.lastCall', {
          prompt: formatTokens(record.usage.promptTokens),
          completion: formatTokens(record.usage.completionTokens),
        })
        : '',
    ].filter((part) => part !== '');
    status.textContent = parts.join(' · ');

    summaryButton.disabled = busy || view.progress.since === 0;
    summaryButton.textContent = view.progress.since > 0
      ? t('memoryView.summarizeCount', { count: view.progress.since })
      : t('memoryView.noNew');
    freezeButton.textContent = record?.frozen === true ? t('memoryView.unfreeze') : t('memoryView.freeze');
    freezeButton.disabled = busy || !record;
    clearButton.textContent = t('memoryView.clear');
    clearButton.disabled = busy || !record;
  }

  freezeButton.addEventListener('click', () => {
    const frozen = view.record?.frozen !== true;
    void run(
      () => api(memoryUrl(chatId), json('PUT', { frozen })),
      frozen ? t('memoryView.frozenToast') : t('memoryView.unfrozenToast'),
    );
  });
  clearButton.addEventListener('click', () => {
    void run(
      () => api(memoryUrl(chatId), { method: 'DELETE' }),
      t('memoryView.clearedToast'),
      true,
    );
  });

  modal.footer.append(
    el('button', {
      class: 'ghost',
      text: t('common.save'),
      onclick: () =>
        void run(
          () => api(memoryUrl(chatId), json('PUT', { text: String(textarea.read() ?? '') })),
          t('memoryView.savedToast'),
          true,
        ),
    }),
    summaryButton,
    freezeButton,
    clearButton,
    el('button', { class: 'ghost', text: t('common.close'), onclick: () => modal.close() }),
  );

  editorOpen = true;
  render();
  modal.open();
}

export function initMemoryView() {
  on('memory-due', (info) => {
    if (info?.due !== true) return;
    void autoSummarize(info);
  });
}
