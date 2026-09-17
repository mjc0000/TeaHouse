/**
 * Group members: which characters talk in a conversation.
 *
 * Two entry points share one picker:
 *
 *   - **create** (the brand menu's 新建群聊): pick two or more characters and a
 *     chat starts with them. The first one ticked is the initiator — the chat's
 *     `characterId`, which greetings, fallbacks and the delete cascade key off.
 *   - **edit** (a chat row's 群聊成员…): change the lineup of an existing chat.
 *     Clearing every box is how a group becomes a solo chat again.
 *
 * There is no "group mode" to switch on: a conversation with two or more members
 * *is* a group, and that fact is what the list badge and the header show.
 */

import { api, json, loadCharacters, loadChat, loadChats, on, state } from '../api.js';
import { connectionItems, connectionLabel } from '../connections.js';
import { createModal } from '../components/modal.js';
import { toastError, toastOk } from '../components/toast.js';
import { el } from '../dom.js';
import { guard } from '../errors.js';
import { t } from '../i18n.js';

/** The picker itself. `chatId === null` means "create a new group chat". */
async function pickMembers(chatId) {
  const chat = chatId === null ? null : state.chats.find((item) => item.id === chatId) ?? state.meta;
  if (chatId !== null && !chat) {
    toastError(t('app.pickChat'));
    return;
  }
  if (state.characters.length === 0) {
    toastError(t('group.noCharacters'));
    return;
  }

  const current = new Set(chat && Array.isArray(chat.members) ? chat.members : []);
  // The primary always has a seat when editing: a group without its owner reads
  // wrong. When creating, the first tick becomes the primary instead.
  if (chatId !== null && current.size === 0 && chat.characterId) current.add(chat.characterId);
  const boxes = new Map();
  const seats = new Map();
  const connections = new Map();
  const talkativeness = new Map();
  const savedConnections = chat?.memberConnections ?? {};

  /**
   * Which endpoint a member answers through. Empty = follow the chat, which is
   * what every member did before extra connections existed.
   */
  const connectionOptions = connectionItems(state.connections);

  /** 羞涩 / 普通 / 健谈 — the same three words SillyTavern's slider shows. */
  function talkLabel(value) {
    if (value < 35) return t('group.talkativeShy');
    return value > 65 ? t('group.talkativeChatty') : t('group.talkativeNormal');
  }

  const list = el('div', { class: 'group-list' });
  for (const character of state.characters) {
    const box = el('input', { type: 'checkbox' });
    box.checked = current.has(character.id);
    boxes.set(character.id, box);
    const seat = el('span', { class: 'muted small' });
    seats.set(character.id, seat);

    // How often this character speaks up in `natural` mode. A preference about
    // the character, not card data, so it is stored on the character itself and
    // shared by every group it is in.
    const range = el('input', {
      type: 'range',
      class: 'group-talk',
      min: '0',
      max: '100',
      step: '5',
      'aria-label': t('group.talkativeLabel'),
      title: t('group.talkativeLabel'),
    });
    range.value = String(Number(character.talkativeness ?? 50));
    const talkValue = el('span', { class: 'muted small group-talk-value' });
    const paintTalk = () => {
      talkValue.textContent = `${range.value} · ${talkLabel(Number(range.value))}`;
    };
    range.addEventListener('input', paintTalk);
    paintTalk();
    talkativeness.set(character.id, { range, original: Number(character.talkativeness ?? 50) });

    const picker = el('select', { class: 'group-conn', 'aria-label': t('group.connectionLabel') });
    picker.append(el('option', { value: '', text: t('group.connectionFollow') }));
    for (const connection of connectionOptions) {
      picker.append(el('option', {
        value: connection.id,
        text: connectionLabel(state.connections, connection.id),
      }));
    }
    picker.value = typeof savedConnections[character.id] === 'string' ? savedConnections[character.id] : '';
    connections.set(character.id, picker);

    list.append(
      el('label', { class: 'group-row' }, [
        box,
        el('span', { class: 'group-name', text: character.name }),
        seat,
        el('span', { class: 'group-talk-box' }, [range, talkValue]),
        picker,
      ]),
    );
  }

  /** The name box only exists when creating; a group gets a sensible default. */
  const nameInput = el('input', {
    type: 'text',
    class: 'group-name-input',
    placeholder: t('group.namePlaceholder'),
  });
  let nameTouched = false;
  nameInput.addEventListener('input', () => {
    nameTouched = true;
  });

  /**
   * How many members may answer one message, whatever the mode: one (default),
   * a fixed few, or as many as the plan names. This is the hard cap the server
   * applies to every group mode.
   */
  const repliesSelect = el('select', { class: 'group-replies', 'aria-label': t('group.repliesLabel') });
  for (const value of [1, 2, 3, 0]) {
    repliesSelect.append(el('option', {
      value: String(value),
      text: value === 0 ? t('group.repliesAll') : t('group.repliesCount', { count: value }),
    }));
  }
  repliesSelect.value = String(chat?.groupReplyLimit ?? 1);

  const note = el('div', { class: 'muted small' });

  function picked() {
    return [...boxes].filter(([, box]) => box.checked).map(([id]) => id);
  }

  /** Only the members that actually chose something are sent. */
  function pickedConnections() {
    const out = {};
    for (const id of picked()) {
      const value = connections.get(id)?.value ?? '';
      if (value !== '') out[id] = value;
    }
    return out;
  }

  /**
   * Talkativeness belongs to the character, not to this chat, so only the
   * sliders that actually moved are written back — a group edit must not rewrite
   * a preference the user set somewhere else.
   */
  async function saveTalkativeness() {
    for (const [id, { range, original }] of talkativeness) {
      const value = Number(range.value);
      if (value === original) continue;
      await api(`/api/characters/${encodeURIComponent(id)}`, json('PATCH', { talkativeness: value }));
    }
  }

  function renderNote() {
    const ids = picked();
    const names = ids
      .map((id) => state.characters.find((character) => character.id === id)?.name ?? id);
    // The seats read as speaking order: first ticked speaks first, and is the
    // initiator of a new group.
    ids.forEach((id, index) => {
      seats.get(id).textContent = index === 0
        ? t('group.initiatorFirst')
        : t('group.seat', { index: index + 1 });
    });
    for (const [id, seat] of seats) if (!ids.includes(id)) seat.textContent = '';
    note.textContent = ids.length >= 2
      ? t('group.noteGroup', { count: ids.length })
      : t('group.noteSolo');
    if (chatId === null && !nameTouched) {
      nameInput.value = names.length === 0 ? '' : t('group.defaultName', { names: names.join(t('commands.join')) });
    }
  }
  list.addEventListener('change', renderNote);
  renderNote();

  const body = [];
  if (chatId === null) {
    body.push(
      el('label', { class: 'group-name-row' }, [
        el('span', { class: 'field-label', text: t('group.nameLabel') }),
        nameInput,
      ]),
    );
  }
  body.push(
    el('label', { class: 'group-name-row' }, [
      el('span', { class: 'field-label', text: t('group.repliesLabel') }),
      repliesSelect,
      el('span', { class: 'muted small', text: t('group.repliesHint') }),
    ]),
  );
  body.push(list, note);
  const modal = createModal({
    className: 'group',
    removeOnClose: true,
    title: chatId === null ? t('group.createTitle') : t('group.title'),
    subtitle: chatId === null
      ? t('group.createSubtitle')
      : t('group.subtitle', { name: chat.name }),
  });
  modal.body.append(...body);
  modal.footer.append(
    el('button', { class: 'ghost', type: 'button', text: t('common.cancel'), onclick: () => modal.close() }),
    el('button', {
      class: 'primary',
      type: 'button',
      text: chatId === null ? t('group.createAction') : t('common.save'),
      onclick: guard(t('group.guardSave'), async () => {
        const members = picked();
        // Talkativeness first: it is a character setting, and a failure here
        // should not leave a half-built group behind.
        await saveTalkativeness();
        await loadCharacters();
        if (chatId === null) {
          if (members.length < 2) throw new Error(t('group.needTwo'));
          const created = await api('/api/chats', json('POST', {
            characterId: members[0],
            members,
            memberConnections: pickedConnections(),
            groupReplyLimit: Number(repliesSelect.value),
            name: nameInput.value.trim() || t('group.defaultName', {
              names: members.map((id) => state.characters.find((character) => character.id === id)?.name ?? id).join(t('commands.join')),
            }),
            worldRefs: state.meta?.worldRefs ?? [],
          }));
          await loadChats();
          await loadChat(created.id);
          modal.close();
          toastOk(t('group.created', { count: members.length }));
          return;
        }
        await api(`/api/chats/${encodeURIComponent(chat.id)}/members`, json('POST', {
          members,
          memberConnections: pickedConnections(),
          groupReplyLimit: Number(repliesSelect.value),
        }));
        await loadChats();
        if (state.chatId === chat.id) await loadChat(chat.id);
        modal.close();
        toastOk(members.length >= 2 ? t('group.opened', { count: members.length }) : t('group.backSolo'));
      }),
    }),
  );
  modal.open();
}

/** Edit the lineup of an existing conversation. */
export async function openGroupMembers(chatId) {
  await pickMembers(chatId);
}

/** Create a conversation that starts out as a group. */
export async function createGroupChat() {
  await pickMembers(null);
}

export function initGroupView() {
  on('open-group-members', ({ chatId }) => {
    openGroupMembers(chatId ?? state.chatId).catch((error) => toastError(error.message));
  });
  on('new-group-chat', () => {
    createGroupChat().catch((error) => toastError(error.message));
  });
}
