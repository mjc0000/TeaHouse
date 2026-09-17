/**
 * Left panel, section 3: chats, and the character -> chat selection flow.
 */

import { api, emit, json, loadChat, loadChats, on, state } from '../api.js';
import { confirmDialog, promptDialog } from '../components/confirm.js';
import { emptyState } from '../components/empty-state.js';
import { openMenu } from '../components/menu.js';
import { toastError, toastOk } from '../components/toast.js';
import { downloadText } from '../clipboard.js';
import { clear, el } from '../dom.js';
import { t } from '../i18n.js';

function run(promise) {
  promise.catch((error) => toastError(error.message));
}

/** Opens this character's most recent chat, creating one if it has none. */
export async function selectCharacter(characterId) {
  const existing = state.chats.find((chat) => chat.characterId === characterId);
  if (existing) {
    await loadChat(existing.id);
    return existing;
  }
  const chat = await api('/api/chats', json('POST', { characterId, worldRefs: [] }));
  await loadChats();
  await loadChat(chat.id);
  return chat;
}

async function createChat() {
  const characterId = state.meta?.characterId ?? state.characters[0]?.id;
  if (!characterId) {
    toastError(t('chats.noCharacter'));
    return;
  }
  const chat = await api('/api/chats', json('POST', {
    characterId,
    name: t('chats.defaultName', { id: characterId }),
    worldRefs: state.meta?.worldRefs ?? [],
  }));
  await loadChats();
  await loadChat(chat.id);
  toastOk(t('chats.created'));
}

async function renameChat(chat) {
  const name = await promptDialog({
    title: t('chats.renameTitle'),
    label: t('chats.renameLabel'),
    value: chat.name,
  });
  if (name === null || name === chat.name) return;
  await api(`/api/chats/${encodeURIComponent(chat.id)}`, json('PUT', { name }));
  await loadChats();
}

async function deleteChat(chat) {
  const ok = await confirmDialog({
    title: t('chats.deleteTitle', { name: chat.name }),
    message: state.entries.length > 0 && state.chatId === chat.id
      ? t('chats.deleteWithMessages', { count: state.entries.length })
      : t('chats.deleteOnly'),
    confirmLabel: t('common.delete'),
    danger: true,
  });
  if (!ok) return;

  await api(`/api/chats/${encodeURIComponent(chat.id)}`, { method: 'DELETE' });
  if (state.chatId === chat.id) {
    state.chatId = null;
    state.meta = null;
    state.entries = [];
  }
  await loadChats();
  if (state.chats[0]) await loadChat(state.chats[0].id);
  else emit('chat', { meta: null, entries: [] });
  toastOk(t('chats.deleted'));
}

/** Exports one transcript in SillyTavern's JSONL, so it can move between tools. */
async function exportChat(chat) {
  const response = await fetch(`/api/chats/${encodeURIComponent(chat.id)}/export`);
  if (!response.ok) throw new Error(t('chats.exportFailed', { status: response.status }));
  const text = await response.text();
  downloadText(`${chat.name || chat.id}.jsonl`, text, 'application/x-ndjson;charset=utf-8');
  toastOk(t('chats.exported'));
}

/**
 * Imports a transcript file onto a character.
 *
 * The file decides the content; the character is the one this panel is showing,
 * because a transcript has to belong to someone. A SillyTavern log carries the
 * character's name, and when it matches a card here that card is used instead.
 */
async function importChatLog(file) {
  let characterId = state.meta?.characterId ?? state.characters[0]?.id;
  if (!characterId) {
    toastError(t('chats.importNoCharacter'));
    return;
  }
  const text = await file.text();

  // A SillyTavern header names the character; prefer that card when it exists.
  try {
    const header = JSON.parse(text.split('\n').find((line) => line.trim() !== '') ?? '{}');
    const named = typeof header?.character_name === 'string' ? header.character_name : '';
    const match = state.characters.find((item) => item.name === named);
    if (match) characterId = match.id;
  } catch {
    /* a header we cannot read is fine; the endpoint will report what it found */
  }

  const name = (file.name ?? '').replace(/\.[^.]+$/, '')
    || t('chats.importName', { date: new Date().toLocaleString() });
  const result = await api(
    `/api/chats/import?characterId=${encodeURIComponent(characterId)}&name=${encodeURIComponent(name)}`,
    { method: 'POST', body: text },
  );
  await loadChats();
  await loadChat(result.id);
  const skipped = result.warnings.length > 0 ? t('chats.importSkipped', { count: result.warnings.length }) : '';
  toastOk(t('chats.imported', { name: result.name, count: result.entries, skipped }));
}

/** Copies a whole conversation into a new one, so an experiment can start from it. */
async function forkChat(chat) {
  const fork = await api(`/api/chats/${encodeURIComponent(chat.id)}/fork`, json('POST', {}));
  await loadChats();
  await loadChat(fork.id);
  toastOk(t('chats.forked', { name: fork.name }));
}

  function chatMenu(chat, anchor) {
    openMenu({
      anchor,
      items: [
        { label: t('chats.menuOpen'), onSelect: () => run(loadChat(chat.id)) },
        { label: t('chats.menuRename'), onSelect: () => run(renameChat(chat)) },
        {
          label: t('chats.menuMembers'),
          hint: (chat.members ?? []).length >= 2
            ? t('chats.menuMembersHint', { count: chat.members.length })
            : t('chats.menuMembersHintOff'),
          onSelect: () => emit('open-group-members', { chatId: chat.id }),
        },
        {
          label: t('chats.menuExport'),
          hint: t('chats.menuExportHint'),
          separatorBefore: true,
          onSelect: () => run(exportChat(chat)),
        },
      { label: t('chats.menuFork'), hint: t('chats.menuForkHint'), onSelect: () => run(forkChat(chat)) },
      { label: t('common.delete'), danger: true, separatorBefore: true, onSelect: () => run(deleteChat(chat)) },
    ],
  });
}

export function renderChats() {
  const list = document.getElementById('chat-list');
  clear(list);

  if (state.chats.length === 0) {
    list.append(
      el('li', { class: 'panel-empty' }, [
        emptyState({
          title: t('chats.emptyTitle'),
          hint: t('chats.emptyHint'),
          action: { label: t('chats.emptyAction'), onClick: () => run(createChat()) },
        }),
      ]),
    );
    return;
  }

  for (const chat of state.chats) {
    const attached = chat.worldRefs?.length ?? 0;
    const members = Array.isArray(chat.members) ? chat.members : [];
    const grouped = members.length >= 2;
    const memberNames = grouped
      ? members.map((id) => state.characters.find((character) => character.id === id)?.name ?? id).join(t('commands.join'))
      : '';
    list.append(
      el('li', { class: state.chatId === chat.id ? 'active' : '' }, [
        el('span', {
          class: 'name',
          text: chat.name,
          title: t('chats.rowTitle', { name: chat.name, character: chat.characterId, books: attached }),
          onclick: () => run(loadChat(chat.id)),
        }),
        // The group marker: a conversation with two or more members is a group,
        // and the list has to say so without opening it.
        grouped
          ? el('span', {
            class: 'pill group-badge',
            text: t('chats.groupBadge', { count: members.length }),
            title: t('chats.groupBadgeTitle', { names: memberNames }),
          })
          : null,
        el('span', { class: 'meta', text: t('chats.rowMeta', { count: attached }) }),
        el('button', {
          class: 'ghost tiny icon-button',
          text: '⋯',
          'aria-label': t('chats.moreActionsAria', { name: chat.name }),
          'aria-haspopup': 'menu',
          title: t('characters.moreActions'),
          onclick: (event) => {
            event.stopPropagation();
            chatMenu(chat, event.currentTarget);
          },
        }),
      ]),
    );
  }
}

export function initChatListView() {
  document.getElementById('btn-new-chat').addEventListener('click', () => run(createChat()));
  document.getElementById('btn-delete-chat').addEventListener('click', () => {
    const chat = state.chats.find((item) => item.id === state.chatId);
    if (!chat) {
      toastError(t('chats.noSelected'));
      return;
    }
    run(deleteChat(chat));
  });

  document.getElementById('import-chat').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await importChatLog(file);
    } catch (error) {
      toastError(t('chats.importFailed', { error: error.message }));
    } finally {
      event.target.value = '';
    }
  });

  on('chats', renderChats);
  on('chat', renderChats);
  // The brand menu asks for a chat the same way the sidebar button does.
  on('new-chat', () => run(createChat()));
  }
