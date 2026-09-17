/**
 * Normalized internal model.
 *
 * Design rule: `raw` is the source of truth. Everything else in this file is a
 * *lens* over `raw`. The engine only ever reads the normalized shape, so no
 * source-format difference (`key` vs `keys` vs `keywords`) leaks past this layer,
 * and untouched fields survive an import/export round trip exactly.
 */

// ---------------------------------------------------------------------------
// World books
// ---------------------------------------------------------------------------

export const SOURCE_FORMATS = [
  'st-native', // SillyTavern world file: entries is an object keyed by uid
  'character-book', // spec_v2 CharacterBook shape: entries is an array (keys/secondary_keys)
  'agnai', // kind === 'memory'
  'risu', // type === 'risu'
  'novelai', // lorebookVersion !== undefined
  'bare-array', // just an array of entries
] as const;

export type SourceFormat = (typeof SOURCE_FORMATS)[number];

/** selectiveLogic, as in SillyTavern's `world_info_logic`. */
export const SELECTIVE_LOGIC = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
} as const;
export type SelectiveLogic = 0 | 1 | 2 | 3;

/** Insertion position, as in SillyTavern's `world_info_position`. */
export const POSITION = {
  before: 0, // before character definitions
  after: 1, // after character definitions
  ANTop: 2, // author's note, top
  ANBottom: 3, // author's note, bottom
  atDepth: 4, // absolute depth in chat
  EMTop: 5, // example messages, top
  EMBottom: 6, // example messages, bottom
  outlet: 7, // named outlet (extensions only)
} as const;
export type Position = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const ROLE = { SYSTEM: 0, USER: 1, ASSISTANT: 2 } as const;
export type Role = 0 | 1 | 2;

export const GENERATION_TRIGGERS = [
  'normal',
  'continue',
  'impersonate',
  'swipe',
  'regenerate',
  'quiet',
] as const;
export type GenerationTrigger = (typeof GENERATION_TRIGGERS)[number];

export const DEFAULT_DEPTH = 4;
export const DEFAULT_ORDER = 100;
export const DEFAULT_WEIGHT = 100;
export const MAX_INJECTION_DEPTH = 10000;

export interface WorldEntry {
  uid: number;
  key: string[];
  keysecondary: string[];
  comment: string;
  content: string;
  constant: boolean;
  selective: boolean;
  selectiveLogic: SelectiveLogic;
  order: number;
  position: Position;
  depth: number;
  role: Role;
  disable: boolean;
  ignoreBudget: boolean;
  probability: number;
  useProbability: boolean;
  group: string;
  groupOverride: boolean;
  groupWeight: number;
  useGroupScoring: boolean | null;
  scanDepth: number | null;
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: number;
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  matchPersonaDescription: boolean;
  matchCharacterDescription: boolean;
  matchCharacterPersonality: boolean;
  matchCharacterDepthPrompt: boolean;
  matchScenario: boolean;
  matchCreatorNotes: boolean;
  vectorized: boolean;
  /**
   * Present on CharacterBook entries that SillyTavern itself exports
   * (`use_regex: true // ST keys are always regex`). Preserved verbatim.
   * Note: SillyTavern's own scanner never reads this field, so neither does
   * ours beyond round-tripping it. Regex keys are detected the ST way, by
   * slash-delimiting: `/pattern/flags`.
   */
  useRegex: boolean;
  automationId: string;
  outletName: string;
  triggers: string[];
  addMemo: boolean;
  displayIndex: number;
  extensions: Record<string, unknown>;

  /**
   * Live reference to the source object this entry was read from.
   * Writes go through `setEntryField`, which uses this plus the source format's
   * field map, so unknown/extra fields are never dropped.
   */
  raw: Record<string, unknown>;
}

export interface World {
  /** File id (name without extension). */
  id: string;
  name: string;
  sourceFormat: SourceFormat;
  /** Book-level overrides. `null` means "fall back to global settings". */
  scanDepth: number | null;
  tokenBudget: number | null;
  recursiveScanning: boolean | null;
  extensions: Record<string, unknown>;
  entries: WorldEntry[];
  /** Where entries live inside `raw`, so patches can be written back. */
  container: 'object' | 'array' | 'card';
  /** Original parsed JSON, untouched. Serialization is just JSON.stringify(raw). */
  raw: Record<string, unknown> | unknown[];
}

export interface ParseWarning {
  code: string;
  message: string;
  uid?: number;
}

export interface ParseResult {
  world: World;
  warnings: ParseWarning[];
}

// ---------------------------------------------------------------------------
// Character cards
// ---------------------------------------------------------------------------

export const CARD_SPECS = ['v1', 'v2', 'v3'] as const;
export type CardSpec = (typeof CARD_SPECS)[number];

export interface DepthPrompt {
  prompt: string;
  depth: number;
  role: string;
}

export interface CharacterCard {
  id: string;
  spec: CardSpec;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  tags: string[];
  creator: string;
  character_version: string;
  extensions: Record<string, unknown>;
  depthPrompt: DepthPrompt | null;
  /** Character books embedded in the card, already normalized. */
  books: World[];
  /** Raw parsed card JSON, untouched (v2/v3 shape; v1 is upgraded on the fly). */
  raw: Record<string, unknown>;
  warnings: ParseWarning[];
}

export interface CardParseResult {
  card: CharacterCard;
  /** Original image bytes when the card came from a PNG. */
  image: Buffer | null;
}

// ---------------------------------------------------------------------------
// Helpers shared by the format layer
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
  }
  return fallback;
}

export function asNullableBool(value: unknown): boolean | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return null;
}

/** Accepts an array, a comma-separated string, or a single value. */
export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
  }
  return [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
