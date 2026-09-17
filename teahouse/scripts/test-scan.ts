/**
 * Scanner semantics suite.
 *
 * Each case pins one rule from SillyTavern's `checkWorldInfo`, so a regression
 * shows up as a failed assertion instead of a subtly different trigger.
 * Run: node scripts/test-scan.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SCAN_SETTINGS,
  SCAN_STATE,
  matchKey,
  parseRegexFromString,
  scanWorldInfo,
  type ScanEntry,
  type ScanInput,
  type ScanMessage,
} from '../src/engine/world-scan.ts';
import { splitKeyList } from '../src/formats/key-list.ts';
import { parseWorldInfo } from '../src/formats/world-info.ts';
import {
  DEFAULT_DEPTH,
  DEFAULT_ORDER,
  DEFAULT_WEIGHT,
  POSITION,
  SELECTIVE_LOGIC,
  type WorldEntry,
} from '../src/formats/types.ts';

const here = dirname(fileURLToPath(import.meta.url));

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

function makeEntry(uid: number, patch: Partial<WorldEntry> = {}): WorldEntry {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment: `entry ${uid}`,
    content: `content ${uid}`,
    constant: false,
    selective: true,
    selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
    order: DEFAULT_ORDER,
    position: POSITION.before,
    depth: DEFAULT_DEPTH,
    role: 0,
    disable: false,
    ignoreBudget: false,
    probability: 100,
    useProbability: true,
    group: '',
    groupOverride: false,
    groupWeight: DEFAULT_WEIGHT,
    useGroupScoring: null,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    vectorized: false,
    useRegex: false,
    automationId: '',
    outletName: '',
    triggers: [],
    addMemo: false,
    displayIndex: uid,
    extensions: {},
    raw: {},
    ...patch,
  };
}

function scan(entries: WorldEntry[], input: Partial<ScanInput> = {}) {
  return scanWorldInfo({
    entries: entries.map((entry) => ({ world: 'test', entry })),
    messages: input.messages ?? [{ name: 'You', content: 'nothing relevant here' }],
    settings: { maxContext: 8192, ...input.settings },
    ...input,
  });
}

const uids = (result: ReturnType<typeof scan>): number[] => result.hits.map((hit) => hit.uid);

// ---------------------------------------------------------------------------
section('key matching primitives');
// ---------------------------------------------------------------------------

eq(parseRegexFromString('/foo/i')?.source, 'foo', 'slash-delimited key parses as regex');
eq(parseRegexFromString('foo'), null, 'plain key is not a regex');
eq(parseRegexFromString('/a/b/'), null, 'unescaped delimiter inside the pattern is rejected');
check(parseRegexFromString('/a\\/b/i') !== null, 'escaped delimiter is accepted');
eq(parseRegexFromString('/(/'), null, 'invalid regex syntax is rejected');

// Key lists: a comma inside a slash-delimited regex does not separate keys.
eq(splitKeyList('a, b, c'), ['a', 'b', 'c'], 'comma-separated keys split');
eq(splitKeyList('/a{1,2}/, plain'), ['/a{1,2}/', 'plain'], 'a comma inside a regex does not split it');
eq(splitKeyList('alpha, /b{2,3}/, gamma'), ['alpha', '/b{2,3}/', 'gamma'], 'mixed list with a regex in the middle');
eq(splitKeyList('/only,one/'), ['/only,one/'], 'a single regex with a comma stays whole');
eq(splitKeyList('  a  ,  , b '), ['a', 'b'], 'blank entries are dropped');
eq(splitKeyList(''), [], 'an empty string yields no keys');
// A stray slash is not a regex, so its commas still separate.
eq(splitKeyList('/not closed, second'), ['/not closed', 'second'], 'an unclosed slash does not swallow the list');

// Regex keys ignore case sensitivity.
eq(matchKey('ELDORIA', '/eldoria/i', { caseSensitive: true, matchWholeWords: false }), true,
  'regex key overrides case sensitivity');
eq(matchKey('wooden', 'wood', { caseSensitive: false, matchWholeWords: true }), false,
  'whole-word single key does not match a longer word');
eq(matchKey('a wood, here', 'wood', { caseSensitive: false, matchWholeWords: true }), true,
  'whole-word single key matches on punctuation boundaries');
eq(matchKey('wooden', 'wood', { caseSensitive: false, matchWholeWords: false }), true,
  'substring mode matches inside a longer word');
// The counter-intuitive one: multi-word keys skip the boundary check entirely.
eq(matchKey('a magical foresty place', 'magical forest', { caseSensitive: false, matchWholeWords: true }), true,
  'whole-word multi-word key degrades to substring matching');
// The join marker is a word boundary, so keys can match across messages.
eq(matchKey(`end of one\x01start of two`, 'one', { caseSensitive: false, matchWholeWords: true }), true,
  'word boundaries work across the message joiner');

// ---------------------------------------------------------------------------
section('activation rules');
// ---------------------------------------------------------------------------

eq(uids(scan([makeEntry(0, { constant: true, key: [] })])), [0], 'constant activates without keys');
eq(uids(scan([makeEntry(0, { key: ['dragon'] })], { messages: [{ name: 'You', content: 'a dragon appears' }] })), [0],
  'primary key match');
eq(uids(scan([makeEntry(0, { key: ['dragon'] })], { messages: [{ name: 'You', content: 'a DRAGON appears' }] })), [0],
  'keys are case-insensitive by default');
eq(uids(scan([makeEntry(0, { key: ['dragon'], caseSensitive: true })], { messages: [{ name: 'You', content: 'a DRAGON appears' }] })), [],
  'per-entry case sensitivity is honoured');
eq(uids(scan([makeEntry(0, { key: ['dragon'], disable: true })])), [], 'disabled entries never activate');
eq(uids(scan([makeEntry(0, { key: ['dragon'], triggers: ['impersonate'] })], { messages: [{ name: 'You', content: 'dragon' }] })), [],
  'generation trigger filter excludes other triggers');
eq(uids(scan([makeEntry(0, { key: ['dragon'], triggers: ['impersonate'] })], {
  messages: [{ name: 'You', content: 'dragon' }], trigger: 'impersonate',
})), [0], 'generation trigger filter admits the matching trigger');
eq(uids(scan([makeEntry(0, { key: [] })])), [], 'an entry with no keys and no constant never activates');

// Secondary keys and all four logics.
const secondary = (logic: number, keys: string[], text: string) =>
  uids(scan([makeEntry(0, { key: ['alpha'], keysecondary: keys, selectiveLogic: logic })], {
    messages: [{ name: 'You', content: text }],
  }));

eq(secondary(SELECTIVE_LOGIC.AND_ANY, ['beta'], 'alpha beta'), [0], 'AND_ANY: any secondary match');
eq(secondary(SELECTIVE_LOGIC.AND_ANY, ['gamma'], 'alpha beta'), [], 'AND_ANY: no secondary match');
eq(secondary(SELECTIVE_LOGIC.AND_ALL, ['beta', 'gamma'], 'alpha beta gamma'), [0], 'AND_ALL: all secondaries match');
eq(secondary(SELECTIVE_LOGIC.AND_ALL, ['beta', 'gamma'], 'alpha beta'), [], 'AND_ALL: one missing');
eq(secondary(SELECTIVE_LOGIC.NOT_ALL, ['beta', 'gamma'], 'alpha beta'), [0], 'NOT_ALL: not all matched');
eq(secondary(SELECTIVE_LOGIC.NOT_ALL, ['beta', 'gamma'], 'alpha beta gamma'), [], 'NOT_ALL: all matched, so suppressed');
eq(secondary(SELECTIVE_LOGIC.NOT_ANY, ['beta'], 'alpha gamma'), [0], 'NOT_ANY: none matched');
eq(secondary(SELECTIVE_LOGIC.NOT_ANY, ['beta'], 'alpha beta'), [], 'NOT_ANY: one matched, so suppressed');

// Probability uses the injectable RNG.
const probabilityEntry = makeEntry(0, { key: ['x'], probability: 50, useProbability: true });
eq(uids(scan([probabilityEntry], { messages: [{ name: 'You', content: 'x' }], random: () => 0.49 })), [0],
  'probability passes below the threshold');
eq(uids(scan([probabilityEntry], { messages: [{ name: 'You', content: 'x' }], random: () => 0.51 })), [],
  'probability fails above the threshold');
eq(uids(scan([makeEntry(0, { key: ['x'], probability: 50, useProbability: false })], {
  messages: [{ name: 'You', content: 'x' }], random: () => 0.99,
})), [0], 'useProbability false bypasses the roll');

// Global-field scanning.
eq(uids(scan([makeEntry(0, { key: ['ashes'], matchScenario: true })], {
  messages: [{ name: 'You', content: 'hello' }], global: { scenario: 'a world of ashes' },
})), [0], 'matchScenario scans the scenario text');
eq(uids(scan([makeEntry(0, { key: ['ashes'] })], {
  messages: [{ name: 'You', content: 'hello' }], global: { scenario: 'a world of ashes' },
})), [], 'scenario is not scanned unless opted in');

// ---------------------------------------------------------------------------
section('scan depth');
// ---------------------------------------------------------------------------

const deepMessages: ScanMessage[] = [
  { name: 'You', content: 'the word eldoria appears here' },
  { name: 'AI', content: 'filler one' },
  { name: 'You', content: 'filler two' },
];
eq(uids(scan([makeEntry(0, { key: ['eldoria'] })], { messages: deepMessages, settings: { depth: 2 } })), [],
  'depth 2 does not reach the third message back');
eq(uids(scan([makeEntry(0, { key: ['eldoria'] })], { messages: deepMessages, settings: { depth: 3 } })), [0],
  'depth 3 reaches it');
eq(uids(scan([makeEntry(0, { key: ['eldoria'], scanDepth: 3 })], { messages: deepMessages, settings: { depth: 1 } })), [0],
  'per-entry scanDepth overrides the global depth');

// Min activations walks deeper until enough entries fire.
const minActResult = scan([makeEntry(0, { key: ['eldoria'] })], {
  messages: deepMessages,
  settings: { depth: 1, minActivations: 1 },
});
eq(minActResult.hits.length, 1, 'min activations advances the scan until something matches');
check(minActResult.loops > 1, 'min activations looped at least twice', `loops=${minActResult.loops}`);

// ---------------------------------------------------------------------------
section('recursion');
// ---------------------------------------------------------------------------

const recursionEntries = [
  makeEntry(0, { key: ['trigger'], content: 'the secret word is moonstone' }),
  makeEntry(1, { key: ['moonstone'], content: 'recursively found' }),
];
eq(uids(scan(recursionEntries, { messages: [{ name: 'You', content: 'trigger' }], settings: { recursive: false } })), [0],
  'without recursive scanning the second entry stays dormant');
const recursed = scan(recursionEntries, {
  messages: [{ name: 'You', content: 'trigger' }],
  settings: { recursive: true },
});
eq(recursed.hits.length, 2, 'recursive scanning activates the follow-up entry');
eq(recursed.hits.find((hit) => hit.uid === 1)?.isRecursion, true, 'the follow-up is marked as recursion');

const excluded = scan(
  [recursionEntries[0]!, makeEntry(1, { key: ['moonstone'], excludeRecursion: true })],
  { messages: [{ name: 'You', content: 'trigger' }], settings: { recursive: true } },
);
eq(excluded.hits.length, 1, 'excludeRecursion keeps an entry out of recursion passes');

const prevented = scan(
  [makeEntry(0, { key: ['trigger'], content: 'the secret word is moonstone', preventRecursion: true }), recursionEntries[1]!],
  { messages: [{ name: 'You', content: 'trigger' }], settings: { recursive: true } },
);
eq(prevented.hits.length, 1, 'preventRecursion stops an entry feeding the recursion buffer');

const delayed = scan(
  [recursionEntries[0]!, makeEntry(1, { key: ['moonstone'], delayUntilRecursion: 1 })],
  { messages: [{ name: 'You', content: 'trigger' }], settings: { recursive: true } },
);
eq(delayed.hits.length, 2, 'delayUntilRecursion 1 activates on the first recursion pass');

const maxSteps = scan(recursionEntries, {
  messages: [{ name: 'You', content: 'trigger' }],
  settings: { recursive: true, maxRecursionSteps: 1 },
});
eq(maxSteps.hits.length, 1, 'maxRecursionSteps 1 stops after the initial pass');

// ---------------------------------------------------------------------------
section('budget');
// ---------------------------------------------------------------------------

// 5% of 1000 = 50 tokens. The heuristic charges ~1 token per 4 latin chars, so
// a 100-char entry costs ~25: the first fits, the second pushes it over.
// Note the ST rule this pins down: the entry that first crosses the budget is
// itself rejected, not admitted.
const big = 'x'.repeat(100);
const budgetResult = scanWorldInfo({
  entries: [
    { world: 'test', entry: makeEntry(0, { key: ['hit'], content: big, order: 200 }) },
    { world: 'test', entry: makeEntry(1, { key: ['hit'], content: big, order: 100 }) },
  ],
  messages: [{ name: 'You', content: 'hit' }],
  settings: { maxContext: 1000, budgetPercent: 5, budgetCap: 0 },
});
eq(budgetResult.hits.map((hit) => hit.uid), [0], 'the entry that crosses the budget is rejected');
eq(budgetResult.overflowed, true, 'overflow is reported');
check(budgetResult.budget === 50, 'budget is a percentage of the context window', `budget=${budgetResult.budget}`);

const ignoreBudgetResult = scanWorldInfo({
  entries: [
    { world: 'test', entry: makeEntry(0, { key: ['hit'], content: big, order: 300 }) },
    { world: 'test', entry: makeEntry(1, { key: ['hit'], content: big, order: 200 }) },
    { world: 'test', entry: makeEntry(2, { key: ['hit'], content: big, order: 100, ignoreBudget: true }) },
  ],
  messages: [{ name: 'You', content: 'hit' }],
  settings: { maxContext: 1000, budgetPercent: 5 },
});
eq(ignoreBudgetResult.hits.map((hit) => hit.uid), [0, 2], 'ignoreBudget entries still get in after overflow');

const capResult = scanWorldInfo({
  entries: [{ world: 'test', entry: makeEntry(0, { key: ['hit'] }) }],
  messages: [{ name: 'You', content: 'hit' }],
  settings: { maxContext: 100_000, budgetPercent: 25, budgetCap: 500 },
});
eq(capResult.budget, 500, 'budgetCap clamps the percentage');

// Order decides who wins the budget.
const ordered = scanWorldInfo({
  entries: [
    { world: 'test', entry: makeEntry(0, { key: ['hit'], content: big, order: 50 }) },
    { world: 'test', entry: makeEntry(1, { key: ['hit'], content: big, order: 500 }) },
  ],
  messages: [{ name: 'You', content: 'hit' }],
  settings: { maxContext: 1000, budgetPercent: 5 },
});
eq(ordered.hits.map((hit) => hit.uid), [1], 'higher order wins the budget');

// ---------------------------------------------------------------------------
section('inclusion groups');
// ---------------------------------------------------------------------------

const groupOf = (uidsToMake: number[], patch: Partial<WorldEntry>) =>
  uidsToMake.map((uid) => makeEntry(uid, { key: ['hit'], group: 'g', ...patch }));

const overrideResult = scan(groupOf([0, 1, 2], { groupOverride: false }).map((entry, i) =>
  i === 1 ? { ...entry, groupOverride: true, order: 900 } : entry,
), { messages: [{ name: 'You', content: 'hit' }] });
eq(overrideResult.hits.length, 1, 'groupOverride keeps exactly one entry');
eq(overrideResult.hits[0]?.uid, 1, 'groupOverride winner is the highest order');

const weighted = scan(groupOf([0, 1], { groupWeight: 100 }), {
  messages: [{ name: 'You', content: 'hit' }],
  random: () => 0.99,
});
eq(weighted.hits.length, 1, 'weighted group keeps exactly one entry');

const stickyGroup = scanWorldInfo({
  entries: [
    { world: 'test', entry: makeEntry(0, { key: ['hit'], group: 'g' }) },
    { world: 'test', entry: makeEntry(1, { key: ['zzz'], group: 'g' }) },
  ],
  messages: [{ name: 'You', content: 'hit' }],
  timedEffects: { 'test.1': { sticky: { start: 0, end: 99 } } },
  chatLength: 5,
  random: () => 0.5,
});
eq(stickyGroup.hits.map((hit) => hit.uid), [1], 'a sticky member wins the whole group');

// ---------------------------------------------------------------------------
section('sticky / cooldown / delay');
// ---------------------------------------------------------------------------

const timed = (effect: 'sticky' | 'cooldown' | 'delay', start: number, end: number, text = 'hit') =>
  scanWorldInfo({
    entries: [{ world: 'test', entry: makeEntry(0, { key: ['hit'] }) }],
    messages: [{ name: 'You', content: text }],
    timedEffects: { 'test.0': { [effect]: { start, end } } },
    chatLength: 5,
  });

eq(timed('sticky', 0, 99, 'nothing').hits.length, 1, 'sticky keeps an entry active without a key match');
eq(timed('sticky', 0, 1, 'nothing').hits.length, 0, 'an expired sticky does not activate');
eq(timed('cooldown', 0, 99).hits.length, 0, 'cooldown suppresses an entry that would match');
eq(timed('cooldown', 10, 99).hits.length, 1, 'a future cooldown does not suppress yet');

// ST's delay is a plain message-count comparison: `chat.length < entry.delay`,
// evaluated independently of the keys.
const delayedProbe = (delay: number | null, chatLength: number) =>
  scanWorldInfo({
    entries: [{ world: 'test', entry: makeEntry(0, { key: ['hit'], delay }) }],
    messages: [{ name: 'You', content: 'hit' }],
    chatLength,
  }).hits.length;
eq(delayedProbe(10, 5), 0, 'delay suppresses while the chat is shorter than the delay');
eq(delayedProbe(10, 20), 1, 'delay stops suppressing once the chat is long enough');
eq(delayedProbe(10, 10), 1, 'delay is inclusive at the boundary');
eq(delayedProbe(null, 0), 1, 'a null delay never suppresses');
eq(delayedProbe(0, 0), 1, 'a zero delay never suppresses');

// `include_names` puts the speaker name into the scanned text (ST's
// `world_info_include_names`, on by default). A key that equals a speaker's name
// therefore matches on every turn — which is why world books often key on the
// character name on purpose, and why a fixture must avoid doing it by accident.
const nameCollision = (includeNames: boolean) =>
  scanWorldInfo({
    entries: [{ world: 'test', entry: makeEntry(0, { key: ['osk'] }) }],
    messages: [{ name: 'Osk', content: 'nothing relevant at all' }],
    settings: { maxContext: 8192, includeNames },
  }).hits.length;
eq(nameCollision(true), 1, 'a key equal to a speaker name matches through the name prefix');
eq(nameCollision(false), 0, 'and stops matching when include_names is off');

const stickyBeatsCooldown = scanWorldInfo({
  entries: [{ world: 'test', entry: makeEntry(0, { key: ['hit'] }) }],
  messages: [{ name: 'You', content: 'hit' }],
  timedEffects: { 'test.0': { sticky: { start: 0, end: 99 }, cooldown: { start: 0, end: 99 } } },
  chatLength: 5,
});
eq(stickyBeatsCooldown.hits.length, 1, 'sticky takes precedence over cooldown');

// ---------------------------------------------------------------------------
section('positions and ordering');
// ---------------------------------------------------------------------------

const positioned = scan([
  makeEntry(0, { constant: true, position: POSITION.before, order: 100 }),
  makeEntry(1, { constant: true, position: POSITION.after, order: 300 }),
  makeEntry(2, { constant: true, position: POSITION.ANTop, order: 200 }),
  makeEntry(3, { constant: true, position: POSITION.atDepth, depth: 2, role: 1 }),
  makeEntry(4, { constant: true, position: POSITION.atDepth, depth: 2, role: 0 }),
  makeEntry(5, { constant: true, position: POSITION.EMBottom }),
  makeEntry(6, { constant: true, position: POSITION.outlet, group: 'sprite' }),
]);
eq(positioned.buckets.before.length, 1, 'before bucket');
eq(positioned.buckets.after.length, 1, 'after bucket');
eq(positioned.buckets.anTop.length, 1, 'author note top bucket');
eq(positioned.buckets.emBottom.length, 1, 'example message bottom bucket');
eq(positioned.buckets.atDepth.length, 2, 'at-depth entries group by depth and role');
eq(positioned.buckets.atDepth[0]?.hits.length, 1, 'each at-depth bucket holds its own entries');
eq(Object.keys(positioned.buckets.outlets).length, 1, 'outlet position is collected separately');
eq(positioned.hits.map((hit) => hit.uid), [1, 2, 0, 3, 4, 5, 6], 'hits are sorted by order descending');

// ---------------------------------------------------------------------------
section('fixture corpus');
// ---------------------------------------------------------------------------

const fixturePath = resolve(here, '..', 'corpus', 'owned', 'st-native', 'full-fields.json');
const fixture = parseWorldInfo(JSON.parse(readFileSync(fixturePath, 'utf8')), {
  id: 'lantern',
  format: 'st-native',
}).world;
console.log(
  `  fixture entries: ${fixture.entries
    .map((entry) => `${entry.uid}:${entry.comment}[${entry.key.join('|')}]`)
    .join(', ')}`,
);

const fixtureHit = scanWorldInfo({
  entries: fixture.entries.map((entry) => ({ world: 'lantern', entry })),
  messages: [{ name: 'You', content: 'I ask about the Lantern District and the river.' }],
  settings: { maxContext: 8192, depth: 2 },
});
check(fixtureHit.hits.length > 0, 'a fixture world book triggers on a matching message');
console.log(`  matched: ${fixtureHit.hits.map((hit) => `${hit.uid}(${hit.matchedKeys.join('|')})`).join(', ') || 'none'}`);
check(
  fixtureHit.hits.some((hit) => hit.uid === 0),
  'the entry whose primary and secondary keys both match fires',
);

const fixtureMiss = scanWorldInfo({
  entries: fixture.entries.map((entry) => ({ world: 'lantern', entry })),
  messages: [{ name: 'You', content: 'Good morning! How are you today?' }],
  settings: { maxContext: 8192, depth: 2 },
});
console.log(`  non-matching message activated: ${fixtureMiss.hits.map((hit) => hit.uid).join(', ') || 'none'}`);
check(
  fixtureMiss.hits.every((hit) => hit.activatedBy === 'constant' || hit.activatedBy === 'sticky'),
  'a non-matching message only activates constant/sticky entries',
);
check(
  !fixtureMiss.hits.some((hit) => hit.uid === 2),
  'a disabled entry stays out even when its key is absent',
);

// The disabled entry must stay out when its key IS present too.
const disabledProbe = scanWorldInfo({
  entries: fixture.entries.map((entry) => ({ world: 'lantern', entry })),
  messages: [{ name: 'You', content: 'Does the tide bell ring?' }],
  settings: { maxContext: 8192, depth: 2 },
});
check(
  !disabledProbe.hits.some((hit) => hit.uid === 2),
  'the disabled fixture entry never activates',
);

// Scale: a large generated book, to keep the budget and timing honest without
// depending on any third-party content.
const bigEntries = Array.from({ length: 1200 }, (_, index) => ({
  world: 'generated',
  entry: makeEntry(index, {
    key: [`keyword${index}`, `lantern district`],
    comment: `generated ${index}`,
    content: `Generated entry ${index}. `.repeat(20),
    order: 100 + (index % 7),
    scanDepth: null,
  }),
}));
bigEntries.push({
  world: 'generated',
  entry: makeEntry(9999, {
    key: ['seawall', 'the wall'],
    comment: 'seawall',
    content: 'The sea wall holds. For now.',
    order: 500,
  }),
});

const started = Date.now();
const bigResult = scanWorldInfo({
  entries: bigEntries,
  messages: [
    { name: 'You', content: 'I walk along the seawall at dusk.' },
    { name: 'AI', content: 'The lanterns come on from the river inward.' },
  ],
  settings: { maxContext: 8192, depth: 3, budgetPercent: 25 },
});
const elapsed = Date.now() - started;
console.log(
  `  ${bigEntries.length}-entry generated book: hits=${bigResult.hits.length} ` +
    `tokens=${bigResult.tokensUsed}/${bigResult.budget} loops=${bigResult.loops} in ${elapsed}ms`,
);
check(bigResult.hits.length > 0, 'the large book activates entries');
check(bigResult.overflowed === false || bigResult.tokensUsed > 0, 'large book reports budget state coherently');
check(elapsed < 5000, 'large book scans quickly', `${elapsed}ms`);
check(
  bigResult.hits.some((hit) => hit.uid === 9999),
  'the highest-order entry wins a place in the budget',
);

// ---------------------------------------------------------------------------
section('external activations (vector storage)');
// ---------------------------------------------------------------------------

// An entry another channel decided on enters the scan already activated, exactly
// like SillyTavern's WORLDINFO_FORCE_ACTIVATE. Everything downstream — position,
// depth, order, budget — then treats it like any other hit.
const externalEntry = makeEntry(0, { key: ['nothing-matches-this'], position: POSITION.before });
const externalResult = scan([externalEntry], { external: [{ world: 'test', uid: 0, score: 0.42 }] });
eq(uids(externalResult), [0], 'an external activation fires without any matching key');
eq(externalResult.hits[0]?.activatedBy, 'external', 'and says where it came from');
eq(externalResult.hits[0]?.score, 0.42, 'carrying the similarity for the UI');
eq(externalResult.hits[0]?.matchedKeys, [], 'with no matched keys to claim');
eq(externalResult.hits[0]?.position, POSITION.before, 'and its own insertion position is respected');

// The same rules as any other activation.
eq(
  uids(scan([makeEntry(0, { key: [], disable: true })], { external: [{ world: 'test', uid: 0 }] })),
  [],
  'a disabled entry is not activated from outside either',
);
eq(
  scan([makeEntry(0, { key: ['dragon'] })], {
    messages: [{ name: 'You', content: 'a dragon' }],
    external: [{ world: 'test', uid: 0 }],
  }).hits.length,
  1,
  'an external hit and a keyword hit for the same entry are one hit, not two',
);
eq(
  uids(scan([externalEntry], { external: [{ world: 'other', uid: 0 }] })),
  [],
  'an activation naming a book that is not scanned does nothing',
);

// Probability is a keyword game: a vector hit was already decided on.
eq(
  uids(scan([makeEntry(0, { key: [], useProbability: true, probability: 1 })], {
    external: [{ world: 'test', uid: 0, score: 0.9 }],
    random: () => 0.999,
  })),
  [0],
  'an external hit does not roll probability',
);

// It does count against the world book budget: a prompt that overshoots is too
// big however its entries got there.
const fatEntry = makeEntry(0, { key: [], content: 'x'.repeat(4000) });
const tight = scan([fatEntry, makeEntry(1, { key: ['dragon'] })], {
  messages: [{ name: 'You', content: 'a dragon' }],
  settings: { maxContext: 2048, budgetPercent: 25 },
  external: [{ world: 'test', uid: 0 }],
});
check(
  tight.overflowed || tight.hits.length < 2,
  'external hits consume the world book budget',
  JSON.stringify({ hits: tight.hits.length, tokens: tight.tokensUsed, budget: tight.budget }),
);

console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILURES'}  checks=${checks} failed=${failures}`);
process.exit(failures === 0 ? 0 : 1);
