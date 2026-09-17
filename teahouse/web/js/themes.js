/**
 * Themes: which palette this browser uses.
 *
 * A theme is a *palette of CSS variables*, declared once in `style.css` under
 * `:root[data-theme='…']`. This module holds the metadata (id, label, icon, whether
 * it is a light or dark palette) and the one thing CSS cannot do by itself: an
 * explicit choice that overrides the system. Following the system needs no code at
 * all — with no attribute set, a media query in the stylesheet decides, and keeps
 * deciding while the window is open.
 *
 * Adding a theme is therefore two steps, both checked by `test:web`:
 *   1. add a `:root[data-theme='your-id']` block in `style.css` defining every
 *      token the sheet uses,
 *   2. add an entry here.
 *
 * The choice is a client preference, not server config: it belongs to this browser
 * on this screen (like the panel layout), and storing it locally means switching
 * never touches `data/config.json`.
 */

export const THEME_STORAGE_KEY = 'teahouse.theme.v1';
export const ACCENT_STORAGE_KEY = 'teahouse.accent.v1';

/** `kind` matters for native chrome: it becomes the CSS `color-scheme`. */
export const THEMES = [
  { id: 'system', labelKey: 'appearance.themeSystem', icon: 'monitor', kind: 'system' },
  { id: 'light', labelKey: 'appearance.themeLight', icon: 'sun', kind: 'light' },
  { id: 'dark', labelKey: 'appearance.themeDark', icon: 'moon', kind: 'dark' },
];

/**
 * Accent schemes: the second, independent axis.
 *
 * An accent overrides the accent family only (`--accent`, its tints, the user
 * bubble), so it composes with light and dark instead of replacing them: six
 * accents × two bases is twelve looks from twelve short CSS blocks. The colours
 * live in `style.css`; what is here is the label and the swatch the picker paints,
 * and `test:web` checks that a swatch matches the accent it claims to show.
 */
export const ACCENTS = [
  { id: 'indigo', labelKey: 'appearance.accentIndigo', swatch: '#7aa2f7' },
  { id: 'violet', labelKey: 'appearance.accentViolet', swatch: '#b28df5' },
  { id: 'teal', labelKey: 'appearance.accentTeal', swatch: '#5fd0c0' },
  { id: 'amber', labelKey: 'appearance.accentAmber', swatch: '#e0b25c' },
  { id: 'rose', labelKey: 'appearance.accentRose', swatch: '#f28fae' },
  { id: 'moss', labelKey: 'appearance.accentMoss', swatch: '#9ec96f' },
];

export const DEFAULT_ACCENT = 'indigo';

export const ACCENT_IDS = ACCENTS.map((accent) => accent.id);

export const DEFAULT_THEME = 'system';

/** Ids that a `data-theme` attribute may carry; `system` means "no attribute". */
export const THEME_IDS = THEMES.map((theme) => theme.id);

export function themeById(id) {
  return THEMES.find((theme) => theme.id === id) ?? THEMES.find((theme) => theme.id === DEFAULT_THEME);
}

/** The stored choice, validated: a deleted theme must not leave the app unstyled. */
export function readStoredTheme() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_IDS.includes(raw) ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * The palette in effect right now. `system` is resolved through the media query so
 * the answer matches what the stylesheet is doing.
 */
export function resolvedTheme(id = readStoredTheme()) {
  if (id !== 'system') return id;
  try {
    return window.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Puts a choice into effect and remembers it. */
export function applyTheme(id) {
  const theme = themeById(id);
  const root = document.documentElement;
  // `system` is the absence of an attribute, not a value: the media query then has
  // the last word, including when the operating system switches mid-session.
  if (theme.id === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme.id);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme.id);
  } catch {
    /* storage may be unavailable; the choice still applies to this session */
  }
  return theme.id;
}

export function accentById(id) {
  return ACCENTS.find((accent) => accent.id === id) ?? ACCENTS.find((accent) => accent.id === DEFAULT_ACCENT);
}

/** The stored accent, validated like the theme: a removed one falls back. */
export function readStoredAccent() {
  try {
    const raw = localStorage.getItem(ACCENT_STORAGE_KEY);
    return ACCENT_IDS.includes(raw) ? raw : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

/**
 * Applies an accent. The default needs no attribute: it is what the base palettes
 * already define, so the sheet has one less block to keep in step.
 */
export function applyAccent(id) {
  const accent = accentById(id);
  const root = document.documentElement;
  if (accent.id === DEFAULT_ACCENT) root.removeAttribute('data-accent');
  else root.setAttribute('data-accent', accent.id);
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, accent.id);
  } catch {
    /* as above */
  }
  return accent.id;
}

/** Called at startup: re-applies the stored choices and keeps `system` honest. */
export function initTheme() {
  applyTheme(readStoredTheme());
  applyAccent(readStoredAccent());
  try {
    const media = window.matchMedia?.('(prefers-color-scheme: light)');
    media?.addEventListener?.('change', () => {
      if (readStoredTheme() === 'system') applyTheme('system');
    });
  } catch {
    /* no matchMedia: the stylesheet's media query still decides */
  }
}
