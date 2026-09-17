/**
 * Bootstrap and wiring.
 *
 * This is the only module that knows about every view: it installs the keyboard
 * layer, initialises the views, subscribes to the events they publish, and loads
 * the initial state. Views stay independent of each other because cross-view
 * actions travel through `emit`.
 */

import {
  api,
  emit,
  hydrateModels,
  json,
  loadCharacters,
  loadChat,
  loadChats,
  loadConfig,
  loadFontFiles,
  loadModels,
  loadPersonas,
  loadConnections,
  loadQuickReplies,
  loadRegexes,
  loadStack,
  loadWorlds,
  on,
  refreshPreview,
  resetFieldMeta,
  state,
  testConnection,
} from './api.js';
import { clear, showError } from './dom.js';
import { applyStaticI18n, onLocaleChange, setLocale, storedLocale, t } from './i18n.js';import { openMenu } from './components/menu.js';
import { createLayoutController } from './components/layout.js';
import { connectionStatus } from './components/connection-status.js';
import { createModelPicker } from './components/model-picker.js';
import { toastError, toastOk } from './components/toast.js';
import { installErrorSurface, reportError } from './errors.js';
import { applyFonts } from './fonts.js';
import { installKeys } from './keys.js';
import { initTheme } from './themes.js';
import { initThemeFab } from './views/theme-fab.js';
import { initCharacterView, renderCharacters } from './views/characters.js';
import { initChatView } from './views/chat.js';
import { initChatListView, selectCharacter } from './views/chats.js';
import { initCommands } from './commands.js';
import { initMemoryView, openMemoryEditor } from './views/memory.js';
import { initPromptView } from './views/prompt.js';
import { initQuickReplyView } from './views/quick-replies.js';
import { initGroupView } from './views/group.js';
import { initSpriteView } from './views/sprite.js';
import { initRegexView } from './views/regex.js';
import { initSettingsView } from './views/settings.js';
import { initTraceView } from './views/trace.js';
import { initWorldView } from './views/worlds.js';
import { openWorldEditor } from './views/world-editor.js';
import { openCharacterEditor } from './views/character-editor.js';

/** Topbar connection badge: renders `state.ui.connection` and re-tests on click. */
function mountBrandMenu() {
  const button = document.getElementById('brand-menu');
  if (!button) return;
  button.addEventListener('click', () => {
    openMenu({
      anchor: button,
      items: [
        { label: t('app.newChat'), hint: t('app.newChatHint'), onSelect: () => emit('new-chat', {}) },
        {
          // A group is its own kind of conversation, so it is created as one:
          // pick the members first, then a chat starts with them. There is no
          // mode to switch on — the members ARE the group.
          label: t('app.newGroupChat'),
          hint: t('app.newGroupChatHint'),
          onSelect: () => emit('new-group-chat', {}),
        },
        {
          label: t('settings.title'),
          hint: t('app.settingsEntryHint'),
          separatorBefore: true,
          onSelect: () => emit('open-settings', {}),
        },
      ],
    });
  });
}

function mountConnectionStatus() {
  const mount = document.getElementById('connection-status');
  if (!mount) return;
  const render = () => {
    clear(mount);
    mount.append(connectionStatus(state.ui.connection, { onTest: () => testConnection() }));
  };
  render();
  on('connection', render);
}

/** The model a chat actually uses: its override, else the global default. */
function effectiveModel() {
  const override = typeof state.meta?.model === 'string' ? state.meta.model : '';
  return override !== '' ? override : (state.config?.model ?? '');
}

/** Set by `mountModelPicker`, called after the chat's model changes. */
let renderModelPicker = () => {};

/** Topbar model picker: switches the current conversation's model, not the default. */
function mountModelPicker() {
  const mount = document.getElementById('model-picker');
  if (!mount) return;

  const picker = createModelPicker({
    className: 'model-picker-topbar',
    fallback: 'no model',
    title: t('app.modelPickerTitle'),
    items: () => {
      const current = effectiveModel();
      const fallback = state.config?.model ?? '';
      const hasChat = state.chatId !== null && state.chatId !== undefined;
      const items = [];

      if (!hasChat) {
        items.push({ label: t('app.pickChat'), disabled: true });
      }
      for (const model of state.models ?? []) {
        // The default carries a marker instead of having its own 「跟随默认」
        // entry, and picking it *clears* this conversation's override rather
        // than pinning it to the same name — so the chat keeps following the
        // default if that is changed later in the settings.
        const isDefault = model === fallback;
        items.push({
          label: model,
          hint: isDefault ? t('app.modelDefaultHint') : model === current ? t('app.modelCurrentHint') : '',
          disabled: !hasChat,
          onSelect: () => setChatModel(isDefault ? null : model),
        });
      }
      if ((state.models?.length ?? 0) === 0) {
        items.push({
          label: state.modelsError ? t('app.modelFetchFailed') : t('app.modelNoList'),
          disabled: true,
        });
      }
      return items;
    },
  });

  const render = () => {
    const current = effectiveModel();
    const override = typeof state.meta?.model === 'string' ? state.meta.model : '';
    const pinned = override !== '' && override !== (state.config?.model ?? '');
    picker.setLabel(current === '' ? 'no model' : current);
    picker.node.title = pinned
      ? t('app.modelPinnedTitle', { model: current, fallback: state.config?.model ?? '—' })
      : (current === '' ? t('app.modelPickerTitle') : t('app.modelTitle', { model: current }));
  };
  renderModelPicker = render;
  render();
  on('chat', render);
  on('config', render);
  on('models', render);
  // No `preview` subscription: the picker reads the chat meta and the config,
  // never the assembled prompt, and every chat load already fires `chat`.
  mount.append(picker.node);
}

/**
 * Pins the current conversation to a model, or clears the pin with `null`.
 *
 * Only the chat meta changes; the global default in the settings dialog is left
 * untouched. A reload of the preview is what moves the token-counting label.
 */
async function setChatModel(model) {
  if (!state.chatId) return;
  try {
    const updated = await api(`/api/chats/${encodeURIComponent(state.chatId)}`, json('PUT', { model }));
    // A stale server (not restarted after the endpoint learned `model`) would
    // answer 200 without changing anything; fail loudly instead of no-oping.
    if (model !== null && updated?.model !== model) {
      throw new Error(t('app.staleServer'));
    }
    state.meta = updated;
    renderModelPicker();
    await refreshPreview();
    toastOk(model ? t('app.modelSwitched', { model }) : t('app.modelFollowDefault'));
  } catch (error) {
    toastError(t('app.modelSwitchFailed', { error: error.message }));
  }
}

async function main() {
  // The error surface goes first: everything after it fails loudly instead of
  // leaving a control that simply does nothing.
  installErrorSurface();
  installKeys();
  // Apply the language remembered from the last session before any view builds
  // its labels; the config below is the source of truth and may change it again.
  setLocale(storedLocale());
  // The static shell is translated through its `data-i18n` attributes. The boot
  // script already did this before the first paint; a later switch wants it again.
  applyStaticI18n();
  onLocaleChange(() => {
    applyStaticI18n();
    // Server-supplied labels (world entry fields) are fetched per language; drop
    // the cache so the next editor or dialog loads them in the new one.
    resetFieldMeta();
  });
  // The theme was applied by the boot script before the first paint; this
  // re-applies the stored choice (so a theme that disappeared still falls back)
  // and keeps "follow the system" honest while the window stays open.
  initTheme();
  // The corner button: appearance is a two-second decision, and it should not
  // require opening the settings dialog.
  initThemeFab();
  // Panel visibility is a layout concern of its own; it restores the saved state
  // as soon as it is created. It announces changes so views that live in a panel
  // (the trajectory, in particular) can load exactly when they become visible.
  createLayoutController({
    onChange: (info) => emit('layout', info),
  });
  // Bring back the last fetched model list before any network call, so an
  // offline reload still has selectable models; a successful fetch replaces it.
  hydrateModels();
  mountBrandMenu();
  mountConnectionStatus();
  mountModelPicker();

  // One broken view must not take the others down with it: a failure while
  // initialising the prompt panel used to disable every view after it, which is
  // what "the settings button does nothing" looked like from the outside.
  const views = [
    ['app.view.characters', initCharacterView],
    ['app.view.worlds', initWorldView],
    ['app.view.chats', initChatListView],
    ['app.view.chat', initChatView],
    ['app.view.prompt', initPromptView],
    ['app.view.trace', initTraceView],
    ['app.view.quickReplies', initQuickReplyView],
    ['app.view.regex', initRegexView],
    ['app.view.group', initGroupView],
    ['app.view.sprite', initSpriteView],
    ['app.view.commands', initCommands],
    ['app.view.memory', initMemoryView],
    ['app.view.settings', initSettingsView],
  ];
  for (const [label, init] of views) {
    try {
      await init();
    } catch (error) {
      reportError(t('app.viewInitFailed', { label: t(label) }), error);
    }
  }

  on('characters', renderCharacters);
  on('chat', renderCharacters);

  // The stored config carries the interface language; changing it in the dialog
  // saves to the config, which lands here and switches every subscriber.
  on('config', () => setLocale(state.config?.uiLanguage));

  on('select-character', ({ characterId }) => {
    selectCharacter(characterId).catch((error) =>
      showError(document.getElementById('messages'), error),
    );
  });

  // Slash commands ask for the model pin by event: `/model` must not import the
  // bootstrap, and the bootstrap is the only place that owns this action.
  on('set-chat-model', ({ model }) => {
    void setChatModel(model ?? null);
  });

  // The world list asks for the editor by event, so the two views stay unaware
  // of each other and the composition root decides who opens what.
  on('open-world-editor', ({ worldId, scrollToHit }) => {
    openWorldEditor(worldId, { scrollToHit }).catch((error) =>
      showError(document.getElementById('world-hits'), error),
    );
  });

  on('open-character-editor', ({ characterId }) => {
    openCharacterEditor(characterId).catch((error) => toastError(t('app.cardEditorFailed', { error: error.message })));
  });

  // The memory editor is opened from the header badge, the prompt panel and
  // `/memory`; one place decides what that means.
  on('open-memory-editor', () => {
    openMemoryEditor().catch((error) => toastError(t('app.memoryFailed', { error: error.message })));
  });

  try {
    await Promise.all([
      loadConfig(),
      loadCharacters(),
      loadWorlds(),
      loadChats(),
      loadStack(),
      loadQuickReplies(),
      loadRegexes(),
      loadPersonas(),
      loadConnections(),
      loadFontFiles().then((files) => applyFonts(files)),
    ]);
    // Fetch the provider's model list automatically, once the interface is
    // configured. It is not awaited: the page is usable while it lands, and the
    // picker updates on the `models` event.
    if (state.config?.apiKey) loadModels();
    if (state.chats[0]) await loadChat(state.chats[0].id);
    else if (state.characters[0]) await selectCharacter(state.characters[0].id);
    else renderCharacters();
  } catch (error) {
    reportError(t('app.loadFailed'), error);
    showError(document.getElementById('messages'), error);
  }
}

main();
