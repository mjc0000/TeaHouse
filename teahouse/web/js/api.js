import { deriveHits } from './hits.js';
import { locale, noticeText } from './i18n.js';

/**
 * Shared client state, the HTTP helpers, and a tiny pub/sub bus.
 *
 * Views read from `state` and subscribe to events; only the loaders below write
 * to it. Nothing here touches the DOM (that is `dom.js`) or renders anything
 * (that is the views).
 */

export const state = {
  config: null,
  characters: [],
  worlds: [],
  chats: [],
  chatId: null,
  meta: null,
  entries: [],
  stack: [],
  macros: [],
  /** Model ids fetched from the provider; overrides any built-in suggestion. */
  models: [],
  /** True when `models` came from the on-disk cache, not the last live fetch. */
  modelsCached: false,
  /** Why the last model-list fetch failed, or null. */
  modelsError: null,
  /** The server's default reply-language wording, used for the settings preview. */
  languageInstructionTemplate: '',
  /** Quick reply snippets: `{ version, enabled, items: [{ id, label, mes, enabled }] }`. */
  quickReplies: { version: 1, enabled: true, items: [] },
  /** Regex rules: `{ version, rules: [{ id, name, pattern, flags, replacement, scope, enabled }] }`. */
  regexes: { version: 1, rules: [] },
  /** Persona library: `{ version, activeId, items: [{ id, name, description }] }`. */
  personas: { version: 1, activeId: '', items: [] },
  /** Extra endpoints a group member can speak through: `{ version, items }`. */
  connections: { version: 1, items: [] },
  /** Uploaded font files from `data/fonts/`. */
  fontFiles: [],
  /** Expression sprites for the current chat, or null. */
  sprite: null,
  fieldMeta: null,
  editingWorldId: null,
  /** Vector storage: the settings in use plus one status line per world book. */
  vectors: null,
  preview: null,
  scan: null,
  streaming: false,
  /**
   * Purely presentational state, kept apart from the data above so a re-render
   * never has to guess whether a field is server truth or a UI detail.
   */
  ui: {
    /** Message currently open in inline editing, or null. */
    editingId: null,
    /** Translated messages currently showing their original text, by entry id. */
    showOriginal: new Set(),
    /** Preview rows the user expanded, by index. */
    previewExpanded: new Set(),
    /** Collapsed prompt-stack groups, by group id. */
    stackCollapsed: {},
    /** Connection-test result shown in the settings dialog. */
    connection: { status: 'idle' },
    /** Highlighted world entries for this turn (see hits.js). */
    hits: { all: [], byWorld: new Map() },
  },
};

const listeners = new Map();

export function on(event, handler) {
  const list = listeners.get(event) ?? [];
  list.push(handler);
  listeners.set(event, list);
}

export function emit(event, payload) {
  for (const handler of listeners.get(event) ?? []) handler(payload);
}

export async function api(path, init) {
  const response = await fetch(path, init);
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON responses are returned as text */
  }
  if (!response.ok) {
    // A server notice (`{ code, params, error }`) is rendered in the current
    // language; `error` stays as the source-language fallback.
    const record = body && typeof body === 'object' ? body : null;
    const message = record && typeof record.code === 'string'
      ? noticeText(record)
      : (record && record.error ? record.error : `HTTP ${response.status}`);
    const error = new Error(message);
    error.status = response.status;
    error.problems = record ? record.problems : undefined;
    throw error;
  }
  return body;
}

export const json = (method, payload) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

// ---------------------------------------------------------------------------
// Loaders: the only writers of `state`
// ---------------------------------------------------------------------------

export async function loadConfig() {
  state.config = await api('/api/config');
  emit('config', state.config);
  return state.config;
}

export async function loadCharacters() {
  state.characters = await api('/api/characters');
  emit('characters', state.characters);
  return state.characters;
}

export async function loadWorlds() {
  state.worlds = await api('/api/worlds');
  emit('worlds', state.worlds);
  return state.worlds;
}

export async function loadChats() {
  state.chats = await api('/api/chats');
  emit('chats', state.chats);
  return state.chats;
}

export async function loadChat(id) {
  const payload = await api(`/api/chats/${id}`);
  state.chatId = id;
  state.meta = payload.meta;
  state.entries = payload.entries;
  state.ui.editingId = null;
  emit('chat', payload);
  // Assemble the preview as part of opening the chat, so the budget bar, the
  // prompt stack and the world-book hits are populated without the user having
  // to press 装配预览. It is a purely local computation (no provider call), and
  // it is what keeps that panel populated across reloads and chat switches —
  // the composition is always available, never fetched on demand.
  await refreshPreview();
  return payload;
}

export async function loadStack() {
  const payload = await api('/api/prompt/stack');
  state.stack = payload.blocks;
  state.macros = payload.macros;
  state.languageInstructionTemplate = payload.defaultLanguageInstruction ?? '';
  emit('stack', payload);
  return payload;
}

export async function loadQuickReplies() {
  state.quickReplies = await api('/api/quick-replies');
  emit('quick-replies', state.quickReplies);
  return state.quickReplies;
}

export async function loadRegexes() {
  state.regexes = await api('/api/regex');
  emit('regexes', state.regexes);
  return state.regexes;
}

export async function saveRegexes(file) {
  state.regexes = await api('/api/regex', json('PUT', file));
  emit('regexes', state.regexes);
  return state.regexes;
}

export async function loadPersonas() {
  state.personas = await api('/api/personas');
  emit('personas', state.personas);
  return state.personas;
}

export async function savePersonas(file) {
  state.personas = await api('/api/personas', json('PUT', file));
  emit('personas', state.personas);
  return state.personas;
}

/**
 * Extra connections (`data/connections.json`): the endpoints a group member can
 * speak through instead of the chat's own. Keys come back masked.
 */
export async function loadConnections() {
  try {
    state.connections = await api('/api/connections');
  } catch {
    state.connections = { version: 1, items: [] };
  }
  emit('connections', state.connections);
  return state.connections;
}

export async function saveConnections(file) {
  state.connections = await api('/api/connections', json('PUT', file));
  emit('connections', state.connections);
  return state.connections;
}

/** Self-hosted font files (`data/fonts/`). Missing directory means none. */
export async function loadFontFiles() {
  try {
    const result = await api('/api/fonts');
    state.fontFiles = Array.isArray(result?.files) ? result.files : [];
  } catch {
    state.fontFiles = [];
  }
  emit('fonts', state.fontFiles);
  return state.fontFiles;
}

/**
 * Vector storage status. Read often (the world list shows a badge per book) and
 * cheap: it only reads local files, never the embedding endpoint.
 */
export async function loadVectors() {
  state.vectors = await api('/api/vectors');
  emit('vectors', state.vectors);
  return state.vectors;
}

export async function saveQuickReplies(file) {
  state.quickReplies = await api('/api/quick-replies', json('PUT', file));
  emit('quick-replies', state.quickReplies);
  return state.quickReplies;
}

/** Accepts our shape or SillyTavern's; the server appends what it finds. */
export async function importQuickReplies(payload) {
  const result = await api('/api/quick-replies/import', json('POST', payload));
  await loadQuickReplies();
  return result;
}

export async function loadFieldMeta() {
  if (state.fieldMeta) return state.fieldMeta;
  // The labels are served in the interface language, so a switch invalidates the
  // cache (see `resetFieldMeta`).
  state.fieldMeta = await api(`/api/worlds/fields?lang=${encodeURIComponent(locale())}`);
  return state.fieldMeta;
}

/** Drops the cached field metadata, e.g. after the interface language changed. */
export function resetFieldMeta() {
  state.fieldMeta = null;
}

export async function refreshPreview(pendingUserMessage) {
  if (!state.chatId) return null;
  try {
    state.preview = await api(
      '/api/prompt/preview',
      json('POST', { chatId: state.chatId, pendingUserMessage }),
    );
    state.ui.hits = deriveHits(state.preview);
  } catch (error) {
    state.preview = { error: error.message };
    state.ui.hits = { all: [], byWorld: new Map(), skipped: [] };
  }
  emit('preview', state.preview);
  return state.preview;
}

/** World book scan diagnostics, used to explain an empty hit list. */
export async function refreshScan(pendingUserMessage) {
  if (!state.chatId) return null;
  try {
    state.scan = await api(
      '/api/scan/debug',
      json('POST', { chatId: state.chatId, message: pendingUserMessage }),
    );
  } catch {
    state.scan = null;
  }
  emit('scan', state.scan);
  return state.scan;
}

/** Connection test for the settings dialog. Never throws: failure is a result. */
export async function testConnection() {
  state.ui.connection = { status: 'testing' };
  emit('connection', state.ui.connection);
  try {
    const result = await api('/api/config/test', { method: 'POST' });
    state.ui.connection = { status: result.ok ? 'ok' : 'error', ...result };
    // A successful test is also the freshest list of models the provider
    // offers, so use it instead of making the user's switch wait for another
    // round trip.
    if (result.ok && Array.isArray(result.models)) {
      state.models = result.models;
      state.modelsError = null;
      state.modelsCached = false;
      writeModelsCache(state.models);
      emit('models', state.models);
    }
  } catch (error) {
    state.ui.connection = { status: 'error', ok: false, error: error.message };
  }
  emit('connection', state.ui.connection);
  return state.ui.connection;
}

/**
 * Model-list cache. The fetched list survives an offline reload and stays put
 * until the next successful fetch overwrites it.
 */
const MODELS_CACHE_KEY = 'teahouse.models.v1';

function readModelsCache() {
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    const models = Array.isArray(parsed?.models)
      ? parsed.models.filter((model) => typeof model === 'string' && model !== '')
      : [];
    return models.length > 0 ? { models, at: typeof parsed?.at === 'string' ? parsed.at : '' } : null;
  } catch {
    return null;
  }
}

function writeModelsCache(models) {
  try {
    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify({ models, at: new Date().toISOString() }));
  } catch {
    /* storage may be unavailable; the list still works for this session */
  }
}

/** Restores the cached list immediately, so an offline reload is not empty. */
export function hydrateModels() {
  const cached = readModelsCache();
  if (!cached) return state.models;
  state.models = cached.models;
  state.modelsCached = true;
  emit('models', state.models);
  return state.models;
}

/**
 * Fetches the provider's model ids and replaces the displayed list.
 *
 * Never throws: a provider without a key or without a model endpoint is a
 * normal state. The fetched list overrides whatever suggestions were shown
 * before, and is cached on disk; when a fetch fails the last cached list is
 * kept, so an offline reload still offers the models instead of going empty.
 */
export async function loadModels() {
  try {
    const payload = await api('/api/models', { method: 'POST' });
    state.models = Array.isArray(payload.models) ? payload.models : [];
    state.modelsError = null;
    state.modelsCached = false;
    writeModelsCache(state.models);
  } catch (error) {
    const cached = readModelsCache();
    if (cached) {
      state.models = cached.models;
      state.modelsCached = true;
      state.modelsError = null;
    } else {
      state.models = [];
      state.modelsCached = false;
      state.modelsError = error.message;
    }
  }
  emit('models', state.models);
  return state.models;
}

/** Re-reads the current chat after the server mutated its metadata. */
export async function refreshChatMeta() {
  if (!state.chatId) return null;
  const payload = await api(`/api/chats/${state.chatId}`);
  state.meta = payload.meta;
  state.entries = payload.entries;
  emit('chat', payload);
  return payload;
}
