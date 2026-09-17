/**
 * Prompt stack assembly suite.
 *
 * Pins the behaviour that makes the stack debuggable: marker filling, card
 * overrides, macro expansion order, absolute injections, and trimming.
 * Run: node scripts/test-prompt.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandMacros } from '../src/engine/macros.ts';
import {
  buildSummaryMessages,
  cleanSummary,
  DEFAULT_MEMORY_PROMPT,
  memoryProgress,
  memorySettings,
  pendingEntries,
  renderMemoryPrompt,
  summarizeRecord,
} from '../src/engine/memory.ts';
import {
  DEFAULT_IMPERSONATE_INSTRUCTION,
  DEFAULT_LANGUAGE_INSTRUCTION,
  INJECTION_POSITION,
  applyImpersonate,
  applyLanguage,
  applyMemory,
  buildPrompt,
  defaultPromptStack,
  renderLanguageInstruction,
  stackOrder,
  type PromptBlock,
} from '../src/engine/prompt-stack.ts';
import { DEFAULT_STORY_TEMPLATE, renderStoryTemplate } from '../src/engine/story-template.ts';
import { applyDisplayRegexes, applyPromptRegexes, coerceRegexFile } from '../src/engine/regex-rules.ts';
import { buildTranslationPrompt, needsTranslation, targetIsCjk } from '../src/engine/translate.ts';
import { MAX_IMAGE_BYTES, messageWithImages, sniffImage } from '../src/engine/images.ts';
import { expandDisplayMacros } from '../src/engine/macros.ts';
import { buildCompletionPrompt } from '../src/engine/completion.ts';
import { activateGroupSpeakers, isGroupMode, matchSpeakerName, namedSpeakers, nextRoundRobin } from '../src/engine/group.ts';
import { TokenCounter } from '../src/engine/tokens.ts';
import { scanWorldInfo } from '../src/engine/world-scan.ts';
import { buildCatalog, parseSelection, selectionInput, selectionPrompt } from '../src/engine/select.ts';
import { effectiveRetrievalMode, fullInjectionHits } from '../src/engine/retrieval.ts';
import {
  agentInput,
  agentSource,
  agentSystemPrompt,
  agentTool,
  buildAgentCatalog,
  collectAgentDocs,
  parseReadPaths,
  readSkillFile,
} from '../src/engine/agent.ts';
import { isContextOverflow, limitKey, parseContextFailure } from '../src/engine/limits.ts';
import { parseWorldInfo } from '../src/formats/world-info.ts';
import { parseCardJSON } from '../src/formats/character-card.ts';
import {
  DEFAULT_DEPTH,
  DEFAULT_ORDER,
  DEFAULT_WEIGHT,
  POSITION,
  SELECTIVE_LOGIC,
  type CharacterCard,
  type WorldEntry,
} from '../src/formats/types.ts';
import type { ChatMessage } from '../src/engine/tokens.ts';
import type { ChatMeta, TeahouseConfig } from '../src/store/db.ts';

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCard(patch: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id: 'seraphina',
    spec: 'v2',
    name: 'Seraphina',
    description: 'A forest guardian with amber eyes.',
    personality: 'Calm, watchful, kind.',
    scenario: 'A glade inside the woods of Eldoria.',
    first_mes: '*She turns, gown shimmering.* "You are safe here."',
    mes_example: '<START>\n{{user}}: Who are you?\n{{char}}: I am the guardian.',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
    depthPrompt: null,
    books: [],
    raw: { spec: 'chara_card_v2', spec_version: '2.0', data: {} },
    warnings: [],
    ...patch,
  };
}

function makeEntry(uid: number, patch: Partial<WorldEntry> = {}): WorldEntry {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment: `entry ${uid}`,
    content: `CONTENT_${uid}`,
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

const counter = new TokenCounter(null);

function build(options: {
  card?: CharacterCard;
  history?: ChatMessage[];
  entries?: WorldEntry[];
  stack?: PromptBlock[];
  maxContext?: number;
  persona?: string;
  settings?: Record<string, unknown>;
  outputLanguage?: string;
  languageInstruction?: string;
  impersonate?: boolean;
  memory?: any;
  storyTemplate?: string;
  promptRegexes?: RegexRule[];
}) {
  const entries = options.entries ?? [];
  const history = options.history ?? [{ role: 'user' as const, content: 'Hello there.' }];
  const scan =
    entries.length > 0
      ? scanWorldInfo({
          entries: entries.map((entry) => ({ world: 'test', entry })),
          messages: history.map((message) => ({ name: message.role, content: message.content })),
          settings: { maxContext: 8192, ...(options.settings ?? {}) },
        })
      : null;
  return buildPrompt({
    card: options.card ?? makeCard(),
    persona: options.persona ?? 'A wandering scholar.',
    personaName: 'You',
    history,
    scan,
    stack: options.stack,
    tokenCounter: counter,
    maxContext: options.maxContext ?? 8192,
    outputLanguage: options.outputLanguage,
    languageInstruction: options.languageInstruction,
    impersonate: options.impersonate,
    memory: options.memory,
    storyTemplate: options.storyTemplate,
    promptRegexes: options.promptRegexes,
    random: () => 0,
  });
}

const textOf = (result: ReturnType<typeof build>, identifier: string): string =>
  result.itemization.find((item) => item.identifier === identifier)?.content ?? '';

// ---------------------------------------------------------------------------
section('stack shape');
// ---------------------------------------------------------------------------

const defaults = defaultPromptStack();
eq(stackOrder(defaults), [
  'main',
  'language',
  'worldInfoBefore',
  'worldInfoANTop',
  'worldInfoANBottom',
  'worldInfoEMTop',
  'worldInfoEMBottom',
  'personaDescription',
  'charDescription',
  'charPersonality',
  'scenario',
  'story',
  'enhanceDefinitions',
  'nsfw',
  'worldInfoAfter',
  'dialogueExamples',
  'impersonate',
  'chatHistory',
  'jailbreak',
], 'default order follows ST, plus the language block and the extra world-info buckets');

const built = build({});
// ---------------------------------------------------------------------------
section('marker filling');
// ---------------------------------------------------------------------------

check(textOf(built, 'charDescription').includes('forest guardian'), 'charDescription marker filled');
check(textOf(built, 'charPersonality').includes('Calm'), 'charPersonality marker filled');
check(textOf(built, 'scenario').includes('Eldoria'), 'scenario marker filled');
check(textOf(built, 'personaDescription').includes('wandering scholar'), 'personaDescription marker filled');
check(textOf(built, 'dialogueExamples').includes('I am the guardian'), 'dialogueExamples marker filled');
eq(
  built.itemization.find((item) => item.identifier === 'nsfw')?.skippedReason,
  'empty',
  'an empty block is skipped with a reason',
);
check(
  !built.messages.some((message) => message.content.includes('nsfw')),
  'empty blocks produce no message',
);

// ---------------------------------------------------------------------------
section('card overrides');
// ---------------------------------------------------------------------------

const override = build({
  card: makeCard({ system_prompt: 'You are Seraphina. Never break character.', post_history_instructions: 'Stay in setting.' }),
});
check(textOf(override, 'main').includes('Never break character'), 'card system_prompt overrides main');
check(textOf(override, 'jailbreak').includes('Stay in setting'), 'card post_history_instructions overrides jailbreak');

const locked: PromptBlock[] = defaultPromptStack().map((item) =>
  item.identifier === 'main' ? { ...item, forbid_overrides: true } : item,
);
const lockedResult = build({
  card: makeCard({ system_prompt: 'SHOULD NOT APPEAR' }),
  stack: locked,
});
check(
  !textOf(lockedResult, 'main').includes('SHOULD NOT APPEAR'),
  'forbid_overrides blocks the card system prompt',
);

// ---------------------------------------------------------------------------
section('macros');
// ---------------------------------------------------------------------------

const macroVars: Record<string, string> = {};
check(expandMacros('{{char}} meets {{user}}', {
  char: 'Seraphina', user: 'You', persona: '', description: '', personality: '',
  scenario: '', mesExamples: '', variables: macroVars,
}) === 'Seraphina meets You', 'char and user macros expand');
check(expandMacros('{{unknownMacro}}', {
  char: '', user: '', persona: '', description: '', personality: '',
  scenario: '', mesExamples: '', variables: macroVars,
}) === '{{unknownMacro}}', 'unknown macros are preserved, not blanked');
check(expandMacros('{{setvar::mood::calm}}mood is {{getvar::mood}}', {
  char: '', user: '', persona: '', description: '', personality: '',
  scenario: '', mesExamples: '', variables: macroVars,
}) === 'mood is calm', 'variables round-trip through macros');
check(expandMacros('{{incvar::n}}/{{incvar::n}}', {
  char: '', user: '', persona: '', description: '', personality: '',
  scenario: '', mesExamples: '', variables: macroVars,
}) === '1/2', 'incvar increments');
check(expandMacros('{{random::a,b}}', {
  char: '', user: '', persona: '', description: '', personality: '',
  scenario: '', mesExamples: '', variables: macroVars, random: () => 0,
}) === 'a', 'random picks deterministically with an injected RNG');

// Main prompt content expands against the card at build time.
check(textOf(built, 'main').includes('Seraphina'), 'main prompt expands {{char}}');
check(!textOf(built, 'main').includes('{{'), 'no unexpanded macros in the main prompt');
check(textOf(built, 'dialogueExamples').includes('Seraphina'), 'macros inside card example text expand');

// ---------------------------------------------------------------------------
section('world info placement');
// ---------------------------------------------------------------------------

const before = build({
  entries: [makeEntry(0, { key: ['ancient'], position: POSITION.before, content: 'BEFORE_CONTENT' })],
  history: [{ role: 'user', content: 'tell me about the ancient wood' }],
});
check(textOf(before, 'worldInfoBefore').includes('BEFORE_CONTENT'), 'before-position entries land in worldInfoBefore');
check(textOf(before, 'worldInfoAfter') === '', 'worldInfoAfter stays empty');
const beforeItem = before.itemization.find((item) => item.identifier === 'worldInfoBefore');
eq(beforeItem?.worldHits?.length, 1, 'itemization reports the hit');
eq(beforeItem?.worldHits?.[0]?.matchedKeys, ['ancient'], 'itemization reports which key matched');
eq(beforeItem?.worldHits?.[0]?.activatedBy, 'key', 'itemization reports how it activated');

const after = build({
  entries: [makeEntry(1, { key: ['ancient'], position: POSITION.after, content: 'AFTER_CONTENT' })],
  history: [{ role: 'user', content: 'the ancient wood' }],
});
check(textOf(after, 'worldInfoAfter').includes('AFTER_CONTENT'), 'after-position entries land in worldInfoAfter');

const constantHit = build({
  entries: [makeEntry(2, { constant: true, content: 'ALWAYS' })],
  history: [{ role: 'user', content: 'nothing relevant' }],
});
check(textOf(constantHit, 'worldInfoBefore').includes('ALWAYS'), 'constant entries always inject');
eq(
  constantHit.itemization.find((item) => item.identifier === 'worldInfoBefore')?.worldHits?.[0]?.activatedBy,
  'constant',
  'constant activation is reported as such',
);

// ---------------------------------------------------------------------------
section('model-selected retrieval');
// ---------------------------------------------------------------------------

const catalog = buildCatalog([
  { world: 'book', entry: makeEntry(0, { key: ['gate'], comment: 'Ashen Gate', content: 'Opens at dusk.' }) },
  { world: 'book', entry: makeEntry(1, { constant: true, comment: 'Always', content: 'Always here.' }) },
  { world: 'book', entry: makeEntry(2, { disable: true, comment: 'Off', content: 'Off.' }) },
  { world: 'book', entry: makeEntry(3, { key: ['tide'], comment: 'Tide Bell', content: '' }) },
  { world: 'book', entry: makeEntry(4, { key: ['keep'], comment: 'The Keep', content: 'A keep.' }) },
]);
eq(catalog.lines.length, 2, 'constant, disabled and empty entries are not offered');
check(catalog.lines[0].startsWith('1. [book#0] Ashen Gate'), 'a line carries world, uid and title', catalog.lines[0]);
check(catalog.lines[0].includes('(keys: gate)'), 'and its first keys');
eq(catalog.map.get(2)?.uid, 4, 'row numbers map back to the entry');
eq(catalog.map.get(1)?.source, 'model', 'picks are tagged as model-chosen');

const fenced = parseSelection('```json\n[2]\n```', catalog, 3);
eq(fenced.length, 1, 'a fenced array parses');
eq(fenced[0].uid, 4, 'and maps to the right entry');
eq(parseSelection('I think 1 and 2 maybe', catalog, 3).length, 0, 'prose without an array yields nothing');
eq(
  parseSelection('[1, 1, 9, "2"]', catalog, 3).map((hit) => hit.uid),
  [0, 4],
  'duplicates and unknown rows are dropped',
);
eq(parseSelection('[1, 2]', catalog, 1).length, 1, 'the cap is honoured');
check(selectionPrompt(7).includes('at most 7'), 'the prompt states the cap');
check(
  selectionInput(catalog, [{ role: 'user', content: 'go' }]).includes('Recent conversation:\nuser: go'),
  'the conversation tail is appended',
);

const capped = buildCatalog(
  Array.from({ length: 5 }, (_, index) => ({
    world: 'w',
    entry: makeEntry(index, { content: `entry ${index}` }),
  })),
  3,
  10_000,
);
eq(capped.lines.length, 3, 'the entry cap truncates the catalogue');
check(capped.truncated, 'and reports the truncation');

// ---------------------------------------------------------------------------
section('retrieval modes');
// ---------------------------------------------------------------------------

const skillCard = parseCardJSON({
  spec: 'chara_card_v2',
  data: {
    name: 'Skilled',
    character_book: {
      name: 'references',
      entries: [
        { keys: ['one'], content: 'EMBEDDED ONLY' },
        { keys: ['two'], content: 'SHARED BODY' },
        { keys: ['three'], content: 'DISABLED COPY' },
      ],
    },
  },
}).card;
const attached = parseWorldInfo(
  {
    entries: [
      { keys: ['four'], content: 'SHARED BODY' },
      { keys: ['five'], content: 'WORLD ONLY' },
      { keys: ['six'], content: 'DISABLED COPY', enabled: false },
    ],
  },
  { id: 'lore', name: 'Lore' },
).world;

const dumpWorlds = [skillCard.books[0], attached];
const dump = fullInjectionHits(skillCard, dumpWorlds, false, false);
eq(dump.map((hit) => hit.uid), [0, 2], 'a duplicate of a live attached entry is dropped');
check(dump.every((hit) => hit.source === 'full'), 'full hits are tagged as such');
eq(
  fullInjectionHits(skillCard, dumpWorlds, false, true).map((hit) => hit.uid),
  [0, 1, 2],
  'the conflict switch keeps the embedded copy',
);
check(
  fullInjectionHits(skillCard, dumpWorlds, true, false).some((hit) => hit.world === 'lore'),
  'includeWorlds widens the dump to the attached book',
);
eq(
  fullInjectionHits(skillCard, dumpWorlds, false, false).some((hit) => hit.world === 'lore'),
  false,
  'and it stays out otherwise',
);

const retrievalConfig = {
  retrieval: { mode: 'all', fullIncludeWorlds: false, fullForceOnConflict: false },
  scan: { modelSelect: true },
} as unknown as TeahouseConfig;
eq(effectiveRetrievalMode(retrievalConfig, null), 'all', 'the configured mode is the effective one');
eq(
  effectiveRetrievalMode(retrievalConfig, { retrievalMode: 'vector' } as unknown as ChatMeta),
  'vector',
  'a chat pin wins over it',
);
eq(
  effectiveRetrievalMode(retrievalConfig, { retrievalMode: 'nonsense' } as unknown as ChatMeta),
  'all',
  'an unknown pin is ignored',
);

// ---------------------------------------------------------------------------
section('agent files');
// ---------------------------------------------------------------------------

/** A STORE-only zip: the agent reads skill packages, so one has to exist. */
function storeZip(entries: { name: string; text: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.text, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

const agentZip = storeZip([
  { name: 'probe/SKILL.md', text: '---\nname: probe\n---\n\nBody.\n' },
  { name: 'probe/references/city.md', text: 'CITY FILE BODY' },
  { name: 'probe/references/off.md', text: 'OFF BODY' },
]);
const agentSkillCard = parseCardJSON({
  spec: 'chara_card_v2',
  data: {
    name: 'Probe',
    description: 'body',
    extensions: { tavern: { skill: { name: 'probe', files: ['probe/references/city.md', 'probe/references/off.md'] } } },
    character_book: {
      name: 'probe references',
      entries: [
        { keys: ['city'], content: 'CITY FILE BODY' },
        { keys: ['off'], content: 'OFF BODY', enabled: false },
        { keys: ['empty'], content: '   ' },
      ],
    },
  },
}, 'probe').card;
const agentCards = [{ id: 'probe', card: agentSkillCard }];
const agentCatalog = buildAgentCatalog(agentCards);
eq(
  agentCatalog.files.map((file) => file.id),
  ['probe/references/city.md', 'probe/references/off.md', 'book/probe:book/0'],
  'the catalogue lists skill files then live book entries',
);
eq(agentCatalog.truncated, false, 'and is not truncated');
check(agentTool().function.name === 'read_file', 'the tool is read_file');
check(
  agentSystemPrompt(agentCatalog, 4).includes('probe/references/city.md')
    && agentSystemPrompt(agentCatalog, 4).includes('at most 4 files'),
  'the instruction lists the ids and the cap',
);
check(agentInput([{ role: 'user', content: 'hello there' }]).includes('user: hello there'),
  'the loop sees the conversation tail');

eq(parseReadPaths('{"path":"a.md"}'), ['a.md'], 'a path argument parses');
eq(parseReadPaths('{"paths":["a","b"]}'), ['a', 'b'], 'a paths array parses');
eq(parseReadPaths('"a.md"'), ['a.md'], 'a bare string argument parses');
eq(parseReadPaths('a.md'), ['a.md'], 'a bare non-JSON string parses');
eq(parseReadPaths('{}'), [], 'no key yields nothing');
eq(parseReadPaths('{oops'), [], 'broken JSON yields nothing');
eq(parseReadPaths(''), [], 'an empty argument yields nothing');

eq(readSkillFile(agentZip, 'probe/references/city.md'), 'CITY FILE BODY', 'a zip entry reads by name');
eq(readSkillFile(agentZip, 'probe/nope.md'), null, 'a missing entry reads as null');
eq(readSkillFile(agentZip, '../SKILL.md'), null, 'traversal is not a zip name');

const agentStore = { skillSource: (id: string) => (id === 'probe' ? { name: 'skill.zip', bytes: agentZip } : null) };
const agentSrc = agentSource(agentStore, agentCards);
eq(agentSrc.readSkill('probe', 'probe/references/city.md'), 'CITY FILE BODY', 'the source reads a skill file');
eq(agentSrc.readBook('probe:book', 0), 'CITY FILE BODY', 'and a book entry');
eq(agentSrc.readBook('probe:book', 99), null, 'an unknown entry is null');

/** A fake provider: each `script` entry is one non-streaming response body. */
function fakeChat(script: unknown[]): typeof fetch {
  return (async () => {
    const payload = script.shift() ?? { choices: [{ message: { content: 'READY' } }] };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  }) as unknown as typeof fetch;
}
const toolCall = (id: string, path: string) => ({
  choices: [{
    message: {
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path }) } }],
    },
  }],
});
const agentConfig = {
  baseUrl: 'http://fake/v1',
  apiKey: '',
  model: 'fake',
  retrieval: { mode: 'agent', agentMaxRounds: 3, agentMaxFiles: 2, fullIncludeWorlds: false, fullForceOnConflict: false },
} as unknown as TeahouseConfig;

const readOnce = await collectAgentDocs({
  config: agentConfig,
  catalog: agentCatalog,
  source: agentSrc,
  messages: [{ role: 'user', content: 'go' }],
  model: 'fake',
  allowModel: true,
  fetchImpl: fakeChat([toolCall('c1', 'probe/references/city.md')]),
});
eq(readOnce.docs.map((doc) => doc.id), ['probe/references/city.md'], 'the asked-for file is collected');
eq(readOnce.calls, 2, 'one read round then the closing call');
eq(readOnce.warning, null, 'and no warning');

const unknownRead = await collectAgentDocs({
  config: agentConfig,
  catalog: agentCatalog,
  source: agentSrc,
  messages: [],
  model: 'fake',
  allowModel: true,
  fetchImpl: fakeChat([toolCall('c1', 'probe/nope.md')]),
});
eq(unknownRead.docs.length, 0, 'an unlisted id yields no document');

const agentCapped = await collectAgentDocs({
  config: agentConfig,
  catalog: agentCatalog,
  source: agentSrc,
  messages: [],
  model: 'fake',
  allowModel: true,
  fetchImpl: fakeChat([
    toolCall('c1', 'probe/references/city.md'),
    toolCall('c2', 'probe/references/off.md'),
    toolCall('c3', 'book/probe:book/0'),
  ]),
});
eq(agentCapped.docs.length, 2, 'the file cap stops the loop');
check(agentCapped.warning?.code === 'agent.capped' && String(agentCapped.warning.text).includes('上限'), 'and says why', JSON.stringify(agentCapped.warning));

const previewAgent = await collectAgentDocs({
  config: agentConfig,
  catalog: agentCatalog,
  source: agentSrc,
  messages: [],
  model: 'fake',
  allowModel: false,
  fetchImpl: fakeChat([]),
});
eq(previewAgent.calls, 0, 'a preview never spends a call');
eq(previewAgent.docs.length, 0, 'and injects nothing');

const noModel = await collectAgentDocs({
  config: agentConfig,
  catalog: agentCatalog,
  source: agentSrc,
  messages: [],
  model: '',
  allowModel: true,
  fetchImpl: fakeChat([]),
});
eq(noModel.calls, 0, 'no model, no call');
check(noModel.warning !== null, 'and a warning says so');

const failed = await collectAgentDocs({
  config: agentConfig,
  catalog: agentCatalog,
  source: agentSrc,
  messages: [],
  model: 'fake',
  allowModel: true,
  fetchImpl: (async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) })) as unknown as typeof fetch,
});
eq(failed.calls, 1, 'a failed call is still counted');
check(failed.warning !== null && failed.warning.code === 'agent.readFailed' && String(failed.warning.text).includes('失败'), 'and becomes a warning', JSON.stringify(failed.warning));

// ---------------------------------------------------------------------------
section('context limits');
// ---------------------------------------------------------------------------

// The fixtures are the providers' own wording; DeepSeek's two are exactly what
// this project measured against the live API.
const deepseekOverflow = 'provider returned 400: {"error":{"message":"This model\'s maximum context length is 1048576 tokens. '
  + 'However, you requested 1093247 tokens (700031 in the messages, 393216 in the completion). '
  + 'Please reduce the length of the messages or completion.","type":"invalid_request_error"}}';

check(isContextOverflow(deepseekOverflow), 'a DeepSeek overflow is recognised');
eq(parseContextFailure(deepseekOverflow).window, 1_048_576, 'and names the window');
eq(parseContextFailure(deepseekOverflow).requested, 700_031, 'and the count it made for our prompt');

// The streaming wording (this one came back through our own streamChat).
const deepseekStreamed = 'provider returned 400: {"error":{"message":"This model\'s maximum context length is 1048576 tokens. '
  + 'However, you requested 1200031 tokens (1200031 in the messages, 0 in the completion)."}}';
eq(parseContextFailure(deepseekStreamed).window, 1_048_576, 'the streaming wording parses too');
eq(parseContextFailure(deepseekStreamed).requested, 1_200_031, 'including the message count');

const providerFixtures: { label: string; text: string; window: number | null }[] = [
  {
    label: 'OpenAI',
    text: "This model's maximum context length is 128000 tokens. However, your messages resulted in 128001 tokens.",
    window: 128_000,
  },
  {
    label: 'Anthropic',
    text: 'prompt is too long: 213462 tokens > 200000 maximum',
    window: 200_000,
  },
  {
    label: 'Google',
    text: 'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)',
    window: 1_048_575,
  },
  {
    label: 'Together',
    text: "The input (265330 tokens) is longer than the model's context length (262144 tokens).",
    window: 262_144,
  },
  {
    label: 'xAI',
    text: "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
    window: 131_072,
  },
  {
    label: 'Qwen / DashScope',
    text: 'Range of input length should be [1, 62400]',
    window: 62_400,
  },
];
for (const fixture of providerFixtures) {
  check(isContextOverflow(fixture.text), `${fixture.label}: the overflow is recognised`, fixture.text);
  eq(parseContextFailure(fixture.text).window, fixture.window, `${fixture.label}: the window is read`);
}

// Some vendors only say "too long": the caller must keep the warning and skip
// the learning rather than invent a number.
const vagueOverflow = 'Please reduce the length of the messages or completion';
check(isContextOverflow(vagueOverflow), 'a numberless overflow is still an overflow');
eq(parseContextFailure(vagueOverflow).window, null, 'but it yields no window');
eq(parseContextFailure(vagueOverflow).requested, null, 'and no count');

// Throttling is not an overflow, even when it mentions tokens.
check(
  !isContextOverflow('Rate limit reached for requests: too many tokens, please wait'),
  'a rate limit is not an overflow',
);
check(!isContextOverflow('provider returned 500: internal error'), 'nor is a server error');
check(!isContextOverflow(''), 'nor is an empty message');

eq(
  limitKey('https://api.deepseek.com', 'deepseek-flash'),
  limitKey('https://api.deepseek.com/v1/', ' deepseek-flash '),
  'one endpoint and model mean one cache key',
);

// ---------------------------------------------------------------------------
section('absolute injection');
// ---------------------------------------------------------------------------

const injectStack = defaultPromptStack().map((item) =>
  item.identifier === 'main'
    ? {
        ...item,
        injection_position: INJECTION_POSITION.ABSOLUTE,
        injection_depth: 1,
        injection_order: 10,
        content: 'INJECTED_AT_DEPTH_1',
        role: 'user' as const,
      }
    : item,
);
const injected = build({
  stack: injectStack,
  history: [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
  ],
});
const injectIndex = injected.messages.findIndex((message) => message.content.includes('INJECTED_AT_DEPTH_1'));
eq(
  injected.messages.length - 1 - injectIndex,
  1,
  'depth 1 injection has exactly one message after it',
);
eq(injected.messages[injectIndex]?.role, 'user', 'injection keeps its role');
check(
  injected.messages.filter((message) => message.content.includes('INJECTED_AT_DEPTH_1')).length === 1,
  'the injection is not also emitted in list position',
);

const depthZero = build({
  stack: defaultPromptStack().map((item) =>
    item.identifier === 'main'
      ? { ...item, injection_position: INJECTION_POSITION.ABSOLUTE, injection_depth: 0, content: 'D0' }
      : item,
  ),
  history: [{ role: 'user', content: 'only' }],
});
eq(depthZero.messages[depthZero.messages.length - 1]?.content, 'D0', 'depth 0 injection goes last');

// With another injection in play (memory at depth 2 is the common case), a
// depth-0 injection must still land at the very end: the index cannot be derived
// from the original history length once something has been spliced in.
const depthZeroWithMemory = build({
  memory: { text: 'MEMORY_TEXT', template: '[Summary: {{summary}}]', depth: 2, role: 'system', enabled: true },
  stack: defaultPromptStack().map((item) =>
    item.identifier === 'main'
      ? { ...item, injection_position: INJECTION_POSITION.ABSOLUTE, injection_depth: 0, content: 'D0_LAST' }
      : item,
  ),
  history: [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
  ],
});
check(
  depthZeroWithMemory.messages.some((message) => message.content.includes('MEMORY_TEXT')),
  'the memory injection is present too',
);
eq(
  depthZeroWithMemory.messages[depthZeroWithMemory.messages.length - 1]?.content,
  'D0_LAST',
  'and the depth 0 injection still goes last',
);

// World entries with position 4 (atDepth) merge into the same mechanism.
const atDepthEntry = build({
  entries: [
    makeEntry(3, {
      key: ['ancient'],
      position: POSITION.atDepth,
      depth: 1,
      role: 1,
      content: 'ATDEPTH_CONTENT',
    }),
  ],
  history: [
    { role: 'user', content: 'the ancient one' },
    { role: 'assistant', content: 'reply' },
  ],
});
const atDepthIndex = atDepthEntry.messages.findIndex((message) => message.content.includes('ATDEPTH_CONTENT'));
check(atDepthIndex >= 0, 'atDepth entry is injected');
eq(atDepthEntry.messages[atDepthIndex]?.role, 'user', 'atDepth entry uses its configured role');
check(
  textOf(atDepthEntry, 'worldInfoBefore') === '',
  'atDepth entries do not also appear in the before bucket',
);

// Character depth prompt.
const depthPromptCard = makeCard({
  depthPrompt: { prompt: 'CARD_DEPTH_PROMPT', depth: 0, role: 'system' },
});
const depthPromptResult = build({ card: depthPromptCard, history: [{ role: 'user', content: 'hi' }] });
eq(
  depthPromptResult.messages[depthPromptResult.messages.length - 1]?.content,
  'CARD_DEPTH_PROMPT',
  'card depth prompt is injected at depth 0',
);

// Outlets are exposed but never injected.
const outletResult = build({
  entries: [makeEntry(4, { key: ['ancient'], position: POSITION.outlet, group: 'sprite', content: 'OUTLET_CONTENT' })],
  history: [{ role: 'user', content: 'the ancient one' }],
});
eq(Object.keys(outletResult.outlets), ['sprite'], 'outlet entries are collected by name');
check(
  !outletResult.messages.some((message) => message.content.includes('OUTLET_CONTENT')),
  'outlet entries are not injected into the prompt',
);

// ---------------------------------------------------------------------------
section('reply language');
// ---------------------------------------------------------------------------

eq(renderLanguageInstruction({}), '', 'no language means no instruction');
eq(renderLanguageInstruction({ outputLanguage: '   ' }), '', 'whitespace counts as no language');
check(renderLanguageInstruction({ outputLanguage: '中文' }).includes('中文'), 'the language is substituted');
check(
  renderLanguageInstruction({ outputLanguage: '火星文' }).includes('火星文'),
  'an arbitrary language string works verbatim',
);
eq(
  renderLanguageInstruction({ outputLanguage: 'English', languageInstruction: 'Answer in {{language}}.' }),
  'Answer in English.',
  'a custom template is used',
);
eq(
  renderLanguageInstruction({ outputLanguage: 'English', languageInstruction: '   ' }),
  renderLanguageInstruction({ outputLanguage: 'English' }),
  'a blank template falls back to the wording the server ships',
);
check(DEFAULT_LANGUAGE_INSTRUCTION.includes('{{language}}'), 'the default wording has a placeholder');

const withLanguage = applyLanguage(defaultPromptStack(), { outputLanguage: '中文' });
const languageBlock = withLanguage.find((item) => item.identifier === 'language');
eq(languageBlock?.enabled, true, 'the block is enabled once a language is set');
check(languageBlock?.content.includes('中文') === true, 'the block carries the instruction');
eq(
  withLanguage.findIndex((item) => item.identifier === 'language'),
  withLanguage.findIndex((item) => item.identifier === 'main') + 1,
  'the language block sits right after the main prompt',
);

const withoutLanguage = applyLanguage(defaultPromptStack(), {});
eq(
  withoutLanguage.find((item) => item.identifier === 'language')?.enabled,
  false,
  'the block is disabled when no language is configured',
);

// A stale client stack that dropped the block must get it back, otherwise the
// setting would silently stop working.
const stripped = defaultPromptStack().filter((item) => item.identifier !== 'language');
const restored = applyLanguage(stripped, { outputLanguage: '日本語' });
eq(
  restored.find((item) => item.identifier === 'language')?.enabled,
  true,
  'a stack missing the block gets it inserted',
);
eq(restored[0]?.identifier, 'main', 'main stays first after the insertion');

const languageBuilt = build({ outputLanguage: '文言文' });
check(
  languageBuilt.messages.some((message) => message.content.includes('文言文')),
  'the instruction reaches the assembled request',
);
check(
  (languageBuilt.itemization.find((item) => item.identifier === 'language')?.tokens ?? 0) > 0,
  'the block is itemised with its own token cost',
);
const noLanguageBuilt = build({});
check(
  !noLanguageBuilt.messages.some((message) => message.content.includes('Always write your replies in')),
  'nothing is injected when the language is unset',
);
check(
  noLanguageBuilt.itemization.find((item) => item.identifier === 'language')?.skippedReason === 'disabled',
  'the skipped language block is reported as disabled',
);

// ---------------------------------------------------------------------------
section('impersonation block');
// ---------------------------------------------------------------------------

check(
  !DEFAULT_IMPERSONATE_INSTRUCTION.includes('{{user}}'),
  'the wording never leans on the persona name (a persona named "我" would read as the pronoun)',
);
check(DEFAULT_IMPERSONATE_INSTRUCTION.includes('{{char}}'), 'and names the character it must not write');
check(DEFAULT_IMPERSONATE_INSTRUCTION.includes('the player'), 'and speaks of the player rather than a persona name');
check(
  DEFAULT_IMPERSONATE_INSTRUCTION.includes('not as {{char}}'),
  'and says which identity to avoid',
);
const impersonated = build({ impersonate: true });
check(
  impersonated.messages.some((message) => message.content.includes('not as Seraphina')),
  'the impersonation instruction reaches the request only in that mode',
);
check(
  (impersonated.itemization.find((item) => item.identifier === 'impersonate')?.tokens ?? 0) > 0,
  'the block is itemised with its own token cost',
);
// The bug this pins: an instruction placed *before* the history is buried under
// the character's own last reply, so the model continues that narration instead
// of writing as the player. It has to be the last message — and it has to be a
// *user* message: a trailing system note is read as background and the model
// keeps answering as the character (measured A/B against the real API).
const impersonateLast = impersonated.messages.at(-1);
eq(impersonateLast?.role, 'user', 'the impersonation instruction is a trailing user message');
check(
  String(impersonateLast?.content ?? '').includes('the player'),
  'and it is the last thing the model reads',
  String(impersonateLast?.content ?? '').slice(0, 60),
);
const notImpersonated = build({});
check(
  !notImpersonated.messages.some((message) => message.content.includes('the player')),
  'normal turns never inject the impersonation instruction',
);
check(
  notImpersonated.itemization.find((item) => item.identifier === 'impersonate')?.skippedReason === 'disabled',
  'the idle impersonation block is reported as disabled',
);
const impersonateOff = applyImpersonate(defaultPromptStack(), true).map((item) =>
  item.identifier === 'impersonate' ? { ...item, enabled: false } : item,
);
const respected = build({ stack: impersonateOff, impersonate: true });
check(
  !respected.messages.some((message) => message.content.includes('the player')),
  'the panel switch wins: off means not injected even in that mode',
);
const legacyStack = defaultPromptStack().filter((item) => item.identifier !== 'impersonate');
const upgraded = applyImpersonate(legacyStack, true);
eq(
  upgraded.find((item) => item.identifier === 'impersonate')?.injection_depth,
  0,
  'an inserted impersonation block is an absolute injection at depth 0',
);
eq(
  upgraded.find((item) => item.identifier === 'impersonate')?.enabled,
  true,
  'a stored stack missing the block gets it inserted',
);

// ---------------------------------------------------------------------------
section('token accounting and trimming');
// ---------------------------------------------------------------------------

const itemized = built.itemization
  .filter((item) => item.tokens > 0)
  .reduce((sum, item) => sum + item.tokens, 0);
const messageTokens = built.messages.reduce((sum, message) => sum + counter.count(message.content), 0);
eq(itemized, messageTokens, 'itemization tokens add up to the message tokens');
eq(built.totalTokens, messageTokens, 'totalTokens matches the message list');
eq(built.trimmed, 0, 'nothing is trimmed when everything fits');

const longHistory: ChatMessage[] = [];
for (let i = 0; i < 40; i++) {
  longHistory.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'word '.repeat(60) });
}
const trimmedResult = build({ history: longHistory, maxContext: 800 });
check(trimmedResult.trimmed > 0, 'long history is trimmed', `trimmed=${trimmedResult.trimmed}`);
check(trimmedResult.messages.length < longHistory.length, 'messages were actually dropped');
check(trimmedResult.warnings.length > 0, 'trimming is reported as a warning');
check(
  trimmedResult.messages.length > 0 && trimmedResult.messages[trimmedResult.messages.length - 1]?.content.includes('word'),
  'the newest history survives trimming',
);

const disabledStack = defaultPromptStack().map((item) =>
  item.identifier === 'charDescription' ? { ...item, enabled: false } : item,
);
const disabled = build({ stack: disabledStack });
eq(
  disabled.itemization.find((item) => item.identifier === 'charDescription')?.skippedReason,
  'disabled',
  'disabled blocks are reported',
);
check(
  !disabled.messages.some((message) => message.content.includes('forest guardian')),
  'disabled blocks produce no message',
);

// ---------------------------------------------------------------------------
section('fixture corpus end to end');
// ---------------------------------------------------------------------------

const fixtureBook = parseWorldInfo(
  JSON.parse(readFileSync(resolve(here, '..', 'corpus', 'owned', 'st-native', 'full-fields.json'), 'utf8')),
  { id: 'lantern', format: 'st-native' },
).world;

const cardFixturePath = resolve(here, '..', 'corpus', 'owned', 'cards', 'osk.png');
const fixtureCard = parseCardJSON(
  JSON.parse(
    // The PNG's embedded book is already covered by the conformance suite; here
    // we only need a realistic card body.
    JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Osk',
        description: 'The harbourmaster of the Lantern District, patient and immovable.',
        personality: 'Patient, immovable, dry.',
        scenario: 'The sea wall at dusk.',
        first_mes: '*She does not look up.* "You are early. Sit."',
        mes_example: '<START>\n{{user}}: Is the water coming over?\n{{char}}: *A page turns.* "Not yet."',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: {},
      },
    }),
  ),
  'osk',
).card;
check(existsSync(cardFixturePath), 'card fixture exists on disk');

const endToEnd = buildPrompt({
  card: fixtureCard,
  persona: 'A traveller.',
  personaName: 'You',
  // Entry 0 needs a primary key AND one of its secondary keys ("river"/"quarter").
  history: [{ role: 'user', content: 'I ask about the Lantern District down by the river.' }],
  scan: scanWorldInfo({
    entries: fixtureBook.entries.map((entry) => ({ world: 'lantern', entry })),
    messages: [{ name: 'You', content: 'I ask about the Lantern District down by the river.' }],
    settings: { maxContext: 8192, depth: 2 },
  }),
  tokenCounter: counter,
  maxContext: 8192,
});
const e2eBefore = endToEnd.itemization.find((item) => item.identifier === 'worldInfoBefore');
console.log(`  end-to-end: ${endToEnd.messages.length} messages, ${endToEnd.totalTokens} tokens, ` +
  `world hits: ${e2eBefore?.worldHits?.map((hit) => `${hit.uid}(${hit.matchedKeys.join('|')})`).join(', ') || 'none'}`);
check((e2eBefore?.worldHits?.length ?? 0) > 0, 'a fixture world book injects into the prompt');
check(endToEnd.totalTokens > 0, 'end-to-end prompt has tokens');
check(
  endToEnd.messages.some((message) => message.content.includes('harbourmaster')),
  'the fixture card description reaches the prompt',
);
check(
  !JSON.stringify(endToEnd.messages).includes('{{user}}'),
  'no unexpanded macros survive into the request',
);

// ---------------------------------------------------------------------------
section('long-term memory');
// ---------------------------------------------------------------------------

// The block is filled from the settings plus the stored summary, and — like the
// reply language — a row switched off in the panel stays off.
const memoryStack = applyMemory(defaultPromptStack(), {
  text: '潮汐表与港口。',
  template: '[Summary: {{summary}}]',
  depth: 2,
  role: 'system',
  enabled: true,
});
const memoryBlock = memoryStack.find((block) => block.identifier === 'memory')!;
check(Boolean(memoryBlock), 'the memory block is inserted into a default stack');
eq(memoryBlock.content, '[Summary: 潮汐表与港口。]', 'with the template filled in');
eq(memoryBlock.injection_position, INJECTION_POSITION.ABSOLUTE, 'it injects at a depth, not in list order');
eq(memoryBlock.injection_depth, 2, 'two messages from the end, like SillyTavern');
eq(memoryBlock.role, 'system', 'as a system message');
eq(memoryBlock.enabled, true, 'and enabled');

const emptyMemory = applyMemory(defaultPromptStack(), {
  text: '   ',
  template: '[Summary: {{summary}}]',
  depth: 2,
  role: 'system',
  enabled: true,
});
eq(
  emptyMemory.find((block) => block.identifier === 'memory')!.enabled,
  false,
  'an empty summary disables the block instead of injecting empty brackets',
);
const offMemory = applyMemory(defaultPromptStack(), {
  text: 'x',
  template: '[Summary: {{summary}}]',
  depth: 2,
  role: 'system',
  enabled: false,
});
// The content stays so the panel can show what is stored; `enabled` is what keeps
// it out of the request.
eq(
  offMemory.find((block) => block.identifier === 'memory')!.enabled,
  false,
  'with the feature off the block is not injected',
);
const builtWithFeatureOff = buildPrompt({
  card: fixtureCard,
  history: [{ role: 'user', content: '我们到港口了' }],
  scan: null,
  tokenCounter: counter,
  maxContext: 8192,
  memory: {
    text: '潮汐表与港口。',
    template: '[Summary: {{summary}}]',
    depth: 2,
    role: 'system',
    enabled: false,
  },
});
check(
  !JSON.stringify(builtWithFeatureOff.messages).includes('潮汐表'),
  'so nothing of the summary reaches the request',
  JSON.stringify(builtWithFeatureOff.messages).slice(0, 160),
);
const panelStack = applyMemory(defaultPromptStack(), {
  text: 'x',
  template: '{{summary}}',
  depth: 1,
  role: 'user',
  enabled: true,
}).map((block) => (block.identifier === 'memory' ? { ...block, enabled: false } : block));
const panelOff = applyMemory(panelStack, {
  text: 'x',
  template: '{{summary}}',
  depth: 1,
  role: 'user',
  enabled: true,
});
eq(
  panelOff.find((block) => block.identifier === 'memory')!.enabled,
  false,
  'a row switched off in the panel is not put back on by the next assembly',
);
const userRole = applyMemory(defaultPromptStack(), {
  text: 'x',
  template: '{{summary}}',
  depth: 4,
  role: 'user',
  enabled: true,
});
const userBlock = userRole.find((block) => block.identifier === 'memory')!;
eq(userBlock.role, 'user', 'the role is configurable');
eq(userBlock.injection_depth, 4, 'so is the depth');

const memoryBuilt = buildPrompt({
  card: fixtureCard,
  history: [{ role: 'user', content: '我们到港口了' }],
  scan: null,
  tokenCounter: counter,
  maxContext: 8192,
  memory: {
    text: '潮汐表与港口。',
    template: '[Summary: {{summary}}]',
    depth: 2,
    role: 'system',
    enabled: true,
  },
});
check(
  memoryBuilt.messages.some((message) => String(message.content).includes('[Summary: 潮汐表与港口。]')),
  'the summary reaches the request',
  JSON.stringify(memoryBuilt.messages).slice(0, 200),
);
const memoryItem = memoryBuilt.itemization.find((item) => item.identifier === 'memory')!;
eq(memoryItem.kind, 'injection', 'and is itemized as an injection');
check(memoryItem.tokens > 0, 'with its own token cost', `${memoryItem.tokens}`);

// Progress and the summarising call itself.
const entriesForMemory = [
  { id: 'm0', parentId: null, role: 'assistant' as const, content: '开场白', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'm1', parentId: 'm0', role: 'user' as const, content: '你好', createdAt: '2026-01-01T00:00:01Z' },
  { id: 'm2', parentId: 'm1', role: 'system' as const, content: '旁白不该被总结', createdAt: '2026-01-01T00:00:02Z' },
  { id: 'm3', parentId: 'm2', role: 'assistant' as const, content: '   ', createdAt: '2026-01-01T00:00:03Z' },
];
const baseMemory = memorySettings({ memory: { enabled: true, interval: 2 } });
const fresh = memoryProgress(entriesForMemory, {}, baseMemory);
eq(fresh.since, 2, 'system notes and empty turns are not counted as messages');
eq(fresh.covered, 0, 'and nothing is covered before the first summary');
eq(fresh.due, true, 'two pending messages reach an interval of two');
eq(
  memoryProgress(entriesForMemory, {}, { ...baseMemory, interval: 3 }).due,
  false,
  'and stay short of an interval of three',
);
eq(
  memoryProgress(entriesForMemory, {}, { ...baseMemory, enabled: false }).due,
  false,
  'a disabled feature is never due',
);
const withRecord = memoryProgress(
  entriesForMemory,
  { memory: { text: 'x', upToEntryId: 'm1', upToIndex: 2, updatedAt: '', model: '', tokens: 1 } },
  baseMemory,
);
eq(withRecord.covered, 2, 'a stored anchor covers what it summarised');
eq(withRecord.since, 0, 'and leaves nothing pending');
const lostAnchor = memoryProgress(
  entriesForMemory,
  { memory: { text: 'x', upToEntryId: 'gone', upToIndex: 2, updatedAt: '', model: '', tokens: 1 } },
  baseMemory,
);
eq(lostAnchor.since, 2, 'a deleted anchor makes everything pending again');
eq(lostAnchor.due, true, 'so the next turn re-summarises instead of losing the thread');
eq(
  memoryProgress(
    entriesForMemory,
    { memory: { text: 'x', upToEntryId: 'm1', upToIndex: 2, updatedAt: '', model: '', tokens: 1, frozen: true } },
    baseMemory,
  ).due,
  false,
  'a frozen summary is never updated automatically',
);
eq(
  pendingEntries(entriesForMemory, {
    text: 'x',
    upToEntryId: 'm0',
    upToIndex: 1,
    updatedAt: '',
    model: '',
    tokens: 1,
  }).map((entry) => entry.id),
  ['m1'],
  'only the messages after the anchor go to the summariser',
);

const summaryRequest = buildSummaryMessages({
  instruction: renderMemoryPrompt(DEFAULT_MEMORY_PROMPT, 200),
  previous: '他们到了港口。',
  entries: entriesForMemory,
  names: { char: 'Osk', user: '旅人' },
});
eq(summaryRequest.length, 2, 'the summarising call is a system instruction plus the transcript');
check(
  summaryRequest[0]!.content.includes('200 words'),
  'with the target length filled in',
  summaryRequest[0]!.content.slice(0, 80),
);
check(summaryRequest[0]!.content.includes('use that as a base'), 'and the rolling instruction SillyTavern uses');
check(summaryRequest[1]!.content.includes('[Existing summary]'), 'the previous summary is handed back');
check(summaryRequest[1]!.content.includes('旅人: 你好'), 'and every line says who spoke');
eq(cleanSummary('  "潮汐表。"  '), '潮汐表。', 'quotes are stripped from the model output');
eq(cleanSummary('[Summary: 潮汐表。]'), '潮汐表。', 'as is an echoed block template');
eq(cleanSummary('\n 两名旅人离港。 \n'), '两名旅人离港。', 'and surrounding whitespace');
const stored = summarizeRecord({
  text: '两名旅人离港。',
  covered: entriesForMemory.filter((entry) => entry.role !== 'system' && entry.content.trim() !== ''),
  model: 'fake-model',
  tokens: 12,
  usage: { promptTokens: 100, completionTokens: 20 },
});
eq(stored.upToEntryId, 'm1', 'a fresh record anchors on the last message it covered');
eq(stored.upToIndex, 2, 'and remembers how many that was');
eq(stored.usage?.promptTokens, 100, 'keeping what the call cost');

// ---------------------------------------------------------------------------
section('context template');
// ---------------------------------------------------------------------------

const storyParams = {
  system: '',
  description: 'A forest guardian with amber eyes.',
  personality: 'Calm, watchful, kind.',
  scenario: 'A glade inside the woods of Eldoria.',
  persona: 'A wandering scholar.',
  char: 'Seraphina',
  user: 'You',
  wiBefore: 'CONTENT_0',
  wiAfter: '',
};
const storyRendered = renderStoryTemplate(DEFAULT_STORY_TEMPLATE, storyParams);
check(storyRendered.text.includes('A forest guardian'), 'the default template carries the description');
check(storyRendered.text.includes("Seraphina's personality"), 'and the personality with the name');
check(storyRendered.text.includes('Scenario: A glade'), 'and the scenario');
check(storyRendered.text.includes('A wandering scholar.'), 'and the persona');
eq(storyRendered.warnings.filter((w) => w.code === 'contextTemplate.unknownFields').length, 0, 'the default template names nothing unknown');

const condRendered = renderStoryTemplate('{{#if persona}}P:{{persona}}{{/if}}|{{#if wiAfter}}W:{{wiAfter}}{{/if}}', storyParams);
eq(condRendered.text, 'P:A wandering scholar.|', 'empty fields render nothing inside their conditionals');

const aliasRendered = renderStoryTemplate('{{loreBefore}}', storyParams);
eq(aliasRendered.text, 'CONTENT_0', 'loreBefore is accepted as wiBefore');
const unknownRendered = renderStoryTemplate('{{char}} {{frobnicate}}', storyParams);
check(unknownRendered.text.includes('Seraphina'), 'known fields still render');
check(
  unknownRendered.warnings.some(
    (w) => w.code === 'contextTemplate.unknownFields' && String(w.params?.fields).includes('frobnicate'),
  ),
  'unknown fields are reported, not silent',
);
const missingRendered = renderStoryTemplate('hi', storyParams);
check(
  missingRendered.warnings.some(
    (w) => w.code === 'contextTemplate.missingContent' && String(w.params?.fields).includes('{{description}}'),
  ),
  'content left out of the template is reported',
);

// Through the stack: a real block with its own cost, off when the template is empty.
const storyBuilt = build({ storyTemplate: '{{#if description}}D:{{description}}{{/if}}' });
const storyItem = storyBuilt.itemization.find((item) => item.identifier === 'story')!;
eq(storyItem.kind, 'static', 'the story is a plain block in list order');
check((storyItem.tokens ?? 0) > 0, 'with its own token cost');
check(textOf(storyBuilt, 'story').includes('D:A forest guardian'), 'rendered, not the raw template');
check(storyBuilt.messages.some((m) => m.content.includes('D:A forest guardian')), 'and it reaches the request');
const noStoryBuilt = build({});
eq(
  noStoryBuilt.itemization.find((item) => item.identifier === 'story')?.skippedReason,
  'disabled',
  'an empty template disables the block instead of injecting nothing',
);
check(!JSON.stringify(noStoryBuilt.messages).includes('Context Template'), 'and nothing extra reaches the request');

// ---------------------------------------------------------------------------
section('regex rules');
// ---------------------------------------------------------------------------

const { problems: regexProblems } = coerceRegexFile({
  rules: [{ id: 'a', name: 'x', pattern: 'foo', flags: 'g', replacement: 'bar', scope: 'both', enabled: true }],
});
eq(regexProblems.length, 0, 'a valid file passes');
eq(coerceRegexFile({ rules: [{ id: 'b', name: 'bad', pattern: '([', flags: '', replacement: '', scope: 'prompt', enabled: true }] }).problems.length, 1, 'an uncompilable pattern is rejected with a reason');
const flagProblems = coerceRegexFile({ rules: [{ id: 'c', name: '', pattern: 'x', flags: 'zz', replacement: '', scope: 'prompt', enabled: true }] }).problems;
check(flagProblems.length >= 1 && flagProblems.some((p) => p.includes('标志')), 'bad flags are rejected too');

const promptRewritten = applyPromptRegexes(['the harbourmaster waits'], [
  { id: 'r1', name: 'tide', pattern: 'harbourmaster', flags: '', replacement: 'warden', scope: 'prompt', enabled: true },
  { id: 'r2', name: 'off', pattern: 'waits', flags: '', replacement: 'sleeps', scope: 'prompt', enabled: false },
]);
eq(promptRewritten.contents, ['the warden waits'], 'prompt rules rewrite; disabled ones do not');
eq(promptRewritten.applied.length, 1, 'and report what fired');
const displayRewritten = applyDisplayRegexes('hello world', [
  { id: 'r3', name: 'd', pattern: 'world', flags: '', replacement: 'teahouse', scope: 'display', enabled: true },
]);
eq(displayRewritten.text, 'hello teahouse', 'display rules rewrite the shown copy');
eq(
  applyDisplayRegexes('hello world', [
    { id: 'r4', name: 'p', pattern: 'world', flags: '', replacement: 'teahouse', scope: 'prompt', enabled: true },
  ]).text,
  'hello world',
  'a prompt-only rule never touches the display',
);

// End to end through the stack: preview messages carry the rewrite, storage does not.
const regexBuilt = build({
  storyTemplate: '',
  promptRegexes: [
    { id: 'r5', name: 'user-tag', pattern: 'Hello there', flags: '', replacement: 'Greetings', scope: 'prompt', enabled: true },
  ],
});
check(
  JSON.stringify(regexBuilt.messages).includes('Greetings'),
  'the prompt-side rewrite reaches the request',
);
check(
  regexBuilt.warnings.some((w) => w.code === 'regex.rewroteNamed' && String(w.params?.name).includes('user-tag')),
  'and the preview names the rule that fired',
);

// ---------------------------------------------------------------------------
section('translation detection');
// ---------------------------------------------------------------------------

eq(targetIsCjk('中文'), true, '中文 wants CJK');
eq(targetIsCjk('English'), false, 'English does not');
eq(needsTranslation('Hello there, traveller.', '中文'), true, 'an English greeting under a 中文 preset needs it');
eq(needsTranslation('你好，旅人。', '中文'), false, 'a Chinese line does not');
eq(needsTranslation('你好，旅人。', 'English'), true, 'nor does a Chinese line under an English preset pass');
eq(needsTranslation('Hello 你好', '中文'), false, 'mixed text is left alone');
eq(needsTranslation('Hello there.', ''), false, 'without a target language nothing is needed');
eq(needsTranslation('   ', '中文'), false, 'nor for an empty message');
const translationPrompt = buildTranslationPrompt('Hello there.', '中文');
check(translationPrompt.system.includes('中文'), 'the instruction names the target');
check(translationPrompt.system.includes('only the translation'), 'and demands nothing but the answer');
eq(translationPrompt.user, 'Hello there.', 'the message travels verbatim');

// ---------------------------------------------------------------------------
section('images');
// ---------------------------------------------------------------------------

eq(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.mime, 'image/png', 'a PNG is sniffed from its bytes');
eq(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))?.mime, 'image/jpeg', 'so is a JPEG');
eq(
  sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))?.mime,
  'image/gif',
  'and a GIF',
);
eq(
  sniffImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]))?.mime,
  'image/webp',
  'and WebP',
);
eq(sniffImage(new Uint8Array([104, 105])) , null, 'while text is refused');
eq(sniffImage(new Uint8Array([])), null, 'as is nothing');
check(MAX_IMAGE_BYTES === 32 * 1024 * 1024, 'the ceiling matches the provider limit');
const blocked = messageWithImages('hi', [{ mime: 'image/png', base64: 'QUJD' }]);
check(
  Array.isArray(blocked) && blocked.length === 2 && blocked[1]?.type === 'image_url' &&
    String((blocked[1] as { image_url: { url: string } }).image_url.url).startsWith('data:image/png;base64,'),
  'a picture becomes an inline block after the text',
);
eq(messageWithImages('hi', []), 'hi', 'without pictures the message stays a string');

// ---------------------------------------------------------------------------
section('display macros');
// ---------------------------------------------------------------------------

const displayCtx = {
  char: 'Seraphina',
  user: '旅人',
  persona: 'scholar',
  description: '',
  personality: '',
  scenario: '',
  mesExamples: '',
  variables: { tide: 'high' },
};
eq(
  expandDisplayMacros('递给{{user}}，{{char}}笑了。', displayCtx),
  '递给旅人，Seraphina笑了。',
  'names expand for reading',
);
eq(expandDisplayMacros('{{getvar::tide}}', displayCtx), 'high', 'getvar reads');
eq(
  expandDisplayMacros('{{setvar::x::1}}{{random::a,b}}不变', displayCtx),
  '{{setvar::x::1}}{{random::a,b}}不变',
  'writers and dice stay literal',
);
eq(displayCtx.variables.tide, 'high', 'and nothing was written as a side effect');
eq(expandDisplayMacros('没宏', displayCtx), '没宏', 'plain text passes through');

// ---------------------------------------------------------------------------
section('text completion');
// ---------------------------------------------------------------------------

const flat = buildCompletionPrompt(
  [
    { role: 'system', content: 'Be Seraphina.' },
    { role: 'user', content: 'Hello there.' },
    { role: 'assistant', content: 'Hi, traveller.' },
    { role: 'user', content: '  ' },
  ],
  'Seraphina',
  'You',
  ['###'],
);
check(flat.prompt.includes('Be Seraphina.'), 'system lines travel verbatim');
check(flat.prompt.includes('You: Hello there.'), 'user turns are prefixed');
check(flat.prompt.includes('Seraphina: Hi, traveller.'), 'so are assistant turns');
check(!flat.prompt.includes('  \n'), 'empty messages are dropped');
check(flat.prompt.endsWith('Seraphina:\n'), 'the prompt ends on the open reply line');
eq(flat.stop[0], '###', 'configured stops keep their place');
check(flat.stop.includes('\nYou:'), 'and the next user line stops the model');
check(flat.stop.includes('\nSeraphina:'), 'as does the next reply line');

// A group turn already carries its speakers: flattening keeps them.
const groupFlat = buildCompletionPrompt(
  [
    { role: 'user', content: 'Hi all.', name: 'You' },
    { role: 'assistant', content: 'Hey.', name: 'Ally' },
  ],
  'Seraphina',
  'You',
  [],
);
check(groupFlat.prompt.includes('Ally: Hey.'), 'assistant turns keep their speaker');
check(groupFlat.prompt.endsWith('Seraphina:\n'), 'while the open line stays the answerer');

// ---------------------------------------------------------------------------
section('group speaker');
// ---------------------------------------------------------------------------

const cast = [
  { id: 's', name: 'Seraphina' },
  { id: 'v', name: 'Valerie Vance' },
];
eq(matchSpeakerName('I think Valerie Vance should go.', cast)?.id, 'v', 'the named member is picked');
eq(matchSpeakerName('Nobody here.', cast), null, 'prose without a name picks nobody');
eq(nextRoundRobin(cast, null).id, 's', 'round-robin starts at the first member');
eq(nextRoundRobin(cast, 's').id, 'v', 'then walks the lineup');
eq(nextRoundRobin(cast, 'v').id, 's', 'and wraps around');

// ---------------------------------------------------------------------------
section('group modes');
// ---------------------------------------------------------------------------

const trio = [
  { id: 's', name: 'Seraphina', talkativeness: 50 },
  { id: 'v', name: 'Valerie Vance', talkativeness: 50 },
  { id: 'b', name: 'Bo', talkativeness: 20 },
];
/** The plan as ids, for short assertions. */
const ids = (members: { id: string }[]): string => members.map((member) => member.id).join(',');
const silent = (): number => 0.99;
const eager = (): number => 0;

eq(isGroupMode('natural'), true, 'a known mode is accepted');
eq(isGroupMode('round'), true, 'including the original one');
eq(isGroupMode('telepathy'), false, 'an unknown mode is not');

// list — everyone, in lineup order.
eq(ids(activateGroupSpeakers({ mode: 'list', members: trio, cap: 0 })), 's,v,b', 'list answers with the whole lineup');
eq(ids(activateGroupSpeakers({ mode: 'list', members: trio, cap: 2 })), 's,v', 'and the cap cuts it short');
eq(ids(activateGroupSpeakers({ mode: 'list', members: trio })), 's', 'while the default cap is one reply per round');

// round — the director's pick, then the lineup in turn.
eq(ids(activateGroupSpeakers({ mode: 'round', members: trio, first: trio[1], cap: 0 })), 'v,b,s', 'round starts at the pick and walks the lineup');
eq(ids(activateGroupSpeakers({ mode: 'round', members: trio, first: trio[1], cap: 1 })), 'v', 'a cap of one keeps the pick alone');
eq(ids(activateGroupSpeakers({ mode: 'round', members: trio, first: null })), 's', 'with no pick the first member answers');

// manual — only the named members.
eq(ids(activateGroupSpeakers({ mode: 'manual', members: trio, input: 'Valerie, your line.', userInput: true })), 'v', 'manual answers the member who was named');
eq(ids(activateGroupSpeakers({ mode: 'manual', members: trio, input: 'Somebody say something.', userInput: true })), '', 'and nobody at all when nobody was named');
eq(
  ids(activateGroupSpeakers({ mode: 'manual', members: trio, input: 'Seraphina, again.', userInput: true, lastSpeaker: 's' })),
  's',
  'the user may call back the member who just spoke',
);

// mentions — a name or a word of it, but never part of a longer word.
eq(ids(namedSpeakers('Bo, go.', trio)), 'b', 'a standalone name is a mention');
eq(ids(namedSpeakers('I asked Valerie about it.', trio)), 'v', 'and so is a word of a longer name');
eq(ids(namedSpeakers('It was valor, not her.', trio)), '', 'while a longer word is not');
eq(ids(namedSpeakers('阿莉，你说', [{ id: 'x', name: '阿莉' }])), 'x', 'a CJK name is matched as a substring');

// pooled — whoever has not spoken since the user's message.
eq(
  ids(activateGroupSpeakers({ mode: 'pooled', members: trio, spokenSinceUser: ['s', 'v'], userInput: false, random: eager })),
  'b',
  'pooled prefers the member who has not spoken',
);
eq(
  ids(activateGroupSpeakers({ mode: 'pooled', members: trio, spokenSinceUser: ['s', 'v', 'b'], userInput: false, random: eager })),
  's',
  'and falls back to the lineup once everyone has',
);
eq(
  ids(activateGroupSpeakers({ mode: 'pooled', members: trio, spokenSinceUser: ['s', 'v', 'b'], userInput: true, random: silent })),
  'b',
  'a user turn starts the pool over, so the pick is a plain random one',
);
eq(
  ids(activateGroupSpeakers({ mode: 'pooled', members: trio, userInput: true, random: eager, cap: 0 })),
  's,v,b',
  'and a larger cap fills from the rest of the lineup',
);

// natural — mentions first, then talkativeness rolls, then a quiet fallback.
eq(
  ids(activateGroupSpeakers({ mode: 'natural', members: trio, input: 'Valerie?', userInput: true, random: silent })),
  'v',
  'natural answers the named member first',
);
eq(
  ids(activateGroupSpeakers({ mode: 'natural', members: trio, userInput: true, random: silent })),
  'b',
  'a silent roll still picks one talkative member, so a round is never empty',
);
eq(
  activateGroupSpeakers({ mode: 'natural', members: trio, userInput: true, random: eager, cap: 0 }).length,
  3,
  'a lucky roll lets the whole lineup speak',
);
eq(
  activateGroupSpeakers({ mode: 'natural', members: trio, userInput: true, random: eager }).length,
  1,
  'bounded by the cap, like every other mode',
);
eq(
  activateGroupSpeakers({ mode: 'natural', members: trio, userInput: false, lastSpeaker: 's', random: eager, cap: 0 })
    .some((member) => member.id === 's'),
  false,
  'and the member who just spoke is barred on a chained turn',
);
eq(
  activateGroupSpeakers({ mode: 'natural', members: trio, userInput: true, lastSpeaker: 's', random: eager, cap: 0 }).length,
  3,
  'but not after the user spoke, where the last line is theirs',
);
eq(
  activateGroupSpeakers({ mode: 'natural', members: trio, userInput: false, lastSpeaker: 's', allowSelfResponses: true, random: eager, cap: 0 }).length,
  3,
  'unless self-responses are allowed',
);
// A member nobody can talk into speaking (talkativeness 0) never rolls, but is
// still a candidate for the fallback pool.
const mute = [{ id: 'm', name: 'Mute', talkativeness: 0 }];
eq(
  ids(activateGroupSpeakers({ mode: 'natural', members: mute, userInput: true, random: eager })),
  'm',
  'a lineup that cannot roll still answers with somebody',
);

console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILURES'}  checks=${checks} failed=${failures}`);
process.exit(failures === 0 ? 0 : 1);
