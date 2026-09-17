/**
 * Generates the committed fixture corpus under `corpus/owned/`.
 *
 * Everything here is original: an invented setting ("the Lantern District"),
 * a PNG character card assembled from raw chunks, and a miniature byte-level BPE
 * tokenizer. Nothing is copied from SillyTavern or from any published world book,
 * so the repository ships no third-party content while the suites still run
 * against real file *shapes*.
 *
 * Real published world books are still worth testing against. Drop them into
 * `corpus/local/` (git-ignored) and the conformance suite picks them up
 * automatically.
 *
 * Run: npm run fixtures
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { byteLevelAlphabet } from '../src/engine/hf-tokenizer.ts';
import { parseCardFile } from '../src/formats/character-card.ts';
import { writeChunks, writeTextChunks } from '../src/formats/png-text.ts';
import { parseWorldInfo } from '../src/formats/world-info.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', 'corpus', 'owned');

function emit(relative: string, value: unknown): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`);
  console.log(`  ${relative}`);
}

function emitBinary(relative: string, bytes: Buffer): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`  ${relative}  (${bytes.length} bytes)`);
}

// ---------------------------------------------------------------------------
// Shared setting. Invented for these fixtures.
// ---------------------------------------------------------------------------

const LANTERN = {
  district:
    'The Lantern District is the old merchant quarter. Every doorway carries a paper lantern; at dusk they are lit in order from the river inward.',
  harbourmaster:
    'The harbourmaster is a wide, patient woman named Osk. She has never once raised her voice and has never once been disobeyed.',
  tideBell:
    'A bronze bell on the sea wall. It rings twice a day; a third ring means the water is coming over the wall.',
  ashfall:
    'Ashfall is what the locals call the grey snow that falls after a burn. It is warm to the touch for the first hour.',
  kettle:
    'The Kettle House is a two-room teahouse with no sign. You are expected to know where it is.',
  wardens:
    'Wardens carry a stamped badge and swear a public oath on appointment. Their authority ends at the river.',
};

// ---------------------------------------------------------------------------
// ST-native (entries is an object keyed by uid)
// ---------------------------------------------------------------------------

/** Every field of `newWorldInfoEntryDefinition`, plus one unknown key. */
const FULL_FIELDS = {
  entries: {
    0: {
      uid: 0,
      key: ['lantern district', 'the district'],
      keysecondary: ['river', 'quarter'],
      comment: 'Lantern District',
      content: LANTERN.district,
      constant: false,
      selective: true,
      selectiveLogic: 0,
      addMemo: true,
      order: 100,
      position: 0,
      disable: false,
      ignoreBudget: false,
      excludeRecursion: false,
      preventRecursion: false,
      matchPersonaDescription: false,
      matchCharacterDescription: false,
      matchCharacterPersonality: false,
      matchCharacterDepthPrompt: false,
      matchScenario: false,
      matchCreatorNotes: false,
      delayUntilRecursion: 0,
      probability: 100,
      useProbability: true,
      depth: 4,
      outletName: '',
      group: '',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      caseSensitive: null,
      matchWholeWords: null,
      useGroupScoring: null,
      automationId: '',
      role: 0,
      sticky: null,
      cooldown: null,
      delay: null,
      vectorized: false,
      triggers: [],
      displayIndex: 0,
      extensions: {},
      // Unknown to the compatibility layer on purpose: the round trip must keep it.
      myCustomField: { nested: [1, 2, 3], flag: true },
    },
    1: {
      uid: 1,
      // Deliberately NOT keyed on the card's own name: with include_names on,
      // every message is prefixed with its speaker, so a key equal to a speaker
      // name would match on every single turn and drown out the timed-effect
      // behaviour this entry exists to exercise.
      key: ['harbourmaster', 'harbour office'],
      keysecondary: [],
      comment: 'The Harbourmaster',
      content: LANTERN.harbourmaster,
      constant: false,
      selective: true,
      selectiveLogic: 0,
      order: 200,
      position: 1,
      disable: false,
      // Certain on purpose: this entry is what the API-level timed-effect tests
      // observe, and a probabilistic entry would make those assertions flaky.
      // Entry 3 below carries a real probability value instead.
      probability: 100,
      useProbability: true,
      depth: 4,
      role: 1,
      group: 'dockfolk',
      groupWeight: 150,
      sticky: 3,
      cooldown: 2,
      delay: 1,
      triggers: ['normal', 'continue'],
      extensions: { source: 'fixture' },
      anotherCustom: 'kept verbatim',
    },
    2: {
      uid: 2,
      comment: 'Tide Bell (disabled)',
      content: LANTERN.tideBell,
      disable: true,
      key: ['tide bell'],
      keysecondary: [],
      order: 50,
      position: 0,
      constant: false,
      selective: true,
      vectorized: true,
      automationId: 'bell',
      outletName: 'ambient',
      caseSensitive: true,
      matchWholeWords: true,
      ignoreBudget: true,
      extensions: {},
    },
    3: {
      uid: 3,
      comment: 'Ashfall (probabilistic)',
      content: LANTERN.ashfall,
      key: ['ashfall'],
      keysecondary: [],
      order: 75,
      position: 1,
      constant: false,
      selective: true,
      probability: 50,
      useProbability: true,
      extensions: {},
    },
  },
  extensions: { fixture: 'full-fields' },
};

const MINIMAL_FIELDS = {
  entries: {
    0: {
      uid: 0,
      key: ['ashfall'],
      content: LANTERN.ashfall,
    },
  },
};

const SPARSE_UIDS = {
  entries: {
    5: { uid: 5, key: ['kettle house'], content: LANTERN.kettle, comment: 'Kettle House', order: 300 },
    9: { uid: 9, key: ['warden', 'wardens'], content: LANTERN.wardens, comment: 'Wardens', order: 10 },
  },
};

// ---------------------------------------------------------------------------
// Standalone CharacterBook (entries is an array)
// ---------------------------------------------------------------------------

const CHARACTER_BOOK = {
  name: 'Lantern District Book',
  description: 'CharacterBook shape, standalone file.',
  scan_depth: 4,
  token_budget: 800,
  recursive_scanning: false,
  extensions: { fixture: 'standalone' },
  entries: [
    {
      id: 0,
      keys: ['lantern district', 'district'],
      secondary_keys: ['river'],
      comment: 'Lantern District',
      content: LANTERN.district,
      constant: false,
      selective: true,
      insertion_order: 100,
      enabled: true,
      position: 'before_char',
      use_regex: true,
      extensions: {
        position: 0,
        depth: 4,
        probability: 100,
        useProbability: true,
        selectiveLogic: 0,
        group: '',
        group_weight: 100,
        scan_depth: null,
        case_sensitive: false,
        match_whole_words: false,
        exclude_recursion: false,
        prevent_recursion: false,
        delay_until_recursion: false,
        display_index: 0,
        role: 0,
        automation_id: '',
      },
      custom_note: 'preserved even though nothing reads it',
    },
    {
      id: 1,
      keys: ['ashfall'],
      secondary_keys: [],
      comment: 'Ashfall',
      content: LANTERN.ashfall,
      constant: false,
      selective: false,
      insertion_order: 50,
      enabled: false,
      position: 'after_char',
      extensions: { position: 3, depth: 2, role: 2 },
    },
  ],
};

/** The same shape but keyed by `uid` with a bare position string. */
const CHARACTER_BOOK_UID_KEYED = {
  name: 'Uid-keyed book',
  entries: [
    {
      uid: 0,
      keys: ['warden'],
      secondary_keys: [],
      comment: 'Wardens',
      content: LANTERN.wardens,
      constant: false,
      selective: true,
      insertion_order: 100,
      enabled: true,
      position: 'before_char',
      extensions: {},
    },
    {
      uid: 1,
      keys: ['kettle house'],
      secondary_keys: [],
      comment: 'Kettle House',
      content: LANTERN.kettle,
      constant: true,
      selective: false,
      insertion_order: 20,
      enabled: true,
      position: 'after_char',
    },
  ],
};

// ---------------------------------------------------------------------------
// Foreign shapes
// ---------------------------------------------------------------------------

const AGNAI = {
  kind: 'memory',
  entries: [
    { keywords: ['lantern', 'lantern district'], name: 'Lantern District', entry: LANTERN.district, enabled: true, weight: 120 },
    { keywords: ['harbourmaster', 'osk'], name: 'The Harbourmaster', entry: LANTERN.harbourmaster, enabled: true, weight: 100 },
    { keywords: ['tide bell'], name: 'Tide Bell', entry: LANTERN.tideBell, enabled: false, weight: 80 },
  ],
};

const RISU = {
  type: 'risu',
  data: [
    { key: 'ashfall,ash fall', secondkey: 'snow', comment: 'Ashfall', content: LANTERN.ashfall, alwaysActive: false, selective: true, insertorder: 90, activationPercent: 100 },
    { key: 'the kettle house', secondkey: '', comment: 'Kettle House', content: LANTERN.kettle, alwaysActive: true, selective: false, insertorder: 100, activationPercent: 100 },
    { key: 'warden', secondkey: 'badge,oath', comment: 'Wardens', content: LANTERN.wardens, alwaysActive: false, selective: true, insertorder: 70, activationPercent: 60 },
  ],
};

const NOVELAI = {
  lorebookVersion: 6,
  name: 'Glass Coast',
  entries: [
    { keys: ['lantern district'], displayName: 'Lantern District', text: LANTERN.district, enabled: true, contextConfig: { budgetPriority: 110, prefix: '', suffix: '\n' } },
    { keys: ['tide bell'], displayName: 'Tide Bell', text: LANTERN.tideBell, enabled: true, contextConfig: { budgetPriority: 95 } },
    { keys: ['deprecated'], displayName: 'Retired entry', text: 'Kept for reference and disabled.', enabled: false, contextConfig: { budgetPriority: 10 } },
  ],
};

const BARE_ARRAY = [
  { uid: 0, key: ['lantern district'], comment: 'Lantern District', content: LANTERN.district, order: 100, position: 0, disable: false },
  { uid: 1, key: ['ashfall'], comment: 'Ashfall', content: LANTERN.ashfall, order: 50, position: 1, disable: false },
];

const SINGLE_ENTRY = {
  entries: {
    0: { uid: 0, key: ['osk'], comment: 'Osk', content: LANTERN.harbourmaster, order: 100, position: 0, disable: false },
  },
};

// ---------------------------------------------------------------------------
// PNG character card
// ---------------------------------------------------------------------------

function tinyPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const at = rowStart + 1 + x * 3;
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
    }
  }

  return writeChunks([
    { type: 'IHDR', data: ihdr },
    { type: 'IDAT', data: deflateSync(raw) },
    { type: 'IEND', data: Buffer.alloc(0) },
  ]);
}

const CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Osk',
    description: 'The harbourmaster of the Lantern District. Wide, patient, never disobeyed.',
    personality: 'Patient, immovable, dry.',
    scenario: 'The sea wall at dusk, a third ring of the tide bell.',
    first_mes: '*Osk does not look up from the ledger.* "You are early. Sit."',
    mes_example: '<START>\n{{user}}: Is the water coming over?\n{{char}}: *She turns a page.* "Not yet."',
    creator_notes: 'Generated by scripts/make-fixtures.ts. Not a real character.',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: ['*The bell rings twice. Osk is already at the wall.*'],
    tags: ['fixture', 'generated'],
    creator: 'teahouse fixtures',
    character_version: '1.0',
    extensions: { depth_prompt: { prompt: 'Keep the harbour cold and the answers short.', depth: 2, role: 'system' } },
    character_book: {
      name: 'Osk book',
      extensions: {},
      entries: [
        { keys: ['lantern district'], content: LANTERN.district, enabled: true, insertion_order: 100, position: 'before_char', extensions: {} },
        { keys: ['tide bell'], content: LANTERN.tideBell, enabled: true, insertion_order: 90, position: 'before_char', extensions: {} },
      ],
    },
  },
};

/** Declares a spec but keeps every field at the top level. Seen in the wild. */
const FLAT_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  name: 'Flat Osk',
  description: 'A card that declares a spec but never nests its data.',
  personality: 'Terse.',
  scenario: 'The sea wall.',
  first_mes: '*She nods.*',
  mes_example: '<START>\n{{user}}: Hello.\n{{char}}: *A nod.*',
  creator_notes: 'Generated malformed-card fixture.',
  tags: ['fixture'],
  creator: 'teahouse fixtures',
  character_version: '1.0',
  character_book: {
    name: 'Flat book',
    extensions: {},
    entries: [{ keys: ['tide bell'], content: LANTERN.tideBell, enabled: true, insertion_order: 100, position: 'before_char', extensions: {} }],
  },
};

function buildCardPng(): Buffer {
  const base = tinyPng(4, 4, [28, 32, 48]);
  const v2 = JSON.stringify(CARD);
  const v3 = JSON.stringify({ ...CARD, spec: 'chara_card_v3', spec_version: '3.0' });
  return writeTextChunks(base, [
    { keyword: 'chara', text: Buffer.from(v2, 'utf8').toString('base64') },
    { keyword: 'ccv3', text: Buffer.from(v3, 'utf8').toString('base64') },
  ]);
}

// ---------------------------------------------------------------------------
// Miniature byte-level BPE tokenizer
// ---------------------------------------------------------------------------

function tinyTokenizer() {
  const { forward } = byteLevelAlphabet();
  const vocab: Record<string, number> = {};
  for (let byte = 0; byte < 256; byte++) vocab[forward.get(byte)!] = byte;

  // Deliberate merges so `hello`, `the` and `the` + suffix collapse, exercising
  // the merge loop instead of only the byte fallback path.
  const merges = ['h e', 'he l', 'hel l', 'hell o', 't h', 'th e', 'th e r', 'a n', 'an d'];
  let next = 256;
  for (const merge of merges) {
    const [left, right] = merge.split(' ');
    vocab[`${left}${right}`] = next++;
  }

  const special = next;
  vocab['<|end|>'] = special;

  return {
    version: '1.0',
    added_tokens: [
      { id: special, content: '<|end|>', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
    ],
    normalizer: null,
    pre_tokenizer: { type: 'ByteLevel', add_prefix_space: false, trim_offsets: true, use_regex: false },
    decoder: { type: 'ByteLevel', add_prefix_space: true, trim_offsets: true, use_regex: true },
    model: {
      type: 'BPE',
      dropout: null,
      unk_token: null,
      continuing_subword_prefix: null,
      end_of_word_suffix: null,
      fuse_unk: false,
      byte_fallback: false,
      ignore_merges: false,
      vocab,
      merges,
    },
  };
}

// ---------------------------------------------------------------------------
// Write everything, then verify the fixtures actually parse
// ---------------------------------------------------------------------------

console.log('generating corpus/owned');

emit('st-native/full-fields.json', FULL_FIELDS);
emit('st-native/minimal.json', MINIMAL_FIELDS);
emit('st-native/sparse-uids.json', SPARSE_UIDS);
emit('character-book/standalone.json', CHARACTER_BOOK);
emit('character-book/uid-keyed.json', CHARACTER_BOOK_UID_KEYED);
emit('agnai/memory.json', AGNAI);
emit('risu/lorebook.json', RISU);
emit('novelai/lorebook.json', NOVELAI);
emit('edge/bare-array.json', BARE_ARRAY);
emit('edge/single-entry.json', SINGLE_ENTRY);
emit('edge/flat-card.json', FLAT_CARD);
emit('tokenizers/tiny-bpe.json', tinyTokenizer());
emitBinary('cards/osk.png', buildCardPng());

const manifest = {
  $comment:
    'Generated by scripts/make-fixtures.ts. All content is original to this project; no third-party world books are shipped. Put real published books in corpus/local/ (git-ignored) and the conformance suite picks them up too.',
  samples: [
    { file: 'st-native/full-fields.json', format: 'st-native', entries: 4, unknownFields: ['myCustomField', 'anotherCustom'], note: 'every field of the ST entry definition, plus deliberately unknown keys that must survive the round trip' },
    { file: 'st-native/minimal.json', format: 'st-native', entries: 1, note: 'only key and content: everything else must fall back to defaults' },
    { file: 'st-native/sparse-uids.json', format: 'st-native', entries: 2, note: 'non-contiguous uid keys (5 and 9)' },
    { file: 'character-book/standalone.json', format: 'character-book', entries: 2, unknownFields: ['custom_note'], note: 'array form with book-level scan_depth/token_budget/recursive_scanning and use_regex' },
    { file: 'character-book/uid-keyed.json', format: 'character-book', entries: 2, note: 'uses uid instead of id, bare position strings, no extensions' },
    { file: 'agnai/memory.json', format: 'agnai', entries: 3 },
    { file: 'risu/lorebook.json', format: 'risu', entries: 3 },
    { file: 'novelai/lorebook.json', format: 'novelai', entries: 3 },
    { file: 'edge/bare-array.json', format: 'bare-array', entries: 2 },
    { file: 'edge/single-entry.json', format: 'st-native', entries: 1 },
    { file: 'edge/flat-card.json', format: 'character-card', entries: 1, note: 'declares v2 but keeps fields at the top level; must import as a character anyway' },
    { file: 'cards/osk.png', format: 'character-card', entries: 2, note: 'PNG built from raw IHDR/IDAT/IEND chunks; embeds chara and ccv3' },
  ],
};
emit('manifest.json', manifest);

// Self-check: a fixture the parser rejects would fail the suites confusingly.
console.log('\nself-check');
let failures = 0;
for (const sample of manifest.samples) {
  const path = join(root, sample.file);
  if (sample.format === 'character-card') {
    const { card } = parseCardFile(readFileSync(path), sample.file);
    const entries = card.books[0]?.entries.length ?? 0;
    const ok = entries === sample.entries && card.name !== '';
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${sample.file}  card="${card.name}" spec=${card.spec} bookEntries=${entries} warnings=${card.warnings.length}`);
    if (!ok) failures++;
    continue;
  }
  const { world } = parseWorldInfo(JSON.parse(readFileSync(path, 'utf8')), { id: sample.file });
  const ok = world.sourceFormat === sample.format && world.entries.length === sample.entries;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${sample.file}  format=${world.sourceFormat} entries=${world.entries.length}`);
  if (!ok) failures++;
}

console.log(`\n${failures === 0 ? 'fixtures written and verified' : `${failures} fixture(s) failed self-check`}`);
process.exit(failures === 0 ? 0 : 1);
