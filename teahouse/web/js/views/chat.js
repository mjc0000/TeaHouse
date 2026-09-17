/**
 * Center panel: transcript, streaming generation, and the message action menu.
 *
 * Rendering lives in components/message.js and the non-streaming operations in
 * chat-actions.js; this view owns the transcript layout, the stream and the
 * keyboard shortcuts that act on the focused message.
 */

import {
  api,
  emit,
  json,
  loadChat,
  loadChats,
  on,
  refreshScan,
  state,
} from '../api.js';
import { copyMessage,
  deleteMessage,
  messageCapabilities,
  saveMessage,
  switchVariant,
  truncateFrom,
  visibleContent,
} from '../chat-actions.js';
import { openMenu } from '../components/menu.js';
import { connectionLabel } from '../connections.js';
import { expandDisplayMacros } from '../display-macros.js';
import { effectivePersona, effectivePersonaName } from '../persona.js';
import { applyDisplayRules } from '../regex.js';
import { isSpeaking, speakEntry, stopSpeech } from '../tts.js';
import { failedTranslation, forgetTranslationFailure, freshTranslation, needsTranslation, rememberTranslationFailure, translationAttemptKey } from '../translate.js';
import { confirmDialog } from '../components/confirm.js';
import { clearBodyCache, messageNode } from '../components/message.js';
import { toastError, toastOk } from '../components/toast.js';
import { isCommandLine, runCommand, syncComposerPalette } from '../commands.js';
import { budgetFromPreview } from '../token-budget.js';
import { clear, el, showError } from '../dom.js';
import { noticeText, t } from '../i18n.js';
import { registerKey } from '../keys.js';
import { effectiveGroupMode, groupModeLabel, groupModeLetter } from '../settings-schema.js';

let controller = null;
/** Images waiting on the composer: `{ id, name }` from `POST /api/images`. */
let pendingImages = [];

/** The chat the transcript on screen belongs to, so a re-render can tell a
 *  refresh (keep the reader's place) from a switch (start at the newest). */
let renderedChatId;

/**
 * `requestAnimationFrame` where the DOM has it (a browser); a macrotask
 * otherwise (the boot suite's shim has no frame clock), so the streaming
 * scroll never throws where there is no frame to wait for.
 */
const nextFrame = typeof requestAnimationFrame === 'function'
  ? (callback) => requestAnimationFrame(callback)
  : (callback) => setTimeout(callback, 0);

/**
 * Keeps the transcript pinned to its bottom while a reply streams in.
 *
 * `scrollHeight` is a forced layout, so it is read at most once a frame, never
 * once per delta. A reader who scrolls up keeps their place; a reader sitting
 * at the bottom follows the stream.
 */
function followBottom(container) {
  let scheduled = false;
  let stick = true;
  const onScroll = () => {
    stick = container.scrollHeight - container.scrollTop - container.clientHeight < 24;
  };
  const follow = () => {
    if (scheduled || !stick) return;
    scheduled = true;
    nextFrame(() => {
      scheduled = false;
      if (stick) container.scrollTop = container.scrollHeight;
    });
  };
  const stop = () => container.removeEventListener('scroll', onScroll);
  container.addEventListener('scroll', onScroll, { passive: true });
  return { follow, stop };
}

/**
 * The shown copy of a message: display macros expanded, then display regex.
 *
 * A re-render (after every turn, a translation toggle, a rule edit) used to run
 * every rule over every message again. The result is pure in the expanded text
 * and the rules, so it is cached per entry; the rules array is replaced whenever
 * rules change, so its identity is the version. The macro pass stays outside the
 * cache — it is one regex and it is what keeps the persona in the key.
 */
const shownCache = new Map();

function shownText(entry, source, rules, macroContext) {
  const withMacros = expandDisplayMacros(source, macroContext);
  const hit = shownCache.get(entry.id);
  if (hit && hit.source === withMacros && hit.rules === rules) return hit.shown;
  const shown = applyDisplayRules(withMacros, rules).text;
  shownCache.set(entry.id, { source: withMacros, rules, shown });
  return shown;
}

function renderPendingImages() {
  const strip = document.getElementById('pending-images');
  clear(strip);
  if (pendingImages.length === 0) {
    strip.classList.add('hidden');
    return;
  }
  strip.classList.remove('hidden');
  for (const image of pendingImages) {
    const thumb = el('span', { class: 'pending-image' }, [
      el('img', { src: `/api/images/${encodeURIComponent(image.id)}`, alt: image.name }),
      el('button', {
        class: 'ghost tiny',
        text: '×',
        title: t('chatView.removeImage', { name: image.name }),
        onclick: () => {
          pendingImages = pendingImages.filter((candidate) => candidate.id !== image.id);
          renderPendingImages();
        },
      }),
    ]);
    strip.append(thumb);
  }
}

async function attachImages(files) {
  for (const file of files) {
    let ref;
    try {
      const response = await fetch(`/api/images?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      ref = body;
    } catch (error) {
      toastError(t('chatView.uploadFailed', { error: error.message }));
      continue;
    }
    if (pendingImages.length >= 10) {
      toastError(t('chatView.tooManyImages'));
      break;
    }
    pendingImages.push({ id: ref.id, name: ref.name });
  }
  renderPendingImages();
}

function userName() {
  return effectivePersona(state.personas, state.meta?.personaId, {
    name: state.config?.personaName || 'You',
    description: state.config?.personaDescription || '',
  }).name;
}

/** Who "you" are for display macros, resolved the same way as the name. */
function userPersona() {
  return effectivePersona(state.personas, state.meta?.personaId, {
    name: state.config?.personaName || 'You',
    description: state.config?.personaDescription || '',
  });
}

/**
 * Who speaks a line, from lookups the caller already made: the persona name,
 * the primary character and a `Map` of every character. Doing the `find` here
 * made a render O(messages × characters) for no reason — the answer does not
 * change between messages.
 */
function speakerName(role, entry, lookup) {
  if (role === 'user') return lookup.userName;
  if (role === 'assistant') {
    // A group turn remembers its speaker; solo chats fall back to the primary.
    if (entry && typeof entry.speaker === 'string' && entry.speaker !== '') {
      const member = lookup.characters.get(entry.speaker);
      if (member) return member.name;
    }
    return lookup.character?.name ?? 'AI';
  }
  return 'system';
}

/** Members of this conversation, in speaking order; empty means solo. */
function groupMembers() {
  const ids = Array.isArray(state.meta?.members) ? state.meta.members : [];
  return ids
    .map((id) => state.characters.find((item) => item.id === id))
    .filter((item) => item !== undefined);
}

/**
 * The lineup as shown in the header: a member with its own connection says so,
 * because "who answers through which model" is the point of that setting.
 */
function lineupLabel(members) {
  return members
    .map((member) => {
      const label = connectionLabel(state.connections, state.meta?.memberConnections?.[member.id]);
      return label === '' ? member.name : `${member.name}（${label}）`;
    })
    .join(t('commands.join'));
}

/**
 * Leading `@Name` pins the turn to that member (`@` alone, or an unknown
 * name, is left for the model to read as ordinary text).
 */
export function parseMention(text) {
  const members = groupMembers();
  if (members.length < 2 || !text.startsWith('@')) return { speaker: null, text };
  const rest = text.slice(1);
  const ordered = [...members].sort((a, b) => b.name.length - a.name.length);
  for (const member of ordered) {
    if (rest.startsWith(member.name)) {
      const after = rest.slice(member.name.length);
      if (after === '' || /^\s/.test(after)) {
        return { speaker: member.id, text: after.trim() === '' ? text : after.trimStart() };
      }
    }
  }
  return { speaker: null, text };
}

function focusedEntry() {
  const node = document.activeElement?.closest?.('.message');
  const id = node?.dataset?.id;
  return id ? state.entries.find((entry) => entry.id === id) : null;
}

async function handleAction(action, entry, payload) {
  const index = state.entries.findIndex((item) => item.id === entry.id);
  const capabilities = messageCapabilities(entry, {
    streaming: state.streaming,
    isLast: index !== -1 && index === state.entries.length - 1,
  });
  switch (action) {
    case 'copy':
      await copyMessage(entry);
      break;
    case 'continue':
      if (!capabilities.canContinue) return;
      await generate({ mode: 'continue' });
      break;
    case 'edit':
      if (!capabilities.canEdit) return;
      state.ui.editingId = entry.id;
      render();
      break;
    case 'variant':
      await switchVariant(entry, payload.index);
      break;
    case 'retry': {
      if (!capabilities.canRetry) return;
      if (entry.id !== state.entries[state.entries.length - 1]?.id) {
        const ok = await confirmDialog({
          title: t('chatView.retryTitle'),
          message: t('chatView.retryMessage'),
          detail: t('chatView.retryDetail'),
          confirmLabel: t('chatView.retryConfirm'),
        });
        if (!ok) return;
      }
      await generate({ retryEntryId: entry.id });
      break;
    }
    case 'translate': {
      if (!capabilities.canTranslate) return;
      try {
        // Asked for by hand: a remembered failure must not block it.
        forgetTranslationFailure(entry, state.config?.outputLanguage ?? '');
        await api(
          `/api/chats/${encodeURIComponent(state.chatId)}/entries/${encodeURIComponent(entry.id)}/translate`,
          json('POST', {}),
        );
        state.ui.showOriginal.delete(entry.id);
        await loadChat(state.chatId);
        toastOk(t('chatView.translated'));
      } catch (error) {
        toastError(t('chatView.translateFailed', { error: error.message }));
      }
      break;
    }
    case 'speak': {
      if (!capabilities.canSpeak) return;
      try {
        await speakEntry(entry, visibleContent(entry));
      } catch (error) {
        toastError(error.message);
      }
      break;
    }
    case 'remove': {
      const ok = await confirmDialog({
        title: t('chatView.removeTitle'),
        message: t('chatView.removeMessage'),
        confirmLabel: t('common.delete'),
        danger: true,
      });
      if (ok) await deleteMessage(entry);
      break;
    }
    case 'fork': {
      // Branching by copy, the way SillyTavern does it: the original stays
      // exactly as it is and the fork is an ordinary chat from here on.
      const index = state.entries.findIndex((item) => item.id === entry.id);
      const kept = index === -1 ? state.entries.length : index + 1;
      const fork = await api(
        `/api/chats/${encodeURIComponent(state.chatId)}/fork`,
        json('POST', { entryId: entry.id }),
      );
      await loadChats();
      await loadChat(fork.id);
      toastOk(t('chatView.forked', { name: fork.name, count: kept }));
      break;
    }
    case 'truncate': {
      const index = state.entries.findIndex((item) => item.id === entry.id);
      const count = index === -1 ? 0 : state.entries.length - index;
      const ok = await confirmDialog({
        title: t('chatView.truncateTitle'),
        message: t('chatView.truncateMessage', { count }),
        detail: t('chatView.truncateDetail'),
        confirmLabel: t('chatView.truncateConfirm', { count }),
        danger: true,
      });
      if (ok) await truncateFrom(entry);
      break;
    }
    default:
      break;
  }
}

function render() {
  const container = document.getElementById('messages');
  // Where the reader is belongs to the reader: a re-render of the same chat
  // keeps their place — following the bottom only for someone already there —
  // while opening another chat starts at the newest message. Both metrics are
  // read before the rebuild, because `clear` throws the old ones away.
  const previousTop = container.scrollTop;
  const wasAtBottom = container.scrollHeight - previousTop - container.clientHeight < 24;
  const freshChat = state.chatId !== renderedChatId;
  renderedChatId = state.chatId;
  // Switching chats retires every entry id in the old cache: drop both so a
  // long session does not keep the parse and shown-text of every chat it saw.
  if (freshChat) {
    clearBodyCache();
    shownCache.clear();
  }
  clear(container);

  if (state.entries.length === 0) {
    container.append(
      el('div', { class: 'empty-state' }, [
        el('div', { class: 'empty-mark', text: '✎' }),
        el('div', { class: 'empty-title', text: state.meta ? t('chatView.emptyTitle') : t('chatView.emptyTitleNoCard') }),
        el('div', {
          class: 'empty-hint',
          text: state.meta ? t('chatView.emptyHint') : t('chatView.emptyHintNoCard'),
        }),
      ]),
    );
    renderHeader();
    return;
  }

  const needFetch = [];
  const character = state.characters.find((item) => item.id === state.meta?.characterId);
  const characters = new Map(state.characters.map((item) => [item.id, item]));
  const who = userPersona();
  const macroContext = {
    char: character?.name ?? 'AI',
    user: who.name,
    persona: who.description,
    variables: state.meta?.variables ?? {},
  };
  for (let i = 0; i < state.entries.length; i++) {
    const entry = state.entries[i];
    // What is stored never changes here: translation and display regex rewrite
    // only the shown copy, and the editor/copy paths below keep reading the raw
    // entry. Translation is decided from the stored text (so it matches the
    // server's cache); display regex runs after it, on what is shown.
    const raw = visibleContent(entry);
    const variant = entry.variants && entry.variants.length > 0
      ? Math.max(0, Math.min(entry.variants.length - 1, entry.activeVariant ?? 0))
      : 0;
    const target = state.config?.autoTranslate !== false ? (state.config?.outputLanguage ?? '').trim() : '';
    let shownRaw = raw;
    let translation = null;
    if (target !== '' && entry.role !== 'system') {
      const fresh = freshTranslation(entry, raw, variant, target);
      if (fresh !== null) {
        translation = state.ui.showOriginal.has(entry.id) ? 'original' : 'translated';
        if (translation === 'translated') shownRaw = fresh;
      } else if (
        needsTranslation(raw, target) &&
        !translating.has(entry.id) &&
        // Already failed this session: asking again would re-fire on every
        // render and reload the transcript that re-fires it.
        !failedTranslation(translationAttemptKey(entry, raw, variant, target))
      ) {
        needFetch.push(entry);
      }
    }
    // The model echoes prompt macros (`{{user}}` in its reply is the classic
    // case): expand the pure ones for reading, after the translation choice
    // and before display regex. Storage, editing and copying keep the raw text.
    const shown = shownText(entry, shownRaw, state.regexes?.rules, macroContext);
    container.append(
      messageNode(entry, {
        content: shown,
        translation,
        speaking: isSpeaking(entry.id),
        onToggleTranslation: (toggled) => {
          if (state.ui.showOriginal.has(toggled.id)) state.ui.showOriginal.delete(toggled.id);
          else state.ui.showOriginal.add(toggled.id);
          render();
        },
        speaker: speakerName(entry.role, entry, { userName: who.name, character, characters }),
        isEditing: state.ui.editingId === entry.id,
        // Old messages keep whatever was stored; the switch decides whether it is
        // shown, so turning it off also hides thinking from earlier turns.
        showReasoning: state.config?.showReasoning !== false,
        markdown: state.config?.markdown !== false,
        ...messageCapabilities(entry, { streaming: state.streaming, isLast: i === state.entries.length - 1 }),
        onAction: (action, target, payload) => {
          handleAction(action, target, payload).catch((error) => toastError(error.message));
        },
        onSave: async (target, text) => {
          // Close the editor *before* saving: the reload inside `saveMessage`
          // renders the saved text without the editor in one pass. Rendering
          // after the await could land mid-stream and clear a pending bubble.
          state.ui.editingId = null;
          const saved = await saveMessage(target, text);
          if (!saved) {
            // The save failed and nothing reloaded: put the editor back.
            state.ui.editingId = target.id;
            render();
          }
        },
        onCancelEdit: () => {
          state.ui.editingId = null;
          render();
        },
      }),
    );
  }

  renderHeader();
  container.scrollTop = freshChat || wasAtBottom ? container.scrollHeight : previousTop;
  // Missing translations are fetched after the paint, never inside it — and
  // never mid-stream, where a reload would trample the pending bubble.
  if (needFetch.length > 0 && !state.streaming) void translateMissing(needFetch, state.chatId);
}

/** One extra model call per untranslated message, then one reload for all. */
async function translateMissing(entries, chatId) {
  const target = (state.config?.outputLanguage ?? '').trim();
  /** entry id → the failure key to remember if the batch reports that id. */
  const attempts = new Map();
  const wanted = [];
  for (const entry of entries) {
    const raw = visibleContent(entry);
    const variant = entry.variants && entry.variants.length > 0
      ? Math.max(0, Math.min(entry.variants.length - 1, entry.activeVariant ?? 0))
      : 0;
    const attempt = translationAttemptKey(entry, raw, variant, target);
    // A failure already seen this session is not asked for again: without this a
    // dead endpoint gets hammered on every render, and each completion reloads
    // the transcript that re-fires it.
    if (failedTranslation(attempt)) continue;
    translating.add(entry.id);
    wanted.push(entry.id);
    attempts.set(entry.id, attempt);
  }
  // Nothing left to ask for: the originals are already on screen, and a reload
  // here would only come back to the same answer.
  if (wanted.length === 0) return;
  try {
    // One request for the whole list: the server translates with a few calls in
    // flight and writes the chat once, instead of one request and one file
    // write per message.
    const result = await api(
      `/api/chats/${encodeURIComponent(chatId)}/translate`,
      json('POST', { entryIds: wanted }),
    );
    for (const failure of result?.failed ?? []) {
      const attempt = attempts.get(failure.entryId);
      if (attempt) rememberTranslationFailure(attempt);
    }
  } catch {
    // The request itself failed (offline, bad key): the originals stay, and
    // every entry this batch covered is remembered so the reload does not
    // immediately re-ask. The menu's manual retry clears the memory.
    for (const attempt of attempts.values()) rememberTranslationFailure(attempt);
  } finally {
    for (const id of wanted) translating.delete(id);
  }
  if (state.chatId === chatId && !state.streaming) {
    await loadChat(chatId);
  }
}

/** In-flight translations, so a re-render does not stack duplicate calls. */
const translating = new Set();

function renderHeader() {
  const members = groupMembers();
  document.getElementById('chat-title').textContent = state.meta
    ? members.length >= 2
      ? t('chatView.headerGroup', { name: state.meta.name, members: lineupLabel(members) })
      : t('chatView.headerSolo', { name: state.meta.name, character: state.meta.characterId })
    : t('chat.none');

  const holder = document.getElementById('chat-stats');
  clear(holder);
  if (!state.meta) return;

  const budget = budgetFromPreview(state.config ?? {}, state.preview ?? {});
  holder.append(
    el('span', { class: 'muted small', text: t('chatView.entriesCount', { count: state.entries.length }) }),
    el('span', { class: 'muted small', text: '·' }),
    el('span', { class: `small token-inline ${budget.level}`, text: `${budget.usedPrefix}${budget.usedLabel} / ${budget.totalLabel} tok` }),
  );

  // Which mode decides who answers: the header is where a reader looks to know
  // why this turn went to the member it did. Changed in the right panel.
  if (members.length >= 2) {
    const mode = effectiveGroupMode(state.meta.groupMode);
    holder.append(
      el('span', { class: 'muted small', text: '·' }),
      el('span', {
        class: 'pill group-mode-badge',
        text: `${groupModeLetter(mode)} · ${groupModeLabel(mode)}`,
        title: t('chatView.groupModeHint', { mode: groupModeLabel(mode) }),
      }),
    );
  }

  // What this conversation remembers, where a reader would look for it. The chat
  // view owns the header, so the badge lives here and asks for the editor by
  // event rather than reaching into another view.
  const memory = state.meta.memory;
  if (memory && String(memory.text ?? '').trim() !== '') {
    const due = state.preview?.memoryState?.due === true;
    holder.append(
      el('span', { class: 'muted small', text: '·' }),
      el('button', {
        class: `ghost tiny memory-badge${due ? ' due' : ''}`,
        text: due ? t('chatView.memoryDue') : t('chatView.memory'),
        title: t('chatView.memoryTitle', {
          state: memory.frozen
            ? t('chatView.memoryFrozen')
            : due
              ? t('chatView.memoryReady')
              : t('chatView.memoryFresh'),
        }),
        onclick: () => emit('open-memory-editor', {}),
      }),
    );
  }

  // Who "you" are in this conversation. A pin stays on this chat; clearing it
  // follows the library default again — the same split the model picker uses.
  if ((state.personas?.items ?? []).length > 0) {
    const pinned = typeof state.meta.personaId === 'string' && state.meta.personaId !== ''
      ? state.personas.items.find((item) => item.id === state.meta.personaId)
      : null;
    holder.append(
      el('span', { class: 'muted small', text: '·' }),
      el('button', {
        class: 'ghost tiny',
        text: t('chatView.personaLabel', { name: pinned?.name ?? userName() }),
        title: pinned
          ? t('chatView.personaPinnedTitle', { name: pinned.name })
          : t('chatView.personaFollowTitle'),
        onclick: (event) => openPersonaMenu(event.currentTarget),
      }),
    );
  }
}

/**
 * Per-chat persona switch. Writes the pin, never the library: changing who
 * "you" are here must not move any other conversation.
 */
async function setChatPersona(personaId) {
  if (!state.chatId) return;
  try {
    const updated = await api(
      `/api/chats/${encodeURIComponent(state.chatId)}`,
      json('PUT', { personaId }),
    );
    // A stale server (not restarted after the endpoint learned `personaId`)
    // would answer 200 without changing anything; fail loudly instead.
    const want = personaId ?? null;
    const got = typeof updated?.personaId === 'string' ? updated.personaId : null;
    if ((want ?? null) !== (got ?? null)) {
      throw new Error(t('app.staleServer'));
    }
    state.meta = updated;
    await loadChat(state.chatId);
    toastOk(personaId
      ? t('chatView.personaSet', { name: effectivePersonaName(state.personas, personaId, '') })
      : t('chatView.personaFollowToast'));
  } catch (error) {
    toastError(t('chatView.personaFailed', { error: error.message }));
  }
}

function openPersonaMenu(anchor) {
  const items = (state.personas?.items ?? []).map((item) => ({
    label: item.name,
    hint: item.id === state.meta?.personaId
      ? t('app.modelCurrentHint')
      : item.id === state.personas?.activeId
        ? t('app.modelDefaultHint')
        : '',
    onSelect: () => setChatPersona(item.id),
  }));
  items.push({
    label: t('chatView.personaFollow'),
    hint: state.meta?.personaId ? '' : t('chatView.personaCurrent'),
    separatorBefore: true,
    onSelect: () => setChatPersona(null),
  });
  openMenu({ anchor, items });
}

function setStatus(text) {
  document.getElementById('stream-status').textContent = text;
}

function setStreaming(active) {
  state.streaming = active;
  document.getElementById('btn-send').disabled = active;
  document.getElementById('btn-regen').disabled = active;
  // The attach control is a label, not a button: it takes a class instead.
  document.getElementById('btn-attach').classList.toggle('disabled', active);
  document.getElementById('btn-continue').disabled = active;
  document.getElementById('btn-impersonate').disabled = active;
  document.getElementById('btn-stop').disabled = !active;
  for (const node of document.querySelectorAll('.message-actions button')) node.disabled = active;
}

/** Reads an SSE body and dispatches each frame. */
async function consumeStream(response, handlers) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Frames are cut with a cursor that only moves forward. Re-slicing the tail
  // per frame (`buffer = buffer.slice(index + 2)`) copied the whole remainder
  // once per frame, which is quadratic when a provider delivers the answer in
  // one burst; the leftover is trimmed once per read instead.
  let cursor = 0;
  const drain = () => {
    let index;
    while ((index = buffer.indexOf('\n\n', cursor)) !== -1) {
      const frame = buffer.slice(cursor, index);
      cursor = index + 2;
      const line = frame.split('\n').find((part) => part.startsWith('data: '));
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      handlers[event.type]?.(event);
    }
    if (cursor > 0) {
      buffer = buffer.slice(cursor);
      cursor = 0;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain();
  }
}

async function generate(options = {}) {
  if (!state.chatId || state.streaming) return;
  // A new turn takes the floor: anything still reading stops first.
  stopSpeech();
  const input = document.getElementById('input');
  const message = options.message ?? '';
  const mode = options.mode === 'continue' || options.mode === 'impersonate' ? options.mode : null;

  /**
   * A group round is the server's plan, delivered on the `prompt` frame: this
   * turn speaks for the first name, and each remaining name is chained as an
   * ordinary turn pinned to it, so a round is what the server decided rather
   * than a fresh decision per reply. A chained turn carries the plan along
   * (`options.plan`), because its own frame describes a plan of one. Retries,
   * regenerates, `@Name` pins and the continue/impersonate modes are never
   * chained: those asked for one specific thing.
   */
  const lineup = groupMembers();
  const groupRound = Number(options.groupRound ?? 0);
  const carriedPlan = Array.isArray(options.plan) ? options.plan : null;
  let plan = carriedPlan ?? [];

  setStreaming(true);
  setStatus(mode === 'impersonate' ? t('chatView.statusImpersonate') : t('chatView.statusWaiting'));

  const container = document.getElementById('messages');
  let pending = null;
  /** The pending bubble's live thinking block, filled by the `reasoning` frames. */
  let thinking = null;
  /** The two live text nodes the stream appends to, one per block. */
  let answerText = null;
  let reasoningText = null;
  // A continuation grows the existing reply on screen, so the bubble starts from
  // what is already there instead of a blank box; deltas extend it.
  const prefix = mode === 'continue' && !options.retryEntryId
    ? visibleContent(state.entries[state.entries.length - 1]) ?? ''
    : '';
  if (!options.retryEntryId) {
    const bubbleRole = mode === 'impersonate' ? 'user' : 'assistant';
    // Appending into one text node per block keeps a delta O(1): writing
    // `prefix + text` back into the element rebuilt the whole answer on every
    // token, which is quadratic over a long reply.
    reasoningText = document.createTextNode('');
    const thinkingBody = el('span', { class: 'thinking-text' }, [reasoningText]);
    thinking = el('div', { class: 'thinking hidden' }, [
      el('span', { class: 'thinking-label', text: t('chatView.thinking') }),
      thinkingBody,
    ]);
    answerText = document.createTextNode(prefix);
    pending = el('div', { class: `message ${bubbleRole} pending` }, [
      el('span', { class: 'role', text: bubbleRole }),
      // Hidden until the model actually thinks, so a non-reasoning model shows
      // no empty box. The answer's text node comes last, so it reads in order.
      thinking,
      el('div', { class: 'message-text' }, [answerText]),
    ]);
    container.append(pending);
    container.scrollTop = container.scrollHeight;
  }
  const follower = followBottom(container);

  controller = new AbortController();
  // A stream that goes quiet is stuck, not thinking: without this the page
  // sits on "等待响应…" with its buttons disabled until it is reloaded.
  // Any frame restarts the clock, so a slow-but-talking model never trips it.
  let stallTimer = null;
  const disarmStall = () => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };
  const armStall = () => {
    disarmStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      try {
        controller?.abort();
      } finally {
        toastError(t('chatView.stall'));
      }
    }, 90_000);
  };
  try {
    armStall();
    const response = await fetch('/api/generate', {
      ...json('POST', {
        chatId: state.chatId,
        message,
        imageIds: pendingImages.length > 0 ? pendingImages.map((image) => ({ id: image.id, name: image.name })) : undefined,
        speaker: typeof options.speaker === 'string' && options.speaker !== '' ? options.speaker : undefined,
        regenerate: options.regenerate ?? false,
        retryEntryId: options.retryEntryId,
        mode,
        stack: state.stack,
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(detail || `HTTP ${response.status}`);
    }

    let failed = null;
    let rewound = false;
    /** Set by the `done` frame; acted on once the turn has fully settled. */
    let memoryDue = null;
    await consumeStream(response, {
      truncated: () => {
        rewound = true;
      },
      prompt: (event) => {
        armStall();
        // The plan only exists on the first turn of a round; a chained turn was
        // handed the same list by the caller.
        if (carriedPlan === null) plan = Array.isArray(event.groupPlan) ? event.groupPlan : [];
        state.preview = {
          ...(state.preview ?? {}),
          itemization: event.itemization,
          totalTokens: event.totalTokens,
          model: event.model,
          pressureTokens: event.pressureTokens,
          projectedTokens: event.projectedTokens,
          anchorAt: event.anchorAt,
          worldTokens: event.worldTokens,
          budget: event.budget,
          mode: event.mode,
          warnings: event.warnings,
          images: event.images,
          imageTokens: event.imageTokens,
        };
        emit('preview', state.preview);
      },
      reasoning: (event) => {
        armStall();
        // Shown as it arrives: without this the thinking phase looks like a hang,
        // which is exactly what a reasoning model feels like from the outside.
        if (!thinking || !reasoningText) return;
        if (thinking.classList.contains('hidden')) {
          thinking.classList.remove('hidden');
          setStatus(t('chatView.statusThinking'));
        }
        reasoningText.appendData(event.text);
        follower.follow();
      },
      delta: (event) => {
        armStall();
        if (answerText) answerText.appendData(event.text);
        // The answer has started: keep the thinking on screen, but stop
        // pretending it is still running.
        if (thinking && !thinking.classList.contains('hidden') && !thinking.classList.contains('settled')) {
          thinking.classList.add('settled');
          thinking.querySelector('.thinking-label').textContent = t('chatView.thinkingSettled');
          setStatus(t('chatView.statusAnswering'));
        }
        follower.follow();
      },
      error: (event) => {
        disarmStall();
        failed = event.message;
      },
      warning: (event) => {
        // A non-fatal correction from the server (today: the context window was
        // too big and has been fixed). Shown as a toast, and the local config is
        // patched so the budget bar reads the new number immediately. The turn is
        // still running, so a `failed` left by the attempt that overflowed is
        // cleared — otherwise the recovered reply would be thrown away.
        const noticeMessage = event.code
          ? noticeText({ code: event.code, params: event.params, text: event.message })
          : event.message;
        const noticeDetail = event.detailCode
          ? noticeText({ code: event.detailCode, params: event.detailParams, text: event.detail })
          : event.detail;
        toastOk(noticeMessage, noticeDetail ? { detail: noticeDetail } : undefined);
        failed = null;
        if (typeof event.maxContext === 'number' && state.config) {
          state.config = { ...state.config, maxContext: event.maxContext };
        }
      },
      calibration: (event) => {
        armStall();
        setStatus(t('chatView.calibration', {
          count: event.stats.calibrations,
          percent: (event.divergence * 100 - 100).toFixed(1),
        }));
      },
      done: (event) => {
        disarmStall();
        setStatus('');
        // Held until the turn has settled: the summary is a second model call and
        // must never run while this one is still unwinding.
        memoryDue = event.memory ?? null;
      },
    });

    if (failed !== null) {
      if (pending) pending.remove();
      container.append(el('div', { class: 'error', text: t('chatView.failed', { error: failed }) }));
      return;
    }

    if (input.value.trim() !== '' && message !== '') {
      input.value = '';
      syncComposerPalette();
    }
    // Whatever rode this turn is now on the transcript; the strip starts empty.
    if (message !== '' && pendingImages.length > 0) {
      pendingImages = [];
      renderPendingImages();
    }
    // Stop looking busy *before* re-rendering. The action menus are built from
    // `state.streaming` at render time, so a transcript rendered while it was
    // still true would come back with 「删除这一条」 and 「从这里重开」 disabled
    // for good — right up until something else happened to re-render it.
    setStreaming(false);
    await loadChat(state.chatId);
    await loadChats();
    if (rewound) await refreshScan();
    // Only now: the reply is stored, the transcript is reloaded and nothing is
    // streaming, so the memory view can spend a second model call on it. While
    // more members are still due in this round the summary waits, or it would
    // summarize a half-finished exchange.
    const moreReplies = mode === null
      && !options.retryEntryId
      && options.regenerate !== true
      && (options.speaker ?? '') === ''
      && lineup.length >= 2
      && plan.length > groupRound + 1;
    if (memoryDue && !moreReplies) emit('memory-due', memoryDue);
    // Optional: after 替我说, let the character answer right away. Scheduled
    // rather than awaited so this turn fully unwinds first, and it is a plain
    // turn (no mode), so it cannot loop.
    if (mode === 'impersonate' && state.config?.impersonateAutoReply === true) {
      setTimeout(() => { generate().catch((error) => toastError(error.message)); }, 0);
    }
    // A group round continues until the plan is spent; each reply is an ordinary
    // turn pinned to its member, so memory, the trace and the budget all see it.
    if (moreReplies) {
      const next = plan[groupRound + 1];
      setTimeout(() => {
        generate({ groupRound: groupRound + 1, speaker: next, plan }).catch((error) => toastError(error.message));
      }, 0);
    }
  } catch (error) {
    disarmStall();
    if (pending) pending.remove();
    if (error.name === 'AbortError') setStatus(t('chatView.statusStopped'));
    else showError(container, error);
  } finally {
    disarmStall();
    follower.stop();
    setStreaming(false);
    controller = null;
  }
}

/**
 * Sends what is in the composer, unless it is a slash command — the command
 * layer consumes its own lines and would otherwise post them as messages.
 *
 * Ordinary text reaches `generate` in the same tick as the click, so the
 * composer locks immediately instead of after a promise hop.
 */
function submit() {
  const value = document.getElementById('input').value.trim();
  if (value === '') return;
  if (isCommandLine(value)) {
    runCommand(value).catch((error) => toastError(t('chatView.commandFailed', { error: error.message })));
    return;
  }
  // A leading `@Name` pins this turn to that member; anything else (a lone
  // `@`, an unknown name) travels as ordinary text.
  const mentioned = parseMention(value);
  generate({ message: mentioned.text, speaker: mentioned.speaker });
}

function regenerateLast() {
  const last = state.entries[state.entries.length - 1];
  if (!last) return;
  generate(last.role === 'assistant' ? { retryEntryId: last.id } : { regenerate: true });
}

function insertInComposer(text) {
  const field = document.getElementById('input');
  const start = typeof field.selectionStart === 'number' ? field.selectionStart : field.value.length;
  const end = typeof field.selectionEnd === 'number' ? field.selectionEnd : start;
  field.value = field.value.slice(0, start) + text + field.value.slice(end);
  const caret = start + String(text).length;
  field.focus();
  field.setSelectionRange?.(caret, caret);
  // Writing `.value` fires no `input` event, so the slash-command palette has to
  // be told; otherwise a list opened with `/` stays on screen over a line that is
  // no longer a command.
  syncComposerPalette();
}

export function initChatView() {
  document.getElementById('btn-send').addEventListener('click', () => {
    submit();
  });

  document.getElementById('btn-regen').addEventListener('click', () => {
    regenerateLast();
  });

  document.getElementById('attach-input').addEventListener('change', (event) => {
    const input = event.currentTarget;
    if (input.files && input.files.length > 0) void attachImages([...input.files]);
    input.value = '';
  });

  // Pasting a screenshot straight into the box attaches it, the same as the
  // paperclip: `clipboardData.files` carries the image, text pastes go through
  // untouched.
  document.getElementById('input').addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
      typeof file.type === 'string' && file.type.startsWith('image/'),
    );
    if (files.length === 0) return;
    event.preventDefault();
    void attachImages(files);
  });

  document.getElementById('btn-continue').addEventListener('click', () => {
    generate({ mode: 'continue' }).catch((error) => toastError(error.message));
  });

  document.getElementById('btn-impersonate').addEventListener('click', () => {
    generate({ mode: 'impersonate' }).catch((error) => toastError(error.message));
  });

  document.getElementById('btn-stop').addEventListener('click', () => controller?.abort());

  // Ctrl+Enter sends, as the placeholder promises. `components/message.js` stops
  // propagation on its own Ctrl+Enter, so the inline editor keeps writing.
  registerKey({
    key: 'enter',
    ctrl: true,
    inInput: true,
    description: t('chatView.keySend'),
    handler: () => submit(),
  });

  // Message shortcuts act on the focused message, so the transcript is usable
  // without a mouse.
  registerKey({
    key: 'c',
    ctrl: true,
    shift: true,
    inInput: true,
    description: t('chatView.keyCopy'),
    handler: () => {
      const entry = focusedEntry();
      if (entry) copyMessage(entry).catch((error) => toastError(error.message));
    },
  });
  registerKey({
    key: 'e',
    ctrl: true,
    inInput: true,
    description: t('chatView.keyEdit'),
    handler: () => {
      const entry = focusedEntry();
      if (entry) handleAction('edit', entry).catch((error) => toastError(error.message));
    },
  });
  registerKey({
    key: 'r',
    ctrl: true,
    shift: true,
    inInput: true,
    description: t('chatView.keyRetry'),
    handler: () => {
      const entry = focusedEntry();
      if (entry) handleAction('retry', entry).catch((error) => toastError(error.message));
    },
  });

  on('chat', () => {
    render();
    document.getElementById('btn-send').disabled = false;
    document.getElementById('btn-continue').disabled = false;
    document.getElementById('btn-impersonate').disabled = false;
  });
  on('preview', renderHeader);
  on('personas', renderHeader);
  // Display regex and Markdown only change the reading view, so a config save
  // or a rule edit re-renders the transcript — but only when the switch that
  // affects it actually moved, not on every unrelated setting.
  let lastMarkdown = state.config?.markdown;
  on('config', (config) => {
    renderHeader();
    if ((config?.markdown ?? true) !== (lastMarkdown ?? true)) {
      lastMarkdown = config?.markdown;
      render();
    }
  });
  on('regexes', () => {
    if (state.entries.length > 0) render();
  });

  // Anything that produces composer text goes through these two events, so the
  // quick-reply bar and the slash commands share one path into the composer.
  on('insert-composer', ({ text }) => insertInComposer(text));
  on('send-message', ({ text }) => {
    if (String(text).trim() === '') return;
    const mentioned = parseMention(String(text).trim());
    generate({ message: mentioned.text, speaker: mentioned.speaker ?? undefined });
  });
  on('regenerate-reply', () => regenerateLast());
  on('continue-reply', () => generate({ mode: 'continue' }).catch((error) => toastError(error.message)));
  on('impersonate', () => generate({ mode: 'impersonate' }).catch((error) => toastError(error.message)));
  // `/persona` pins the conversation without generating anything.
  on('set-chat-persona', ({ personaId }) => {
    void setChatPersona(personaId ?? null);
  });
}

/** Exposed for the prompt panel's "已裁剪" link. */
export function scrollTranscriptToTop() {
  document.getElementById('messages').scrollTop = 0;
}
