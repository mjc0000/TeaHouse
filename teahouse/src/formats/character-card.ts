/**
 * Character card compatibility layer.
 *
 * Supports:
 *  - spec v1 (flat TavernAI fields)
 *  - spec v2 (`chara_card_v2`, `data` object)
 *  - spec v3 (`chara_card_v3`)
 *  - PNG carriers: `chara` (v2) and `ccv3` (v3) tEXt chunks, v3 wins
 *  - the embedded `data.character_book`, normalized via world-info.ts
 */

import { getTextChunk, isPng, writeTextChunks } from './png-text.ts';
import {
  asNumber,
  asRecord,
  asString,
  asStringArray,
  isRecord,
  type CardParseResult,
  type CharacterCard,
  type DepthPrompt,
  type ParseWarning,
  type World,
} from './types.ts';
import { parseWorldInfo } from './world-info.ts';

const V1_KEYS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];

function looksLikeV1(raw: Record<string, unknown>): boolean {
  if (typeof raw.spec === 'string' && raw.spec.startsWith('chara_card')) return false;
  if (isRecord(raw.data) && (raw.data.name !== undefined || raw.data.description !== undefined)) {
    return false;
  }
  return V1_KEYS.some((key) => key in raw);
}

/**
 * Upgrades a v1 card to the v2 shape, mirroring SillyTavern's importer so the
 * rest of the code only ever deals with one structure.
 */
function upgradeV1(raw: Record<string, unknown>): Record<string, unknown> {
  const tags = typeof raw.tags === 'string' ? asStringArray(raw.tags) : asStringArray(raw.tags);
  const extensions: Record<string, unknown> = {
    talkativeness: asNumber(raw.talkativeness, 0.5),
    fav: raw.fav === true || raw.fav === 'true',
    world: asString(raw.world, ''),
  };

  const depth = asNumber(raw.depth_prompt_depth, 4);
  if (raw.depth_prompt_prompt !== undefined || raw.depth_prompt_depth !== undefined) {
    extensions.depth_prompt = {
      prompt: asString(raw.depth_prompt_prompt, ''),
      depth,
      role: asString(raw.depth_prompt_role, 'system'),
    };
  }

  const data: Record<string, unknown> = {
    name: asString(raw.name ?? raw.char_name, ''),
    description: asString(raw.description, ''),
    personality: asString(raw.personality ?? raw.char_persona, ''),
    scenario: asString(raw.scenario ?? raw.world_scenario, ''),
    first_mes: asString(raw.first_mes ?? raw.char_greeting, ''),
    mes_example: asString(raw.mes_example ?? raw.char_example, ''),
    creator_notes: asString(raw.creatorcomment ?? raw.creator_notes, ''),
    system_prompt: asString(raw.system_prompt, ''),
    post_history_instructions: asString(raw.post_history_instructions, ''),
    alternate_greetings: asStringArray(raw.alternate_greetings),
    tags,
    creator: asString(raw.creator, ''),
    character_version: asString(raw.character_version, ''),
    extensions,
  };

  const merged: Record<string, unknown> = { ...raw, spec: 'chara_card_v2', spec_version: '2.0', data };
  // Keep v1 flat fields available for round-trip fidelity.
  return merged;
}

function parseDepthPrompt(extensions: Record<string, unknown>, warnings: ParseWarning[]): DepthPrompt | null {
  const candidate = extensions.depth_prompt;
  if (!isRecord(candidate)) return null;
  const role = asString(candidate.role, 'system');
  const depth = asNumber(candidate.depth, 4);
  return { prompt: asString(candidate.prompt, ''), depth, role };
}

export function parseCardJSON(raw: unknown, id = 'card'): CardParseResult {
  const warnings: ParseWarning[] = [];
  if (!isRecord(raw)) throw new Error('character card must be a JSON object');

  let spec: CharacterCard['spec'] = 'v2';
  let root = raw;

  if (looksLikeV1(raw)) {
    spec = 'v1';
    root = upgradeV1(raw);
    warnings.push({ code: 'v1-upgraded', message: 'converted spec v1 card to v2 shape in memory' });
  } else if (raw.spec === 'chara_card_v3' || String(raw.spec_version ?? '').startsWith('3')) {
    spec = 'v3';
  } else if (raw.spec === 'chara_card_v2' || raw.data !== undefined) {
    spec = 'v2';
  } else {
    warnings.push({ code: 'unknown-spec', message: 'no spec field; treated as v2' });
  }

  // Spec v2/v3 cards put everything under `data`. Cards downloaded from the
  // internet are often malformed: they declare a spec but keep every field at the
  // top level, and occasionally nest the book at the top level too. Treat those
  // as v1 rather than refusing to open them.
  if (Object.keys(asRecord(root.data)).length === 0 && V1_KEYS.some((key) => key in root)) {
    if (spec !== 'v1') {
      warnings.push({
        code: 'flattened-card',
        message: `card declared ${spec} but kept its fields at the top level; read as a v1 card`,
      });
    }
    spec = 'v1';
    root = upgradeV1(root);
  }

  const data = asRecord(root.data);
  if (Object.keys(data).length === 0) {
    throw new Error(
      'character card has no data object and no recognisable card fields at the top level',
    );
  }

  // A top-level `character_book` on an otherwise flat card is still the card's book.
  if (data.character_book === undefined && isRecord(raw.character_book)) {
    data.character_book = raw.character_book;
  }

  const extensions = asRecord(data.extensions);
  const books: World[] = [];

  if (data.character_book !== undefined) {
    try {
      const parsed = parseWorldInfo(data.character_book, {
        id: `${id}:book`,
        name: asString(asRecord(data.character_book).name, `${asString(data.name, id)} book`),
        format: 'character-book',
      });
      books.push(parsed.world);
      warnings.push(...parsed.warnings);
    } catch (error) {
      warnings.push({
        code: 'book-parse-failed',
        message: `embedded character_book failed to parse: ${(error as Error).message}`,
      });
    }
  }

  const card: CharacterCard = {
    id,
    spec,
    name: asString(data.name, id),
    description: asString(data.description, ''),
    personality: asString(data.personality, ''),
    scenario: asString(data.scenario, ''),
    first_mes: asString(data.first_mes, ''),
    mes_example: asString(data.mes_example, ''),
    creator_notes: asString(data.creator_notes, ''),
    system_prompt: asString(data.system_prompt, ''),
    post_history_instructions: asString(data.post_history_instructions, ''),
    alternate_greetings: asStringArray(data.alternate_greetings),
    tags: asStringArray(data.tags),
    creator: asString(data.creator, ''),
    character_version: asString(data.character_version, ''),
    extensions,
    depthPrompt: parseDepthPrompt(extensions, warnings),
    books,
    raw: root,
    warnings,
  };

  return { card, image: null };
}

function decodeBase64JSON(chunkText: string, label: string): unknown {
  const json = Buffer.from(chunkText, 'base64').toString('utf8');
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`PNG ${label} chunk is not valid JSON: ${(error as Error).message}`);
  }
}

/** Reads a card out of a PNG image. `ccv3` takes precedence over `chara`. */
export function parseCardPNG(image: Buffer, id = 'card'): CardParseResult {
  if (!isPng(image)) throw new Error('not a PNG file');

  const ccv3 = getTextChunk(image, 'ccv3');
  if (ccv3 !== null) {
    const result = parseCardJSON(decodeBase64JSON(ccv3, 'ccv3'), id);
    result.card.spec = 'v3';
    result.image = image;
    return result;
  }

  const chara = getTextChunk(image, 'chara');
  if (chara !== null) {
    const result = parseCardJSON(decodeBase64JSON(chara, 'chara'), id);
    result.image = image;
    return result;
  }

  throw new Error('PNG contains no chara/ccv3 text chunk');
}

/** Detects PNG vs JSON from the bytes. */
export function parseCardFile(buffer: Buffer, id = 'card'): CardParseResult {
  if (isPng(buffer)) return parseCardPNG(buffer, id);
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  return parseCardJSON(JSON.parse(text), id);
}

/**
 * The card fields a user may edit, and how each one is shaped.
 *
 * Declared here rather than in the route so the patch validation, the editor's
 * form and its tests all read the same list — the failure mode otherwise is a
 * field that the UI offers and the server silently drops, or the reverse.
 */
export const EDITABLE_CARD_FIELDS: Record<string, 'string' | 'stringList'> = {
  name: 'string',
  description: 'string',
  personality: 'string',
  scenario: 'string',
  first_mes: 'string',
  mes_example: 'string',
  system_prompt: 'string',
  post_history_instructions: 'string',
  creator_notes: 'string',
  creator: 'string',
  character_version: 'string',
  alternate_greetings: 'stringList',
  tags: 'stringList',
};

/**
 * The greetings a card offers, in the order the UI lists them: the first message
 * first, then the alternates. Empty entries are dropped, so index 0 is always a
 * real greeting when the card has any.
 */
export function cardGreetings(card: CharacterCard): string[] {
  return [card.first_mes, ...card.alternate_greetings]
    .map((greeting) => greeting.trim())
    .filter((greeting) => greeting !== '');
}

/** The card as a v2 JSON object, ready to be written into a PNG or saved as .json. */
export function cardToV2JSON(card: CharacterCard): Record<string, unknown> {  const raw = card.raw;
  const data = { ...asRecord(raw.data) };
  // Reflect any normalized edits back into the data object.
  data.name = card.name;
  data.description = card.description;
  data.personality = card.personality;
  data.scenario = card.scenario;
  data.first_mes = card.first_mes;
  data.mes_example = card.mes_example;
  data.creator_notes = card.creator_notes;
  data.system_prompt = card.system_prompt;
  data.post_history_instructions = card.post_history_instructions;
  data.alternate_greetings = card.alternate_greetings;
  data.tags = card.tags;
  data.creator = card.creator;
  data.character_version = card.character_version;
  data.extensions = card.extensions;
  data.character_book = card.books[0]?.raw ?? data.character_book;

  return { ...raw, spec: 'chara_card_v2', spec_version: '2.0', data };
}

/**
 * Writes card metadata into a PNG. Mirrors SillyTavern: a `chara` chunk plus a
 * `ccv3` chunk derived from it, replacing any existing ones.
 */
export function writeCardPNG(image: Buffer, card: CharacterCard): Buffer {
  const v2 = cardToV2JSON(card);
  const v2Text = JSON.stringify(v2);
  const v3 = { ...v2, spec: 'chara_card_v3', spec_version: '3.0' };

  return writeTextChunks(image, [
    { keyword: 'chara', text: Buffer.from(v2Text, 'utf8').toString('base64') },
    { keyword: 'ccv3', text: Buffer.from(JSON.stringify(v3), 'utf8').toString('base64') },
  ]);
}
