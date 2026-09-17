/**
 * Interface translation.
 *
 * The app ships its strings as plain ES modules — no build step, no dependency,
 * which is the same reason the rest of the client is hand-written. A locale is
 * one object: `{ id, label, nativeLabel, dir, messages }`, where `messages` is a
 * nested tree and `t('a.b.c')` walks it. Adding a language is one file plus a
 * line in the registry.
 *
 * Two rules keep this from drifting:
 *
 *   - The fallback is `zh-CN`, whose strings are the ones the code carried
 *     before this module existed, so an untranslated key shows Chinese rather
 *     than a bare dot-path.
 *   - `test:web` asserts every locale has exactly the same key set, so a key
 *     added to one dictionary fails until the others have it too.
 *
 * Only interface text lives here. Prompt content — the reply-language
 * instruction, the memory prompt, the story template — is user data that steers
 * the model, not a message, and must never be routed through `t()`.
 */

import zhCN from './locales/zh-CN.js';
import en from './locales/en.js';

const FALLBACK = 'zh-CN';
const STORAGE_KEY = 'teahouse.uiLanguage.v1';

/** @type {Map<string, {id: string, label: string, nativeLabel: string, dir: 'ltr'|'rtl', messages: object}>} */
const registry = new Map();
/** @type {Set<(id: string) => void>} */
const listeners = new Set();

let current = FALLBACK;

export function registerLocale(definition) {
  registry.set(definition.id, definition);
}

/** Locale descriptors for the settings dropdown, in registration order. */
export function locales() {
  return [...registry.values()].map(({ id, label, nativeLabel, dir }) => ({
    id,
    label,
    nativeLabel,
    dir,
  }));
}

export function hasLocale(id) {
  return typeof id === 'string' && registry.has(id);
}

export function locale() {
  return current;
}

export function direction(id = current) {
  return registry.get(id)?.dir ?? 'ltr';
}

/**
 * Switches the interface language and notifies subscribers.
 *
 * An unknown id falls back to `zh-CN` rather than throwing: a config written by
 * a newer build must still render. A no-op switch does not notify, so boot does
 * not fire a re-render storm on the default locale.
 */
export function setLocale(id) {
  const next = hasLocale(id) ? id : FALLBACK;
  if (next === current) {
    applyDocumentLanguage();
    return current;
  }
  current = next;
  persist(next);
  applyDocumentLanguage();
  for (const handler of [...listeners]) handler(next);
  return next;
}

/**
 * Keeps `<html lang>` and `dir` honest. Done here rather than at each call site
 * so the boot script, the config loader and a manual switch all agree, and
 * guarded so the pure-JS suites can import this module without a DOM.
 */
function applyDocumentLanguage() {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.setAttribute('lang', current);
  document.documentElement.setAttribute('dir', direction(current));
}

/** Subscribes to language changes; returns an unsubscribe function. */
export function onLocaleChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/** The locale remembered for the next boot (the config remains the source of truth). */
export function storedLocale() {
  if (typeof document === 'undefined') return '';
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function persist(id) {
  // Storage is a browser concern; the pure-JS suites import this module without
  // a DOM, and touching Node's experimental `localStorage` emits a warning.
  if (typeof document === 'undefined') return;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    /* private mode or storage disabled: the choice still holds for this session */
  }
}

function lookup(messages, key) {
  let node = messages;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Interpolates `{name}` placeholders. Deliberately single-braced so it never
 * touches `{{macro}}` sequences that appear inside explanatory hint text.
 */
function interpolate(text, params) {
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/**
 * The plural category a count falls into, per the current locale's own rules.
 * Chinese, Japanese and Korean only ever pick `other`; English picks `one` for
 * exactly 1. Locales declare both forms anyway, so the key sets stay identical.
 */
function pluralSuffix(count) {
  try {
    return new Intl.PluralRules(current).select(Number(count));
  } catch {
    return 'other';
  }
}

/**
 * @param {string} key dot-path into the messages tree
 * @param {Record<string, unknown>} [params] values for `{name}` placeholders.
 *   A `count` also selects the plural form: `${key}_one` / `${key}_other`.
 * @returns {string} the message, the fallback's message, or the key itself
 */
export function t(key, params) {
  const messages = registry.get(current)?.messages ?? {};
  const fallback = registry.get(FALLBACK)?.messages ?? {};
  let message;
  if (params && params.count !== undefined) {
    const suffix = pluralSuffix(params.count);
    message =
      lookup(messages, `${key}_${suffix}`) ??
      lookup(messages, `${key}_other`) ??
      lookup(fallback, `${key}_${suffix}`) ??
      lookup(fallback, `${key}_other`);
  }
  message ??= lookup(messages, key) ?? lookup(fallback, key);
  if (message === undefined) return key;
  return params ? interpolate(message, params) : message;
}

/** A number in the current locale's grouping/decimal form. */
export function formatNumber(value, options) {
  try {
    return new Intl.NumberFormat(current, options).format(value);
  } catch {
    return String(value);
  }
}

/**
 * Renders a server `Notice` — `{ code, params, text }` — in the current
 * language. Falls back to the source-language `text` the server sent, then to
 * the code itself, so a notice the dictionary does not know is still visible
 * instead of blank. Plain strings pass through.
 */
export function noticeText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  const key = `server.${value.code}`;
  const translated = t(key, value.params);
  return translated === key ? String(value.text ?? value.code) : translated;
}

/**
 * The `data-i18n*` attribute vocabulary and where each one writes.
 *
 * `data-i18n` sets text; the rest set an attribute. A `data-i18n` element must
 * hold no child elements (wrap the text in its own `<span>`), because setting
 * `textContent` replaces whatever is inside it.
 */
const STATIC_TARGETS = {
  'data-i18n': '',
  'data-i18n-title': 'title',
  'data-i18n-placeholder': 'placeholder',
  'data-i18n-aria-label': 'aria-label',
};

/** Translates every `data-i18n*` node under `root` (the whole document by default). */
export function applyStaticI18n(root = globalThis.document) {
  if (!root) return;
  for (const [attribute, target] of Object.entries(STATIC_TARGETS)) {
    for (const node of root.querySelectorAll(`[${attribute}]`)) {
      const key = node.getAttribute(attribute);
      if (key === null || key === '') continue;
      const value = t(key);
      if (target === '') node.textContent = value;
      else node.setAttribute(target, value);
    }
  }
}

/** Every leaf key of a locale, for the key-parity contract test. */
export function translationKeys(id) {
  const out = [];
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node)) {
      const key = prefix === '' ? name : `${prefix}.${name}`;
      if (value !== null && typeof value === 'object') walk(value, key);
      else out.push(key);
    }
  };
  walk(registry.get(id)?.messages ?? {}, '');
  return out;
}

registerLocale(zhCN);
registerLocale(en);
