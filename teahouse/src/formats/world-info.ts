/**
 * World book compatibility layer.
 *
 * Reads six source shapes into the normalized `World` model and writes edits
 * back into the *original* object graph, so unknown fields survive untouched.
 *
 * Verified against SillyTavern (reference checkout at ../_ref/SillyTavern):
 *  - entry field set: `newWorldInfoEntryDefinition` (world-info.js)
 *  - format detection: `importWorldInfo` (world-info.js)
 *  - CharacterBook mapping: `convertCharacterBook` (world-info.js)
 *  - position enum: `world_info_position` (world-info.js)
 *  - logic enum: `world_info_logic` (world-info.js)
 */

import {
  DEFAULT_DEPTH,
  DEFAULT_ORDER,
  DEFAULT_WEIGHT,
  GENERATION_TRIGGERS,
  POSITION,
  SELECTIVE_LOGIC,
  asBool,
  asNullableBool,
  asNullableNumber,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  isRecord,
  type ParseResult,
  type ParseWarning,
  type Position,
  type Role,
  type SelectiveLogic,
  type SourceFormat,
  type World,
  type WorldEntry,
} from './types.ts';

/** Namespace used to persist fields a foreign format has no home for. */
const OVERFLOW_KEY = 'tavern';

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * A character card is not a world book, even though v2 cards embed a
 * `character_book`: those entries live at `data.character_book.entries`, not at
 * the top level. Mis-detecting one here is what used to produce a silent
 * zero-entry "world" that was saved and attached but could never fire.
 */
export function looksLikeCharacterCard(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  if (typeof raw.spec === 'string' && raw.spec.startsWith('chara_card')) return true;
  if (isRecord(raw.data)) {
    const data = raw.data;
    if (data.character_book !== undefined) return true;
    if (data.first_mes !== undefined || data.mes_example !== undefined || data.personality !== undefined) {
      return true;
    }
  }
  // Flat spec v1 card: a greeting with no world-info container.
  if (raw.entries === undefined && raw.first_mes !== undefined) return true;
  return false;
}

export function detectWorldFormat(raw: unknown): SourceFormat | null {
  if (Array.isArray(raw)) {
    // An array of cards is not an array of entries.
    if (raw.length > 0 && looksLikeCharacterCard(raw[0])) return null;
    return 'bare-array';
  }
  if (!isRecord(raw)) return null;
  if (looksLikeCharacterCard(raw)) return null;
  if (raw.lorebookVersion !== undefined) return 'novelai';
  if (raw.kind === 'memory') return 'agnai';
  if (raw.type === 'risu') return 'risu';
  if (raw.entries !== undefined) {
    return Array.isArray(raw.entries) ? 'character-book' : 'st-native';
  }
  return null;
}

/** Does this JSON look like a world book at all? */
export function isWorldShape(raw: unknown): boolean {
  return detectWorldFormat(raw) !== null;
}

// ---------------------------------------------------------------------------
// Field maps: normalized field -> path inside the source entry
// ---------------------------------------------------------------------------

type FieldMap = Partial<Record<keyof WorldEntry, string>>;

const ST_NATIVE_MAP: FieldMap = {
  key: 'key',
  keysecondary: 'keysecondary',
  comment: 'comment',
  content: 'content',
  constant: 'constant',
  selective: 'selective',
  selectiveLogic: 'selectiveLogic',
  order: 'order',
  position: 'position',
  depth: 'depth',
  role: 'role',
  disable: 'disable',
  ignoreBudget: 'ignoreBudget',
  probability: 'probability',
  useProbability: 'useProbability',
  group: 'group',
  groupOverride: 'groupOverride',
  groupWeight: 'groupWeight',
  useGroupScoring: 'useGroupScoring',
  scanDepth: 'scanDepth',
  caseSensitive: 'caseSensitive',
  matchWholeWords: 'matchWholeWords',
  excludeRecursion: 'excludeRecursion',
  preventRecursion: 'preventRecursion',
  delayUntilRecursion: 'delayUntilRecursion',
  sticky: 'sticky',
  cooldown: 'cooldown',
  delay: 'delay',
  matchPersonaDescription: 'matchPersonaDescription',
  matchCharacterDescription: 'matchCharacterDescription',
  matchCharacterPersonality: 'matchCharacterPersonality',
  matchCharacterDepthPrompt: 'matchCharacterDepthPrompt',
  matchScenario: 'matchScenario',
  matchCreatorNotes: 'matchCreatorNotes',
  vectorized: 'vectorized',
  automationId: 'automationId',
  outletName: 'outletName',
  triggers: 'triggers',
  addMemo: 'addMemo',
  displayIndex: 'displayIndex',
};

const CHARACTER_BOOK_MAP: FieldMap = {
  key: 'keys',
  keysecondary: 'secondary_keys',
  comment: 'comment',
  content: 'content',
  constant: 'constant',
  selective: 'selective',
  selectiveLogic: 'extensions.selectiveLogic',
  order: 'insertion_order',
  depth: 'extensions.depth',
  role: 'extensions.role',
  disable: 'enabled', // inverted, handled specially
  ignoreBudget: 'extensions.ignore_budget',
  probability: 'extensions.probability',
  useProbability: 'extensions.useProbability',
  group: 'extensions.group',
  groupOverride: 'extensions.group_override',
  groupWeight: 'extensions.group_weight',
  useGroupScoring: 'extensions.use_group_scoring',
  scanDepth: 'extensions.scan_depth',
  caseSensitive: 'extensions.case_sensitive',
  matchWholeWords: 'extensions.match_whole_words',
  excludeRecursion: 'extensions.exclude_recursion',
  preventRecursion: 'extensions.prevent_recursion',
  delayUntilRecursion: 'extensions.delay_until_recursion',
  sticky: 'extensions.sticky',
  cooldown: 'extensions.cooldown',
  delay: 'extensions.delay',
  matchPersonaDescription: 'extensions.match_persona_description',
  matchCharacterDescription: 'extensions.match_character_description',
  matchCharacterPersonality: 'extensions.match_character_personality',
  matchCharacterDepthPrompt: 'extensions.match_character_depth_prompt',
  matchScenario: 'extensions.match_scenario',
  matchCreatorNotes: 'extensions.match_creator_notes',
  vectorized: 'extensions.vectorized',
  useRegex: 'use_regex',
  automationId: 'extensions.automation_id',
  outletName: 'extensions.outlet_name',
  triggers: 'extensions.triggers',
  displayIndex: 'extensions.display_index',
};

const AGNAI_MAP: FieldMap = {
  key: 'keywords',
  comment: 'name',
  content: 'entry',
  order: 'weight',
  disable: 'enabled', // inverted
};

const RISU_MAP: FieldMap = {
  key: 'key',
  keysecondary: 'secondkey',
  comment: 'comment',
  content: 'content',
  constant: 'alwaysActive',
  selective: 'selective',
  order: 'insertorder',
  probability: 'activationPercent',
};

const NOVELAI_MAP: FieldMap = {
  key: 'keys',
  comment: 'displayName',
  content: 'text',
  order: 'contextConfig.budgetPriority',
  disable: 'enabled', // inverted
};

const FIELD_MAPS: Record<SourceFormat, FieldMap> = {
  'st-native': ST_NATIVE_MAP,
  'bare-array': ST_NATIVE_MAP,
  'character-book': CHARACTER_BOOK_MAP,
  agnai: AGNAI_MAP,
  risu: RISU_MAP,
  novelai: NOVELAI_MAP,
};

/**
 * Every normalised field. ST_NATIVE_MAP is the complete one, so it doubles as
 * the canonical field list: creating an entry has to consider all of them, not
 * just the ones a given source format happens to have a home for.
 */
const ALL_ENTRY_FIELDS = Object.keys(ST_NATIVE_MAP) as (keyof WorldEntry)[];

/** Source keys we knowingly read elsewhere or intentionally ignore. */
const KNOWN_SOURCE_KEYS: Record<SourceFormat, string[]> = {
  'st-native': ['uid', 'extensions'],
  'bare-array': ['uid', 'extensions'],
  'character-book': ['id', 'uid', 'name', 'priority', 'position', 'extensions', 'case_sensitive', 'enabled'],
  agnai: ['id', 'keywords', 'name', 'entry', 'weight', 'enabled', 'extensions'],
  risu: ['key', 'secondkey', 'comment', 'content', 'alwaysActive', 'selective', 'insertorder', 'activationPercent'],
  novelai: ['keys', 'displayName', 'text', 'enabled', 'contextConfig', 'extensions'],
};

// ---------------------------------------------------------------------------
// Path helpers (dotted paths, creating intermediate objects as needed)
// ---------------------------------------------------------------------------

function getPath(obj: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = obj;
  for (const part of path.split('.')) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cursor[part];
    if (!isRecord(next)) {
      const created: Record<string, unknown> = {};
      cursor[part] = created;
      cursor = created;
    } else {
      cursor = next;
    }
  }
  cursor[parts[parts.length - 1]!] = value;
}

function ensureRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = obj[key];
  if (isRecord(existing)) return existing;
  const created: Record<string, unknown> = {};
  obj[key] = created;
  return created;
}

// ---------------------------------------------------------------------------
// Entry reading
// ---------------------------------------------------------------------------

function normalizePosition(value: unknown, fallback: Position): Position {
  if (typeof value === 'string') {
    if (value === 'before_char') return POSITION.before;
    if (value === 'after_char') return POSITION.after;
  }
  const n = asNumber(value, fallback);
  return (n >= 0 && n <= 7 ? n : fallback) as Position;
}

function normalizeSelectiveLogic(value: unknown): SelectiveLogic {
  const n = asNumber(value, SELECTIVE_LOGIC.AND_ANY);
  return (n >= 0 && n <= 3 ? n : SELECTIVE_LOGIC.AND_ANY) as SelectiveLogic;
}

function normalizeRole(value: unknown): Role {
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (v === 'user') return 1;
    if (v === 'assistant') return 2;
    return 0;
  }
  const n = asNumber(value, 0);
  return (n >= 0 && n <= 2 ? n : 0) as Role;
}

function normalizeTriggers(value: unknown): string[] {
  const list = asStringArray(value);
  return list.filter((t) => (GENERATION_TRIGGERS as readonly string[]).includes(t));
}

/**
 * `delayUntilRecursion` is a number in the ST UI but SillyTavern's own
 * converters write booleans, where `true` means recursion level 1.
 */
function normalizeDelayUntilRecursion(value: unknown): number {
  if (value === true) return 1;
  if (value === false || value === null || value === undefined) return 0;
  const n = asNumber(value, 0);
  return n > 0 ? n : 0;
}

function readEntry(rawEntry: Record<string, unknown>, uid: number, format: SourceFormat): WorldEntry {
  const map = FIELD_MAPS[format];
  const get = (field: keyof WorldEntry): unknown => {
    const path = map[field];
    if (path === undefined) return undefined;
    return getPath(rawEntry, path);
  };

  // Foreign formats have no home for most ST fields; look in the overflow
  // namespace too, and let an explicit source field win over it.
  const overflow = asRecord(asRecord(rawEntry.extensions)[OVERFLOW_KEY]);
  const pick = (field: keyof WorldEntry): unknown => {
    const direct = get(field);
    return direct === undefined ? overflow[field] : direct;
  };

  const disableRaw = get('disable');
  const disable =
    map.disable === 'enabled' ? !asBool(disableRaw, true) : asBool(disableRaw, false);

  // character_book keeps case_sensitive both top-level (spec) and in extensions.
  // SillyTavern only reads the extensions one; we accept the spec field too.
  let caseSensitive = asNullableBool(pick('caseSensitive'));
  if (caseSensitive === null && format === 'character-book') {
    caseSensitive = asNullableBool(rawEntry.case_sensitive);
  }

  const comment = asString(pick('comment'), '');

  // Insertion position differs per format.
  // character-book: extensions.position wins, else the before_char/after_char
  // string, else `after` (matching SillyTavern's convertCharacterBook).
  let position: Position;
  if (format === 'character-book') {
    const extPosition = asRecord(rawEntry.extensions).position;
    position =
      extPosition !== undefined
        ? normalizePosition(extPosition, POSITION.before)
        : normalizePosition(rawEntry.position, POSITION.after);
  } else {
    position = normalizePosition(pick('position'), POSITION.before);
  }

  return {
    uid,
    key: asStringArray(pick('key')),
    keysecondary: asStringArray(pick('keysecondary')),
    comment,
    content: asString(pick('content'), ''),
    constant: asBool(pick('constant'), false),
    selective: asBool(pick('selective'), true),
    selectiveLogic: normalizeSelectiveLogic(pick('selectiveLogic')),
    order: asNumber(pick('order'), DEFAULT_ORDER),
    position,
    depth: asNumber(pick('depth'), DEFAULT_DEPTH),
    role: normalizeRole(pick('role')),
    disable,
    ignoreBudget: asBool(pick('ignoreBudget'), false),
    probability: asNumber(pick('probability'), 100),
    useProbability: asBool(pick('useProbability'), true),
    group: asString(pick('group'), ''),
    groupOverride: asBool(pick('groupOverride'), false),
    groupWeight: asNumber(pick('groupWeight'), DEFAULT_WEIGHT),
    useGroupScoring: asNullableBool(pick('useGroupScoring')),
    scanDepth: asNullableNumber(pick('scanDepth')),
    caseSensitive,
    matchWholeWords: asNullableBool(pick('matchWholeWords')),
    excludeRecursion: asBool(pick('excludeRecursion'), false),
    preventRecursion: asBool(pick('preventRecursion'), false),
    delayUntilRecursion: normalizeDelayUntilRecursion(pick('delayUntilRecursion')),
    sticky: asNullableNumber(pick('sticky')),
    cooldown: asNullableNumber(pick('cooldown')),
    delay: asNullableNumber(pick('delay')),
    matchPersonaDescription: asBool(pick('matchPersonaDescription'), false),
    matchCharacterDescription: asBool(pick('matchCharacterDescription'), false),
    matchCharacterPersonality: asBool(pick('matchCharacterPersonality'), false),
    matchCharacterDepthPrompt: asBool(pick('matchCharacterDepthPrompt'), false),
    matchScenario: asBool(pick('matchScenario'), false),
    matchCreatorNotes: asBool(pick('matchCreatorNotes'), false),
    vectorized: asBool(pick('vectorized'), false),
    useRegex: asBool(pick('useRegex'), false),
    automationId: asString(pick('automationId'), ''),
    outletName: asString(pick('outletName'), ''),
    triggers: normalizeTriggers(pick('triggers')),
    addMemo: asBool(pick('addMemo'), comment !== ''),
    displayIndex: asNumber(pick('displayIndex'), uid),
    extensions: asRecord(rawEntry.extensions),
    raw: rawEntry,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function bookLevel(world: Record<string, unknown>, format: SourceFormat) {
  const read = (snake: string): unknown => {
    if (format === 'character-book' || format === 'st-native' || format === 'bare-array') {
      return world[snake];
    }
    return asRecord(world.extensions)[snake];
  };
  return {
    scanDepth: asNullableNumber(read('scan_depth')),
    tokenBudget: asNullableNumber(read('token_budget')),
    recursiveScanning: asNullableBool(read('recursive_scanning')),
  };
}

export interface ParseOptions {
  id?: string;
  name?: string;
  /** Force a format instead of detecting one. */
  format?: SourceFormat;
  /**
   * Accept a book that yields zero entries. Off by default: a world book that
   * produces nothing means the shape was mis-detected, and silently saving it is
   * how an empty book ends up in the list, attached to a chat, never firing.
   */
  allowEmpty?: boolean;
}

export function parseWorldInfo(raw: unknown, options: ParseOptions = {}): ParseResult {
  const warnings: ParseWarning[] = [];
  const format = options.format ?? detectWorldFormat(raw);

  if (format === null) {
    if (looksLikeCharacterCard(raw)) {
      throw new Error(
        'this is a character card, not a world book: import it as a character instead — its embedded character_book is picked up automatically',
      );
    }
    throw new Error('unrecognized world info format: no entries/knowledge source found');
  }

  const entries: WorldEntry[] = [];
  let container: World['container'] = 'object';
  let root: Record<string, unknown> | unknown[];
  let bookRaw: Record<string, unknown>;

  if (format === 'bare-array') {
    container = 'array';
    root = raw as unknown[];
    bookRaw = {};
    (raw as unknown[]).forEach((entry, index) => {
      if (!isRecord(entry)) {
        warnings.push({ code: 'entry-not-object', message: `entry ${index} is not an object`, uid: index });
        return;
      }
      entries.push(readEntry(entry, index, format));
    });
  } else if (format === 'character-book') {
    bookRaw = raw as Record<string, unknown>;
    root = bookRaw;
    const list = Array.isArray(bookRaw.entries) ? (bookRaw.entries as unknown[]) : [];
    container = 'array';
    list.forEach((entry, index) => {
      if (!isRecord(entry)) {
        warnings.push({ code: 'entry-not-object', message: `entry ${index} is not an object`, uid: index });
        return;
      }
      // CharacterBook entries carry `id`; some publishers (e.g. the Elden Ring
      // lorebooks) use ST's `uid` instead. Accept either before falling back.
      const uid =
        entry.id !== undefined
          ? asNumber(entry.id, index)
          : entry.uid !== undefined
            ? asNumber(entry.uid, index)
            : index;
      entries.push(readEntry(entry, uid, format));
    });
  } else if (format === 'agnai') {
    bookRaw = raw as Record<string, unknown>;
    root = bookRaw;
    const list = Array.isArray(bookRaw.entries) ? (bookRaw.entries as unknown[]) : [];
    container = 'array';
    list.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      entries.push(readEntry(entry, index, format));
    });
  } else if (format === 'novelai') {
    bookRaw = raw as Record<string, unknown>;
    root = bookRaw;
    const list = Array.isArray(bookRaw.entries) ? (bookRaw.entries as unknown[]) : [];
    container = 'array';
    list.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      entries.push(readEntry(entry, index, format));
    });
  } else if (format === 'risu') {
    bookRaw = raw as Record<string, unknown>;
    root = bookRaw;
    const list = Array.isArray(bookRaw.data) ? (bookRaw.data as unknown[]) : [];
    container = 'array';
    list.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      entries.push(readEntry(entry, index, format));
    });
  } else {
    // st-native: entries is an object keyed by uid
    bookRaw = raw as Record<string, unknown>;
    root = bookRaw;
    container = 'object';
    const bag = asRecord(bookRaw.entries);
    for (const [key, entry] of Object.entries(bag)) {
      if (!isRecord(entry)) continue;
      const uid = entry.uid === undefined ? asNumber(key, entries.length) : asNumber(entry.uid, entries.length);
      entries.push(readEntry(entry, uid, format));
    }
  }

  entries.sort((a, b) => a.displayIndex - b.displayIndex || a.uid - b.uid);

  // A "world book" with nothing in it is a mis-detection, not a valid import.
  if (entries.length === 0 && options.allowEmpty !== true) {
    const containerName =
      format === 'st-native' ? 'entries (object)'
      : format === 'character-book' ? 'entries (array)'
      : format === 'risu' ? 'data (array)'
      : 'entries';
    throw new Error(
      `no entries found: format detected as ${format} but \`${containerName}\` contained no usable items`,
    );
  }

  const book = bookLevel(bookRaw, format);
  if (book.scanDepth === null && bookRaw.scan_depth !== undefined && format === 'st-native') {
    // seen in the wild on ST-native files exported by some tools
    warnings.push({ code: 'book-scan-depth', message: 'book-level scan_depth present' });
  }

  const world: World = {
    id: options.id ?? 'world',
    name: options.name ?? asString(bookRaw.name ?? (raw as Record<string, unknown>)?.name, options.id ?? 'world'),
    sourceFormat: format,
    scanDepth: book.scanDepth,
    tokenBudget: book.tokenBudget,
    recursiveScanning: book.recursiveScanning,
    extensions: { ...asRecord(bookRaw.extensions) },
    entries,
    container,
    raw: root,
  };

  return { world, warnings };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Round-trip safe: the original object graph, whitespace-normalized. */
export function serializeWorld(world: World): string {
  return `${JSON.stringify(world.raw, null, 4)}\n`;
}

/**
 * Deep-equality check used by the conformance test.
 * Formatting is normalized; structure and values must match exactly.
 */
export function worldsDeepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Writing edits back into the source graph
// ---------------------------------------------------------------------------

/** Normalized field -> source path, falling back to the overflow namespace. */
function writePathFor(format: SourceFormat, field: keyof WorldEntry): string | null {
  const path = FIELD_MAPS[format][field];
  if (path !== undefined) return path;
  // No home in this format: park it under extensions.tavern so it round-trips.
  return `extensions.${OVERFLOW_KEY}.${field}`;
}

export function setEntryField(
  world: World,
  uid: number,
  field: keyof WorldEntry,
  value: unknown,
): boolean {
  const entry = world.entries.find((candidate) => candidate.uid === uid);
  if (!entry) return false;
  const rawEntry = entry.raw;
  const format = world.sourceFormat;

  if (field === 'disable') {
    if (FIELD_MAPS[format].disable === 'enabled') {
      rawEntry.enabled = !asBool(value, false);
    } else {
      rawEntry.disable = asBool(value, false);
    }
  } else if (field === 'position') {
    // character_book reads `extensions.position` first, then the
    // before_char/after_char string. That string can only express 0 and 1, so
    // anything else (author's note, at-depth, outlets) must go to extensions.
    if (format === 'character-book') {
      const ext = asRecord(rawEntry.extensions);
      const canUseString =
        ext.position === undefined &&
        (value === POSITION.before || value === POSITION.after) &&
        typeof rawEntry.position === 'string';
      if (canUseString) {
        rawEntry.position = value === POSITION.before ? 'before_char' : 'after_char';
      } else {
        setPath(rawEntry, 'extensions.position', value);
      }
    } else {
      setPath(rawEntry, writePathFor(format, field)!, value);
    }
  } else if (field === 'key' && format === 'risu') {
    rawEntry.key = asStringArray(value).join(',');
  } else if (field === 'keysecondary' && format === 'risu') {
    rawEntry.secondkey = asStringArray(value).join(',');
  } else {
    setPath(rawEntry, writePathFor(format, field)!, value);
  }

  // Keep the live view in sync with what we just wrote.
  (entry as unknown as Record<string, unknown>)[field] = value;
  return true;
}

export function setBookField(
  world: World,
  field: 'scanDepth' | 'tokenBudget' | 'recursiveScanning',
  value: number | boolean | null,
): void {
  const snake = { scanDepth: 'scan_depth', tokenBudget: 'token_budget', recursiveScanning: 'recursive_scanning' }[field];
  const root = world.raw;
  if (Array.isArray(root)) return;

  if (world.sourceFormat === 'character-book' || world.sourceFormat === 'st-native' || world.sourceFormat === 'bare-array') {
    if (value === null) delete root[snake];
    else root[snake] = value;
  } else {
    const ext = ensureRecord(root, 'extensions');
    if (value === null) delete ext[snake];
    else ext[snake] = value;
  }
  world[field] = value as never;
}

/** Creates a brand-new raw entry object for the target format and attaches it. */
function materializeRawEntry(world: World, entry: WorldEntry): void {
  const format = world.sourceFormat;
  const map = FIELD_MAPS[format];
  const fresh: Record<string, unknown> = {};
  // The defaults for this format, used to keep a foreign entry free of noise:
  // only fields that differ from the default are parked in the overflow
  // namespace.
  const baseline = readEntry({}, entry.uid, format);
  const sameAsDefault = (a: unknown, b: unknown): boolean =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  // Every normalised field is visited, not just the ones this format maps:
  // a sparse foreign map is exactly where fields used to disappear.
  const fields = new Set<keyof WorldEntry>([...ALL_ENTRY_FIELDS, 'position']);

  for (const field of fields) {
    const value = entry[field];
    if (value === undefined) continue;

    if (field === 'disable') {
      if (map.disable === 'enabled') fresh.enabled = !entry.disable;
      else fresh.disable = entry.disable;
      continue;
    }
    if (field === 'position' && format === 'character-book') {
      if (entry.position === POSITION.before) fresh.position = 'before_char';
      else if (entry.position === POSITION.after) fresh.position = 'after_char';
      else setPath(fresh, 'extensions.position', entry.position);
      continue;
    }
    if (field === 'key' && format === 'risu') {
      fresh.key = entry.key.join(',');
      continue;
    }
    if (field === 'keysecondary' && format === 'risu') {
      fresh.secondkey = entry.keysecondary.join(',');
      continue;
    }

    const path = map[field];
    if (path !== undefined) {
      setPath(fresh, path, value);
      continue;
    }
    // No home in this format. Foreign shapes (Agnai, Risu, NovelAI) have no
    // place for most ST fields, and dropping them here is what made a newly
    // created entry lose half its settings on the next read. Anything the user
    // actually set is kept in the overflow namespace; defaults are not written,
    // so a foreign entry does not grow thirty meaningless keys.
    if (!sameAsDefault(value, baseline[field])) {
      setPath(fresh, `extensions.${OVERFLOW_KEY}.${field}`, value);
    }
  }

  entry.raw = fresh;
}

export function addEntry(world: World, patch: Partial<WorldEntry> = {}): WorldEntry {
  const maxUid = world.entries.reduce((max, entry) => Math.max(max, entry.uid), -1);
  const uid = maxUid + 1;
  const entry: WorldEntry = { ...readEntry({}, uid, world.sourceFormat), ...patch, uid, raw: {} };
  entry.displayIndex = world.entries.length;

  // Build the raw entry first, then attach that exact object to the container.
  materializeRawEntry(world, entry);
  const rawEntry = entry.raw;
  const format = world.sourceFormat;

  if (format === 'st-native') {
    ensureRecord(world.raw as Record<string, unknown>, 'entries')[String(uid)] = rawEntry;
  } else if (format === 'character-book') {
    const root = world.raw as Record<string, unknown>;
    rawEntry.id = uid;
    if (!Array.isArray(root.entries)) root.entries = [];
    (root.entries as unknown[]).push(rawEntry);
  } else if (format === 'risu') {
    const root = world.raw as Record<string, unknown>;
    if (!Array.isArray(root.data)) root.data = [];
    (root.data as unknown[]).push(rawEntry);
  } else if (format === 'bare-array') {
    (world.raw as unknown[]).push(rawEntry);
  } else {
    const root = world.raw as Record<string, unknown>;
    if (!Array.isArray(root.entries)) root.entries = [];
    (root.entries as unknown[]).push(rawEntry);
  }

  world.entries.push(entry);
  return entry;
}

export function removeEntry(world: World, uid: number): boolean {
  const index = world.entries.findIndex((entry) => entry.uid === uid);
  if (index === -1) return false;
  const entry = world.entries[index]!;
  const format = world.sourceFormat;

  if (format === 'st-native') {
    delete asRecord((world.raw as Record<string, unknown>).entries)[String(uid)];
  } else if (format === 'risu') {
    const list = (world.raw as Record<string, unknown>).data;
    if (Array.isArray(list)) list.splice(list.indexOf(entry.raw), 1);
  } else {
    const list = (world.raw as Record<string, unknown>).entries;
    if (Array.isArray(list)) list.splice(list.indexOf(entry.raw), 1);
    else if (Array.isArray(world.raw)) (world.raw as unknown[]).splice(index, 1);
  }

  world.entries.splice(index, 1);
  return true;
}

/**
 * Applies a validated patch to one entry, writing each field through the source
 * format's field map. Fields absent from the patch are left alone, so unknown
 * vocabulary in the original document survives an edit.
 */
export function updateEntry(world: World, uid: number, patch: Partial<WorldEntry>): WorldEntry {
  const entry = world.entries.find((candidate) => candidate.uid === uid);
  if (!entry) throw new Error(`entry not found: uid ${uid}`);

  for (const [field, value] of Object.entries(patch)) {
    if (field === 'uid' || field === 'raw') continue;
    setEntryField(world, uid, field as keyof WorldEntry, value);
  }
  return entry;
}

/** Copies an entry (all fields, unknown ones included) under a fresh uid. */
export function duplicateEntry(world: World, uid: number, patch: Partial<WorldEntry> = {}): WorldEntry {
  const source = world.entries.find((candidate) => candidate.uid === uid);
  if (!source) throw new Error(`entry not found: uid ${uid}`);

  const copy: Partial<WorldEntry> = { ...patch };
  for (const field of Object.keys(FIELD_MAPS[world.sourceFormat]) as (keyof WorldEntry)[]) {
    const value = source[field];
    if (value === undefined) continue;
    // Deep-copy lists so the duplicate does not share arrays with the original.
    (copy as Record<string, unknown>)[field] = Array.isArray(value) ? [...value] : value;
  }
  copy.extensions = { ...source.extensions };
  copy.comment = patch.comment ?? `${source.comment || `entry ${uid}`} (copy)`;

  const created = addEntry(world, copy);
  // addEntry materialises a fresh raw entry from the field map; carry over the
  // source's unknown keys so a duplicate is as lossless as the original.
  for (const [key, value] of Object.entries(source.raw)) {
    if (!(key in created.raw)) created.raw[key] = value;
  }
  return created;
}

export function createEmptyWorld(id: string, name = id): World {
  const entries: Record<string, unknown> = {};
  const raw: Record<string, unknown> = { entries };
  return {
    id,
    name,
    sourceFormat: 'st-native',
    scanDepth: null,
    tokenBudget: null,
    recursiveScanning: null,
    extensions: {},
    entries: [],
    container: 'object',
    raw,
  };
}

// ---------------------------------------------------------------------------
// Export as SillyTavern native
// ---------------------------------------------------------------------------

/**
 * Materializes any source format as an ST-native world file
 * (`{ entries: { "<uid>": {...} } }`), so books from other tools can be moved
 * into SillyTavern itself.
 */
export function toStNative(world: World): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const entry of world.entries) {
    const out: Record<string, unknown> = { uid: entry.uid };
    for (const field of Object.keys(ST_NATIVE_MAP) as (keyof WorldEntry)[]) {
      out[field] = entry[field];
    }
    out.extensions = entry.extensions;
    entries[String(entry.uid)] = out;
  }
  const out: Record<string, unknown> = { entries };
  if (world.scanDepth !== null) out.scan_depth = world.scanDepth;
  if (world.tokenBudget !== null) out.token_budget = world.tokenBudget;
  if (world.recursiveScanning !== null) out.recursive_scanning = world.recursiveScanning;
  return out;
}

// ---------------------------------------------------------------------------
// Field coverage report
// ---------------------------------------------------------------------------

export interface CoverageReport {
  perFormat: Record<
    string,
    {
      entries: number;
      /** Source keys that map onto a normalized field. */
      mapped: string[];
      /** Source keys we read elsewhere or intentionally ignore. */
      ignored: string[];
      /** Source keys we have never seen before. Empty is the goal. */
      unknown: string[];
    }
  >;
  unknownTotal: number;
}

/** Every source key that some field map writes to (top-level segment). */
function mappedSourceKeys(format: SourceFormat): Set<string> {
  const keys = new Set<string>();
  for (const path of Object.values(FIELD_MAPS[format])) {
    if (typeof path === 'string') keys.add(path.split('.')[0]!);
  }
  // Fields handled outside the map.
  if (FIELD_MAPS[format].disable === 'enabled') keys.add('enabled');
  if (format === 'character-book') keys.add('position');
  return keys;
}

/**
 * Source keys in this book that the compatibility layer neither maps nor
 * knowingly ignores. An empty result means every field of every entry is
 * accounted for — either read, or deliberately preserved as opaque data.
 */
export function unknownFieldsOf(world: World): string[] {
  const mapped = mappedSourceKeys(world.sourceFormat);
  const ignored = new Set(KNOWN_SOURCE_KEYS[world.sourceFormat]);
  const unknown = new Set<string>();
  for (const entry of world.entries) {
    for (const key of Object.keys(entry.raw)) {
      if (!mapped.has(key) && !ignored.has(key)) unknown.add(key);
    }
  }
  return [...unknown].sort();
}

export function fieldCoverage(worlds: World[]): CoverageReport {
  const perFormat: CoverageReport['perFormat'] = {};
  let unknownTotal = 0;

  for (const world of worlds) {
    const format = world.sourceFormat;
    const bucket = (perFormat[format] ??= { entries: 0, mapped: [], ignored: [], unknown: [] });
    const mapped = mappedSourceKeys(format);
    const ignored = new Set(KNOWN_SOURCE_KEYS[format]);

    for (const entry of world.entries) {
      bucket.entries++;
      for (const key of Object.keys(entry.raw)) {
        if (mapped.has(key)) {
          if (!bucket.mapped.includes(key)) bucket.mapped.push(key);
        } else if (ignored.has(key)) {
          if (!bucket.ignored.includes(key)) bucket.ignored.push(key);
        } else if (!bucket.unknown.includes(key)) {
          bucket.unknown.push(key);
          unknownTotal++;
        }
      }
    }
  }

  for (const bucket of Object.values(perFormat)) {
    bucket.mapped.sort();
    bucket.ignored.sort();
    bucket.unknown.sort();
  }

  return { perFormat, unknownTotal };
}
