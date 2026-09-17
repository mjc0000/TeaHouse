/**
 * Web UI suite.
 *
 * There is no browser here, so the checks are the ones a browser would fail on
 * anyway:
 *   1. every shipped asset is served with the right content type
 *   2. every module parses (imports stripped, then compiled)
 *   3. every named import resolves to a real export in the target module
 *   4. every `getElementById('x')` has a matching id in index.html
 *   5. components that build their own DOM do not use `getElementById` at all
 *   6. the page really contains the three panels
 *
 * Check 3 exists because a missing export is invisible to a syntax check: the
 * module compiles, then fails at runtime in the browser.
 *
 * Run: node scripts/test-web.ts
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTeahouseServer } from '../src/server.ts';
import {
  DEFAULT_LANGUAGE_INSTRUCTION,
  renderLanguageInstruction as renderLanguageOnServer,
} from '../src/engine/prompt-stack.ts';
import { INSERTION_STRATEGY } from '../src/engine/world-scan.ts';
import { EDITABLE_CARD_FIELDS } from '../src/formats/character-card.ts';
import { DEFAULT_CONFIG, GROUP_MODES, RETRIEVAL_MODES } from '../src/store/db.ts';
import { normalizeBaseUrl } from '../src/llm/openai-compat.ts';
import { PROVIDERS, knownContextWindow, matchProvider, providersPayload } from '../src/llm/providers.ts';
import { resolveConnection } from '../src/engine/connections.ts';
import { connectionById, connectionLabel, newConnectionId } from '../web/js/connections.js';
import { INTERFACE_LANGUAGES, localize } from '../src/i18n.ts';
import { CHARACTER_FIELDS } from '../web/js/character-fields.js';
import { COMMANDS, isCommandLine } from '../web/js/commands.js';
import { ICON_PATHS } from '../web/js/components/icon.js';
import { FALLBACK_LANGUAGE_INSTRUCTION,
  renderLanguageInstruction as renderLanguageOnClient,
} from '../web/js/language.js';
import { DEFAULT_STORY_TEMPLATE as SERVER_STORY_TEMPLATE } from '../src/engine/story-template.ts';
import { applyDisplayRegexes as serverDisplay } from '../src/engine/regex-rules.ts';
import { effectivePersona as serverPersona } from '../src/engine/personas.ts';
import { applyDisplayRules as clientDisplay } from '../web/js/regex.js';
import { effectivePersonaName as clientPersonaName } from '../web/js/persona.js';
import { FONT_STACKS, resolveFamily } from '../web/js/fonts.js';
import { failedTranslation, forgetTranslationFailure, freshTranslation, needsTranslation as clientNeeds, rememberTranslationFailure, translationAttemptKey } from '../web/js/translate.js';import { expandDisplayMacros as clientMacros } from '../web/js/display-macros.js';
import { expandDisplayMacros as serverMacros } from '../src/engine/macros.ts';
import { matchesVoice, stripForSpeech, voiceKey } from '../web/js/tts.js';
import { focusFromPixels, nudgeFocus } from '../web/js/sprite-focus.js';
import { parseMath, splitBalanced } from '../web/js/math.js';
import { needsTranslation as serverNeeds } from '../src/engine/translate.ts';
import { DEFAULT_STORY_TEMPLATE as CLIENT_STORY_TEMPLATE, parseContextPreset, toContextPreset } from '../web/js/context-template.js';
import {
  SETTINGS_PAGES,
  buildPatch,
  changedFields,
  effectiveGroupMode,
  groupModeLabel,
  groupModeLabels,
  groupModeLetter,
  hasGroupMode,
  hasRetrievalMode,
  pageOfField,
  retrievalMigrationNotice,
  retrievalModeLabel,
  retrievalModeLabels,
  schemaFields,
  validateValues,
  valuesFromConfig,
} from '../web/js/settings-schema.js';
import { formatNumber, locale, locales, setLocale, t, translationKeys } from '../web/js/i18n.js';
import { attributeTokens } from '../web/js/preview-tokens.js';
import { budgetFromPreview, describeBudget, describeCounting, formatTokens } from '../web/js/token-budget.js';
import { tokenBreakdown } from '../web/js/token-breakdown.js';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..', 'web');
const jsRoot = join(webRoot, 'js');

let checks = 0;
let failures = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks++;
  if (ok) return;
  failures++;
  console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
}

function eq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(a === b, label, `got ${a}, want ${b}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function listModules(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) listModules(path, out);
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

/** Exported names of a module, including `export { a, b }` and re-exports. */
function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]!);
  }
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const piece of match[1]!.split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default/m.test(source)) names.add('default');
  return names;
}

/**
 * Removes `//` and block comments while keeping string/regex content, so a CJK
 * scan sees only code and literals — not the Chinese examples comments use.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const character = source[i]!;
    const next = source[i + 1];
    if (character === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (character === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      out += character;
      i++;
      while (i < source.length) {
        const inside = source[i]!;
        out += inside;
        i++;
        if (inside === '\\') {
          if (i < source.length) {
            out += source[i];
            i++;
          }
          continue;
        }
        if (inside === quote) break;
      }
      continue;
    }
    out += character;
    i++;
  }
  return out;
}

interface ImportSpec {
  specifier: string;
  names: string[];
  line: number;
}

function importsOf(source: string): ImportSpec[] {
  const out: ImportSpec[] = [];
  const pattern = /^import\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))?\s*(?:from\s*)?['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[3]!;
    const names: string[] = [];
    if (match[1]) {
      for (const piece of match[1].split(',')) {
        const name = piece.trim().split(/\s+as\s+/)[0]?.trim();
        if (name) names.push(name);
      }
    } else if (match[2]) {
      names.push('default');
    }
    const line = source.slice(0, match.index ?? 0).split('\n').length;
    out.push({ specifier, names, line });
  }
  return out;
}

const dataDir = mkdtempSync(join(tmpdir(), 'teahouse-web-'));
const app = createTeahouseServer({ dataDir, port: 0, host: '127.0.0.1' });
const base = await app.listen();

try {
  const modules = listModules(jsRoot);
  const relativeModules = modules.map((path) => relative(webRoot, path).replace(/\\/g, '/'));

  // -------------------------------------------------------------------------
  section('static assets');
  // -------------------------------------------------------------------------

  const assets = [
    ['/', 'text/html; charset=utf-8'],
    ['/style.css', 'text/css; charset=utf-8'],
    ['/js/app.js', 'text/javascript; charset=utf-8'],
    ['/js/api.js', 'text/javascript; charset=utf-8'],
    ['/js/dom.js', 'text/javascript; charset=utf-8'],
    ['/js/errors.js', 'text/javascript; charset=utf-8'],
    ['/js/language.js', 'text/javascript; charset=utf-8'],
    ['/js/components/layout.js', 'text/javascript; charset=utf-8'],
    ['/js/components/icon.js', 'text/javascript; charset=utf-8'],
    ['/js/views/chat.js', 'text/javascript; charset=utf-8'],
    ['/js/views/world-editor.js', 'text/javascript; charset=utf-8'],
  ];

  for (const [path, expectedType] of assets) {
    const response = await fetch(`${base}${path}`);
    check(response.status === 200, `${path} is served`, `status ${response.status}`);
    check(
      response.headers.get('content-type') === expectedType,
      `${path} content type`,
      String(response.headers.get('content-type')),
    );
    // A no-build client has no version manifest; without no-store a refresh can
    // mix a new index.html with a cached module and break in ways that look like
    // a dead button.
    check(
      (response.headers.get('cache-control') ?? '').includes('no-store'),
      `${path} is not cached`,
      String(response.headers.get('cache-control')),
    );
  }

  const traversal = await fetch(`${base}/../package.json`);
  check(traversal.status === 404, 'path traversal is refused', `status ${traversal.status}`);

  const html = await (await fetch(`${base}/`)).text();

  // -------------------------------------------------------------------------
  section('page structure');
  // -------------------------------------------------------------------------

  // The three panels are addressed by class; the rest are element ids.
  for (const marker of ['panel-left', 'panel-center', 'panel-right']) {
    check(html.includes(`class="panel ${marker}"`), `page contains a ${marker} panel`);
  }
  for (const marker of [
    'prompt-stack',
    'world-hits',
    'preview',
    'token-budget',
    'messages',
    'character-list',
    'world-list',
    'chat-list',
    'input',
    'btn-toggle-left',
    'btn-toggle-right',
    'btn-preview',
    'btn-settings',
  ]) {
    check(html.includes(`id="${marker}"`), `page contains #${marker}`);
  }
  check(html.includes('aria-pressed="true"'), 'the panel toggles start pressed');
  check(
    t('app.toggleLeftTitle').includes('Ctrl+B') && t('app.toggleRightTitle').includes('Ctrl+Alt+B'),
    'the panel toggles explain their shortcuts',
  );
  check(html.includes('导入世界书'), 'world import control exists');
  check(html.includes('导入角色卡'), 'character import control exists');
  check(
    /id="import-character"[^>]*accept="[^"]*\.md[^"]*\.zip/.test(html),
    'the character import also takes Agent Skills (.md / .zip)',
  );
  check(html.includes('导入记录'), 'chat log import control exists');
  // Every hidden file input in the page is wrapped in the same styled label.
  const fileInputs = (html.match(/type="file"/g) ?? []).length;
  check(
    (html.match(/class="file-button"/g) ?? []).length === fileInputs && fileInputs === 4,
    'each file input (card, world, chat log, image attach) uses the file-button treatment',
    `${fileInputs} inputs`,
  );
  check(html.includes('id="connection-status"'), 'the topbar has a connection badge slot');
  check(html.includes('id="model-picker"'), 'the topbar has a model control');
  check(html.includes('装配预览'), 'preview control exists');

  // -------------------------------------------------------------------------
  section('module layout');
  // -------------------------------------------------------------------------

  console.log(`  modules: ${relativeModules.join(', ')}`);
  check(relativeModules.includes('js/app.js'), 'there is a bootstrap module');
  check(relativeModules.includes('js/dom.js'), 'DOM helpers are their own module');
  check(relativeModules.includes('js/keys.js'), 'keyboard handling is its own module');
  check(relativeModules.includes('js/token-budget.js'), 'budget arithmetic is its own module');
  const componentCount = relativeModules.filter((name) => name.startsWith('js/components/')).length;
  const viewCount = relativeModules.filter((name) => name.startsWith('js/views/')).length;
  check(componentCount >= 8, 'components are split into their own directory', `${componentCount} components`);
  check(viewCount >= 7, 'views are split into their own directory', `${viewCount} views`);
  check(
    !relativeModules.includes('js/chat.js') && !relativeModules.includes('js/prompt.js'),
    'the superseded top-level view files are gone',
  );

  // Architecture rules, enforced rather than documented.
  const viewModules = relativeModules.filter((name) => name.startsWith('js/views/'));
  for (const name of viewModules) {
    const source = readFileSync(join(webRoot, name), 'utf8');
    const crossView = importsOf(source)
      .map((spec) => spec.specifier)
      .filter((specifier) => /^\.\.?\/.*views\//.test(specifier) || /^\.\/(characters|worlds|chats|chat|prompt|settings|world-editor)\.js$/.test(specifier));
    check(crossView.length === 0, `${name} does not import another view`, crossView.join(', '));
    check(
      !source.includes("'modal hidden'") && !source.includes('"modal hidden"'),
      `${name} does not hand-roll a modal`,
    );
  }

  for (const name of ['js/views/settings.js', 'js/views/world-editor.js']) {
    const source = readFileSync(join(webRoot, name), 'utf8');
    check(source.includes('createModal'), `${name} uses the shared modal shell`);
  }
  const editorSource = readFileSync(join(webRoot, 'js/views/world-editor.js'), 'utf8');
  check(!editorSource.includes('getElementById'), 'the world editor owns its DOM instead of using global ids');

  // -------------------------------------------------------------------------
  section('module syntax');
  // -------------------------------------------------------------------------

  for (const path of modules) {
    const source = readFileSync(path, 'utf8');
    const stripped = source
      .replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '')
      .replace(/^\s*import\s+['"][^'"]+['"];?$/gm, '')
      // `export default X` survives as a real binding rather than a bare
      // expression, so an object literal does not get parsed as a block.
      .replace(/^export\s+default\s+/gm, 'const __default = ')
      .replace(/^export\s+/gm, '');
    try {
      new Function(stripped);
      check(true, `${relative(webRoot, path)} parses`);
    } catch (error) {
      check(false, `${relative(webRoot, path)} parses`, (error as Error).message);
    }
  }

  // -------------------------------------------------------------------------
  section('import resolution');
  // -------------------------------------------------------------------------

  const exportCache = new Map<string, Set<string>>();
  const exportsOf = (path: string): Set<string> => {
    const cached = exportCache.get(path);
    if (cached) return cached;
    const names = exportedNames(readFileSync(path, 'utf8'));
    exportCache.set(path, names);
    return names;
  };

  let importCount = 0;
  for (const path of modules) {
    const label = relative(webRoot, path).replace(/\\/g, '/');
    for (const spec of importsOf(readFileSync(path, 'utf8'))) {
      if (!spec.specifier.startsWith('.')) continue;
      importCount++;
      const target = resolve(dirname(path), spec.specifier);
      const targetLabel = relative(webRoot, target).replace(/\\/g, '/');
      let available: Set<string>;
      try {
        available = exportsOf(target);
      } catch {
        check(false, `${label} line ${spec.line}: ${spec.specifier} exists`, 'file not found');
        continue;
      }
      const missing = spec.names.filter((name) => !available.has(name));
      check(
        missing.length === 0,
        `${label} line ${spec.line}: imports from ${targetLabel} resolve`,
        `missing export(s): ${missing.join(', ')}`,
      );
    }
  }
  check(importCount > 10, 'a meaningful number of imports was checked', `${importCount} imports`);

  // -------------------------------------------------------------------------
  section('dom ownership');
  // -------------------------------------------------------------------------

  const staticIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]!));

  const references = new Map<string, string[]>();
  for (const path of modules) {
    const label = relative(webRoot, path).replace(/\\/g, '/');
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/getElementById\(\s*['"`]([^'"`$]+)['"`]\s*\)/g)) {
      const id = match[1]!;
      references.set(id, [...(references.get(id) ?? []), label]);
    }
  }

  for (const [id, sources] of references) {
    check(staticIds.has(id), `#${id} exists in index.html`, `referenced by ${sources.join(', ')}`);
  }

  // -------------------------------------------------------------------------
  section('themes');
  // -------------------------------------------------------------------------

  // A theme is a palette of CSS variables, and every theme block must define the
  // whole contract: the sheet may use any token, and a theme that forgets one shows
  // up as a dark patch in the light theme instead of as an error. So the check reads
  // the sheet, collects what it uses, and requires every theme to define all of it.
  const stylesheet = readFileSync(join(webRoot, 'style.css'), 'utf8');
  const cssRules = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
  const themeSource = readFileSync(join(jsRoot, 'themes.js'), 'utf8');
  /** The ids inside one exported array of `themes.js`. */
  const idsIn = (name: string): string[] => {
    const start = themeSource.indexOf(`export const ${name}`);
    const end = themeSource.indexOf('];', start);
    return start === -1 ? [] : [...themeSource.slice(start, end).matchAll(/id:\s*'([a-z-]+)'/g)].map((m) => m[1]!);
  };
  const themeIds = idsIn('THEMES');
  const accentIds = idsIn('ACCENTS');
  check(
    themeIds.includes('system') && themeIds.includes('light') && themeIds.includes('dark'),
    'there are system, light and dark themes',
    themeIds.join(','),
  );
  check(accentIds.length >= 4, 'there are several accent schemes', accentIds.join(','));
  // An icon name that does not exist falls back to the default drawing, so a typo
  // would show a slider where a moon belongs, silently.
  for (const match of themeSource.matchAll(/icon:\s*'([a-z-]+)'/g)) {
    check(Object.hasOwn(ICON_PATHS, match[1]!), `the theme icon "${match[1]}" exists`);
  }

  /** Every `--token: value` declared in a CSS block body. */
  const tokensIn = (body: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out.set(match[1]!, match[2]!.trim());
    return out;
  };
  const blockBody = (selector: string): string => {
    const start = cssRules.indexOf(selector);
    check(start !== -1, `the stylesheet defines ${selector}`);
    if (start === -1) return '';
    return cssRules.slice(start, cssRules.indexOf('}', start));
  };

  // `:root` *is* the dark theme: with `data-theme="dark"` set that block still
  // matches, so dark needs no second copy of its palette.
  const darkTheme = tokensIn(blockBody(':root {'));
  const lightTheme = tokensIn(blockBody(":root[data-theme='light'] {"));
  const systemLight = tokensIn(blockBody(':root:not([data-theme]) {'));

  const usedTokens = new Set([...cssRules.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!));
  check(usedTokens.size > 20, 'the sheet is token-driven', `${usedTokens.size} tokens in use`);
  // Everything the sheet reads must be defined — in the stylesheet, or by the client
  // that writes it onto an element (`--swatch` is set per swatch button). That
  // catches a typo without demanding that every token be a palette entry.
  const declared = new Set([...cssRules.matchAll(/(--[a-z0-9-]+):\s*[^;]+;/g)].map((match) => match[1]!));
  for (const path of modules) {
    for (const match of readFileSync(path, 'utf8').matchAll(/(--[a-z0-9-]+):/g)) declared.add(match[1]!);
  }
  eq(
    [...usedTokens].filter((token) => !declared.has(token)),
    [],
    'every token the sheet uses is defined somewhere',
  );
  // …and every *palette* token must be defined by every theme.
  for (const token of darkTheme.keys()) {
    check(usedTokens.has(token), `the dark theme only defines tokens the sheet uses (${token})`);
    check(lightTheme.has(token), `the light theme defines ${token}`);
    check(systemLight.has(token), `the system-light palette defines ${token}`);
  }
  // Layout state is not a theme: the panel tracks belong to `.layout`, and a palette
  // carrying them would break collapsing whenever the theme changed.
  for (const track of ['--track-left', '--track-right']) {
    check(!darkTheme.has(track), `${track} is layout state, not part of a palette`);
  }
  eq(
    [...lightTheme.keys()].sort().join(','),
    [...darkTheme.keys()].sort().join(','),
    'the light theme defines exactly the same tokens as the dark one',
  );
  // The same palette twice, because CSS cannot apply one block to both "chosen" and
  // "following the system". Identical, or the two modes drift apart.
  eq(
    [...systemLight.entries()].sort().join('|'),
    [...lightTheme.entries()].sort().join('|'),
    'the system-light palette is the same as the chosen light one',
  );

  // "Keep the colours" is a promise to the user: the shipped dark palette must not
  // drift while themes are added. These are the values it had before themes existed.
  const shippedDark = {
    '--bg': '#14161a',
    '--panel': '#1b1e24',
    '--panel-2': '#22262e',
    '--line': '#2e333d',
    '--text': '#dfe3ea',
    '--muted': '#8b93a3',
    '--accent': '#7aa2f7',
    '--accent-dim': '#3d5a8a',
    '--danger': '#f7768e',
    '--ok': '#9ece6a',
    '--warn': '#e0af68',
  };
  for (const [token, value] of Object.entries(shippedDark)) {
    eq(darkTheme.get(token), value, `${token} keeps the colour it shipped with`);
  }
  check(
    /:root\s*\{[^}]*color-scheme:\s*dark/.test(cssRules),
    'the dark theme tells the browser it is dark',
  );
  check(
    /:root\[data-theme='light'\]\s*\{[^}]*color-scheme:\s*light/.test(cssRules),
    'and the light theme tells it the opposite',
  );

  // Every theme in the list needs a palette, and every palette needs an entry: a
  // theme that cannot be selected is as bad as one that cannot be rendered. Dark is
  // satisfied by `:root` itself, so it is the one id without a block of its own.
  for (const id of themeIds) {
    if (id === 'system' || id === 'dark') continue;
    check(cssRules.includes(`:root[data-theme='${id}']`), `theme "${id}" has a palette block`);
  }
  for (const match of cssRules.matchAll(/:root\[data-theme='([a-z-]+)'\]/g)) {
    check(themeIds.includes(match[1]!), `the palette for "${match[1]}" is selectable`);
  }
  check(
    /@media \(prefers-color-scheme: light\)/.test(cssRules),
    'following the system is decided by the stylesheet, without script',
  );

  // The pre-paint script exists to stop a flash, so it must run before the app
  // module — and must not grow into a second copy of the rules in themes.js.
  const bootSource = readFileSync(join(jsRoot, 'theme-boot.js'), 'utf8');
  check(bootSource.includes('teahouse.theme.v1'), 'the boot script reads the stored theme');
  check(bootSource.includes('teahouse.accent.v1'), 'and the stored accent');
  check(!bootSource.includes('import '), 'and depends on nothing');
  check(
    html.indexOf('/js/theme-boot.js') < html.indexOf('/js/app.js'),
    'the theme is applied before the app runs',
  );

  // Accents are the second axis: they override the accent family only, so they have
  // to work in both bases. That means three blocks each — dark, a chosen light, and
  // "following the system, which is light" — and the two light ones must agree.
  const accentTokens = [
    '--accent',
    '--accent-dim',
    '--accent-soft',
    '--accent-mid',
    '--accent-strong',
    '--user-bubble',
  ];
  const accentSwatchesIn = new Map(
    [...themeSource.matchAll(/id:\s*'([a-z-]+)',\s*labelKey:\s*'[^']*',\s*swatch:\s*'(#[0-9a-f]{6})'/g)].map(
      (match) => [match[1]!, match[2]!],
    ),
  );
  for (const id of accentIds) {
    if (id === 'indigo') {
      // The default accent is the base palette, so it has no blocks of its own.
      check(accentSwatchesIn.get(id) === darkTheme.get('--accent'), 'the default swatch is the base accent');
      continue;
    }
    const dark = tokensIn(blockBody(`:root[data-accent='${id}'] {`));
    const light = tokensIn(blockBody(`:root[data-accent='${id}'][data-theme='light'] {`));
    const systemLight = tokensIn(blockBody(`:root[data-accent='${id}']:not([data-theme]) {`));
    eq(
      [...dark.keys()].sort().join(','),
      [...accentTokens].sort().join(','),
      `accent "${id}" overrides the accent family and nothing else`,
    );
    eq(
      [...systemLight.entries()].sort().join('|'),
      [...light.entries()].sort().join('|'),
      `accent "${id}" looks the same whether light was chosen or followed`,
    );
    check(
      dark.get('--accent') !== light.get('--accent'),
      `accent "${id}" is adjusted for each base`,
      `${dark.get('--accent')} / ${light.get('--accent')}`,
    );
    // A swatch that does not match its palette is worse than no swatch: the button
    // has to show the colour the app will actually use.
    eq(accentSwatchesIn.get(id), dark.get('--accent'), `the swatch for "${id}" is its accent colour`);
  }
  // The dark theme defines the default accent, so every accent family member is part
  // of the theme contract even though only some themes override it.
  for (const token of accentTokens) {
    check(darkTheme.has(token), `the base palette defines ${token}`);
  }

  // -------------------------------------------------------------------------
  section('hidden state');
  // -------------------------------------------------------------------------

  // There is no global `.hidden` in this stylesheet: each component says what
  // hidden means for it. A `class: 'x hidden'` with no matching rule is invisible
  // to every other check here and to the DOM shim — the element simply never
  // disappears, which is exactly how the command palette covered the transcript
  // for good.
  const hiddenRules = new Set(
    [...stylesheet.matchAll(/\.([a-z0-9-]+)\.hidden\b/g)].map((match) => match[1]!),
  );
  const hiddenUsers = new Map<string, string>();
  for (const path of modules) {
    const label = relative(webRoot, path).replace(/\\/g, '/');
    for (const match of readFileSync(path, 'utf8').matchAll(/class:\s*'([^']*\bhidden\b[^']*)'/g)) {
      for (const token of match[1]!.split(/\s+/).filter((part) => part && part !== 'hidden')) {
        hiddenUsers.set(token, label);
      }
    }
  }
  check(hiddenUsers.size >= 3, 'the sheet-wide sweep found the components that hide', `${hiddenUsers.size}`);
  for (const [token, source] of hiddenUsers) {
    check(
      hiddenRules.has(token),
      `.${token}.hidden is defined, as ${source} assumes`,
      [...hiddenRules].join(', '),
    );
  }

  // A multi-line control in a flex row needs the whole row: the label there is
  // `flex: 1; min-width: 0`, so a `width: 100%` textarea next to it squeezes the
  // label into one character per line. That is exactly what the stop-strings row
  // did: `field-row-text` had a rule stacking it and `field-row-keys` did not.
  // Only the types each pane actually builds are required.
  const stackingFields = [
    { pane: '.settings-pane', types: ['text', 'keys'] },
    { pane: '.modal-panel.editor.character', types: ['text', 'keys', 'text-list'] },
  ];
  for (const { pane, types } of stackingFields) {
    for (const type of types) {
      const stacked = new RegExp(
        `${pane.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\.field-row-${type}[^{]*\\{[^}]*display: block`,
        's',
      );
      check(
        stacked.test(stylesheet),
        `${pane} .field-row-${type} stacks its label above the control`,
      );
    }
  }

  // -------------------------------------------------------------------------
  section('settings schema');
  // -------------------------------------------------------------------------

  // The schema is the only description of the settings form; the markup that
  // used to duplicate it (and could disagree with it) is gone. What matters
  // now is that its keys really exist on the server and that the payload it
  // builds is the shape the server merges.
  const configKeys = new Set(Object.keys(DEFAULT_CONFIG));
  const scanKeys = new Set(Object.keys(DEFAULT_CONFIG.scan));
  const memoryKeys = new Set(Object.keys(DEFAULT_CONFIG.memory));
  const vectorKeys = new Set([
    ...Object.keys(DEFAULT_CONFIG.vector),
    // `local.baseUrl` and friends address the endpoint objects one level down.
    ...Object.keys(DEFAULT_CONFIG.vector.local).map((key) => `local.${key}`),
    ...Object.keys(DEFAULT_CONFIG.vector.remote).map((key) => `remote.${key}`),
  ]);
  const ttsKeys = new Set(Object.keys(DEFAULT_CONFIG.tts));
  const retrievalKeys = new Set(Object.keys(DEFAULT_CONFIG.retrieval));
  const SCOPES = { scan: scanKeys, memory: memoryKeys, vector: vectorKeys, tts: ttsKeys, retrieval: retrievalKeys };
  const types = new Set(['line', 'password', 'text', 'number', 'boolean', 'enum', 'keys']);

  check(SETTINGS_PAGES.length >= 4, 'the settings dialog has several pages', `${SETTINGS_PAGES.length}`);
  const seenPages = new Set<string>();
  const seenKeys = new Set<string>();
  const seenPaths = new Map<string, string>();
  for (const page of SETTINGS_PAGES) {
    check(!seenPages.has(page.id), `page id "${page.id}" is unique`);
    seenPages.add(page.id);
    check(page.labelKey !== '' && page.hintKey !== '', `page "${page.id}" is labelled`);
    check(t(page.labelKey) !== page.labelKey && t(page.hintKey) !== page.hintKey, `page "${page.id}" labels resolve`);
    check(page.fields.length > 0, `page "${page.id}" has fields`);
    check(
      Object.hasOwn(ICON_PATHS, page.icon),
      `page "${page.id}" has an icon that exists`,
      String(page.icon),
    );
    for (const field of page.fields) {
      check(!seenKeys.has(field.key), `field "${field.key}" appears on one page only`);
      seenKeys.add(field.key);
      check(types.has(field.type), `field "${field.key}" has a control type`, field.type);
      check(
        field.scope === undefined || field.scope === 'config' || Object.hasOwn(SCOPES, field.scope),
        `field "${field.key}" has a known scope`,
        String(field.scope),
      );
      const section = field.scope === 'scan' || field.scope === 'memory' || field.scope === 'vector' || field.scope === 'tts' || field.scope === 'retrieval'
        ? field.scope
        : null;
      const inSection = section ? SCOPES[section] : configKeys;
      check(
        inSection.has(field.name ?? field.key),
        `field "${field.key}" exists in DEFAULT_CONFIG${section ? `.${section}` : ''}`,
        [...inSection].join(', '),
      );
      // `name` is the key a scoped field writes inside its section. Two fields
      // addressing the same path would silently overwrite each other in the
      // values map the dialog keeps (`scan.depth` and `memory.depth` nearly did).
      const path = `${section ?? 'config'}.${field.name ?? field.key}`;
      check(
        !seenPaths.has(path),
        `field "${field.key}" writes its own config path ${path}`,
        seenPaths.get(path) ?? '',
      );
      seenPaths.set(path, field.key);
      eq(pageOfField(field.key), page.id, `field "${field.key}" maps back to its page`);
    }
  }
  eq(schemaFields().length, seenKeys.size, 'every field is reachable through schemaFields()');
  check(
    SETTINGS_PAGES.some((page) => page.fields.some((field) => field.groupKey)),
    'at least one page groups its rows under headings',
  );

  const strategy = schemaFields().find((field) => field.key === 'characterStrategy');
  eq(
    (strategy?.options ?? []).map((option) => option.value),
    Object.values(INSERTION_STRATEGY),
    'the insertion-strategy options match the server constants',
  );
  check(
    schemaFields().some((field) => field.key === 'retrievalMode' && field.scope === 'retrieval'),
    'the retrieval mode is a setting',
  );
  check(
    schemaFields().some((field) => field.key === 'fullForceOnConflict' && field.scope === 'retrieval'),
    'and so is the conflict switch for full injection',
  );
  check(
    schemaFields().some((field) => field.key === 'agentMaxRounds' && field.scope === 'retrieval')
      && schemaFields().some((field) => field.key === 'agentMaxFiles' && field.scope === 'retrieval'),
    'and the agent loop caps are settings',
  );
  const modeField = schemaFields().find((field) => field.key === 'retrievalMode');
  eq(
    (modeField?.options ?? []).map((option) => option.value),
    [...RETRIEVAL_MODES],
    'the mode options match the server constant, in order',
  );
  eq(
    Object.keys(retrievalModeLabels()).sort(),
    [...RETRIEVAL_MODES].sort(),
    'every mode has exactly one client label',
  );
  // The switches the mode absorbed are gone from the UI, so nothing can set
  // them any more; their values stay readable in the config for the migration.
  check(
    !schemaFields().some((field) => field.key === 'vectorEnabled' || field.key === 'modelSelect'),
    'the retired vector/model switch fields are hidden',
  );
  const worldPage = SETTINGS_PAGES.find((page) => page.id === 'world');
  check(
    (worldPage?.extras ?? []).includes('retrievalNotice'),
    'the world page renders the migration notice',
  );
  eq(retrievalMigrationNotice(null), null, 'no config, no notice');
  eq(retrievalMigrationNotice(DEFAULT_CONFIG), null, 'no legacy switch, no notice');
  const staleVector = retrievalMigrationNotice({
    ...DEFAULT_CONFIG,
    vector: { ...DEFAULT_CONFIG.vector, enabled: true },
  });
  check(
    typeof staleVector === 'string' && staleVector.includes('向量检索'),
    'a stale vector switch is called out',
    String(staleVector),
  );
  eq(
    retrievalMigrationNotice({
      ...DEFAULT_CONFIG,
      vector: { ...DEFAULT_CONFIG.vector, enabled: true },
      retrieval: { ...DEFAULT_CONFIG.retrieval, mode: 'vector' },
    }),
    null,
    'the notice clears once the mode matches the old switch',
  );
  const staleSelect = retrievalMigrationNotice({
    ...DEFAULT_CONFIG,
    scan: { ...DEFAULT_CONFIG.scan, modelSelect: true },
  });
  check(
    typeof staleSelect === 'string' && staleSelect.includes('模型自选条目') && staleSelect.includes('模型点名'),
    'a stale model switch is named, with the mode that restores it',
    String(staleSelect),
  );
  check(
    t('hitCard.modelPicked') !== 'hitCard.modelPicked'
      && readFileSync(join(jsRoot, 'components', 'hit-card.js'), 'utf8').includes('hitCard.modelPicked'),
    'the hit panel names model-picked entries',
  );

  section('interface language');
  // -------------------------------------------------------------------------

  // A locale is a module; the registry is what the settings dropdown reads.
  const localeIds = locales().map((entry) => entry.id);
  check(
    localeIds.includes('zh-CN') && localeIds.includes('en'),
    'the shipped locales are registered',
    localeIds.join(','),
  );
  eq(locale(), 'zh-CN', 'the source locale is the default');

  // Every locale must carry exactly the source's keys, so a translation is
  // complete before it can ship, and a key added to the source fails until all
  // the others follow. Plural forms count as keys (`_one` / `_other`).
  const sourceKeys = translationKeys('zh-CN').slice().sort();
  for (const id of localeIds) {
    const keys = translationKeys(id).slice().sort();
    const missing = sourceKeys.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !sourceKeys.includes(key));
    check(
      missing.length === 0 && extra.length === 0,
      `${id} has exactly the source key set`,
      `missing: ${missing.join(', ')} | extra: ${extra.join(', ')}`,
    );
  }

  // Every key the schema asks for must resolve in every locale, so a missing
  // translation cannot ship as a bare dot-path in the dialog.
  const schemaKeys: string[] = [];
  for (const page of SETTINGS_PAGES) {
    schemaKeys.push(page.labelKey, page.hintKey);
    for (const field of page.fields) {
      schemaKeys.push(field.labelKey);
      if (field.hintKey) schemaKeys.push(field.hintKey);
      if (field.placeholderKey) schemaKeys.push(field.placeholderKey);
      if (field.groupKey) schemaKeys.push(`settings.groups.${field.groupKey}`);
      for (const option of field.options ?? []) {
        if (option.labelKey) schemaKeys.push(option.labelKey);
      }
    }
  }
  for (const id of locales().map((entry) => entry.id)) {
    setLocale(id);
    const missing = schemaKeys.filter((key) => t(key) === key);
    check(missing.length === 0, `every schema key resolves in ${id}`, missing.join(', '));
    check(
      Object.keys(retrievalModeLabels()).every((mode) => retrievalModeLabel(mode) !== `settings.retrievalModes.${mode}`),
      `retrieval modes are translated in ${id}`,
    );
    check(
      Object.keys(groupModeLabels()).every((mode) => groupModeLabel(mode) !== `settings.groupModes.${mode}`),
      `group modes are translated in ${id}`,
    );
  }

  // Static markup (index.html) declares its strings with `data-i18n*`; every key
  // it names must resolve, so a typo cannot ship as a bare dot-path in the shell.
  const htmlSource = readFileSync(join(webRoot, 'index.html'), 'utf8');
  const staticKeys = [...htmlSource.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g)].map(
    (match) => match[1]!,
  );
  for (const id of localeIds) {
    setLocale(id);
    const unresolved = staticKeys.filter((key) => t(key) === key);
    check(unresolved.length === 0, `every data-i18n key resolves in ${id}`, unresolved.join(', '));
  }

  // The pre-paint boot script carries the index.html subset of the dictionary.
  // The two must agree exactly, or the shell would flash the source language
  // where a key or value is missing.
  const i18nBootSource = readFileSync(join(jsRoot, 'i18n-boot.js'), 'utf8');
  const shellMaps = new Map<string, Record<string, string>>();
  for (const match of i18nBootSource.matchAll(/\/\* SHELL:([\w-]+) \*\/\s*SHELL\[[^\]]*\] = (\{[\s\S]*?\});/g)) {
    shellMaps.set(match[1]!, JSON.parse(match[2]!) as Record<string, string>);
  }
  const staticKeySet = [...new Set(staticKeys)].sort();
  for (const id of localeIds) {
    setLocale(id);
    const shell = shellMaps.get(id);
    check(Boolean(shell), `the boot script ships a ${id} shell`);
    if (!shell) continue;
    const keys = Object.keys(shell).sort();
    const missing = staticKeySet.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !staticKeySet.includes(key));
    check(
      missing.length === 0 && extra.length === 0,
      `the ${id} shell covers exactly the static keys`,
      `missing: ${missing.join(', ')} | extra: ${extra.join(', ')}`,
    );
    const wrong = staticKeySet.filter((key) => shell[key] !== t(key));
    check(wrong.length === 0, `the ${id} shell matches the dictionary`, wrong.join(', '));
  }

  // Every server notice a `notice(...)` call (or an SSE frame's `code`) names
  // must exist under `server.*`, or the client would silently fall back to the
  // source-language text instead of the reader's language.
  const noticeCodes = new Set<string>();
  const collectCodes = (source: string) => {
    for (const match of source.matchAll(/notice\(\s*'([^']+)'/g)) noticeCodes.add(match[1]!);
    for (const match of source.matchAll(/badRequest\([\s\S]*?,\s*'([a-z][\w]*\.[\w.]+)'/g)) noticeCodes.add(match[1]!);
  };
  const srcRoot = resolve(here, '..', 'src');
  const walkSource = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walkSource(path);
      else if (entry.name.endsWith('.ts')) collectCodes(readFileSync(path, 'utf8'));
    }
  };
  walkSource(srcRoot);
  // The generate route builds its SSE frames by hand; scan those `code` fields too.
  for (const match of readFileSync(join(srcRoot, 'routes', 'generate.ts'), 'utf8').matchAll(/(?:detail)?code:\s*'([^']+)'/g)) {
    noticeCodes.add(match[1]!);
  }
  check(noticeCodes.size > 20, 'the server names its notices', `${noticeCodes.size}`);
  const knownServerKeys = new Set(translationKeys('zh-CN'));
  setLocale('zh-CN');
  const missingCodes = [...noticeCodes].filter((code) => !knownServerKeys.has(`server.${code}`));
  check(
    missingCodes.length === 0,
    'every server notice code has a dictionary entry',
    missingCodes.join(', '),
  );

  // Interface text must live in the dictionaries. Comments are stripped first
  // (they legitimately use Chinese examples); what remains is code, string
  // literals and regexes, and any CJK there is an untranslated string unless the
  // file is one of the few that hold data, not messages.
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
  const cjkAllowlist = new Set([
    'js/commands.js', // boolean-argument aliases the user types (on/开/是…)
    'js/hits.js', // matches the server's own reason wording
    'js/settings-schema.js', // LANGUAGE_PRESETS: reply-language values, not labels
    'js/translate.js', // CJK detection regexes
    'js/i18n-boot.js', // the pre-paint shell dictionary
    'js/fonts.js', // CJK family names of installed system fonts (data, not messages)
  ]);
  const leftovers: string[] = [];
  for (const path of relativeModules) {
    if (path.startsWith('js/locales/') || cjkAllowlist.has(path)) continue;
    const code = stripComments(readFileSync(join(webRoot, path), 'utf8'));
    const hits = code.match(new RegExp(CJK, 'g'));
    if (hits) leftovers.push(`${path} (${hits.length})`);
  }
  check(leftovers.length === 0, 'no untranslated interface text outside the dictionaries', leftovers.join(', '));

  // The switch is observable and falls back rather than throwing.
  setLocale('en');
  eq(t('settings.title'), 'Settings', 'switching the locale changes the message');
  eq(t('settings.status.saved', { count: 3 }), 'Saved 3 field(s)', 'placeholders are interpolated');
  check(hasRetrievalMode('vector') && !hasRetrievalMode('nope'), 'only declared retrieval modes are known');
  check(hasGroupMode('natural') && !hasGroupMode('nope'), 'and so are the group modes');
  eq(
    Object.keys(groupModeLabels()).sort(),
    [...GROUP_MODES].sort(),
    'every group mode has exactly one client label',
  );
  eq(effectiveGroupMode('pooled'), 'pooled', 'a pinned group mode is its own effective mode');
  eq(effectiveGroupMode(undefined), 'round', 'while a missing one falls back to in-turn');
  eq(groupModeLetter('round'), 'A', 'the first mode is A');
  eq(groupModeLetter('manual'), 'E', 'and the last is E');
  eq(groupModeLabel('list'), t('settings.groupModes.list'), 'a mode label comes from the dictionary');
  eq(t('settings.extras.counting.candidates', { count: 1 }), '1 candidate', 'a count picks the one form');
  eq(t('settings.extras.counting.candidates', { count: 3 }), '3 candidates', 'and the other form');
  eq(formatNumber(1234567), '1,234,567', 'numbers use the current locale');
  setLocale('zh-CN');
  eq(t('settings.extras.counting.candidates', { count: 1 }), '1 个候选', 'the source locale stays single-form');
  eq(formatNumber(1234567), '1,234,567', 'and still groups');
  setLocale('xx-not-a-locale');
  eq(locale(), 'zh-CN', 'an unknown locale falls back to the source');
  eq(t('settings.title'), '设置', 'and the fallback renders the source text');
  eq(t('no.such.key.at.all'), 'no.such.key.at.all', 'a missing key is visible, not blank');

  // Provider presets: the table is data, and the URL matching that decides
  // which row the dialog highlights is a pure function.
  check(PROVIDERS.length >= 10, 'the provider table covers the common endpoints', `${PROVIDERS.length}`);
  eq(new Set(PROVIDERS.map((provider) => provider.id)).size, PROVIDERS.length, 'provider ids are unique');
  check(
    PROVIDERS.every((provider) => /^https?:\/\//.test(provider.baseUrl)),
    'every preset is a URL',
  );
  check(
    PROVIDERS.every((provider) =>
      INTERFACE_LANGUAGES.every(
        (lang) => localize(provider.label, lang) !== '' && localize(provider.note, lang) !== '',
      )),
    'every preset is labelled and annotated in every language',
  );
  const zhZhipu = providersPayload('', '', {}, 'zh-CN').providers.find((provider) => provider.id === 'zhipu');
  const enZhipu = providersPayload('', '', {}, 'en').providers.find((provider) => provider.id === 'zhipu');
  eq(zhZhipu?.label, '智谱 GLM', 'the payload flattens labels for the requested language');
  eq(enZhipu?.label, 'Zhipu GLM', 'in both directions');
  check(
    PROVIDERS.every((provider) =>
      provider.models.every(
        (model) =>
          model.id !== ''
          && (model.contextWindow === null || (Number.isInteger(model.contextWindow) && model.contextWindow > 0))
          && (model.maxTokens === null || (Number.isInteger(model.maxTokens) && model.maxTokens > 0)),
      )),
    'documented model limits are null or positive integers',
  );
  eq(matchProvider('https://api.deepseek.com/v1')?.id, 'deepseek', 'a full base URL matches its preset');
  eq(matchProvider('https://api.deepseek.com')?.id, 'deepseek', 'so does a bare host');
  eq(
    matchProvider('https://generativelanguage.googleapis.com/v1beta/openai')?.id,
    'gemini',
    'and a path-based base URL keeps its path',
  );
  eq(matchProvider('http://127.0.0.1:9999/v1'), null, 'an unknown endpoint matches nothing');
  eq(normalizeBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1', 'a bare host gets /v1');
  eq(
    normalizeBaseUrl('https://open.bigmodel.cn/api/paas/v4'),
    'https://open.bigmodel.cn/api/paas/v4',
    'a versioned path is left alone',
  );
  const deepseekPayload = providersPayload('https://api.deepseek.com/v1', 'deepseek-flash');
  eq(deepseekPayload.active, 'deepseek', 'the payload names the active preset');
  eq(deepseekPayload.current?.contextWindow, 1_048_576, 'and the documented window');
  eq(deepseekPayload.current?.maxTokens, 393_216, 'and the documented output cap');
  eq(
    providersPayload('http://127.0.0.1:11434/v1', 'not-a-listed-model').current,
    null,
    'an unknown model has no documented limits',
  );
  // A limit learned from an overflow error outranks the curated table, and is
  // shown even for an endpoint the table does not know.
  const learnedPayload = providersPayload('http://127.0.0.1:11434/v1', 'not-a-listed-model', {
    'http://127.0.0.1:11434/v1#not-a-listed-model': { contextWindow: 4096, maxOutput: 1024 },
  });
  eq(learnedPayload.current?.contextWindow, 4096, 'a learned window is used for an unknown model');
  eq(learnedPayload.current?.source, 'learned', 'and marked as learned');
  eq(
    providersPayload('https://api.deepseek.com/v1', 'deepseek-flash', {
      'https://api.deepseek.com/v1#deepseek-flash': { contextWindow: 32768, maxOutput: null },
    }).current?.contextWindow,
    32_768,
    'and outranks the documented number',
  );
  // What the store adopts on load: a learned window beats the table, the table
  // beats nothing, an unknown endpoint or model yields nothing.
  eq(knownContextWindow('https://api.deepseek.com/v1', 'deepseek-flash'), 1_048_576, 'the table answers for a known model');
  eq(knownContextWindow('https://api.deepseek.com/v1', 'deepseek-flash', {
    'https://api.deepseek.com/v1#deepseek-flash': { contextWindow: 2048 },
  }), 2048, 'a learned window wins over the table');
  eq(knownContextWindow('https://api.deepseek.com/v1', 'who-knows'), null, 'an unknown model has no window');
  eq(knownContextWindow('http://127.0.0.1:9999/v1', 'x'), null, 'nor has an unknown endpoint');

  // Extra connections: which endpoint a turn actually uses.
  const connConfig = { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'chat-key', model: 'deepseek-flash' };
  const connList = [
    { id: 'glm', label: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'glm-key', model: 'glm-5.3' },
  ];
  const pinned = resolveConnection(connConfig, connList, 'glm', 'deepseek-flash');
  eq(pinned.model, 'glm-5.3', 'a member connection carries its own model');
  eq(pinned.baseUrl, 'https://open.bigmodel.cn/api/paas/v4', 'its own endpoint');
  eq(pinned.apiKey, 'glm-key', 'and its own key');
  eq(pinned.label, 'GLM', 'with a label for the header');
  eq(resolveConnection(connConfig, connList, '', 'deepseek-flash').model, 'deepseek-flash', 'no pin follows the chat');
  eq(resolveConnection(connConfig, connList, '', 'deepseek-flash').id, '', 'and reports no connection');
  const stale = resolveConnection(connConfig, connList, 'deleted', 'deepseek-flash');
  eq(stale.model, 'deepseek-flash', 'a deleted connection falls back to the chat');
  eq(stale.apiKey, 'chat-key', 'with the chat key');
  // Client-side vocabulary: the label shown in the picker and the header.
  eq(connectionLabel({ items: connList }, 'glm'), 'GLM', 'the client shows the label');
  eq(connectionLabel({ items: [{ id: 'x', label: '  ', model: 'm' }] }, 'x'), 'm', 'falling back to the model');
  eq(connectionLabel({ items: [{ id: 'x', label: '', model: '' }] }, 'x'), 'x', 'then to the id');
  eq(connectionLabel({ items: connList }, 'gone'), '', 'a deleted connection reads as "follow the chat"');
  eq(connectionLabel({ items: connList }, ''), '', 'so does no pin at all');
  eq(connectionById({ items: connList }, 'glm')?.model, 'glm-5.3', 'a connection can be looked up');
  eq(connectionById({ items: connList }, 'gone'), null, 'and a missing one is null');
  check(/^c-/.test(newConnectionId()), 'a fresh connection id has the client prefix', newConnectionId());

  // The dialog must keep one size while categories are switched. There is no
  // layout engine in this environment, so the rules that make it true are
  // asserted directly: a fixed height, and the scrolling owned by the pane
  // instead of by the dialog body (which is what made it resize).
  const settingsCss = readFileSync(join(webRoot, 'style.css'), 'utf8');
  const block = (selector: string) => {
    const start = settingsCss.indexOf(`${selector} {`);
    return start === -1 ? '' : settingsCss.slice(start, settingsCss.indexOf('}', start));
  };
  check(
    /height:\s*min\(/.test(block('.modal-panel.settings')),
    'the settings dialog has a fixed height, not a content-driven one',
    block('.modal-panel.settings'),
  );
  check(
    !/max-height/.test(block('.modal-panel.settings')),
    'and no max-height that could let a short page shrink it',
  );
  check(
    /overflow:\s*hidden/.test(block('.modal-panel.settings .modal-content')),
    'the dialog body does not scroll',
    block('.modal-panel.settings .modal-content'),
  );
  check(
    /overflow-y:\s*auto/.test(block('.settings-panes')),
    'the page column is the scroll container',
    block('.settings-panes'),
  );
  check(
    /scrollbar-gutter:\s*stable/.test(block('.settings-panes')),
    'the scrollbar track is reserved, so rows do not shift sideways between pages',
  );

  const stored = valuesFromConfig(DEFAULT_CONFIG);
  eq(changedFields(stored, DEFAULT_CONFIG).length, 0, 'the stored values are not reported as changes');
  eq(changedFields({ ...stored, model: 'other' }, DEFAULT_CONFIG), ['model'], 'a changed field is reported');
  eq(changedFields({ ...stored, apiKey: '***' }, DEFAULT_CONFIG).length, 0, 'a masked secret is not a change');
  eq(changedFields({ ...stored, apiKey: 'sk-new' }, DEFAULT_CONFIG), ['apiKey'], 'a typed secret is a change');

  const edited = buildPatch({
    ...stored,
    apiKey: '***',
    outputLanguage: '',
    maxContext: '32000',
    temperature: '0.9',
    recursive: true,
    characterStrategy: 2,
  });
  eq(edited.maxContext, 32000, 'a numeric string is coerced for the payload');
  eq(edited.temperature, 0.9, 'a fractional string is coerced for the payload');
  eq(edited.scan.recursive, true, 'scan fields are nested under scan');
  eq(edited.scan.characterStrategy, 2, 'an enum is sent as the number the server stores');
  eq(edited.outputLanguage, '', 'an emptied text field is still sent');
  check(!('apiKey' in edited), 'a masked API key is left out of the payload');
  check(!('maxContext' in buildPatch({ ...stored, maxContext: '' })), 'an emptied number is omitted, not zeroed');
  check('apiKey' in buildPatch({ ...stored, apiKey: 'sk-y' }), 'a typed API key is sent');

  eq(validateValues(stored).length, 0, 'the defaults pass validation');
  const bad = validateValues({ ...stored, maxContext: 0, budgetPercent: 250 });
  eq(bad.length, 2, 'both invalid numbers are reported');
  eq(bad.find((problem) => problem.key === 'maxContext')?.pageId, 'model', 'the context window points at its page');
  eq(bad.find((problem) => problem.key === 'budgetPercent')?.pageId, 'world', 'the budget points at its page');
  eq(validateValues({ ...stored, maxContext: 'abc' }).length, 1, 'a non-numeric number field is rejected');
  const penalties = validateValues({ ...stored, frequencyPenalty: 5, presencePenalty: -3 });
  eq(penalties.length, 2, 'both penalties are range-checked');
  eq(penalties.find((problem) => problem.key === 'frequencyPenalty')?.pageId, 'model', 'on the model page');
  // The right panel writes the same knobs per chat, so the schema must own them.
  for (const key of ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty']) {
    check(
      (SETTINGS_PAGES.find((page) => page.id === 'model')?.fields ?? []).some((field) => field.key === key),
      `the model page owns ${key}`,
    );
  }

  // -------------------------------------------------------------------------
  section('panel layout');
  // -------------------------------------------------------------------------

  const layoutSource = readFileSync(join(jsRoot, 'components', 'layout.js'), 'utf8');
  check(layoutSource.includes('hide-left') && layoutSource.includes('hide-right'), 'the layout toggles grid classes');
  check(layoutSource.includes('localStorage'), 'the layout choice is remembered');
  check(layoutSource.includes("'b'") && layoutSource.includes('ctrl: true'), 'the layout toggles register shortcuts');
  const css = readFileSync(join(webRoot, 'style.css'), 'utf8');
  for (const rule of ['.layout.hide-left', '.layout.hide-right', '.panel-toggle[aria-pressed=']) {
    check(css.includes(rule), `the stylesheet defines ${rule}`);
  }
  // The bug this guards: with auto-placement, a `display: none` panel leaves the
  // grid's item list, so the remaining panels shuffle into the wrong tracks and
  // the transcript lands in the zero-width column.
  for (const [selector, column] of [
    ['.panel-left', '1'],
    ['.resizer-left', '2'],
    ['.panel-center', '3'],
    ['.resizer-right', '4'],
    ['.panel-right', '5'],
  ]) {
    const rule = new RegExp(`\\${selector}\\s*\\{[^}]*grid-column:\\s*${column}`);
    check(rule.test(css), `${selector} is pinned to grid column ${column}`);
  }
  // Resizable columns: each divider is its own gutter track with the column
  // cursor, and the page carries the two anchors the controller binds to.
  check(
    /\.layout\s*\{[^}]*--gutter-left[^}]*--gutter-right/.test(css),
    'the grid gives each divider its own gutter track',
  );
  check(/\.resizer\s*\{[^}]*cursor:\s*col-resize/.test(css), 'a divider shows the column-resize cursor');
  check(
    /\.layout\.hide-left\s*\{[^}]*--gutter-left:\s*0/.test(css) &&
      /\.layout\.hide-right\s*\{[^}]*--gutter-right:\s*0/.test(css),
    'collapsing a panel also takes its divider away',
  );
  check(
    layoutSource.includes('setPointerCapture') && layoutSource.includes('pointermove'),
    'the controller drags the dividers',
  );
  const indexSource = readFileSync(join(webRoot, 'index.html'), 'utf8');
  check(
    (indexSource.match(/class="resizer resizer-/g) ?? []).length === 2,
    'the page carries two panel dividers',
  );
  // The page must not scroll on its own: a body scrollbar next to a panel's own
  // scrollbar is two bars at the same edge. The layout takes the height the
  // topbar leaves instead of guessing it.
  check(/\.layout\s*\{[^}]*flex:\s*1/.test(css), 'the panel grid takes the height the topbar leaves');
  check(
    !/\.layout\s*\{[^}]*height:\s*calc\(/.test(css),
    'the layout no longer guesses the topbar height',
  );
  // Columns compose through variables instead of every mode and collapse writing
  // its own `grid-template-columns`. The bug this guards: the trace mode rewrote
  // the whole template with a specificity above `.layout.hide-left`, so collapsing
  // the left panel left its 300px standing and the transcript could not grow into
  // it — the panel was gone but its space was not.
  check(
    /\.layout\s*\{[^}]*grid-template-columns:\s*var\(--track-left\)[^;]*var\(--track-right\)/.test(css),
    'the layout tracks come from variables',
  );
  check(
    /\.layout\.hide-left\s*\{[^}]*--track-left:\s*0/.test(css),
    'collapsing the left panel zeroes its own track',
  );
  check(
    /\.layout\.hide-right\s*\{[^}]*--track-right:\s*0/.test(css),
    'collapsing the right panel zeroes its own track',
  );
  check(
    /\.layout\.trace-mode:not\(\.hide-right\)\s*\{[^}]*--track-right:/.test(css),
    'the trace mode widens only the right track',
  );
  check(
    !/\.layout\.(hide-left|hide-right|trace-mode)[^{]*\{[^}]*grid-template-columns:/.test(css),
    'no mode writes the whole template',
  );
  check(
    /body\s*\{[^}]*flex-direction:\s*column/.test(css),
    'the page is a flex column, so the topbar can size itself',
  );

  // -------------------------------------------------------------------------
  section('scrollbars');
  // -------------------------------------------------------------------------

  // The panels, the transcript, the dialogs and the lists all scroll, and the
  // platform scrollbar is far too heavy for a dark UI. The rules below are what
  // keeps them quiet; they are asserted so a later edit cannot quietly drop
  // them back to the default.
  const scrollbarWidth = /::-webkit-scrollbar\s*\{[^}]*width:\s*(\d+)px/.exec(css);
  const thumbCss = css.slice(css.indexOf('::-webkit-scrollbar-thumb {'), css.indexOf('::-webkit-scrollbar-thumb:hover'));
  check(scrollbarWidth !== null, 'the scrollbar has an explicit width');
  check(Number(scrollbarWidth?.[1]) <= 10, 'and it is narrow', scrollbarWidth?.[1]);
  check(thumbCss.includes('background-clip: content-box'), 'the thumb is inset into the track');
  check(thumbCss.includes('border-radius: 999px'), 'the thumb is a pill, not a slab');
  check(thumbCss.includes('var(--scroll-thumb)'), 'the thumb colour comes from the palette');
  for (const variable of ['--scroll-thumb:', '--scroll-thumb-hover:']) {
    check(css.includes(variable), `${variable} is defined with the rest of the palette`);
  }
  check(/::-webkit-scrollbar-track[^{]*\{[^}]*background:\s*transparent/.test(css), 'the track is invisible');
  check(css.includes('::-webkit-scrollbar-button'), 'the arrow buttons are removed');
  check(
    !/scrollbar-(width|color):/.test(css),
    'the standard scrollbar properties stay unset, or Chromium drops the rules above',
  );

  // -------------------------------------------------------------------------
  section('client robustness');
  // -------------------------------------------------------------------------

  const appSource = readFileSync(join(jsRoot, 'app.js'), 'utf8');
  check(appSource.includes('installErrorSurface'), 'the bootstrap installs the error surface');
  // A preview can be partial: the stream's `prompt` frame carries no `messages`,
  // and reading `.length` off it blanked the panel with a type error until the
  // page was reloaded. The panel must tolerate the missing list.
  const promptSource = readFileSync(join(jsRoot, 'views', 'prompt.js'), 'utf8');
  check(
    !/preview\.messages\.length/.test(promptSource),
    'the preview panel never reads .length off a possibly missing message list',
  );
  check(
    promptSource.includes('preview.messages ?? []'),
    'and it falls back to an empty list instead',
  );
  const errorsSource = readFileSync(join(jsRoot, 'errors.js'), 'utf8');
  check(errorsSource.includes("addEventListener('error'"), 'uncaught errors are reported');
  check(errorsSource.includes("addEventListener('unhandledrejection'"), 'rejected promises are reported');
  check(errorsSource.includes('export function guard'), 'handlers can be guarded');
  // One broken view must not disable the ones after it.
  check(
    /for \(const \[label, init\] of views\)/.test(appSource) && appSource.includes('reportError'),
    'view initialisation is isolated per view',
  );
  for (const [file, label] of [
    ['views/settings.js', 'guard(t('],
    ['views/prompt.js', "guard(t('prompt.guardPreview')"],
  ]) {
    check(
      readFileSync(join(jsRoot, file), 'utf8').includes(label),
      `${file} guards its top-level action`,
    );
  }

  // A dialog may relocate static markup into itself, which detaches it unless the
  // shell is already in the document. The modal shell now attaches at
  // construction, and no view moves a form into it any more:
  const modalSource = readFileSync(join(jsRoot, 'components', 'modal.js'), 'utf8');
  const construction = modalSource.slice(0, modalSource.indexOf('function show'));
  check(
    construction.includes('document.body.append(root)'),
    'the modal shell attaches itself at construction',
  );
  // One-shot dialogs leave the document on close instead of piling up hidden;
  // the reused editors (settings, world book, card, quick replies) keep theirs.
  for (const file of ['components/confirm.js', 'components/message.js', 'views/memory.js', 'views/group.js', 'views/regex.js', 'commands.js']) {
    const source = readFileSync(join(jsRoot, file), 'utf8');
    check(source.includes('removeOnClose: true'), `${file} drops its dialog on close`);
  }
  for (const file of ['views/world-editor.js', 'views/character-editor.js', 'views/quick-replies.js']) {
    const source = readFileSync(join(jsRoot, file), 'utf8');
    const shells = [...source.matchAll(/createModal\(\{[^}]*\}\)/gs)].map((match) => match[0]);
    check(
      shells.every((shell) => !shell.includes('removeOnClose')),
      `${file} keeps its reused editor shells`,
    );
  }
  // The settings dialog itself is reused too; only its per-open persona editor drops.
  // (Checked below, after settingsSource is read.)
  const settingsSource = readFileSync(join(jsRoot, 'views', 'settings.js'), 'utf8');  const settingsIds = [...settingsSource.matchAll(/getElementById\(\s*['"`]([^'"`]+)['"`]/g)].map(
    (match) => match[1],
  );
  eq(settingsIds, ['btn-settings'], 'the settings dialog reads only the id the page owns: its button');
  const settingsShell = settingsSource.match(/createModal\(\{[^}]*title: t\('settings\.title'\)[^}]*\}\)/s);
  check(Boolean(settingsShell) && !settingsShell[0].includes('removeOnClose'), 'the settings shell is reused');
  // The category list is a real tab list: buttons, panels, and the ARIA wiring
  // between them.
  for (const attribute of ["role: 'tablist'", "role: 'tab'", "role: 'tabpanel'", "'aria-selected'", 'settings-tab-${page.id}', 'settings-pane-${page.id}']) {
    check(settingsSource.includes(attribute), `the settings dialog declares ${attribute}`);
  }
  check(settingsSource.includes('ArrowDown'), 'the category list responds to arrow keys');
  check(settingsSource.includes('icon(page.icon'), 'each category is drawn with the icon its page declares');
  check(
    settingsSource.includes("hint: 'inline'"),
    'the settings rows show their explanation, unlike the denser entry editor',
  );
  check(settingsSource.includes("class: 'field-group'"), 'runs of related rows get a heading');
  check(settingsSource.includes('validateValues') && settingsSource.includes('showProblems'), 'an invalid value is reported before saving');
  check(settingsSource.includes('renderLanguageInstruction'), 'the reply-language page previews the real instruction');
  check(settingsSource.includes('testConnection'), 'the counting page can test the connection');

  // Both views render their controls through the shared factory, so a control
  // type exists in one place.
  for (const [source, name] of [
    [settingsSource, 'views/settings.js'],
    [editorSource, 'views/world-editor.js'],
  ] as const) {
    check(source.includes('createFieldRows'), `${name} builds its controls through components/form-field.js`);
    check(!source.includes("el('textarea'"), `${name} does not hand-roll a textarea`);
  }

  // -------------------------------------------------------------------------
  section('character card editor');
  // -------------------------------------------------------------------------

  // The editor's form and the patch endpoint must agree on the field set: a
  // field offered in the UI but dropped by the server (or the reverse) is the
  // failure this pair exists to prevent.
  eq(
    CHARACTER_FIELDS.map((field) => field.key).sort(),
    Object.keys(EDITABLE_CARD_FIELDS).sort(),
    'the card editor and the patch endpoint accept the same fields',
  );
  for (const field of CHARACTER_FIELDS) {
    check(
      t(field.labelKey) !== field.labelKey && t(field.groupKey) !== field.groupKey,
      `card field "${field.key}" is labelled and grouped`,
    );
    check(
      ['line', 'text', 'text-list', 'keys'].includes(field.type),
      `card field "${field.key}" uses a control the factory provides`,
      field.type,
    );
  }

  const cardEditorSource = readFileSync(join(jsRoot, 'views', 'character-editor.js'), 'utf8');
  check(cardEditorSource.includes('createModal'), 'the card editor uses the shared modal shell');
  check(
    cardEditorSource.includes('createFieldRows'),
    'the card editor builds its controls through components/form-field.js',
  );
  check(!cardEditorSource.includes("el('textarea'"), 'and does not hand-roll a textarea');
  check(!cardEditorSource.includes('getElementById'), 'the card editor owns its DOM');
  check(
    readFileSync(join(jsRoot, 'views', 'characters.js'), 'utf8').includes("emit('open-character-editor'"),
    'the character list asks for the editor by event, not by importing the view',
  );
  check(appSource.includes('open-character-editor'), 'and app.js is what wires the two together');
  check(
    readFileSync(join(jsRoot, 'components', 'form-field.js'), 'utf8').includes("'text-list'"),
    'the shared factory provides the repeatable text list the greetings need',
  );

  // -------------------------------------------------------------------------
  section('reply language');
  // -------------------------------------------------------------------------

  const clients = [
    { outputLanguage: '中文' },
    { outputLanguage: '火星文' },
    { outputLanguage: 'English', languageInstruction: 'Answer in {{language}}.' },
    { outputLanguage: '日本語', languageInstruction: '   ' },
    {},
    { outputLanguage: '   ' },
  ];
  for (const settings of clients) {
    eq(
      renderLanguageOnClient(settings),
      renderLanguageOnServer(settings),
      `client and server agree on the instruction for ${JSON.stringify(settings)}`,
    );
  }
  eq(
    FALLBACK_LANGUAGE_INSTRUCTION,
    DEFAULT_LANGUAGE_INSTRUCTION,
    'the client fallback wording matches the server default',
  );
  check(
    renderLanguageOnClient({ outputLanguage: '中文' }).length > 0,
    'a configured language produces an instruction',
  );
  eq(renderLanguageOnClient({}), '', 'no language produces nothing');

  // -------------------------------------------------------------------------
  section('budget arithmetic');
  // -------------------------------------------------------------------------

  eq(formatTokens(999), '999', 'three digits stay plain');
  eq(formatTokens(1400), '1.4k', 'thousands are abbreviated');
  eq(formatTokens(65536), '65.5k', 'five digits keep one decimal');
  eq(formatTokens(128000), '128k', 'past a hundred thousand it rounds');

  const roomy = describeBudget({ maxContext: 8192, responseReserve: 512, totalTokens: 1000 });
  eq(roomy.level, 'ok', 'a comfortable prompt is ok');
  eq(roomy.usable, 7680, 'the reserve is excluded from the usable window');
  eq(roomy.remaining, 6680, 'remaining is measured against the usable window');
  eq(roomy.fillPercent, 13, 'fill percent is derived from usable');

  const tight = describeBudget({ maxContext: 1000, responseReserve: 0, totalTokens: 850 });
  eq(tight.level, 'warn', 'past 80% is a warning');
  const blown = describeBudget({ maxContext: 1000, responseReserve: 0, totalTokens: 1200 });
  eq(blown.level, 'over', 'past the window is over budget');
  eq(blown.fillPercent, 100, 'the bar clamps instead of overflowing');
  eq(blown.remaining, 0, 'remaining never goes negative');
  eq(blown.percent, 120, 'the percentage keeps the overshoot visible');

  const estimated = describeCounting({ model: 'deepseek-chat', mode: 'estimate', calibrations: 0 });
  check(estimated.text.includes('deepseek-chat'), 'the estimate label names the model');
  check(estimated.text.includes('估算'), 'the estimate label says it is an estimate');
  check(estimated.text.includes('锚定'), 'an unanchored estimate says how it will be anchored');
  eq(estimated.anchored, false, 'an estimate with no provider usage is not anchored');

  // Once a request has reported usage, the label switches to the provider
  // anchor and says the composition is the only approximate half.
  const anchoredLabel = describeCounting({ model: 'deepseek-chat', mode: 'estimate', pressureTokens: 1234 });
  check(anchoredLabel.text.includes('锚定'), 'an anchored label says so');
  check(anchoredLabel.text.includes('1.2k'), 'and names the provider prompt size', anchoredLabel.text);
  eq(anchoredLabel.anchored, true, 'the provider-anchored mode is flagged');

  const exact = describeCounting({ model: 'gpt-x', mode: 'exact', calibrations: 2, divergence: 1.01 });
  eq(exact.suspicious, false, 'a matching tokenizer is not flagged');
  const mismatched = describeCounting({ model: 'gpt-x', mode: 'exact', calibrations: 2, divergence: 1.4 });
  eq(mismatched.suspicious, true, 'a diverging tokenizer is flagged');
  check(mismatched.text.includes('不匹配'), 'the mismatch is explained');

  const combined = budgetFromPreview(
    { maxContext: 4096, responseReserve: 256, model: 'deepseek-chat' },
    { totalTokens: 1024, mode: 'estimate', counting: { calibrations: 1 }, trimmed: 2, warnings: ['w'] },
  );
  eq(combined.used, 1024, 'the preview total is the used figure');
  eq(combined.usedPrefix, '~', 'an unanchored used figure is marked approximate');
  eq(combined.trimmed, 2, 'trimming is carried through');
  eq(combined.warnings.length, 1, 'warnings are carried through');
  check(combined.counting.text.includes('deepseek-chat'), 'the counting label reaches the bar');

  // Provider-anchored: the projected figure drives the bar, not the heuristic.
  const anchoredBudget = budgetFromPreview(
    { maxContext: 4096, responseReserve: 0, model: 'deepseek-chat' },
    { totalTokens: 1300, pressureTokens: 1000, projectedTokens: 1100, mode: 'estimate' },
  );
  eq(anchoredBudget.used, 1100, 'the projected figure is the used figure');
  eq(anchoredBudget.usedPrefix, '', 'an anchored used figure is not marked approximate');
  check(anchoredBudget.summary.startsWith('已用 1.1k'), 'the summary reports the anchored figure', anchoredBudget.summary);

  // The collapsible breakdown splits the used figure per channel, with the
  // window as the denominator, the entries under each channel, and an explicit
  // row for anything the channels do not account for.
  const breakdownPreview = {
    model: 'deepseek-flash',
    projectedTokens: 8200,
    imageTokens: 1024,
    images: [{ name: 'a.png', bytes: 10 }],
    itemization: [
      { identifier: 'main', name: 'Main Prompt', kind: 'static', enabled: true, tokens: 300 },
      { identifier: 'charDescription', name: 'Char Description', kind: 'static', enabled: true, tokens: 500 },
      { identifier: 'worldInfoBefore', name: 'World Info (before)', kind: 'marker', enabled: true, tokens: 2000, worldHits: [
        { uid: 0, world: 'eldenring', comment: 'Lantern District', tokens: 1500, activatedBy: 'key' },
        { uid: 3, world: 'eldenring', comment: 'Tide Bell', tokens: 500, activatedBy: 'key' },
      ] },
      { identifier: 'memory', name: 'Memory', kind: 'injection', enabled: true, tokens: 200 },
      { identifier: 'agentSkillFiles', name: 'Skill files (agent)', kind: 'static', enabled: true, tokens: 700 },
      { identifier: 'chatHistory', name: 'Chat History', kind: 'history', enabled: true, tokens: 3000, messages: [
        { role: 'user', tokens: 1000, preview: 'hello' },
        { role: 'assistant', tokens: 2000, preview: 'hi there' },
      ] },
      { identifier: 'jailbreak', name: 'Post-History Instructions', kind: 'static', enabled: false, tokens: 999 },
    ],
  };
  const breakdownBudget = budgetFromPreview({ maxContext: 100_000, responseReserve: 512 }, breakdownPreview);
  const breakdown = breakdownBudget.breakdown;
  const byKey = new Map(breakdown.rows.map((row) => [row.key, row]));
  eq(byKey.get('stack')?.tokens, 800, 'the prompt stack bucket sums its blocks');
  eq(byKey.get('world')?.tokens, 2000, 'the world bucket sums the hits');
  eq(byKey.get('memory')?.tokens, 200, 'memory is its own channel');
  eq(byKey.get('agent')?.tokens, 700, 'so are the agent-read files');
  eq(byKey.get('history')?.tokens, 3000, 'and the history');
  eq(byKey.get('images')?.tokens, 1024, 'pictures are counted at the provider estimate');
  eq(byKey.has('jailbreak'), false, 'a disabled block is not counted');
  eq(breakdown.rows.reduce((sum, row) => sum + row.tokens, 0), breakdown.used, 'the rows add up to the used figure');
  eq(byKey.get('other')?.tokens, 476, 'the unattributed remainder is said out loud');
  eq(byKey.get('world')?.percent, 2, 'the share is of the window');
  eq(byKey.get('world')?.children.length, 2, 'the world entries are listed underneath');
  eq(breakdown.usable, 99_488, 'the usable figure subtracts the reserve');
  eq(breakdown.remaining, 91_288, 'and the remaining figure is window minus reserve minus used');

  // A long history folds its smallest messages into one row instead of filling
  // the panel with a hundred lines.
  const longHistory = budgetFromPreview({ maxContext: 100_000, responseReserve: 0 }, {
    totalTokens: 780,
    itemization: [{
      identifier: 'chatHistory',
      name: 'Chat History',
      kind: 'history',
      enabled: true,
      tokens: 780,
      messages: Array.from({ length: 20 }, (_, index) => ({ role: 'user', tokens: 10 + index, preview: `m${index}` })),
    }],
  });
  const historyRow = longHistory.breakdown.rows.find((row) => row.key === 'history');
  eq(historyRow?.children.length, 12, 'only the biggest twelve messages are listed');
  eq(historyRow?.hidden, 8, 'and the rest are counted, not dropped');
  check(
    longHistory.breakdown.rows.reduce((sum, row) => sum + row.tokens, 0) === longHistory.breakdown.used,
    'the fold still adds up',
  );
  eq(tokenBreakdown(null, { maxContext: 1000 }), null, 'no preview, no breakdown');
  eq(tokenBreakdown({ totalTokens: 10, itemization: [] }, { maxContext: 0 }).rows.length, 1, 'a zero window still reports what was used');

  // -------------------------------------------------------------------------
  section('preview token attribution');
  // -------------------------------------------------------------------------

  // The assembly order is blocks first, then history. The row costs must add up
  // to the headline total, and a trimmed history must be aligned from the end
  // rather than from the (longer) untrimmed list.
  const previewFixture = {
    totalTokens: 25,
    trimmed: 0,
    messages: [
      { role: 'system', content: 'main text' },
      { role: 'system', content: 'jail text' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    ],
    itemization: [
      { identifier: 'main', kind: 'static', enabled: true, tokens: 10, content: 'main text' },
      {
        identifier: 'chatHistory',
        kind: 'history',
        enabled: true,
        tokens: 12,
        content: '',
        messages: [
          { role: 'user', tokens: 5, preview: 'u' },
          { role: 'assistant', tokens: 7, preview: 'a' },
        ],
      },
      { identifier: 'jailbreak', kind: 'static', enabled: true, tokens: 3, content: 'jail text' },
    ],
  };
  eq(attributeTokens(previewFixture), [10, 3, 5, 7], 'blocks and history are attributed per row');

  const trimmedPreview = {
    ...previewFixture,
    trimmed: 1,
    messages: [
      { role: 'system', content: 'main text' },
      { role: 'assistant', content: 'a' },
    ],
  };
  eq(attributeTokens(trimmedPreview), [10, 7], 'a trimmed history is aligned from the end');

  eq(attributeTokens(null), [], 'a missing preview attributes nothing');

  // A component that builds its own DOM must not reach into the global id space.
  const editor = readFileSync(join(jsRoot, 'views', 'world-editor.js'), 'utf8');
  check(
    !editor.includes('getElementById'),
    'the world editor owns its DOM instead of using global ids',
  );

  // -------------------------------------------------------------------------
  section('state keys');
  // -------------------------------------------------------------------------

  const apiSource = readFileSync(join(jsRoot, 'api.js'), 'utf8');
  const stateBlock = apiSource.slice(apiSource.indexOf('export const state'), apiSource.indexOf('const listeners'));
  const stateKeys = new Set([...stateBlock.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1]!));
  check(stateKeys.size > 8, 'the state object has the expected fields', `${stateKeys.size} keys`);

  const usedKeys = new Set<string>();
  for (const path of modules) {
    const source = readFileSync(path, 'utf8');
    // Only modules that actually import the shared store are checked; a module
    // with its own local `state` object is not talking about the app store.
    const importsSharedState = importsOf(source).some(
      (spec) => spec.specifier.endsWith('api.js') && spec.names.includes('state'),
    );
    if (!importsSharedState) continue;
    // `(?<![\w-])` guard: without it, the import path "empty-state.js" reads as
    // `state.js` and shows up as a bogus state field.
    for (const match of source.matchAll(/(?<![\w-])state\.(\w+)/g)) usedKeys.add(match[1]!);
  }
  const unknown = [...usedKeys].filter((key) => !stateKeys.has(key));
  check(unknown.length === 0, 'every state field the UI reads exists', unknown.join(', '));
  console.log(`  state keys: ${[...stateKeys].sort().join(', ')}`);

  // -------------------------------------------------------------------------
  section('rendering: markdown, regex, context template');
  // -------------------------------------------------------------------------

  // Markdown builds element nodes through dom.js and never innerHTML: the only
  // assignment to it in the client must stay the single outlet in dom.js itself.
  // (Comments mention the word; the pattern below only matches real writes.)
  const markdownSource = readFileSync(join(jsRoot, 'markdown.js'), 'utf8');
  check(!/\.innerHTML\s*=/.test(markdownSource), 'markdown never writes innerHTML');
  const messageSource = readFileSync(join(jsRoot, 'components', 'message.js'), 'utf8');
  check(!/\.innerHTML\s*=/.test(messageSource), 'neither does the message component');
  check(!/\.outerHTML/.test(messageSource), 'nor outerHTML');
  check(
    markdownSource.includes("rel: 'noopener'") && markdownSource.includes('https?'),
    'links are http(s) only and do not leak the opener',
  );
  check(!/\(\s*['"]javascript:/i.test(markdownSource), 'no javascript: URL anywhere in the renderer');

  // Chat math is a LaTeX subset: the Markdown renderer owns the delimiters,
  // math.js owns the inside. The parser is pure data, so it is pinned here.
  const mathSource = readFileSync(join(jsRoot, 'math.js'), 'utf8');
  check(!/\.innerHTML\s*=/.test(mathSource), 'math builds nodes, never innerHTML');
  check(markdownSource.includes('mathNodes'), 'markdown hands formulas to the math renderer');
  check(markdownSource.includes('\\[') && markdownSource.includes('$$'), 'both display delimiters are recognised');
  eq(parseMath('x^2')[0], { t: 'scripts', base: { t: 'text', s: 'x' }, sub: null, sup: [{ t: 'text', s: '2' }] }, 'a superscript attaches');
  eq(
    parseMath('\\sum_{i=1}^{n}')[0],
    {
      t: 'scripts', base: { t: 'op', name: 'sum', label: '∑' },
      sub: [{ t: 'text', s: 'i=1' }], sup: [{ t: 'text', s: 'n' }],
    },
    'both limits attach to the operator',
  );
  eq(
    parseMath('\\frac{a}{b}')[0],
    { t: 'frac', num: [{ t: 'text', s: 'a' }], den: [{ t: 'text', s: 'b' }] },
    'a fraction holds numerator and denominator',
  );
  eq(parseMath('\\sqrt[3]{x}')[0], { t: 'sqrt', n: '3', body: [{ t: 'text', s: 'x' }] }, 'a root takes its index');
  eq(parseMath('\\alpha+\\beta').map((node: any) => node.s).join(''), 'α+β', 'greek letters resolve');
  eq(parseMath('\\foo')[0], { t: 'text', s: '\\foo' }, 'an unknown command stays literal');
  eq(parseMath('a}b')[0], { t: 'text', s: 'a}b' }, 'a stray brace stays literal');
  check(parseMath('\\frac{a').length > 0, 'an unclosed group still yields nodes, never a throw');
  const cases = parseMath('\\begin{cases} a & b \\\\ c & d \\end{cases}')[0] as any;
  eq(cases.t, 'env', 'an environment parses');
  eq(cases.rows.length, 2, 'with two rows');
  eq(cases.rows[0].length, 2, 'of two cells each');
  eq(parseMath('\\begin{nope} x')[0], { t: 'text', s: '\\begin{nope}' }, 'an unknown environment stays literal');
  eq(splitBalanced('{a&b}&c', '&'), ['{a&b}', 'c'], 'cells do not split inside braces');
  eq(splitBalanced('a \\\\ b', '\\\\'), ['a ', ' b'], 'rows split on the break');
  eq(parseMath('\\left. x \\right|').map((node: any) => node.t ?? node.s), ['text', 'delim'], 'an empty side vanishes');

  // Display regex: the client copy must agree with the server on the same inputs.
  const rulePairs = [
    { pattern: 'foo', flags: 'g', replacement: 'bar', scope: 'both' as const, enabled: true },
    { pattern: '(a)(b)', flags: '', replacement: '$2$1', scope: 'display' as const, enabled: true },
    { pattern: 'x', flags: '', replacement: 'y', scope: 'prompt' as const, enabled: true },
    { pattern: 'z', flags: '', replacement: 'y', scope: 'display' as const, enabled: false },
  ];
  for (const text of ['foo ab foo', 'nothing here', 'axb']) {
    const server = serverDisplay(text, rulePairs.map((rule) => ({ id: '', name: '', ...rule })));
    const client = clientDisplay(text, rulePairs.map((rule) => ({ ...rule })));
    eq(client.text, server.text, `display regex agrees on ${JSON.stringify(text)}`);
  }

  // Context preset exchange, both directions, plus the duplicated default.
  eq(CLIENT_STORY_TEMPLATE, SERVER_STORY_TEMPLATE, 'the browser and server defaults are byte-identical');
  eq(
    parseContextPreset(JSON.stringify({ name: 'x', story_string: '{{char}}!' })),
    '{{char}}!',
    'a SillyTavern context preset yields its story_string',
  );
  eq(
    toContextPreset('{{char}}!', 'mine').story_string,
    '{{char}}!',
    'and ours exports back in the same shape',
  );
  let presetFailed = false;
  try {
    parseContextPreset(JSON.stringify({ name: 'nope' }));
  } catch {
    presetFailed = true;
  }
  check(presetFailed, 'a preset without a story_string is refused');

  // -------------------------------------------------------------------------
  section('personas, appearance, fonts');
  // -------------------------------------------------------------------------

  // The client names speakers with the same resolution the server assembles with.
  const personaFile = {
    version: 1 as const,
    activeId: 'p1',
    items: [
      { id: 'p1', name: '旅人', description: 'd1' },
      { id: 'p2', name: '旁观者', description: 'd2' },
    ],
  };
  for (const pin of ['p2', '', 'gone', null]) {
    const server = serverPersona(personaFile, pin, { name: 'CFG', description: '' }).name;
    const client = clientPersonaName(personaFile, pin ?? undefined, 'CFG');
    eq(client, server, `persona resolution agrees for pin ${JSON.stringify(pin)}`);
  }

  // The appearance page exists, owns Markdown, and carries the theme picker.
  const appearance = SETTINGS_PAGES.find((page) => page.id === 'appearance');
  check(Boolean(appearance), 'there is an appearance page');
  eq(appearance?.icon, 'palette', 'with the palette icon');
  check(
    (appearance?.fields ?? []).some((field) => field.key === 'markdown'),
    'Markdown moved there from the general page',
  );
  check(
    !(SETTINGS_PAGES.find((page) => page.id === 'general')?.fields ?? []).some((field) => field.key === 'markdown'),
    'and is gone from the general page',
  );
  check(
    (appearance?.extras ?? []).includes('appearance') && (appearance?.extras ?? []).includes('fonts'),
    'carrying the theme picker and the font picker',
  );

  // Fonts: the registry is well-formed, and file choices resolve or fall back.
  const fontIds = FONT_STACKS.map((stack) => stack.id);
  eq(new Set(fontIds).size, fontIds.length, 'every font stack has its own id');
  check(
    FONT_STACKS.every((stack) => t(stack.labelKey) !== stack.labelKey && stack.family.includes(',')),
    'every stack names a label and a fallback chain',
    fontIds.join(','),
  );
  const uploaded = [{ name: 'ZQX.woff2', family: 'ZQX', url: '/api/fonts/ZQX.woff2/file', format: 'woff2', bytes: 8 }];
  check(
    String(resolveFamily('file:ZQX.woff2', uploaded)).includes('ZQX'),
    'an uploaded file resolves to its own family',
  );
  eq(resolveFamily('file:gone.woff2', uploaded), null, 'a missing file resolves to nothing (then the default)');
  eq(resolveFamily('nope', uploaded), null, 'so does an unknown stack');
  const fontsSource = readFileSync(join(jsRoot, 'fonts.js'), 'utf8');
  check(!/\.innerHTML\s*=/.test(fontsSource), 'the font injector uses CSS text, not innerHTML');

  // -------------------------------------------------------------------------
  section('speech');
  // -------------------------------------------------------------------------

  // The voice page exists, owns its fields, and borrows nothing from the model page.
  const voice = SETTINGS_PAGES.find((page) => page.id === 'voice');
  check(Boolean(voice), 'there is a voice page');
  eq(voice?.icon, 'speech', 'with a speaker icon that exists');
  for (const key of ['ttsMode', 'ttsVoice', 'ttsRate', 'ttsBaseUrl', 'ttsKey', 'ttsModel', 'ttsOnlineVoice']) {
    check(
      (voice?.fields ?? []).some((field) => field.key === key),
      `the voice page owns ${key}`,
    );
  }
  const ttsSource = readFileSync(join(jsRoot, 'tts.js'), 'utf8');
  check(!/\.innerHTML\s*=/.test(ttsSource), 'speech builds no HTML at all');

  // The voice picker is a bare select in a flex row whose label may shrink
  // to zero width: it must carry a width-capping class, and the stylesheet
  // must cap it — long system voice names once squeezed the whole row into
  // one character per line.
  const settingsViewsSource = readFileSync(join(jsRoot, 'views', 'settings.js'), 'utf8');
  check(
    /class: 'voice-pick'/.test(settingsViewsSource),
    'the voice picker carries a width-capping class',
  );
  check(
    /\.settings-pane \.field-row > select\.voice-pick[^}]*max-width/.test(cssRules),
    'the stylesheet caps the voice picker width',
  );

  // The sprite panel can lay the current portrait behind the transcript.
  // The backdrop node lives in the static page (the id sweep pairs it with
  // the view), the sheet blurs it under a veil, and the toggle persists.
  const spriteSource = readFileSync(join(jsRoot, 'views', 'sprite.js'), 'utf8');
  check(html.includes('id="chat-backdrop"'), 'the page owns the backdrop node');
  check(/\.chat-backdrop[^{]*\{[^}]*blur/.test(cssRules), 'the sheet blurs the backdrop');
  check(
    /\.chat-backdrop\.hidden[^{]*\{[^}]*display:\s*none/.test(cssRules),
    'and can hide it',
  );
  check(spriteSource.includes('teahouse.spriteBackdrop'), 'the toggle persists per browser');

  // Smart framing is arithmetic on pixels, so it is unit-tested directly:
  // interest at the top pulls the focus up, flat grey stays centred.
  const paintRows = (rows: Array<[number, number, number]>) => {
    const data: number[] = [];
    for (const [r, g, b] of rows) for (let x = 0; x < 4; x++) data.push(r, g, b, 255);
    return data;
  };
  const topHeavy = focusFromPixels(paintRows([[200, 30, 30], [128, 128, 128], [128, 128, 128]]), 4, 3);
  check(topHeavy < 40, 'interest at the top pulls the focus up', `${topHeavy}`);
  const bottomHeavy = focusFromPixels(paintRows([[128, 128, 128], [128, 128, 128], [20, 20, 20]]), 4, 3);
  check(bottomHeavy > 60, 'and at the bottom pulls it down', `${bottomHeavy}`);
  eq(focusFromPixels(paintRows([[128, 128, 128], [128, 128, 128]]), 4, 2), 50, 'flat grey stays centred');
  eq(focusFromPixels([], 0, 0), 50, 'garbage dimensions stay centred');
  eq(nudgeFocus(50, 0), 50, 'no nudge, no move');
  eq(nudgeFocus(90, 30), 100, 'a nudge clamps to the image');
  eq(nudgeFocus(10, -30), 0, 'in either direction');

  // A voice is stored by id, or by name where the browser gives no id —
  // otherwise those options are all value "" and picking one is picking
  // the default. Reading matches the same way.
  eq(voiceKey({ voiceURI: 'u1', name: 'N1' }), 'u1', 'the id wins when there is one');
  eq(voiceKey({ voiceURI: '', name: 'N1' }), 'N1', 'without an id the name tells options apart');
  eq(voiceKey({}), '', 'nothing stored, nothing matched');
  check(matchesVoice({ voiceURI: 'u1', name: 'N1' }, 'u1'), 'reading finds the voice by id');
  check(matchesVoice({ voiceURI: '', name: 'N1' }, 'N1'), 'and by name where there is no id');
  check(!matchesVoice({ voiceURI: 'u1', name: 'N1' }, ''), 'blank never matches, so the default stays the default');
  check(!matchesVoice({ voiceURI: 'u1', name: 'N1' }, 'u2'), 'nor does another voice');

  // Markdown is stripped for ears, but the words survive.
  eq(stripForSpeech('**加粗**和`代码`'), '加粗和代码', 'markers go, words stay');
  eq(stripForSpeech('> 引用\n\n# 标题'), '引用\n标题', 'blocks flatten to lines');
  eq(stripForSpeech('[文字](https://x)'), '文字', 'links keep their label');
  eq(stripForSpeech('   '), '', 'blank stays blank');
  eq(stripForSpeech('看这个\\[\\frac{a}{b}\\]好'), '看这个 frac a b 好', 'display math reads as words');
  eq(stripForSpeech('当\\(x \\to 0\\)时'), '当 x to 0 时', 'inline math too');

  // Translation: the client decides locally with the server's rule.
  for (const [text, target] of [
    ['Hello there.', '中文'],
    ['你好。', '中文'],
    ['你好。', 'English'],
    ['Hello 你好', '中文'],
    ['Hi', ''],
  ] as [string, string][]) {
    eq(clientNeeds(text, target), serverNeeds(text, target), `translation detection agrees on ${JSON.stringify(text)}`);
  }
  eq(
    freshTranslation({ translation: { lang: '中文', text: '你好。', ofVariant: 0, ofHead: 'Hello.', ofLength: 6 } }, 'Hello.', 0, '中文'),
    '你好。',
    'a fresh cache entry is used',
  );
  eq(
    freshTranslation({ translation: { lang: '中文', text: '你好。', ofVariant: 0, ofHead: 'Hello.', ofLength: 6 } }, 'Hello!', 0, '中文'),
    null,
    'an edited source re-translates',
  );

  // Failed translations rest this session instead of hammering a dead endpoint
  // on every render; the key covers the exact text, so an edit retries.
  const attempt = translationAttemptKey({ id: 'm1' }, 'Hello there.', 0, '中文');
  check(!failedTranslation(attempt), 'a fresh attempt is not failed');
  rememberTranslationFailure(attempt);
  check(failedTranslation(attempt), 'a remembered failure blocks the retry');
  check(
    !failedTranslation(translationAttemptKey({ id: 'm1' }, 'Hello there!', 0, '中文')),
    'edited text is a new attempt',
  );
  forgetTranslationFailure({ id: 'm1' }, '中文');
  check(!failedTranslation(attempt), 'the menu retry clears it on purpose');

  // Display macros: the reading view expands with the server's pure rule.
  const macroCtx = {
    char: 'Seraphina',
    user: '旅人',
    persona: 'scholar',
    description: '',
    personality: '',
    scenario: '',
    mesExamples: '',
    variables: { tide: 'high' },
  };
  for (const text of [
    '递给{{user}}，{{char}}笑了。',
    '{{getvar::tide}}涨了',
    '{{setvar::x::1}}不动{{random::a,b}}不动{{unknown}}不动',
    '没宏',
  ]) {
    eq(clientMacros(text, macroCtx), serverMacros(text, macroCtx), `display macros agree on ${JSON.stringify(text)}`);
  }
  eq(macroCtx.variables.tide, 'high', 'and neither copy wrote anything');

  // -------------------------------------------------------------------------
  section('slash commands');
  // -------------------------------------------------------------------------

  const commandNames = COMMANDS.map((command) => command.name);
  check(COMMANDS.length >= 8, 'the registry has a working set of commands', `${COMMANDS.length}`);
  check(
    COMMANDS.every((command) => /^[a-z][a-z0-9-]*$/.test(command.name)),
    'every name is lowercase and kebab-cased',
    commandNames.join(', '),
  );
  check(
    new Set(commandNames).size === commandNames.length,
    'and unique',
    commandNames.join(', '),
  );
  check(
    COMMANDS.every(
      (command) =>
        t(command.hintKey) !== command.hintKey
        && (command.argsKey === undefined || t(command.argsKey) !== command.argsKey),
    ),
    'each one documents itself for the palette, in the dictionary',
  );
  check(
    COMMANDS.every((command) => typeof command.run === 'function'),
    'and has something to run',
  );
  for (const name of ['help', 'send', 'sys', 'new', 'model', 'world', 'export', 'fork', 'regen', 'continue', 'impersonate']) {
    check(commandNames.includes(name), `the registry offers /${name}`);
  }

  eq(isCommandLine('/'), true, 'a lone slash starts a command');
  eq(isCommandLine('/model other-model'), true, 'a command with arguments is one too');
  eq(isCommandLine('  你好  '), false, 'ordinary text is not a command');
  eq(isCommandLine('看 / 这个符号'), false, 'neither is a slash inside a sentence');
  eq(isCommandLine('//escape'), false, 'and //x stays a message, as an escape hatch');

  console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILURES'}  checks=${checks} failed=${failures}`);
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
