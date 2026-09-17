/**
 * Message operations that are not streaming: edit, delete, copy, variant switch,
 * truncate.
 *
 * Kept apart from the chat view so the view stays about layout and the stream,
 * and so these can be reasoned about (and later tested) on their own. Retrying
 * is deliberately absent: it starts a stream, which the chat view owns.
 */

import { api, json, loadChat, state } from './api.js';
import { copyText } from './clipboard.js';
import { toastError, toastOk } from './components/toast.js';
import { t } from './i18n.js';

/** Resolves the text a message currently displays (active variant when swiped). */
export function visibleContent(entry) {
  if (entry.variants && entry.variants.length > 0) {
    return entry.variants[entry.activeVariant ?? 0] ?? entry.content;
  }
  return entry.content;
}

async function settle(chatId) {
  // loadChat re-assembles the preview, which is what refreshes the token bar
  // and the request preview after an edit, delete or variant switch.
  await loadChat(chatId);
}

export async function copyMessage(entry) {
  const ok = await copyText(visibleContent(entry));
  if (ok) toastOk(t('chatActions.copied'));
  else toastError(t('chatActions.copyFailed'));
  return ok;
}

export async function saveMessage(entry, content) {
  const text = content.trim();
  if (text === '') {
    toastError(t('chatActions.empty'));
    return false;
  }
  try {
    await api(`/api/chats/${state.chatId}/entries/${encodeURIComponent(entry.id)}`, json('PATCH', { content: text }));
    // Re-read rather than patching locally: the server also recomputes what the
    // prompt looks like, and the token numbers must follow the new text.
    await settle(state.chatId);
    toastOk(t('chatActions.saved'));
    return true;
  } catch (error) {
    toastError(t('chatActions.saveFailed', { error: error.message }));
    return false;
  }
}

export async function deleteMessage(entry) {
  try {
    await api(`/api/chats/${state.chatId}/entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
    await settle(state.chatId);
    toastOk(t('chatActions.deleted'));
    return true;
  } catch (error) {
    toastError(t('chatActions.deleteFailed', { error: error.message }));
    return false;
  }
}

export async function truncateFrom(entry) {
  const entries = state.entries;
  const index = entries.findIndex((item) => item.id === entry.id);
  const removed = index === -1 ? 0 : entries.length - index;
  try {
    await api(`/api/chats/${state.chatId}/truncate`, json('POST', { entryId: entry.id }));
    await settle(state.chatId);
    toastOk(t('chatActions.truncated', { count: removed }));
    return true;
  } catch (error) {
    toastError(t('chatActions.truncateFailed', { error: error.message }));
    return false;
  }
}

export async function switchVariant(entry, index) {
  try {
    await api(`/api/chats/${state.chatId}/variant`, json('POST', { entryId: entry.id, index }));
    await settle(state.chatId);
    return true;
  } catch (error) {
    toastError(t('chatActions.variantFailed', { error: error.message }));
    return false;
  }
}

/** Conversation rules the menu uses to decide what is offered. */
export function messageCapabilities(entry, options = {}) {
  const streaming = options.streaming === true;
  const isLast = options.isLast === true;
  return {
    streaming,
    canEdit: !streaming && entry.role !== 'system',
    canRetry: !streaming && entry.role === 'assistant',
    // Translating a system note is noise; the endpoint refuses it too.
    canTranslate: !streaming && entry.role !== 'system',
    // Reading a system note aloud is noise for the same reason.
    canSpeak: !streaming && entry.role !== 'system',
    // Continuing only makes sense on the trailing assistant reply: it grows the
    // same message instead of starting a new one.
    canContinue: !streaming && entry.role === 'assistant' && isLast,
    canTruncate: !streaming,
  };
}
