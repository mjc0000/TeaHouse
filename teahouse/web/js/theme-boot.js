/**
 * Applies the stored theme before the first paint.
 *
 * A classic script in `<head>`, not a module: modules are deferred, so a light
 * theme on a dark-preferring system would flash dark first. It deliberately knows
 * nothing but the storage key — all the rules (validation, system resolution,
 * persistence) live in `themes.js`, which the settings dialog uses.
 *
 * If the stored value is `system`, no attribute is set and the stylesheet's
 * `prefers-color-scheme` query decides, so this file needs no media query either.
 */
try {
  var theme = localStorage.getItem('teahouse.theme.v1');
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  }
  var accent = localStorage.getItem('teahouse.accent.v1');
  // The default accent is the absence of the attribute, like `system` for the mode.
  if (accent && accent !== 'indigo') {
    document.documentElement.setAttribute('data-accent', accent);
  }
} catch (error) {
  /* private mode, or storage disabled: the default (system) applies */
}
