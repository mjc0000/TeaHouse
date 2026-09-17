/**
 * World book scanner.
 *
 * A faithful port of SillyTavern's `checkWorldInfo` / `WorldInfoBuffer`
 * (public/scripts/world-info.js). Every rule below cites the reference so the
 * behaviour can be re-checked against the source rather than trusted.
 *
 * Differences from a naive implementation that would silently change triggers:
 *   - the token budget is a PERCENTAGE of the context window, not an entry count
 *   - keys may be slash-delimited regexes, which override case/whole-word options
 *   - whole-word matching only applies boundaries to single-word keys
 *   - the haystack joins messages with "\n\x01" so word boundaries work across them
 *   - recursion, min-activations and delayed recursion are one state machine
 *   - inclusion groups are decided by sticky > already-activated > override > score > weighted roll
 */

import { parseRegexFromString } from '../formats/key-list.ts';
import {
  DEFAULT_WEIGHT,
  POSITION,
  SELECTIVE_LOGIC,
  type Position,
  type Role,
  type WorldEntry,
} from '../formats/types.ts';
import { estimateTextTokens } from './tokens.ts';

// ---------------------------------------------------------------------------
// Constants (mirrors of the ST source)
// ---------------------------------------------------------------------------

export const SCAN_STATE = {
  NONE: 0,
  INITIAL: 1,
  RECURSION: 2,
  MIN_ACTIVATIONS: 3,
} as const;
export type ScanState = (typeof SCAN_STATE)[keyof typeof SCAN_STATE];

/** ST: `const MATCHER = '\x01'; const JOINER = '\n' + MATCHER;` */
const MATCHER = '\x01';
const JOINER = `\n${MATCHER}`;

/** ST: `MAX_SCAN_DEPTH = 1000` */
export const MAX_SCAN_DEPTH = 1000;

/** ST: `KNOWN_DECORATORS = ['@@activate', '@@dont_activate']` */
const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'] as const;

/** ST: `world_info_insertion_strategy` — how multiple books interleave. */
export const INSERTION_STRATEGY = { evenly: 0, character_first: 1, global_first: 2 } as const;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ScanSettings {
  /** `world_info_depth`, default 2. Base scan depth in messages. */
  depth: number;
  /** `world_info_budget`, default 25. PERCENT of the context window. */
  budgetPercent: number;
  /** `world_info_budget_cap`, default 0 (no cap). Absolute token ceiling. */
  budgetCap: number;
  /** `world_info_recursive`, default false. */
  recursive: boolean;
  /** `world_info_max_recursion_steps`, default 0 (unlimited). */
  maxRecursionSteps: number;
  /** `world_info_min_activations`, default 0 (disabled). */
  minActivations: number;
  /** `world_info_min_activations_depth_max`, default 0 (no limit). */
  minActivationsDepthMax: number;
  /** `world_info_include_names`, default true. Prefix messages with the speaker. */
  includeNames: boolean;
  /** `world_info_case_sensitive`, default false. */
  caseSensitive: boolean;
  /** `world_info_match_whole_words`, default false. */
  matchWholeWords: boolean;
  /** `world_info_use_group_scoring`, default false. */
  useGroupScoring: boolean;
  /** `world_info_character_strategy`, default character_first. */
  characterStrategy: number;
  /** The model's context window; the budget percentage is applied to this. */
  maxContext: number;
}

export const DEFAULT_SCAN_SETTINGS: ScanSettings = {
  depth: 2,
  budgetPercent: 25,
  budgetCap: 0,
  recursive: false,
  maxRecursionSteps: 0,
  minActivations: 0,
  minActivationsDepthMax: 0,
  includeNames: true,
  caseSensitive: false,
  matchWholeWords: false,
  useGroupScoring: false,
  characterStrategy: INSERTION_STRATEGY.character_first,
  maxContext: 8192,
};

export interface ScanMessage {
  name: string;
  content: string;
}

/** ST's `WIGlobalScanData`: extra text an entry may opt into scanning. */
export interface ScanGlobalData {
  personaDescription?: string;
  characterDescription?: string;
  characterPersonality?: string;
  characterDepthPrompt?: string;
  scenario?: string;
  creatorNotes?: string;
}

export interface ScanEntry {
  /** Book id, used for identity and for `world.uid` keys. */
  world: string;
  /** Whether this book was attached to the character (affects insertion order). */
  fromCharacter?: boolean;
  entry: WorldEntry;
}

export type GenerationTrigger = 'normal' | 'continue' | 'impersonate' | 'swipe' | 'regenerate' | 'quiet';

/** A timed effect window, in chat message counts. */
export interface TimedEffect {
  start: number;
  end: number;
  protected?: boolean;
}

/**
 * Per-entry timed effects, keyed `<world>.<uid>`.
 * Sticky/cooldown are stored per chat, never written into the world file.
 */
export type TimedEffectMap = Record<
  string,
  { sticky?: TimedEffect; cooldown?: TimedEffect; delay?: TimedEffect }
>;

export interface ScanInput {
  entries: ScanEntry[];
  messages: ScanMessage[];
  global?: ScanGlobalData;
  settings?: Partial<ScanSettings>;
  trigger?: GenerationTrigger;
  timedEffects?: TimedEffectMap;
  /** Total messages in the chat; drives delay/sticky/cooldown windows. */
  chatLength?: number;
  /** Injectable token counter, so budgets are exact when a tokenizer exists. */
  tokenCount?: (text: string) => number;
  /** Injectable RNG for deterministic tests. */
  random?: () => number;
  /**
   * Entries another channel already activated (vector storage). Treated exactly
   * like a hit the scanner produced, minus the keyword-event side effects.
   */
  external?: ExternalActivation[];
}

/** An entry activated from outside the keyword scan, with why. */
export interface ExternalActivation {
  world: string;
  uid: number;
  /** Cosine similarity, shown in the "why did this fire" panel. */
  score?: number;
  /** Which outside channel decided this: vector storage, the model, or "inject all". */
  source?: 'vector' | 'model' | 'full';
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface ScanHit {
  world: string;
  uid: number;
  comment: string;
  content: string;
  tokens: number;
  order: number;
  position: Position;
  depth: number;
  role: Role;
  group: string;
  /** Which primary keys matched, for the UI's "why did this trigger" panel. */
  matchedKeys: string[];
  matchedSecondaryKeys: string[];
  activatedBy: 'constant' | 'key' | 'sticky' | 'external' | 'decorator';
  /** Cosine similarity, for hits that came from vector storage. */
  score?: number;
  /** Which outside channel fired it, for the "why did this fire" panel. */
  source?: 'vector' | 'model' | 'full';
  /** Which scan loop produced it: 1 = initial, >1 = recursion/min-activations. */
  loop: number;
  isRecursion: boolean;
  ignoreBudget: boolean;
}

export interface ScanBuckets {
  before: ScanHit[];
  after: ScanHit[];
  anTop: ScanHit[];
  anBottom: ScanHit[];
  emTop: ScanHit[];
  emBottom: ScanHit[];
  /** Absolute-depth injections, keyed `${depth}:${role}`. */
  atDepth: { depth: number; role: Role; hits: ScanHit[] }[];
  /** Position 7: named outlets. */
  outlets: Record<string, ScanHit[]>;
}

export interface ScanResult {
  buckets: ScanBuckets;
  /** Every activated entry, in activation order. */
  hits: ScanHit[];
  overflowed: boolean;
  /** Tokens the budget allowed this pass. */
  budget: number;
  tokensUsed: number;
  loops: number;
  /** Entries excluded by disable/triggers/keys, for diagnostics. */
  skipped: { world: string; uid: number; reason: string }[];
}

// ---------------------------------------------------------------------------
// Key matching (ST `matchKeys`)
// ---------------------------------------------------------------------------

// Key *syntax* (what counts as a regex key, how a key list splits) belongs to the
// format layer; matching belongs here. Re-exported so callers keep one import.
export { parseRegexFromString };

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function transform(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLowerCase();
}

export interface MatchOptions {
  caseSensitive: boolean;
  matchWholeWords: boolean;
}

/** ST `WorldInfoBuffer.matchKeys`. */
export function matchKey(haystack: string, needle: string, options: MatchOptions): boolean {
  const keyRegex = parseRegexFromString(needle);
  if (keyRegex) return keyRegex.test(haystack);

  const hay = transform(haystack, options.caseSensitive);
  const transformed = transform(needle, options.caseSensitive);

  if (options.matchWholeWords) {
    const keyWords = transformed.split(/\s+/);
    if (keyWords.length > 1) {
      // Multi-word phrases degrade to a plain substring check.
      return hay.includes(transformed);
    }
    const regex = new RegExp(`(?:^|\\W)(${escapeRegex(transformed)})(?:$|\\W)`);
    return regex.test(hay);
  }

  return hay.includes(transformed);
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

interface Candidate {
  item: ScanEntry;
  matchedKeys: string[];
  matchedSecondaryKeys: string[];
  activatedBy: ScanHit['activatedBy'];
  key: string;
  loop: number;
}

export function scanWorldInfo(input: ScanInput): ScanResult {
  const settings: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, ...input.settings };
  const globalData = input.global ?? {};
  const trigger: GenerationTrigger = input.trigger ?? 'normal';
  const tokenCount = input.tokenCount ?? estimateTextTokens;
  const random = input.random ?? Math.random;
  const timedEffects = input.timedEffects ?? {};
  const chatLength = input.chatLength ?? input.messages.length;

  const skipped: ScanResult['skipped'] = [];
  const entries = sortEntries(input.entries, settings);

  // `budget = Math.round(world_info_budget * maxContext / 100) || 1`, then cap.
  let budget = Math.round((settings.budgetPercent * settings.maxContext) / 100) || 1;
  if (settings.budgetCap > 0 && budget > settings.budgetCap) budget = settings.budgetCap;

  // Newest-first buffer, like ST's `#depthBuffer`.
  const depthBuffer = [...input.messages].reverse().map((message) => {
    if (!settings.includeNames) return message.content;
    return message.name ? `${message.name}: ${message.content}` : message.content;
  });

  let skew = 0;
  const recurseBuffer: string[] = [];
  const injectBuffer: string[] = [];

  const getHaystack = (entry: WorldEntry, state: ScanState): string => {
    const baseDepth = settings.depth + skew;
    const depth = entry.scanDepth ?? baseDepth;
    if (depth <= 0) return MATCHER;
    if (depth < 0) return MATCHER;

    const clamped = Math.min(depth, MAX_SCAN_DEPTH);
    let result = MATCHER + depthBuffer.slice(0, clamped).join(JOINER);

    if (entry.matchPersonaDescription && globalData.personaDescription) {
      result += JOINER + globalData.personaDescription;
    }
    if (entry.matchCharacterDescription && globalData.characterDescription) {
      result += JOINER + globalData.characterDescription;
    }
    if (entry.matchCharacterPersonality && globalData.characterPersonality) {
      result += JOINER + globalData.characterPersonality;
    }
    if (entry.matchCharacterDepthPrompt && globalData.characterDepthPrompt) {
      result += JOINER + globalData.characterDepthPrompt;
    }
    if (entry.matchScenario && globalData.scenario) {
      result += JOINER + globalData.scenario;
    }
    if (entry.matchCreatorNotes && globalData.creatorNotes) {
      result += JOINER + globalData.creatorNotes;
    }
    if (injectBuffer.length > 0) {
      result += JOINER + injectBuffer.join(JOINER);
    }
    // Min activations must not see the recursion buffer.
    if (recurseBuffer.length > 0 && state !== SCAN_STATE.MIN_ACTIVATIONS) {
      result += JOINER + recurseBuffer.join(JOINER);
    }
    return result;
  };

  /** ST `WorldInfoBuffer.getScore`: only AND_ANY counts secondary matches. */
  const getScore = (entry: WorldEntry, state: ScanState): number => {
    const hay = getHaystack(entry, state);
    const options = optionsFor(entry);
    let primary = 0;
    for (const key of entry.key) if (matchKey(hay, key, options)) primary++;
    if (entry.key.length === 0) return 0;

    let secondary = 0;
    for (const key of entry.keysecondary) if (matchKey(hay, key, options)) secondary++;

    if (entry.keysecondary.length > 0 && entry.selectiveLogic === SELECTIVE_LOGIC.AND_ANY) {
      return primary + secondary;
    }
    return primary;
  };

  const optionsFor = (entry: WorldEntry): MatchOptions => ({
    caseSensitive: entry.caseSensitive ?? settings.caseSensitive,
    matchWholeWords: entry.matchWholeWords ?? settings.matchWholeWords,
  });

  // --- timed effects -------------------------------------------------------

  const effectActive = (type: 'sticky' | 'cooldown', key: string): boolean => {
    const effect = timedEffects[key]?.[type];
    if (!effect) return false;
    return chatLength >= effect.start && chatLength <= effect.end;
  };

  /** ST's delay rule, shared by the scan loop and the inclusion-group filter. */
  const isDelayed = (entry: WorldEntry): boolean =>
    entry.delay !== null && entry.delay > 0 && chatLength < entry.delay;

  // --- main loop (ST's `while (scanState)`) --------------------------------

  const allActivated = new Map<string, ScanHit>();
  const failedProbability = new Set<string>();
  let allActivatedText = '';
  let overflowed = false;
  let loops = 0;
  let state: ScanState = SCAN_STATE.INITIAL;

  const delayLevels = [
    ...new Set(
      entries
        .map((item) => item.entry.delayUntilRecursion)
        .filter((level) => level > 0),
    ),
  ].sort((a, b) => a - b);
  let currentDelayLevel = delayLevels.shift() ?? 0;

  // --- external activations (vector storage) -------------------------------

  // Entries another channel already decided on — today that is vector storage.
  // SillyTavern does the same thing with `WORLDINFO_FORCE_ACTIVATE`: they are
  // activated *before* the scan, and everything downstream (position, depth,
  // insertion strategy, budget, recursion) then treats them like any other hit.
  // They are not keyword events, so they neither roll probability nor arm or
  // respect the sticky/cooldown windows; their text does count against the world
  // book budget, because a prompt that overshoots its budget is still too big.
  const external = input.external ?? [];
  for (const activation of external) {
    const item = entries.find(
      (candidate) => candidate.world === activation.world && candidate.entry.uid === activation.uid,
    );
    if (!item) continue;
    const key = `${item.world}.${item.entry.uid}`;
    if (allActivated.has(key)) continue;
    if (item.entry.disable) {
      skipped.push({ world: item.world, uid: item.entry.uid, reason: 'disabled' });
      continue;
    }
    const content = item.entry.content;
    allActivated.set(key, {
      world: item.world,
      uid: item.entry.uid,
      comment: item.entry.comment,
      content,
      tokens: tokenCount(content),
      order: item.entry.order,
      position: item.entry.position,
      depth: item.entry.depth,
      role: item.entry.role,
      group: item.entry.group,
      matchedKeys: [],
      matchedSecondaryKeys: [],
      activatedBy: 'external',
      loop: 1,
      isRecursion: false,
      ignoreBudget: item.entry.ignoreBudget,
      score: activation.score,
      source: activation.source,
    });
    if (!item.entry.ignoreBudget) allActivatedText = `${content}\n${allActivatedText}`;
  }

  while (state) {
    if (settings.maxRecursionSteps && settings.maxRecursionSteps <= loops) break;
    loops++;
    const stateAtLoopStart = state;
    let nextState: ScanState = SCAN_STATE.NONE;
    let candidates: Candidate[] = [];

    for (const item of entries) {
      const entry = item.entry;
      const key = `${item.world}.${entry.uid}`;
      if (failedProbability.has(key) || allActivated.has(key)) continue;
      if (entry.disable) {
        skipped.push({ world: item.world, uid: entry.uid, reason: 'disabled' });
        continue;
      }
      if (entry.triggers.length > 0 && !entry.triggers.includes(trigger)) {
        skipped.push({ world: item.world, uid: entry.uid, reason: `trigger ${trigger} not in [${entry.triggers.join(', ')}]` });
        continue;
      }

      const isSticky = effectActive('sticky', key);
      const isCooldown = effectActive('cooldown', key);
      // ST: `if (this.#chat.length < entry.delay) { buffer.push(entry) }` — delay
      // is a plain message-count comparison, not a window.
      const isDelay = isDelayed(entry);
      if (isDelay) {
        skipped.push({ world: item.world, uid: entry.uid, reason: `suppressed by delay (chat ${chatLength} < ${entry.delay})` });
        continue;
      }
      if (isCooldown && !isSticky) {
        skipped.push({ world: item.world, uid: entry.uid, reason: 'suppressed by cooldown' });
        continue;
      }
      if (state !== SCAN_STATE.RECURSION && entry.delayUntilRecursion > 0 && !isSticky) {
        skipped.push({ world: item.world, uid: entry.uid, reason: 'delayed until recursion' });
        continue;
      }
      if (
        state === SCAN_STATE.RECURSION &&
        entry.delayUntilRecursion > currentDelayLevel &&
        !isSticky
      ) {
        skipped.push({ world: item.world, uid: entry.uid, reason: `delayed until recursion level ${entry.delayUntilRecursion}` });
        continue;
      }
      if (state === SCAN_STATE.RECURSION && settings.recursive && entry.excludeRecursion && !isSticky) {
        skipped.push({ world: item.world, uid: entry.uid, reason: 'excluded from recursion' });
        continue;
      }

      const decorators = KNOWN_DECORATORS.filter((token) => entry.content.includes(token));
      if (decorators.includes('@@activate')) {
        candidates.push({ item, matchedKeys: [], matchedSecondaryKeys: [], activatedBy: 'decorator', key, loop: loops });
        continue;
      }
      if (decorators.includes('@@dont_activate')) {
        skipped.push({ world: item.world, uid: entry.uid, reason: '@@dont_activate' });
        continue;
      }

      if (entry.constant) {
        candidates.push({ item, matchedKeys: [], matchedSecondaryKeys: [], activatedBy: 'constant', key, loop: loops });
        continue;
      }
      if (isSticky) {
        candidates.push({ item, matchedKeys: [], matchedSecondaryKeys: [], activatedBy: 'sticky', key, loop: loops });
        continue;
      }
      if (entry.key.length === 0) {
        skipped.push({ world: item.world, uid: entry.uid, reason: 'no keys' });
        continue;
      }

      const haystack = getHaystack(entry, state);
      const options = optionsFor(entry);
      const matchedKeys = entry.key.filter(
        (candidate) => candidate !== '' && matchKey(haystack, candidate.trim(), options),
      );
      if (matchedKeys.length === 0) continue;

      const hasSecondary = entry.key.length > 0 && entry.keysecondary.length > 0;
      if (!hasSecondary) {
        candidates.push({ item, matchedKeys, matchedSecondaryKeys: [], activatedBy: 'key', key, loop: loops });
        continue;
      }

      const matchedSecondaryKeys = entry.keysecondary.filter(
        (candidate) => candidate !== '' && matchKey(haystack, candidate.trim(), options),
      );
      if (secondarySatisfied(entry.selectiveLogic, matchedSecondaryKeys, entry.keysecondary.length)) {
        candidates.push({ item, matchedKeys, matchedSecondaryKeys, activatedBy: 'key', key, loop: loops });
      }
    }

    // Sticky entries first, then declaration order (which is `order` desc).
    const orderIndex = new Map(entries.map((item, index) => [item, index]));
    candidates.sort((a, b) => {
      const stickyA = effectActive('sticky', a.key) ? 1 : 0;
      const stickyB = effectActive('sticky', b.key) ? 1 : 0;
      return stickyB - stickyA || (orderIndex.get(a.item) ?? 0) - (orderIndex.get(b.item) ?? 0);
    });

    const tokensBefore = tokenCount(allActivatedText);
    filterByInclusionGroups(candidates, allActivated, effectActive, isDelayed, getScore, state, settings, random);

    let newContent = '';
    let ignoresBudget = candidates.filter((candidate) => candidate.item.entry.ignoreBudget).length;

    for (const candidate of candidates) {
      const entry = candidate.item.entry;
      if (entry.ignoreBudget) ignoresBudget--;
      if (overflowed && !entry.ignoreBudget) {
        if (ignoresBudget > 0) continue;
        break;
      }

      // Probability (sticky entries never re-roll).
      if (entry.useProbability && entry.probability !== 100) {
        if (!effectActive('sticky', candidate.key)) {
          if (random() * 100 > entry.probability) {
            failedProbability.add(candidate.key);
            continue;
          }
        }
      }

      const content = entry.content;
      newContent += `${content}\n`;
      if (!entry.ignoreBudget && tokensBefore + tokenCount(newContent) >= budget) {
        overflowed = true;
        continue;
      }

      const hit: ScanHit = {
        world: candidate.item.world,
        uid: entry.uid,
        comment: entry.comment,
        content,
        tokens: tokenCount(content),
        order: entry.order,
        position: entry.position,
        depth: entry.depth,
        role: entry.role,
        group: entry.group,
        matchedKeys: candidate.matchedKeys,
        matchedSecondaryKeys: candidate.matchedSecondaryKeys,
        activatedBy: candidate.activatedBy,
        loop: candidate.loop,
        isRecursion: candidate.loop > 1,
        ignoreBudget: entry.ignoreBudget,
      };
      allActivated.set(candidate.key, hit);
    }

    const successful = candidates.filter((candidate) => !failedProbability.has(candidate.key));
    const forRecursion = successful.filter((candidate) => !candidate.item.entry.preventRecursion);

    if (settings.recursive && !overflowed && forRecursion.length > 0) {
      nextState = SCAN_STATE.RECURSION;
    }
    if (settings.recursive && !overflowed && state === SCAN_STATE.MIN_ACTIVATIONS && recurseBuffer.length > 0) {
      nextState = SCAN_STATE.RECURSION;
    }

    const minActivationsMissing = settings.minActivations > 0 && allActivated.size < settings.minActivations;
    if (!nextState && !overflowed && minActivationsMissing) {
      const depth = settings.depth + skew;
      const overMax =
        (settings.minActivationsDepthMax > 0 && depth > settings.minActivationsDepthMax) ||
        depth > Math.max(chatLength, 1);
      if (!overMax) {
        nextState = SCAN_STATE.MIN_ACTIVATIONS;
        skew++;
      }
    }

    if (nextState === SCAN_STATE.NONE && delayLevels.length > 0) {
      nextState = SCAN_STATE.RECURSION;
      currentDelayLevel = delayLevels.shift() ?? currentDelayLevel;
    }

    state = nextState;
    if (state) {
      const text = forRecursion.map((candidate) => candidate.item.entry.content).join('\n');
      if (text) {
        recurseBuffer.push(text);
        allActivatedText = `${text}\n${allActivatedText}`;
      }
    }
    void stateAtLoopStart;
  }

  // --- buckets -------------------------------------------------------------

  const hits = [...allActivated.values()];
  const sorted = [...hits].sort((a, b) => b.order - a.order || a.uid - b.uid);
  const buckets: ScanBuckets = {
    before: [],
    after: [],
    anTop: [],
    anBottom: [],
    emTop: [],
    emBottom: [],
    atDepth: [],
    outlets: {},
  };

  for (const hit of sorted) {
    switch (hit.position) {
      case POSITION.before:
        buckets.before.push(hit);
        break;
      case POSITION.after:
        buckets.after.push(hit);
        break;
      case POSITION.ANTop:
        buckets.anTop.push(hit);
        break;
      case POSITION.ANBottom:
        buckets.anBottom.push(hit);
        break;
      case POSITION.EMTop:
        buckets.emTop.push(hit);
        break;
      case POSITION.EMBottom:
        buckets.emBottom.push(hit);
        break;
      case POSITION.atDepth: {
        let bucket = buckets.atDepth.find((entry) => entry.depth === hit.depth && entry.role === hit.role);
        if (!bucket) {
          bucket = { depth: hit.depth, role: hit.role, hits: [] };
          buckets.atDepth.push(bucket);
        }
        bucket.hits.push(hit);
        break;
      }
      case POSITION.outlet: {
        const name = outletNameFor(hit);
        (buckets.outlets[name] ??= []).push(hit);
        break;
      }
    }
  }
  buckets.atDepth.sort((a, b) => a.depth - b.depth || a.role - b.role);

  const tokensUsed = hits.reduce((sum, hit) => sum + hit.tokens, 0);

  return { buckets, hits: sorted, overflowed, budget, tokensUsed, loops, skipped };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function outletNameFor(hit: ScanHit): string {
  return hit.group === '' ? 'default' : hit.group;
}

/** ST `matchSecondaryKeys`, including the fixed AND ANY / NOT ALL shortcut. */
function secondarySatisfied(logic: number, matched: string[], total: number): boolean {
  switch (logic) {
    case SELECTIVE_LOGIC.AND_ANY:
      return matched.length > 0;
    case SELECTIVE_LOGIC.NOT_ALL:
      return matched.length < total;
    case SELECTIVE_LOGIC.NOT_ANY:
      return matched.length === 0;
    case SELECTIVE_LOGIC.AND_ALL:
      return matched.length === total;
    default:
      return matched.length > 0;
  }
}

/**
 * ST `getSortedEntries`: `order` descending. Books attached to the character can
 * be floated to the front (the `character_first` strategy).
 */
function sortEntries(entries: ScanEntry[], settings: ScanSettings): ScanEntry[] {
  const strategy = settings.characterStrategy;
  return [...entries].sort((a, b) => {
    if (strategy !== INSERTION_STRATEGY.evenly) {
      const aChar = a.fromCharacter ? 1 : 0;
      const bChar = b.fromCharacter ? 1 : 0;
      if (aChar !== bChar) {
        return strategy === INSERTION_STRATEGY.character_first ? bChar - aChar : aChar - bChar;
      }
    }
    return b.entry.order - a.entry.order || a.entry.displayIndex - b.entry.displayIndex;
  });
}

type EffectCheck = (type: 'sticky' | 'cooldown', key: string) => boolean;

/**
 * ST `filterByInclusionGroups`. Order of decisions matters:
 *   1. timed effects inside a group (sticky wins, cooldown/delay dropped)
 *   2. score losers dropped (only for entries that opt into scoring)
 *   3. if the group is already represented in this pass, drop all newcomers
 *   4. `groupOverride` entries: the highest `order` wins outright
 *   5. otherwise a weighted random pick by `groupWeight`
 */
function filterByInclusionGroups(
  candidates: Candidate[],
  allActivated: Map<string, ScanHit>,
  effectActive: EffectCheck,
  isDelayed: (entry: WorldEntry) => boolean,
  getScore: (entry: WorldEntry, state: ScanState) => number,
  state: ScanState,
  settings: ScanSettings,
  random: () => number,
): void {
  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (candidate.item.entry.group === '') continue;
    for (const group of candidate.item.entry.group.split(/,\s*/).filter((part) => part !== '')) {
      const list = grouped.get(group) ?? [];
      list.push(candidate);
      grouped.set(group, list);
    }
  }
  if (grouped.size === 0) return;

  const remove = (candidate: Candidate): void => {
    const index = candidates.indexOf(candidate);
    if (index !== -1) candidates.splice(index, 1);
  };

  const stickyGroups = new Set<string>();
  for (const [group, list] of grouped) {
    const sticky = list.filter((candidate) => effectActive('sticky', candidate.key));
    if (sticky.length > 0) {
      for (const candidate of list) if (!sticky.includes(candidate)) remove(candidate);
      stickyGroups.add(group);
    }
    for (const candidate of list.filter(
      (c) => effectActive('cooldown', c.key) || isDelayed(c.item.entry),
    )) {
      remove(candidate);
    }
  }

  // Score filter.
  for (const [group, list] of grouped) {
    if (!settings.useGroupScoring && !list.some((candidate) => candidate.item.entry.useGroupScoring === true)) {
      continue;
    }
    if (stickyGroups.has(group)) continue;
    const scores = list.map((candidate) => getScore(candidate.item.entry, state));
    const maxScore = Math.max(...scores);
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]!.item.entry;
      const scored = entry.useGroupScoring ?? settings.useGroupScoring;
      if (!scored) continue;
      if (scores[i]! < maxScore) {
        remove(list[i]!);
        list.splice(i, 1);
      }
    }
  }

  for (const [group, list] of grouped) {
    if (stickyGroups.has(group)) continue;
    if ([...allActivated.values()].some((hit) => hit.group === group)) {
      for (const candidate of list) remove(candidate);
      continue;
    }
    const remaining = list.filter((candidate) => candidates.includes(candidate));
    if (remaining.length <= 1) continue;

    const overrides = remaining
      .filter((candidate) => candidate.item.entry.groupOverride)
      .sort((a, b) => b.item.entry.order - a.item.entry.order);
    if (overrides.length > 0) {
      const winner = overrides[0]!;
      for (const candidate of remaining) if (candidate !== winner) remove(candidate);
      continue;
    }

    const totalWeight = remaining.reduce(
      (sum, candidate) => sum + (candidate.item.entry.groupWeight ?? DEFAULT_WEIGHT),
      0,
    );
    let roll = random() * totalWeight;
    let winner: Candidate | undefined = remaining[remaining.length - 1];
    for (const candidate of remaining) {
      roll -= candidate.item.entry.groupWeight ?? DEFAULT_WEIGHT;
      if (roll <= 0) {
        winner = candidate;
        break;
      }
    }
    for (const candidate of remaining) if (candidate !== winner) remove(candidate);
  }
}
