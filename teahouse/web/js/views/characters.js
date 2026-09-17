/**
 * Left panel, section 1: character cards.
 *
 * Selecting a character is published as an event rather than imported from the
 * chats view, so the two views stay independent and `app.js` owns the wiring.
 */

import { api, emit, json, loadCharacters, loadChat, loadChats, state } from '../api.js';
import { confirmDialog, promptDialog } from '../components/confirm.js';
import { emptyState } from '../components/empty-state.js';
import { openMenu } from '../components/menu.js';
import { attachTooltip } from '../components/tooltip.js';
import { toastError, toastOk } from '../components/toast.js';
import { downloadBlob, downloadJson } from '../clipboard.js';
import { clear, el } from '../dom.js';
import { t } from '../i18n.js';

async function renameCharacter(character) {
  const name = await promptDialog({
    title: t('characters.renameTitle'),
    label: t('characters.renameLabel'),
    value: character.name,
    hint: t('characters.renameHint'),
  });
  if (name === null || name === character.name) return;
  await api(`/api/characters/${encodeURIComponent(character.id)}`, json('PATCH', { name }));
  await loadCharacters();
  toastOk(t('characters.renamed', { name }));
}

async function rekeyCharacter(character) {
  const next = await promptDialog({
    title: t('characters.rekeyTitle'),
    label: t('characters.rekeyLabel'),
    value: character.id,
    hint: t('characters.rekeyHint'),
  });
  if (next === null || next === character.id) return;
  const result = await api(`/api/characters/${encodeURIComponent(character.id)}`, json('PATCH', { id: next }));
  await loadCharacters();
  await loadChats();
  // The open chat may belong to the re-keyed character.
  const openChat = state.chats.find((chat) => chat.id === state.chatId);
  if (openChat && openChat.characterId === character.id) await loadChat(openChat.id);
  toastOk(t('characters.rekeyed', { id: result.id, count: result.chatsUpdated }));
}

async function exportCharacter(character) {
  const card = await api(`/api/characters/${encodeURIComponent(character.id)}/export`);
  downloadJson(`${character.id}.card.json`, card);
  toastOk(t('characters.exportedJson'));
}

/** The PNG carrier already holds the card, so this is a plain download. */
async function exportCharacterPNG(character) {
  const response = await fetch(`/api/characters/${encodeURIComponent(character.id)}/export?format=png`);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `HTTP ${response.status}`);
  }
  downloadBlob(`${character.id}.card.png`, await response.blob());
  toastOk(t('characters.exportedPng'));
}

async function deleteCharacter(character) {
  let detail = null;
  try {
    detail = await api(`/api/characters/${encodeURIComponent(character.id)}`);
  } catch {
    /* the plain confirmation below is enough */
  }
  const chats = detail?.chats ?? [];

  const ok = await confirmDialog({
    title: t('characters.deleteTitle', { name: character.name }),
    message: chats.length > 0
      ? t('characters.deleteWithChats', { count: chats.length })
      : t('characters.deleteOnly'),
    detail: chats.length > 0
      ? t('characters.deleteChats', { list: chats.map((chat) => chat.name).join(t('commands.join')) })
      : t('characters.deleteIrreversible'),
    confirmLabel: chats.length > 0
      ? t('characters.deleteConfirmWithChats', { count: chats.length })
      : t('common.delete'),
    danger: true,
  });
  if (!ok) return;

  await api(`/api/characters/${encodeURIComponent(character.id)}?cascade=true`, { method: 'DELETE' });
  await loadCharacters();
  await loadChats();
  toastOk(t('characters.deleted'));
  if (!state.chats.some((chat) => chat.id === state.chatId)) {
    state.chatId = null;
    state.meta = null;
    state.entries = [];
    emit('chat', { meta: null, entries: [] });
  }
}

/** First line of a greeting, for a menu hint. */
function firstLine(text, limit = 36) {
  const line = String(text).split('\n').find((part) => part.trim() !== '') ?? '';
  const trimmed = line.trim().replace(/[*_`>#]/g, '');
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** The card's greetings: the first message, then the alternates. */
function greetingsOf(detail) {
  const fields = detail?.fields ?? {};
  return [fields.first_mes ?? '', ...(fields.alternate_greetings ?? [])]
    .map((greeting) => String(greeting).trim())
    .filter((greeting) => greeting !== '');
}

async function newChatWithGreeting(character, greeting) {
  const chat = await api('/api/chats', json('POST', { characterId: character.id, greeting }));
  await loadChats();
  await loadChat(chat.id);
  toastOk(greeting === 0
    ? t('characters.newChatFirst')
    : t('characters.newChatGreeting', { index: greeting }));
}

/** Picks which greeting a new conversation should start from. */
function greetingMenu(character, anchor, greetings) {
  openMenu({
    anchor,
    items: greetings.map((greeting, index) => ({
      label: index === 0 ? t('characters.greetingFirst') : t('characters.greetingAlternate', { index }),
      hint: firstLine(greeting),
      onSelect: () => run(newChatWithGreeting(character, index)),
    })),
  });
}

/**
 * The row menu. It loads the card first, because both the editor's entry and the
 * greeting list depend on the card's content, not just its summary.
 */
async function characterMenu(character, anchor) {
  let detail = null;
  try {
    detail = await api(`/api/characters/${encodeURIComponent(character.id)}`);
  } catch {
    /* the menu still offers the operations that need no card content */
  }
  const greetings = greetingsOf(detail);

  const items = [
    { label: t('characters.menuSelect'), onSelect: () => emit('select-character', { characterId: character.id }) },
    {
      label: t('characters.menuEdit'),
      hint: t('characters.menuEditHint'),
      onSelect: () => emit('open-character-editor', { characterId: character.id }),
    },
    {
      label: t('characters.menuNewChat'),
      hint: t('characters.menuNewChatHint'),
      onSelect: () => run(newChatWithGreeting(character, 0)),
    },
  ];
  if (greetings.length > 1) {
    items.push({
      label: t('characters.menuGreeting'),
      hint: t('characters.menuGreetingHint', { count: greetings.length }),
      onSelect: () => greetingMenu(character, anchor, greetings),
    });
  }

  items.push(
    { label: t('characters.menuRename'), hint: t('characters.menuRenameHint'), onSelect: () => run(renameCharacter(character)) },
    { label: t('characters.menuRekey'), hint: t('characters.menuRekeyHint'), onSelect: () => run(rekeyCharacter(character)) },
    { label: t('characters.menuExportJson'), onSelect: () => run(exportCharacter(character)) },
    {
      label: t('characters.menuExportPng'),
      hint: character.hasImage ? t('characters.menuExportPngHint') : t('characters.menuExportPngDisabled'),
      disabled: !character.hasImage,
      onSelect: () => run(exportCharacterPNG(character)),
    },
    { label: t('characters.menuDelete'), hint: t('characters.menuDeleteHint'), danger: true, separatorBefore: true, onSelect: () => run(deleteCharacter(character)) },
  );

  openMenu({ anchor, items });
}

function run(promise) {
  promise.catch((error) => toastError(error.message));
}

export function renderCharacters() {
  const list = document.getElementById('character-list');
  clear(list);

  if (state.characters.length === 0) {
    list.append(
      el('li', { class: 'panel-empty' }, [
        emptyState({
          title: t('characters.emptyTitle'),
          hint: t('characters.emptyHint'),
          action: {
            label: t('characters.emptyAction'),
            onClick: () => document.getElementById('import-character').click(),
          },
        }),
      ]),
    );
    return;
  }

  for (const character of state.characters) {
    const active = state.meta?.characterId === character.id;
    const name = el('span', {
      class: 'name',
      text: character.name,
      onclick: () => emit('select-character', { characterId: character.id }),
    });
    attachTooltip(name, t('characters.tooltipName', { name: character.name, id: character.id }));
    const meta = el('span', {
      class: 'meta',
      text: character.hasBook ? t('characters.metaWithBook', { spec: character.spec }) : character.spec,
    });
    attachTooltip(
      meta,
      character.hasBook
        ? t('characters.tooltipMetaBook', { spec: character.spec })
        : t('characters.tooltipMetaNoBook', { spec: character.spec }),
    );
    list.append(
      el('li', { class: active ? 'active' : '' }, [
        name,
        meta,
        el('button', {
          class: 'ghost tiny icon-button',
          text: '⋯',
          'aria-label': t('characters.moreActionsAria', { name: character.name }),
          'aria-haspopup': 'menu',
          title: t('characters.moreActions'),
          onclick: (event) => {
            event.stopPropagation();
            run(characterMenu(character, event.currentTarget));
          },
        }),
      ]),
    );
  }
}

export function initCharacterView() {
  const input = document.getElementById('import-character');
  input.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const name = file.name.replace(/\.[^.]+$/, '') || `character-${Date.now()}`;
    try {
      const result = await api(`/api/characters/import?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      await loadCharacters();
      toastOk(t('characters.imported', { name: result.name }));
      emit('select-character', { characterId: result.id });
    } catch (error) {
      toastError(t('characters.importFailed', { error: error.message }));
    } finally {
      event.target.value = '';
    }
  });
}
