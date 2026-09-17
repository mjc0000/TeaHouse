/**
 * Agent mode: the model reads skill files on demand.
 *
 * Agent Skills are written for progressive disclosure — the prompt carries only
 * a name and a description, and the body plus `references/` are pulled in with a
 * `read` tool. `all` and `select` approximated that; this is the real thing, in
 * the only shape this app can offer safely:
 *
 *   - the model gets one tool, `read_file`, and a catalogue of readable ids;
 *   - it calls the tool, the App answers with text **it already stored**;
 *   - a bounded loop (rounds, files, characters) collects the answers;
 *   - the collected documents become one prompt block, so the request the user
 *     previews is still byte-for-byte the request that is sent.
 *
 * The tool answering is a pure map over a whitelist: an id the catalogue did not
 * list can never be read, so a prompt-injected card cannot walk the filesystem.
 * Nothing is executed, and a failure only costs this channel.
 */

import { readZipEntries, readZipEntry } from '../formats/zip.ts';
import { asRecord, asString, type CharacterCard } from '../formats/types.ts';
import { notice, type Notice } from '../i18n.ts';
import {
  chatWithTools,
  type LlmMessage,
  type LlmTool,
  type LlmToolCallRequest,
} from '../llm/openai-compat.ts';
import type { TeahouseConfig } from '../store/db.ts';

export const READ_TOOL = 'read_file';

/** Catalogue cap: enough to be useful, small enough to stay a cheap prompt. */
const MAX_CATALOG_FILES = 80;
const MAX_LABEL_CHARS = 120;
/** One document, and everything a single turn may pull in. */
const MAX_DOC_CHARS = 24_000;
const MAX_TOTAL_CHARS = 96_000;
const MAX_ROUNDS_CAP = 8;
const MAX_FILES_CAP = 20;
const MIN_ROUNDS = 1;
const MIN_FILES = 1;
/** The loop keeps only the tail of the conversation: it needs the scene, not history. */
const MAX_MESSAGES = 4;
const MAX_MESSAGE_CHARS = 400;

/** One readable thing: a file in a skill package, or an embedded book entry. */
export interface AgentFileRef {
  /** Stable id the model passes to `read_file`. Also the catalogue's label. */
  id: string;
  /** What to show beside the id (skill/book name and title). */
  label: string;
  kind: 'skill' | 'book';
  /** Card id for a skill file, book id for a book entry. */
  owner: string;
  /** Zip entry name for a skill file, entry uid for a book entry. */
  key: string | number;
  /** Known size, for the catalogue line. Book entries know theirs; files do not. */
  chars: number;
}

export interface AgentCatalog {
  files: AgentFileRef[];
  /** True when the cap cut the catalogue short. */
  truncated: boolean;
}

/** Fetches the text behind a catalogue id; `null` means "not readable". */
export interface AgentSource {
  readSkill(owner: string, name: string): string | null;
  readBook(owner: string, uid: number): string | null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** The `extensions.tavern.skill` object a skill import writes, if present. */
function skillMeta(card: CharacterCard): { name: string; files: string[] } | null {
  const tavern = asRecord(card.extensions.tavern);
  const skill = asRecord(tavern.skill);
  if (Object.keys(skill).length === 0) return null;
  const name = asString(skill.name, '') || card.name;
  const files = Array.isArray(skill.files)
    ? skill.files.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : [];
  return { name, files };
}

/**
 * The catalogue: every skill package file plus every enabled embedded book entry
 * of the given cards (the chat's card and its group members). Attached world
 * books are deliberately out — those are the keyword/vector channels' business.
 */
export function buildAgentCatalog(cards: { id: string; card: CharacterCard }[]): AgentCatalog {
  const files: AgentFileRef[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const push = (file: AgentFileRef): void => {
    if (seen.has(file.id)) return;
    if (files.length >= MAX_CATALOG_FILES) {
      truncated = true;
      return;
    }
    seen.add(file.id);
    files.push(file);
  };

  for (const { id, card } of cards) {
    const skill = skillMeta(card);
    if (skill) {
      for (const name of skill.files) {
        push({
          id: name,
          label: `${skill.name} · ${name}`,
          kind: 'skill',
          owner: id,
          key: name,
          chars: 0,
        });
      }
    }
    for (const book of card.books) {
      for (const entry of book.entries) {
        if (entry.disable) continue;
        if (entry.content.trim() === '') continue;
        const title = oneLine(entry.comment) || entry.key[0] || `uid ${entry.uid}`;
        push({
          id: `book/${book.id}/${entry.uid}`,
          label: `${book.name} · ${title}`,
          kind: 'book',
          owner: book.id,
          key: entry.uid,
          chars: entry.content.length,
        });
      }
    }
  }

  return { files, truncated };
}

/** The single tool the loop offers. `path` must be one of the listed ids. */
export function agentTool(): LlmTool {
  return {
    type: 'function',
    function: {
      name: READ_TOOL,
      description:
        'Read one background file by its exact path from the available list. '
        + 'Returns the file text. Call it for the files you need, then stop.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Exact path from the available list, e.g. "references/architecture.md".',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  };
}

/** The instruction that turns the catalogue into a "read what you need" round. */
export function agentSystemPrompt(catalog: AgentCatalog, maxFiles: number): string {
  const lines = catalog.files.map((file) => {
    const label = oneLine(file.label).slice(0, MAX_LABEL_CHARS);
    const size = file.chars > 0 ? ` — ${file.chars} chars` : '';
    return `- ${file.id} — ${label}${size}`;
  });
  return [
    'You are gathering background material for the next roleplay reply.',
    'You may read files from this character\'s skill package and its embedded lore book. Nothing else is readable.',
    `Available files (${catalog.files.length}${catalog.truncated ? ', truncated' : ''}):`,
    ...lines,
    '',
    `Call ${READ_TOOL} with the exact "path" of each file worth reading; you may call it several times.`,
    `Read at most ${maxFiles} files in total. Never invent a path.`,
    'When you already have what the scene needs, reply with a short line of text and no further calls.',
  ].join('\n');
}

/** Catalogue plus the conversation tail, as the loop's first user message. */
export function agentInput(messages: { role: string; content: string }[]): string {
  const tail = messages
    .filter((message) => message.role !== 'system')
    .slice(-MAX_MESSAGES)
    .map((message) => `${message.role}: ${oneLine(message.content).slice(0, MAX_MESSAGE_CHARS)}`);
  return `Next reply will continue this conversation:\n${tail.join('\n')}`;
}

/**
 * Paths out of a tool call's arguments. Deliberately lenient: providers and
 * models disagree on the key (`path`, `file`, `paths`, …), and a bare string is
 * not unheard of. Anything unreadable yields no paths, never an exception.
 */
export function parseReadPaths(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed.startsWith('{') || trimmed.startsWith('[') ? [] : [trimmed];
  }
  const fromValue = (value: unknown): string[] => {
    if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()];
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item !== '');
    }
    return [];
  };
  if (typeof parsed === 'string' || Array.isArray(parsed)) return fromValue(parsed);
  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    for (const key of ['path', 'file', 'name', 'paths', 'files']) {
      const paths = fromValue(record[key]);
      if (paths.length > 0) return paths;
    }
  }
  return [];
}

export interface AgentDoc {
  id: string;
  label: string;
  text: string;
}

export interface AgentDocsResult {
  docs: AgentDoc[];
  warning: Notice | null;
  /** Provider calls actually made, for the trace. */
  calls: number;
}

export interface CollectAgentInput {
  config: TeahouseConfig;
  catalog: AgentCatalog;
  source: AgentSource;
  messages: { role: string; content: string }[];
  model: string;
  /** The preview passes false: never spend a provider call there. */
  allowModel: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * A bounded read loop. Never throws: a failed call keeps whatever was read so
 * far and the turn goes on with a warning.
 */
export async function collectAgentDocs(input: CollectAgentInput): Promise<AgentDocsResult> {
  const empty: AgentDocsResult = { docs: [], warning: null, calls: 0 };
  if (!input.allowModel) return empty;
  if (input.catalog.files.length === 0) return empty;
  if (input.model === '') {
    return { ...empty, warning: notice('agent.noModel', 'agent 模式已选中，但本会话没有可用模型') };
  }

  const maxRounds = clampInt(input.config.retrieval.agentMaxRounds, MIN_ROUNDS, MAX_ROUNDS_CAP, 3);
  const maxFiles = clampInt(input.config.retrieval.agentMaxFiles, MIN_FILES, MAX_FILES_CAP, 6);
  const byId = new Map(input.catalog.files.map((file) => [file.id, file]));

  const docs: AgentDoc[] = [];
  const read = new Set<string>();
  let totalChars = 0;
  let calls = 0;
  let warning: Notice | null = input.catalog.truncated
    ? notice('agent.tooMany', `agent：可读文件过多，只列出了前 ${input.catalog.files.length} 个`, { count: input.catalog.files.length })
    : null;

  const loop: LlmMessage[] = [
    { role: 'system', content: agentSystemPrompt(input.catalog, maxFiles) },
    { role: 'user', content: agentInput(input.messages) },
  ];

  const readOne = (id: string): string => {
    if (read.has(id)) return `[${id}] already provided`;
    if (docs.length >= maxFiles) return `[${id}] not read: file budget reached`;
    const file = byId.get(id);
    if (!file) return `[${id}] no such file`;
    const raw = file.kind === 'skill'
      ? input.source.readSkill(file.owner, String(file.key))
      : input.source.readBook(file.owner, Number(file.key));
    if (raw === null) return `[${id}] not readable`;
    const room = Math.max(0, Math.min(MAX_DOC_CHARS, MAX_TOTAL_CHARS - totalChars));
    if (room === 0) return `[${id}] not read: size budget reached`;
    const text = raw.length > room ? `${raw.slice(0, room)}\n…（已截断）` : raw;
    docs.push({ id, label: file.label, text });
    read.add(id);
    totalChars += text.length;
    return `[${id}]\n${text}`;
  };

  try {
    for (let round = 0; round < maxRounds; round++) {
      calls++;
      const result = await chatWithTools(
        {
          ...input.config,
          model: input.model,
          // Gathering material wants the boring answer, like translation does.
          temperature: 0.2,
          maxTokens: 256,
          stop: [],
          requestUsage: false,
        },
        loop,
        [agentTool()],
        { fetchImpl: input.fetchImpl },
      );
      if (result.toolCalls.length === 0) break;

      const requests: LlmToolCallRequest[] = result.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));
      loop.push({ role: 'assistant', content: result.text, tool_calls: requests });

      let exhausted = false;
      for (const call of result.toolCalls) {
        if (call.name !== READ_TOOL) {
          loop.push({ role: 'tool', tool_call_id: call.id, content: 'unknown tool' });
          continue;
        }
        const answers = parseReadPaths(call.arguments).map(readOne);
        loop.push({ role: 'tool', tool_call_id: call.id, content: answers.join('\n\n') || '(no path given)' });
      }
      if (docs.length >= maxFiles || totalChars >= MAX_TOTAL_CHARS) exhausted = true;

      if (round === maxRounds - 1 || exhausted) {
        warning = notice('agent.capped', `agent：读满上限（${maxRounds} 轮 / ${maxFiles} 个文件），本轮不再继续读`, { rounds: maxRounds, files: maxFiles });
        break;
      }
    }
  } catch (error) {
    const message = (error as Error).message;
    return {
      docs,
      // The capped/too-many note is dropped here: the failure is the actionable
      // part, and a single warning slot cannot carry two sentences cleanly.
      warning: notice('agent.readFailed', `agent 读取失败，本轮按已有文件注入：${message}`, { error: message }),
      calls,
    };
  }

  return { docs, warning, calls };
}

/** Reads a single skill file out of a stored archive, whitelist not included. */
export function readSkillFile(bytes: Buffer, name: string): string | null {
  const content = readZipEntry(bytes, name) ?? (name === 'skill.md' ? bytes : null);
  if (content === null) return null;
  if (content.includes(0)) return null;
  return content.toString('utf8');
}

/**
 * The real reader: skill files come out of the card's stored archive (which the
 * card's `files` list already whitelisted), book entries out of the cards that
 * were catalogued. Only the store is touched, never a path from the model.
 */
export function agentSource(
  store: { skillSource(id: string): { name: string; bytes: Buffer } | null },
  cards: { id: string; card: CharacterCard }[],
): AgentSource {
  const books = new Map<string, string>();
  for (const { card } of cards) {
    for (const book of card.books) {
      for (const entry of book.entries) books.set(`${book.id}/${entry.uid}`, entry.content);
    }
  }
  return {
    readSkill: (owner, name) => {
      const source = store.skillSource(owner);
      return source === null ? null : readSkillFile(source.bytes, name);
    },
    readBook: (owner, uid) => books.get(`${owner}/${uid}`) ?? null,
  };
}

/** Every entry name in a skill archive, for callers that need the raw list. */
export function listSkillFiles(bytes: Buffer): string[] {
  try {
    return readZipEntries(bytes).map((entry) => entry.name);
  } catch {
    return [];
  }
}
