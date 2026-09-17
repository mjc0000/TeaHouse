/**
 * Slash commands for the composer.
 *
 * The command line is the only thing this module owns: it watches the composer,
 * offers a palette while the line is a bare `/word`, and runs the command when
 * the composer is submitted — `views/chat.js` delegates to `runCommand` instead
 * of sending, so the two features do not have to know about each other.
 *
 * Two rules keep this from growing into a scripting engine:
 *
 *   1. A command either calls an API the interface can already reach, or asks
 *      for a chat-side action with `emit`. Nothing here touches a view.
 *   2. The registry lists only what works today.
 *
 * User-facing text is declared as translation keys (`hintKey`, `argsKey`) and
 * resolved when the palette or the help sheet renders, so a language switch is
 * picked up without rebuilding the registry.
 */

import { api, emit, json, loadChat, loadChats, loadConfig, refreshPreview, state } from './api.js';
import { downloadText } from './clipboard.js';
import { createModal } from './components/modal.js';
import { toastError, toastOk } from './components/toast.js';
import { clear, el } from './dom.js';
import { t } from './i18n.js';

/**
 * Words a boolean argument accepts, in both languages. These are *input*, not
 * interface text: they stay regardless of the selected language.
 */
const TRUTHY = new Set(['on', 'true', '1', '开', '是', '启用']);
const FALSY = new Set(['off', 'false', '0', '关', '否', '禁用']);

/** A line that is nothing but a command token: `/`, `/mod`, `/re-gen`. */
const COMMAND_LINE = /^\/([a-z0-9-]*)$/i;

/** `/name rest…` — the arguments stay raw, so a command may accept slashes. */
const COMMAND_CALL = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/;

function requireArg(args, usage) {
  const text = args.trim();
  if (text === '') throw new Error(t('commands.usage', { usage }));
  return text;
}

function requireChat() {
  if (!state.chatId) throw new Error(t('app.pickChat'));
  return state.chatId;
}

function booleanArg(word) {
  const value = word.toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  throw new Error(t('commands.booleanValue', { word }));
}

/** The argument list as shown in the palette, with `{}` filled by the locale. */
function commandArgs(command) {
  return command.argsKey ? t(command.argsKey) : '';
}

/** The full usage line for a command, e.g. `/send <text>`. */
function commandUsage(command) {
  const args = commandArgs(command);
  return `/${command.name}${args ? ` ${args}` : ''}`;
}

/**
 * The registry. `run` receives `{ args, usage }` and may be async; a throw is
 * reported as a failed command and the composer keeps the text.
 */
export const COMMANDS = [
  {
    name: 'help',
    hintKey: 'commands.hintHelp',
    run: () => openHelp(),
  },
  {
    name: 'send',
    argsKey: 'commands.argsText',
    hintKey: 'commands.hintSend',
    run: ({ args, usage }) => emit('send-message', { text: requireArg(args, usage) }),
  },
  {
    name: 'sys',
    argsKey: 'commands.argsText',
    hintKey: 'commands.hintSys',
    async run({ args, usage }) {
      const content = requireArg(args, usage);
      const chatId = requireChat();
      await api(
        `/api/chats/${encodeURIComponent(chatId)}/message`,
        json('POST', { role: 'system', content }),
      );
      await loadChat(chatId);
      await loadChats();
      await refreshPreview();
      toastOk(t('commands.insertedSystem'));
    },
  },
  {
    name: 'regen',
    hintKey: 'commands.hintRegen',
    run: () => emit('regenerate-reply', {}),
  },
  {
    name: 'continue',
    hintKey: 'commands.hintContinue',
    run: () => emit('continue-reply', {}),
  },
  {
    name: 'impersonate',
    hintKey: 'commands.hintImpersonate',
    run: () => emit('impersonate', {}),
  },
  {
    name: 'memory',
    hintKey: 'commands.hintMemory',
    run: () => emit('open-memory-editor', {}),
  },
  {
    name: 'new',
    argsKey: 'commands.argsName',
    hintKey: 'commands.hintNew',
    async run({ args }) {
      const characterId = state.meta?.characterId ?? state.characters[0]?.id;
      if (!characterId) throw new Error(t('commands.noCharacter'));
      const created = await api(
        '/api/chats',
        json('POST', { characterId, name: args.trim() || undefined }),
      );
      await loadChats();
      await loadChat(created.id);
      toastOk(t('commands.created', { name: created.name }));
    },
  },
  {
    name: 'model',
    argsKey: 'commands.argsModel',
    hintKey: 'commands.hintModel',
    run({ args }) {
      const wanted = args.trim();
      if (wanted === '') {
        const current = state.meta?.model ?? state.config?.model ?? t('commands.noSetting');
        const others = state.models.filter((item) => item !== current);
        toastOk(t('commands.modelCurrent', { model: current }), {
          detail: others.length ? t('commands.available', { list: others.join(t('commands.join')) }) : '',
        });
        return;
      }
      if (['默认', 'default', 'auto', 'reset'].includes(wanted.toLowerCase())) {
        emit('set-chat-model', { model: null });
        return;
      }
      emit('set-chat-model', { model: wanted });
    },
  },
  {
    name: 'persona',
    argsKey: 'commands.argsPersona',
    hintKey: 'commands.hintPersona',
    run({ args }) {
      const wanted = args.trim();
      const items = state.personas?.items ?? [];
      const current = items.find((item) => item.id === state.meta?.personaId)?.name
        ?? items.find((item) => item.id === state.personas?.activeId)?.name
        ?? state.config?.personaName
        ?? t('commands.noSetting');
      if (wanted === '') {
        toastOk(t('commands.personaCurrent', { name: current }), {
          detail: items.length
            ? t('commands.available', { list: items.map((item) => item.name).join(t('commands.join')) })
            : t('commands.personaEmpty'),
        });
        return;
      }
      if (['默认', 'default', 'auto', 'reset'].includes(wanted.toLowerCase())) {
        emit('set-chat-persona', { personaId: null });
        return;
      }
      const found = items.find((item) => item.name === wanted || item.id === wanted);
      if (!found) throw new Error(t('commands.noPersona', { name: wanted }));
      emit('set-chat-persona', { personaId: found.id });
    },
  },
  {
    name: 'world',
    argsKey: 'commands.argsWorld',
    hintKey: 'commands.hintWorld',
    async run({ args }) {
      const chatId = requireChat();
      const attached = state.meta?.worldRefs ?? [];
      const [wanted, flag] = args.trim().split(/\s+/).filter(Boolean);
      if (!wanted) {
        toastOk(
          attached.length
            ? t('commands.attached', { list: attached.join(t('commands.join')) })
            : t('commands.noneAttached'),
          {
            detail: state.worlds.length
              ? t('commands.available', { list: state.worlds.map((world) => world.id).join(t('commands.join')) })
              : t('commands.noWorlds'),
          },
        );
        return;
      }
      const world = state.worlds.find((item) => item.id === wanted || item.name === wanted);
      if (!world) throw new Error(t('commands.noWorld', { name: wanted }));
      // No flag means "flip it", which is what a slash command is good at.
      const on = flag === undefined ? !attached.includes(world.id) : booleanArg(flag);
      await api(
        `/api/chats/${encodeURIComponent(chatId)}/worlds`,
        json('POST', { worldId: world.id, attached: on }),
      );
      await loadChat(chatId);
      await refreshPreview();
      toastOk(t(on ? 'commands.worldOn' : 'commands.worldOff', { name: world.name }));
    },
  },
  {
    name: 'reasoning',
    argsKey: 'commands.argsOnOff',
    hintKey: 'commands.hintReasoning',
    async run({ args }) {
      const wanted = args.trim();
      if (wanted === '') {
        toastOk(state.config?.showReasoning ? t('commands.reasoningOn') : t('commands.reasoningOff'));
        return;
      }
      const value = booleanArg(wanted);
      await api('/api/config', json('PUT', { showReasoning: value }));
      await loadConfig();
      toastOk(value ? t('commands.reasoningEnabled') : t('commands.reasoningDisabled'));
    },
  },
  {
    name: 'export',
    hintKey: 'commands.hintExport',
    async run() {
      const chatId = requireChat();
      const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/export`);
      if (!response.ok) throw new Error(t('commands.exportFailed', { status: response.status }));
      const text = await response.text();
      downloadText(`${state.meta?.name || chatId}.jsonl`, text, 'application/x-ndjson;charset=utf-8');
      toastOk(t('commands.exported'));
    },
  },
  {
    name: 'fork',
    hintKey: 'commands.hintFork',
    async run() {
      const chatId = requireChat();
      const fork = await api(`/api/chats/${encodeURIComponent(chatId)}/fork`, json('POST', {}));
      await loadChats();
      await loadChat(fork.id);
      toastOk(t('commands.forked', { name: fork.name }));
    },
  },
];

/** Commands whose name starts with `prefix` (the palette's filter). */
function matchingCommands(prefix) {
  const needle = String(prefix).toLowerCase();
  return COMMANDS.filter((command) => command.name.startsWith(needle));
}

/**
 * `text` is a command line (or the lone `/` that starts one), so the composer
 * must not send it as a message. Synchronous on purpose: the caller decides
 * between sending and running without yielding a tick.
 */
export function isCommandLine(text) {
  const raw = String(text).trim();
  return raw === '/' || COMMAND_CALL.test(raw);
}

/**
 * Runs `text` when it is a command line.
 *
 * @returns {Promise<boolean>} true when the composer text was consumed as a
 *   command; the caller must then not send it as a message.
 */
export async function runCommand(text) {
  const raw = String(text).trim();
  if (raw === '/') {
    // An unfinished command: show the list instead of sending a lone slash.
    syncComposerPalette();
    return true;
  }
  const match = COMMAND_CALL.exec(raw);
  if (!match) return false;
  closePalette();

  const command = COMMANDS.find((item) => item.name === match[1].toLowerCase());
  if (!command) {
    toastError(t('commands.unknown', { name: match[1] }), { detail: t('commands.unknownHint') });
    return true;
  }

  const usage = commandUsage(command);
  setComposer('');
  try {
    await command.run({ args: match[2] ?? '', usage });
  } catch (error) {
    // The text comes back so a typo in the arguments can be fixed in place.
    setComposer(raw);
    toastError(t('commands.failed', { name: command.name, error: error.message }));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Composer palette
// ---------------------------------------------------------------------------

let palette = null;
let candidates = [];
let activeIndex = 0;

function composer() {
  return document.getElementById('input');
}

function setComposer(value) {
  const field = composer();
  field.value = value;
  field.focus?.();
  const caret = value.length;
  field.setSelectionRange?.(caret, caret);
}

function paletteNode() {
  if (palette) return palette;
  palette = el('div', { class: 'command-palette hidden', role: 'listbox', 'aria-label': t('commands.paletteAria') });
  // Inside the composer, so it rises from the input without any positioning
  // maths and never covers the buttons.
  composer().parentNode.append(palette);
  return palette;
}

function paletteOpen() {
  return palette !== null && !palette.classList.contains('hidden');
}
function closePalette() {
  candidates = [];
  activeIndex = 0;
  palette?.classList.add('hidden');
}

function renderPalette() {
  const node = paletteNode();
  clear(node);
  if (candidates.length === 0) {
    closePalette();
    return;
  }
  activeIndex = Math.max(0, Math.min(activeIndex, candidates.length - 1));
  candidates.forEach((command, index) => {
    const args = commandArgs(command);
    const row = el(
      'div',
      {
        class: `command-item${index === activeIndex ? ' active' : ''}`,
        role: 'option',
        'aria-selected': index === activeIndex ? 'true' : 'false',
        // mousedown, not click: preventing the default keeps the caret in the
        // textarea, so the choice lands where the user was typing.
        onmousedown: (event) => {
          event.preventDefault?.();
          complete(command);
        },
      },
      [
        el('span', { class: 'command-name', text: `/${command.name}` }),
        args ? el('span', { class: 'command-args', text: args }) : null,
        el('span', { class: 'command-hint', text: t(command.hintKey) }),
      ],
    );
    node.append(row);
  });
  // The registry is longer than the palette, so keep the selection in view.
  node.querySelector('.command-item.active')?.scrollIntoView?.({ block: 'nearest' });
  node.classList.remove('hidden');
}

/** Replaces the line with `/name ` and gets out of the way. */
function complete(command) {
  setComposer(`/${command.name} `);
  closePalette();
}

/**
 * Brings the palette in line with what the composer holds right now.
 *
 * The rule is deliberately narrow: the line must be a bare command token (`/`,
 * `/mod`) **and** at least one command must match it. Anything else — ordinary
 * text, a slash in the middle of a sentence, a prefix nothing starts with, an
 * empty box — means no palette at all, because a list that covers the transcript
 * without offering anything is worse than no list.
 *
 * Called on every `input` and, from the composer's owner, after a programmatic
 * write: setting `.value` fires no `input` event, so a quick reply inserted
 * under an open palette would otherwise leave it sitting there.
 */
export function syncComposerPalette() {
  const match = COMMAND_LINE.exec(composer().value.trim());
  if (!match) {
    closePalette();
    return;
  }
  candidates = matchingCommands(match[1]);
  if (candidates.length === 0) {
    closePalette();
    return;
  }
  activeIndex = 0;
  renderPalette();
}

function onKeydown(event) {
  if (!paletteOpen()) return;
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      event.preventDefault?.();
      const step = event.key === 'ArrowDown' ? 1 : candidates.length - 1;
      activeIndex = (activeIndex + step) % candidates.length;
      renderPalette();
      break;
    }
    case 'Tab':
    case 'Enter': {
      // Enter completes instead of sending: half a command is never a message.
      event.preventDefault?.();
      event.stopPropagation?.();
      complete(candidates[activeIndex]);
      break;
    }
    case 'Escape': {
      // Only the palette: whatever sits under it (a modal, say) stays open.
      event.preventDefault?.();
      event.stopPropagation?.();
      closePalette();
      break;
    }
    default:
      break;
  }
}

function openHelp() {
  const modal = createModal({
    className: 'commands',
    title: t('commands.helpTitle'),
    subtitle: t('commands.helpSubtitle'),
    removeOnClose: true,
  });
  const list = el('div', { class: 'command-help' });
  for (const command of COMMANDS) {
    const args = commandArgs(command);
    list.append(
      el('div', { class: 'command-help-row' }, [
        el('code', {
          class: 'command-name',
          text: `/${command.name}${args ? ` ${args}` : ''}`,
        }),
        el('span', { class: 'command-hint', text: t(command.hintKey) }),
      ]),
    );
  }
  modal.body.append(list);
  modal.footer.append(
    el('button', { class: 'ghost', text: t('common.close'), onclick: () => modal.close() }),
  );
  modal.open();
}

export function initCommands() {
  const field = composer();
  field.addEventListener('input', () => syncComposerPalette());
  field.addEventListener('keydown', onKeydown);
  field.addEventListener('blur', () => closePalette());
}
