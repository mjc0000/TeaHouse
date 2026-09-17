/**
 * File storage.
 *
 * Everything is plain files under `data/` so a user can read, diff, back up or
 * hand-edit their teahouse. World book files are stored as the exact bytes that
 * were imported, which is what makes lossless round-tripping possible.
 *
 *   data/config.json
 *   data/characters/<id>/card.png | card.json
 *   data/worlds/<id>.json  (+ .meta.json)
 *   data/chats/<id>.jsonl  (+ .meta.json)
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { parseCardFile, cardToV2JSON, writeCardPNG, type CardParseResult } from '../formats/character-card.ts';
import { EMPTY_QUICK_REPLIES, normalizeQuickReplies, type QuickReplyFile } from '../formats/quick-replies.ts';
import { coerceRegexFile, EMPTY_REGEX_FILE, type RegexFile } from '../engine/regex-rules.ts';
import { coercePersonaFile, EMPTY_PERSONAS, type PersonaFile } from '../engine/personas.ts';
import { coerceConnectionFile, EMPTY_CONNECTIONS, type ConnectionFile } from '../engine/connections.ts';
import type { ChatImageRef } from '../engine/images.ts';
import { parseWorldInfo } from '../formats/world-info.ts';
import type { CharacterCard, SourceFormat, World } from '../formats/types.ts';
import type { LlmConfig } from '../llm/openai-compat.ts';
import { knownContextWindow } from '../llm/providers.ts';
import type { MemoryRecord } from '../engine/memory.ts';
import { coerceTraceEvent, pruneTraceBodies, type TraceEvent } from '../engine/trace.ts';
import { coerceVectorIndex, type VectorIndex } from '../engine/vectors.ts';
import type { TimedEffectMap } from '../engine/world-scan.ts';

/** How a turn picks extra entries on top of the keyword scan. */
export const RETRIEVAL_MODES = ['keyword', 'all', 'vector', 'select', 'agent'] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

/**
 * How a group conversation picks who speaks. `round` is the original
 * director-then-round-robin path; the rest mirror SillyTavern's reply
 * strategies (natural, list, pooled, manual) and decide locally instead of
 * asking the model.
 */
export const GROUP_MODES = ['round', 'natural', 'list', 'pooled', 'manual'] as const;
export type GroupMode = (typeof GROUP_MODES)[number];

/**
 * A window (or output cap) the provider itself told us, in `model-limits.json`.
 * `source` is kept so the settings dialog can say where a number came from —
 * an overflow error, a metadata probe, or the shipped preset table.
 */
export interface LearnedModelLimit {
  contextWindow: number | null;
  maxOutput: number | null;
  source: 'overflow' | 'metadata' | 'probe';
  /** The provider's own words, for the UI and for debugging. */
  detail?: string;
  at: string;
}

export interface TeahouseConfig extends Partial<LlmConfig> {
  /** Model context window, used for the world book budget and trimming. */
  maxContext: number;
  /** Tokens held back for the reply. */
  responseReserve: number;
  /** Persona shown as `{{user}}`. */
  personaName: string;
  personaDescription: string;
  /**
   * Language the model should answer in. Free text on purpose: "中文",
   * "English", or anything else the model can be asked to imitate.
   * Empty means no language instruction is injected at all.
   */
  outputLanguage: string;
  /** Optional override for the instruction wording; `{{language}}` is replaced. */
  languageInstruction: string;
  /**
   * Language of the interface itself — labels, buttons, hints. Orthogonal to
   * `outputLanguage`, which is the language the model replies in. An unknown id
   * falls back to `zh-CN` on the client.
   */
  uiLanguage: string;
  /**
   * Translate messages written in another language into the reply language.
   * Only acts while a reply language is set; each message costs one extra
   * model call the first time, then reads from its cached translation.
   */
  autoTranslate: boolean;
  /**
   * After an impersonation turn, let the character answer right away instead of
   * waiting for the user to press send. Off by default: one extra model call,
   * and it takes away the chance to edit the impersonated line first.
   */
  impersonateAutoReply: boolean;
  /**
   * Talk to a `/completions` backend instead of chat completions. The prompt
   * is the assembled stack flattened to plain text (see `engine/completion`);
   * everything else — scanning, template, regex, variants, trace — is unchanged.
   */
  textCompletion: boolean;
  /**
   * Reading replies aloud. `mode: 'local'` uses the browser's own voices
   * (offline, free); `'online'` proxies an OpenAI-compatible
   * `/audio/speech` endpoint so the key never leaves this machine.
   */
  tts: {
    mode: 'local' | 'online';
    /** `voiceURI` of the system voice; '' follows the browser default. */
    voice: string;
    /** Speaking rate for the local engine. */
    rate: number;
    baseUrl: string;
    apiKey: string;
    model: string;
    /** Voice name the online service knows (e.g. `alloy`). */
    onlineVoice: string;
  };
  /**
   * Context template ("story string"): renders description/personality/
   * scenario/persona plus the world-info buckets into one prompt block.
   * Empty means off — the assembled prompt is exactly what it was before.
   */
  contextTemplate: string;
  /** Render transcript messages as Markdown (sanitised, structural). Off = plain text. */
  markdown: boolean;
  /**
   * Sequences that make the provider stop mid-answer. Empty means "send none",
   * which is the only safe default: a wrong stop string truncates replies.
   */
  stop: string[];
  /** Optional path to a HuggingFace tokenizer.json for exact counting. */
  tokenizerPath: string;
  /**
   * Reasoning models think before they answer, and the thinking is streamed as
   * its own channel. On: forward it, show it, and keep it on the message. Off:
   * it is neither sent to the client nor stored.
   */
  showReasoning: boolean;
  /**
   * Ask the provider to skip the thinking phase (experimental). Sends
   * `reasoning_effort: 'none'` and `thinking: { type: 'disabled' }`; endpoints
   * that do not know a parameter ignore it, but a strict one may reject it, in
   * which case this has to go back off.
   */
  disableThinking: boolean;
  /**
   * Which extra entries a turn injects on top of the keyword scan: none
   * (`keyword`), the whole embedded skill book (`all`), semantic top-N
   * (`vector`), the ones the model picks (`select`), or the skill files the model
   * asks to read (`agent`). A chat may pin its own with `ChatMeta.retrievalMode`;
   * the pin follows the same override rule as the model and the persona.
   */
  retrieval: {
    mode: RetrievalMode;
    /** `all` also dumps every attached world book, not only the embedded one. */
    fullIncludeWorlds: boolean;
    /** `all` keeps the embedded copy of an entry an attached book already has. */
    fullForceOnConflict: boolean;
    /** `agent`: how many read rounds one turn may spend (1–8). */
    agentMaxRounds: number;
    /** `agent`: how many files those rounds may pull in total (1–20). */
    agentMaxFiles: number;
  };
  scan: {
    depth: number;
    budgetPercent: number;
    budgetCap: number;
    recursive: boolean;
    maxRecursionSteps: number;
    minActivations: number;
    minActivationsDepthMax: number;
    includeNames: boolean;
    caseSensitive: boolean;
    matchWholeWords: boolean;
    useGroupScoring: boolean;
    characterStrategy: number;
    /**
     * Let the chat's own model pick which entries to inject, one cheap call per
     * turn. Off by default — it is an extra provider call.
     */
    modelSelect: boolean;
    /** Most entries the model may pick in one turn (1–10). */
    modelSelectMax: number;
  };
  /**
   * Long-term memory: a rolling summary of the conversation, injected as its own
   * prompt block. Off by default — with it off the assembled prompt is exactly
   * what it was before the feature existed.
   */
  memory: {
    enabled: boolean;
    /** Messages between two summaries, counted from the end of the last one. */
    interval: number;
    /** Target length handed to the model through `{{words}}`. */
    words: number;
    /** Instruction sent to the model; `{{words}}` is replaced with the count. */
    prompt: string;
    /** Wording of the injected block; `{{summary}}` is replaced. */
    template: string;
    /** Messages from the end the block is injected at. */
    depth: number;
    role: 'system' | 'user' | 'assistant';
    /** '' follows the model this conversation uses. */
    model: string;
  };
  /**
   * Vector storage: activating world book entries by meaning instead of by
   * keyword. Off by default, and the two endpoints are configured separately
   * because the chat provider is often not an embedding provider.
   */
  vector: {
    enabled: boolean;
    /** Which of the two configured endpoints a request uses. */
    mode: 'local' | 'remote';
    local: { baseUrl: string; apiKey: string; model: string };
    remote: { baseUrl: string; apiKey: string; model: string };
    /** Cosine similarity a hit has to reach. */
    threshold: number;
    /** Most entries one turn may activate this way. */
    maxEntries: number;
    /** How many recent messages form the query. */
    queryMessages: number;
    /** Index every entry, not only the ones marked `vectorized`. */
    allEntries: boolean;
    /** Texts per embedding request. */
    batchSize: number;
  };
}

export const DEFAULT_CONFIG: TeahouseConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 1,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  maxTokens: 0,
  requestUsage: true,
  maxContext: 65536,
  responseReserve: 512,
  personaName: 'You',
  personaDescription: '',
  outputLanguage: '',
  languageInstruction: '',
  uiLanguage: 'zh-CN',
  autoTranslate: true,
  impersonateAutoReply: false,
  textCompletion: false,
  tts: {
    mode: 'local',
    voice: '',
    rate: 1,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'tts-1',
    onlineVoice: 'alloy',
  },
  contextTemplate: '',
  markdown: true,
  tokenizerPath: '',
  stop: [],
  showReasoning: true,
  disableThinking: false,
  retrieval: {
    mode: 'keyword',
    fullIncludeWorlds: false,
    fullForceOnConflict: false,
    agentMaxRounds: 3,
    agentMaxFiles: 6,
  },
  scan: {
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
    characterStrategy: 1,
    modelSelect: false,
    modelSelectMax: 5,
  },
  memory: {
    enabled: false,
    interval: 10,
    words: 200,
    prompt: '',
    template: '',
    depth: 2,
    role: 'system',
    model: '',
  },
  vector: {
    enabled: false,
    mode: 'local',
    // A local server needs no key; Ollama's default port and a small model that
    // is a one-command install.
    local: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'nomic-embed-text' },
    remote: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'text-embedding-3-small' },
    threshold: 0.25,
    maxEntries: 5,
    queryMessages: 2,
    allEntries: false,
    batchSize: 64,
  },
};

export interface WorldSummary {
  id: string;
  name: string;
  format: SourceFormat;
  entries: number;
  bytes: number;
  warnings: number;
  /**
   * Set when the file on disk cannot be parsed. Such a file can only get there
   * from an older build or manual editing; the UI surfaces it and offers delete
   * instead of pretending it is a usable empty book.
   */
  error?: string;
}

export interface CharacterSummary {
  id: string;
  name: string;
  spec: string;
  hasImage: boolean;
  hasBook: boolean;
  tags: string[];
  /**
   * How readily this character speaks up in a group, 0–100. A preference, not
   * card data: our own `meta.json` wins, then the card's own
   * `extensions.talkativeness` (SillyTavern's 0–1 scale), then 50.
   */
  talkativeness: number;
}

export interface ChatEntry {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /**
   * The model's thinking, one entry per candidate reply and index-aligned with
   * `variants` (or with the single `content` when there are no variants). Kept
   * only while `config.showReasoning` is on, and never sent back to the
   * provider — assembly reads `content` only.
   */
  reasonings?: string[];
  /** Alternative generations for this position (swipes). */
  variants?: string[];
  activeVariant?: number;
  /**
   * A cached translation of the visible text into the reply language. A
   * derivative, like thinking: the transcript keeps the original, `ofVariant`
   * plus the source head/length say what it was made from, and anything newer
   * (an edit, a swipe, another preset language) translates again.
   */
  translation?: { lang: string; text: string; ofVariant: number; ofHead: string; ofLength: number };
  /**
   * Pictures attached to this message. References only
   * (`data/images/<id>` holds the bytes); sent as `image_url` blocks with the
   * newest user message, history travels as text.
   */
  images?: ChatImageRef[];
  /** Group chat speaker: the member character id behind this assistant turn. */
  speaker?: string;
  createdAt: string;
}

/**
 * The last successful request's token anchor for one chat.
 *
 * `promptTokens` is the provider-reported prompt size — the authoritative
 * figure. `heuristicTokens` is the meter's own total for exactly the messages
 * that request sent, so the next request can be projected as
 * `promptTokens + (currentHeuristic - heuristicTokens)`: provider-exact, yet it
 * still moves the moment history or the prompt stack changes.
 */
export interface UsageAnchor {
  promptTokens: number;
  heuristicTokens: number;
  at: string;
}

/** Sampler knobs one chat may pin; missing keys follow the global defaults. */
export interface ChatParams {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
}

export interface ChatMeta {
  id: string;
  name: string;
  characterId: string;
  worldRefs: string[];
  variables: Record<string, string>;
  timedEffects: TimedEffectMap;
  /**
   * Per-chat model override. Absent means "follow the global default"
   * (`config.model`); switching models from the topbar writes this, never the
   * default, so the default only changes from the settings dialog.
   */
  model?: string;
  /**
   * Per-chat sampler overrides. Absent (or missing keys) means "follow the
   * global defaults"; the right panel writes this, never the defaults, so the
   * settings dialog stays the defaults for new conversations. New chats
   * snapshot the defaults at creation, exactly like the model above.
   */
  params?: ChatParams;
  /**
   * Per-chat persona override. Absent means "follow the library default"
   * (`personas.json`'s active preset, else the global persona fields) — the
   * same follow/override split the per-chat model uses.
   */
  personaId?: string;
  /**
   * Group members, in speaking order. Empty/missing means a solo chat with
   * `characterId`; two or more makes it a group (see `engine/group` notes in
   * the routes). Old files simply have no field and keep working.
   */
  members?: string[];
  /**
   * Per-member connection overrides, keyed by character id (`connections.json`
   * holds the endpoints). A member without an entry follows the chat's own
   * endpoint and model, which is what every chat did before this existed.
   */
  memberConnections?: Record<string, string>;
  /**
   * How many members may answer one user message in a group: 1 (default) means
   * only the first name on the plan; 0 means everyone the plan names. It is a
   * hard cap on every group mode (`engine/group` builds the plan, the client
   * chains the extra replies, so the server only stores the number).
   */
  groupReplyLimit?: number;
  /**
   * How the group picks its speakers (`engine/group`). Missing means `round`,
   * which is what every group did before the mode existed.
   */
  groupMode?: GroupMode;
  /** Present once a provider has reported usage for a successful request. */
  usageAnchor?: UsageAnchor;
  /**
   * Long-term memory for this conversation (see `engine/memory.ts`). Lives here
   * rather than on a message: the summary belongs to the chat, and deleting a
   * message must never take the memory with it.
   */
  memory?: MemoryRecord;
  createdAt: string;
  updatedAt: string;
}

/**
 * The per-character sidecar (`data/characters/<id>/meta.json`), written by the
 * importers and by the settings we keep about a character rather than in the
 * card. Unknown keys are preserved, so a newer build's field survives an older
 * one writing the file.
 */
export interface CharacterMeta {
  importedAt?: string;
  spec?: string;
  source?: string;
  original?: string;
  /** Group talkativeness, 0–100, as the user set it. Absent follows the card. */
  talkativeness?: number;
  [key: string]: unknown;
}

/**
 * The talkativeness one character answers with, 0–100.
 *
 * Nothing in the card format defines this, and SillyTavern does not expect it
 * either — it ships a slider defaulting to 0.5 and only reads a value a card
 * happens to carry in `extensions`. The same order applies here: our own
 * sidecar first (the user's explicit choice), then the card's
 * `extensions.talkativeness` on SillyTavern's 0–1 scale, then an even 50.
 */
export function effectiveTalkativeness(
  meta: { talkativeness?: unknown },
  extensions: Record<string, unknown> | undefined,
): number {
  const own = meta.talkativeness;
  if (typeof own === 'number' && Number.isFinite(own)) return Math.min(100, Math.max(0, Math.round(own)));
  const shipped = extensions?.talkativeness;
  if (typeof shipped === 'number' && Number.isFinite(shipped)) {
    const percent = shipped <= 1 ? shipped * 100 : shipped;
    return Math.min(100, Math.max(0, Math.round(percent)));
  }
  return 50;
}

export class Store {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  get worldsDir(): string {
    return join(this.root, 'worlds');
  }
  get charactersDir(): string {
    return join(this.root, 'characters');
  }
  get chatsDir(): string {
    return join(this.root, 'chats');
  }
  get configPath(): string {
    return join(this.root, 'config.json');
  }

  ensure(): void {
    for (const dir of [this.root, this.worldsDir, this.charactersDir, this.chatsDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  // --- config --------------------------------------------------------------

  loadConfig(): TeahouseConfig {
    if (!existsSync(this.configPath)) return this.adoptKnownWindow({ ...DEFAULT_CONFIG, scan: { ...DEFAULT_CONFIG.scan } });
    const parsed = JSON.parse(readFileSync(this.configPath, 'utf8')) as Partial<TeahouseConfig>;
    return this.adoptKnownWindow({
      ...DEFAULT_CONFIG,
      ...parsed,
      scan: { ...DEFAULT_CONFIG.scan, ...(parsed.scan ?? {}) },
      memory: { ...DEFAULT_CONFIG.memory, ...(parsed.memory ?? {}) },
      tts: { ...DEFAULT_CONFIG.tts, ...(parsed.tts ?? {}) },
      retrieval: mergeRetrieval(parsed.retrieval, parsed),
      vector: mergeVector(parsed.vector),
    });
  }

  /**
   * A window the provider or the shipped table tells us is a *fact about the
   * model*, not a preference, so it becomes the value as soon as we know it —
   * otherwise a fresh install sits on the 65536 default while the model takes a
   * million, and nothing ever corrects it (an overflow cannot happen, so the
   * learning path never fires).
   *
   * Only a value still on the shipped default is adopted: anything the user typed
   * (including a deliberately smaller window) is left exactly as it is. The next
   * save persists the adopted number, so the file agrees with what is displayed.
   */
  private adoptKnownWindow(config: TeahouseConfig): TeahouseConfig {
    if (config.maxContext !== DEFAULT_CONFIG.maxContext) return config;
    const known = knownContextWindow(config.baseUrl ?? '', config.model ?? '', this.loadModelLimits());
    if (known === null || known === config.maxContext) return config;
    return { ...config, maxContext: known };
  }

  saveConfig(patch: Partial<TeahouseConfig>): TeahouseConfig {
    const stored = this.loadConfig();
    const merged: TeahouseConfig = {
      ...stored,
      ...patch,
      scan: { ...stored.scan, ...(patch.scan ?? {}) },
      memory: { ...stored.memory, ...(patch.memory ?? {}) },
      tts: { ...stored.tts, ...(patch.tts ?? {}) },
      retrieval: { ...stored.retrieval, ...(patch.retrieval ?? {}) },
      // Three levels deep, and a patch that only names one endpoint must not drop
      // the other: the two are kept side by side so switching is instant.
      vector: mergeVector(patch.vector, stored.vector),
    };
    writeAtomic(this.configPath, `${JSON.stringify(merged, null, 4)}\n`);
    return merged;
  }

  // --- quick replies -------------------------------------------------------

  get quickRepliesPath(): string {
    return join(this.root, 'quick-replies.json');
  }

  // --- model limits learned from a provider --------------------------------

  get modelLimitsPath(): string {
    return join(this.root, 'model-limits.json');
  }

  /**
   * Windows (and output caps) this install has *learned* from a provider, keyed
   * by `normalizedBaseUrl#model`. Separate from `config.json` on purpose: it is
   * machine-written and can be deleted at any time — the worst case is one
   * overflow being learned again.
   */
  loadModelLimits(): Record<string, LearnedModelLimit> {
    if (!existsSync(this.modelLimitsPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.modelLimitsPath, 'utf8')) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, LearnedModelLimit>)
        : {};
    } catch {
      return {};
    }
  }

  /** Merges one learned value in, keeping any number the caller did not supply. */
  recordModelLimit(key: string, patch: Partial<Omit<LearnedModelLimit, 'at'>>): LearnedModelLimit {
    const all = this.loadModelLimits();
    const previous = all[key];
    const next: LearnedModelLimit = {
      contextWindow: patch.contextWindow ?? previous?.contextWindow ?? null,
      maxOutput: patch.maxOutput ?? previous?.maxOutput ?? null,
      source: patch.source ?? previous?.source ?? 'overflow',
      detail: patch.detail ?? previous?.detail,
      at: new Date().toISOString(),
    };
    all[key] = next;
    writeAtomic(this.modelLimitsPath, `${JSON.stringify(all, null, 4)}\n`);
    return next;
  }

  /** Missing file means "none yet"; a broken one is reported, never silently emptied. */
  loadQuickReplies(): QuickReplyFile {
    if (!existsSync(this.quickRepliesPath)) return { ...EMPTY_QUICK_REPLIES };
    const parsed = JSON.parse(readFileSync(this.quickRepliesPath, 'utf8')) as unknown;
    return normalizeQuickReplies(parsed).file;
  }

  saveQuickReplies(file: QuickReplyFile): QuickReplyFile {
    const normalised = normalizeQuickReplies(file).file;
    writeAtomic(this.quickRepliesPath, `${JSON.stringify(normalised, null, 4)}\n`);
    return normalised;
  }

  // --- regex rules -----------------------------------------------------------

  get regexPath(): string {
    return join(this.root, 'regex.json');
  }
  /** Missing file means "none yet"; a broken one fails loudly on save, not here. */
  loadRegex(): RegexFile {
    if (!existsSync(this.regexPath)) return { ...EMPTY_REGEX_FILE, rules: [] };
    try {
      return coerceRegexFile(JSON.parse(readFileSync(this.regexPath, 'utf8'))).file;
    } catch {
      return { ...EMPTY_REGEX_FILE, rules: [] };
    }
  }

  saveRegex(file: RegexFile): RegexFile {
    const normalised = coerceRegexFile(file).file;
    writeAtomic(this.regexPath, `${JSON.stringify(normalised, null, 4)}\n`);
    return normalised;
  }

  // --- persona library -------------------------------------------------------

  get personasPath(): string {
    return join(this.root, 'personas.json');
  }

  /** Missing file means "none yet"; a broken one fails loudly on save, not here. */
  loadPersonas(): PersonaFile {
    if (!existsSync(this.personasPath)) return { ...EMPTY_PERSONAS, items: [] };
    try {
      return coercePersonaFile(JSON.parse(readFileSync(this.personasPath, 'utf8'))).file;
    } catch {
      return { ...EMPTY_PERSONAS, items: [] };
    }
  }

  savePersonas(file: PersonaFile): PersonaFile {
    const { file: normalised, problems } = coercePersonaFile(file);
    if (problems.length > 0) throw new Error(problems.join('；'));
    writeAtomic(this.personasPath, `${JSON.stringify(normalised, null, 4)}\n`);
    return normalised;
  }

  // --- extra connections ----------------------------------------------------

  /** Named endpoints a group member can speak through; see engine/connections. */
  get connectionsPath(): string {
    return join(this.root, 'connections.json');
  }

  loadConnections(): ConnectionFile {
    if (!existsSync(this.connectionsPath)) return { ...EMPTY_CONNECTIONS, items: [] };
    try {
      return coerceConnectionFile(JSON.parse(readFileSync(this.connectionsPath, 'utf8'))).file;
    } catch {
      return { ...EMPTY_CONNECTIONS, items: [] };
    }
  }

  saveConnections(file: ConnectionFile): ConnectionFile {
    const { file: normalised, problems } = coerceConnectionFile(file, this.loadConnections().items);
    if (problems.length > 0) throw new Error(problems.join('；'));
    writeAtomic(this.connectionsPath, `${JSON.stringify(normalised, null, 4)}\n`);
    return normalised;
  }

  // --- worlds --------------------------------------------------------------

  private worldPath(id: string): string {
    return join(this.worldsDir, `${sanitizeId(id)}.json`);
  }

  private worldMetaPath(id: string): string {
    return join(this.worldsDir, `${sanitizeId(id)}.meta.json`);
  }

  listWorlds(): WorldSummary[] {
    this.ensure();
    const out: WorldSummary[] = [];
    for (const name of readdirSync(this.worldsDir)) {
      if (!name.endsWith('.json') || name.endsWith('.meta.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const path = join(this.worldsDir, name);
      try {
        const { world, warnings } = this.loadWorld(id);
        out.push({
          id,
          name: world.name || id,
          format: world.sourceFormat,
          entries: world.entries.length,
          bytes: statSync(path).size,
          warnings: warnings.length,
        });
      } catch (error) {
        out.push({
          id,
          name: id,
          format: 'st-native',
          entries: 0,
          bytes: statSync(path).size,
          warnings: 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  loadWorld(id: string): { world: World; warnings: ReturnType<typeof parseWorldInfo>['warnings'] } {
    const path = this.worldPath(id);
    if (!existsSync(path)) throw new Error(`world not found: ${id}`);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parseWorldInfo(raw, { id, name: id });
  }

  /** Stores the imported document verbatim, then reports what was understood. */
  importWorld(id: string, bytes: Buffer, sourceName?: string): { world: World; warnings: string[] } {
    this.ensure();
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text) as unknown;
    const parsed = parseWorldInfo(raw, { id, name: id });
    writeAtomic(this.worldPath(id), text.endsWith('\n') ? text : `${text}\n`);
    writeAtomic(
      this.worldMetaPath(id),
      `${JSON.stringify({ sourceName: sourceName ?? `${id}.json`, importedAt: new Date().toISOString(), format: parsed.world.sourceFormat }, null, 4)}\n`,
    );
    return { world: parsed.world, warnings: parsed.warnings.map((warning) => warning.message) };
  }

  writeWorldRaw(id: string, raw: unknown): void {
    writeAtomic(this.worldPath(id), `${JSON.stringify(raw, null, 4)}\n`);
  }

  /** Throws when the world is not there, so a delete can never silently no-op. */
  deleteWorld(id: string): void {
    const path = this.worldPath(id);
    if (!existsSync(path)) throw new Error(`world not found: ${id}`);
    rmSync(path, { force: true });
    rmSync(this.worldMetaPath(id), { force: true });
  }

  // --- characters ----------------------------------------------------------

  private characterDir(id: string): string {
    return join(this.charactersDir, sanitizeId(id));
  }

  private characterMetaPath(id: string): string {
    return join(this.characterDir(id), 'meta.json');
  }

  /**
   * The sidecar for one character. A missing or unreadable file is an empty
   * object rather than an error: the card is the character, and every field in
   * here is an addition that can be rebuilt.
   */
  loadCharacterMeta(id: string): CharacterMeta {
    const path = this.characterMetaPath(id);
    if (!existsSync(path)) return {};
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as CharacterMeta) : {};
    } catch {
      return {};
    }
  }

  /** Merges into the sidecar rather than replacing it, so import data survives. */
  saveCharacterMeta(id: string, patch: Partial<CharacterMeta>): CharacterMeta {
    if (!this.characterExists(id)) throw new Error(`character not found: ${id}`);
    const merged = { ...this.loadCharacterMeta(id), ...patch };
    writeAtomic(this.characterMetaPath(id), `${JSON.stringify(merged, null, 4)}\n`);
    return merged;
  }

  /** The talkativeness this character speaks with, 0–100 (see the pure helper). */
  characterTalkativeness(id: string): number {
    return effectiveTalkativeness(this.loadCharacterMeta(id), this.loadCharacter(id).card.extensions);
  }

  listCharacters(): CharacterSummary[] {
    this.ensure();
    const out: CharacterSummary[] = [];
    for (const name of readdirSync(this.charactersDir)) {
      const dir = join(this.charactersDir, name);
      if (!statSync(dir).isDirectory()) continue;
      try {
        const { card } = this.loadCharacter(name);
        out.push({
          id: name,
          name: card.name,
          spec: card.spec,
          hasImage: existsSync(join(dir, 'card.png')),
          hasBook: card.books.length > 0,
          tags: card.tags,
          talkativeness: effectiveTalkativeness(this.loadCharacterMeta(name), card.extensions),
        });
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  loadCharacter(id: string): CardParseResult {
    const dir = this.characterDir(id);
    const png = join(dir, 'card.png');
    if (existsSync(png)) return parseCardFile(readFileSync(png), id);
    const json = join(dir, 'card.json');
    if (existsSync(json)) return parseCardFile(readFileSync(json), id);
    throw new Error(`character not found: ${id}`);
  }

  importCharacter(id: string, bytes: Buffer, kind: 'png' | 'json'): CharacterCard {
    const dir = this.characterDir(id);
    mkdirSync(dir, { recursive: true });
    const { card } = parseCardFile(bytes, id);
    if (kind === 'png') writeAtomic(join(dir, 'card.png'), bytes);
    else writeAtomic(join(dir, 'card.json'), bytes);
    // Merged, not replaced: re-importing a card must not throw away the
    // settings the user made about it (talkativeness today).
    this.saveCharacterMeta(id, { importedAt: new Date().toISOString(), spec: card.spec });
    return card;
  }

  /**
   * Stores a card made from an Agent Skill, keeping the original `SKILL.md` or
   * zip beside it verbatim: the card is a lens over the skill, not a replacement
   * for it, so the references it shipped stay recoverable.
   */
  importSkill(id: string, card: CharacterCard, original: { name: string; bytes: Buffer }): CharacterCard {
    const dir = this.characterDir(id);
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, 'card.json'), `${JSON.stringify(cardToV2JSON(card), null, 4)}\n`);
    writeAtomic(join(dir, original.name), original.bytes);
    this.saveCharacterMeta(id, {
      importedAt: new Date().toISOString(),
      spec: card.spec,
      source: 'skill',
      original: original.name,
    });
    return card;
  }

  /**
   * The original file a skill was imported from (`skill.zip` or `skill.md`),
   * kept verbatim beside the card. The agent read loop is its only reader: the
   * card is a lens over the skill, and this is the skill itself. `null` for a
   * card that did not come from a skill.
   */
  skillSource(id: string): { name: string; bytes: Buffer } | null {
    const dir = this.characterDir(id);
    for (const name of ['skill.zip', 'skill.md']) {
      const path = join(dir, name);
      if (existsSync(path)) return { name, bytes: readFileSync(path) };
    }
    return null;
  }

  characterImage(id: string): { bytes: Buffer; contentType: string } | null {
    const png = join(this.characterDir(id), 'card.png');
    if (existsSync(png)) return { bytes: readFileSync(png), contentType: 'image/png' };
    return null;
  }

  /** Persists an edited card, keeping whichever carrier the import produced. */
  writeCharacter(id: string, card: CharacterCard): void {
    const dir = this.characterDir(id);
    if (!existsSync(dir)) throw new Error(`character not found: ${id}`);
    const png = join(dir, 'card.png');
    if (existsSync(png)) {
      writeAtomic(png, writeCardPNG(readFileSync(png), card));
      return;
    }
    const json = join(dir, 'card.json');
    if (existsSync(json)) {
      writeAtomic(json, `${JSON.stringify(cardToV2JSON(card), null, 4)}\n`);
      return;
    }
    throw new Error(`character has no card file: ${id}`);
  }

  /** Changes the card's display name, leaving its id (and chats) alone. */
  setCharacterName(id: string, name: string): CharacterCard {
    const { card } = this.loadCharacter(id);
    card.name = name;
    this.writeCharacter(id, card);
    return card;
  }

  /** Whether a character directory exists, cheap and without parsing the card. */
  characterExists(id: string): boolean {
    return existsSync(this.characterDir(id));
  }

  /** Whether a world book file exists, without parsing it. */
  worldExists(id: string): boolean {
    return existsSync(this.worldPath(id));
  }

  /** Chats that reference this character, by id. */
  chatsForCharacter(id: string): ChatMeta[] {
    return this.listChats().filter((meta) => meta.characterId === id);
  }

  /**
   * Moves a character to a new id and repoints its chats.
   * Refuses when the target exists, so a move can never overwrite.
   */
  moveCharacter(id: string, newId: string): { id: string; chatsUpdated: number } {
    const from = this.characterDir(id);
    const to = this.characterDir(newId);
    if (!existsSync(from)) throw new Error(`character not found: ${id}`);
    if (from === to) return { id: newId, chatsUpdated: 0 };
    if (existsSync(to)) throw new Error(`a character with id "${newId}" already exists`);

    mkdirSync(this.charactersDir, { recursive: true });
    renameSync(from, to);

    let chatsUpdated = 0;
    for (const meta of this.chatsForCharacter(id)) {
      meta.characterId = newId;
      this.saveChatMeta(meta);
      chatsUpdated++;
    }
    return { id: newId, chatsUpdated };
  }

  /**
   * Deletes a character. Its chats block the delete by default, because losing a
   * transcript silently is worse than an extra confirmation.
   */
  deleteCharacter(id: string, options: { cascade?: boolean } = {}): { chatsDeleted: number } {
    const dir = this.characterDir(id);
    if (!existsSync(dir)) throw new Error(`character not found: ${id}`);

    const chats = this.chatsForCharacter(id);
    if (chats.length > 0 && options.cascade !== true) {
      throw new Error(
        `character has ${chats.length} chat(s); delete them first or pass cascade=true`,
      );
    }
    for (const meta of chats) this.deleteChat(meta.id);
    rmSync(dir, { recursive: true, force: true });
    return { chatsDeleted: chats.length };
  }

  // --- chats ---------------------------------------------------------------

  private chatPath(id: string): string {
    return join(this.chatsDir, `${sanitizeId(id)}.jsonl`);
  }

  private chatMetaPath(id: string): string {
    return join(this.chatsDir, `${sanitizeId(id)}.meta.json`);
  }

  listChats(): ChatMeta[] {
    this.ensure();
    const out: ChatMeta[] = [];
    for (const name of readdirSync(this.chatsDir)) {
      if (!name.endsWith('.meta.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.chatsDir, name), 'utf8')) as ChatMeta);
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Creates a chat, optionally seeding it with the character's greeting.
   *
   * The greeting is a normal assistant turn, so everything downstream — the
   * prompt stack, the transcript, editing, deleting — needs no special case; it
   * just is not a reply the model produced.
   */
  createChat(options: {
    characterId: string;
    name?: string;
    worldRefs?: string[];
    model?: string;
    /** Sampler snapshot; callers pass the current defaults. */
    params?: ChatParams;
    /** Snapshot of the library default; ''/missing follows it from here on. */
  personaId?: string;
  /**
   * Per-chat retrieval mode. Absent means "follow the configured default"; the
   * pin follows the same follow/override rule as the model and the persona.
   */
  retrievalMode?: RetrievalMode;
    /** Group lineup; empty means solo. */
    members?: string[];
    greeting?: string;
  }): ChatMeta {
    const id = `${sanitizeId(options.characterId)}-${Date.now().toString(36)}`;
    const meta: ChatMeta = {
      id,
      name: options.name ?? `${options.characterId} chat`,
      characterId: options.characterId,
      worldRefs: options.worldRefs ?? [],
      variables: {},
      timedEffects: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // The default model is only applied here, at creation: the conversation
    // then owns its model, and later default changes do not retroactively move
    // it. The topbar switches this per-conversation value. The persona snapshot
    // below works the same way: a later change of the library default does not
    // move existing chats, and clearing it follows the default again.
    if (typeof options.model === 'string' && options.model !== '') meta.model = options.model;
    if (options.params && typeof options.params === 'object') meta.params = { ...options.params };
    if (typeof options.personaId === 'string' && options.personaId !== '') meta.personaId = options.personaId;
    if (Array.isArray(options.members) && options.members.length > 0) meta.members = [...options.members];
    if (options.memberConnections && Object.keys(options.memberConnections).length > 0) {
      meta.memberConnections = { ...options.memberConnections };
    }
    if (typeof options.groupReplyLimit === 'number' && options.groupReplyLimit !== 1) {
      meta.groupReplyLimit = options.groupReplyLimit;
    }
    if (options.groupMode !== undefined && options.groupMode !== 'round') {
      meta.groupMode = options.groupMode;
    }
    writeAtomic(this.chatMetaPath(id), `${JSON.stringify(meta, null, 4)}\n`);

    const greeting = typeof options.greeting === 'string' ? options.greeting.trim() : '';
    const seed: ChatEntry[] = greeting === ''
      ? []
      : [
          {
            id: `m0-${Date.now().toString(36)}`,
            parentId: null,
            role: 'assistant',
            content: options.greeting!.trim(),
            createdAt: new Date().toISOString(),
          },
        ];
    this.writeChat(id, seed);
    return meta;
  }

  loadChatMeta(id: string): ChatMeta {
    const path = this.chatMetaPath(id);
    if (!existsSync(path)) throw new Error(`chat not found: ${id}`);
    return JSON.parse(readFileSync(path, 'utf8')) as ChatMeta;
  }

  saveChatMeta(meta: ChatMeta): ChatMeta {
    meta.updatedAt = new Date().toISOString();
    writeAtomic(this.chatMetaPath(meta.id), `${JSON.stringify(meta, null, 4)}\n`);
    return meta;
  }

  loadChat(id: string): ChatEntry[] {
    const path = this.chatPath(id);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as ChatEntry);
  }

  /** JSONL appends are single-line writes, so they stay crash-safe. */
  appendChat(id: string, entry: ChatEntry): void {
    this.ensure();
    appendFileSync(this.chatPath(id), `${JSON.stringify(entry)}\n`);
  }

  writeChat(id: string, entries: ChatEntry[]): void {
    writeAtomic(this.chatPath(id), entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''));
  }

  deleteChat(id: string): void {
    rmSync(this.chatPath(id), { force: true });
    rmSync(this.chatMetaPath(id), { force: true });
    rmSync(this.tracePath(id), { force: true });
  }

  // --- trace (instrumentation, see engine/trace.ts) ------------------------

  tracePath(id: string): string {
    return join(this.chatsDir, `${sanitizeId(id)}.trace.jsonl`);
  }

  /** The trajectory of one chat, oldest first. */
  loadTrace(id: string): TraceEvent[] {
    const path = this.tracePath(id);
    if (!existsSync(path)) return [];
    const events: TraceEvent[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const event = coerceTraceEvent(JSON.parse(line));
        if (event) events.push(event);
      } catch {
        // A half-written or hand-edited line costs its own row, not the file.
        continue;
      }
    }
    return events;
  }

  /**
   * Adds one event and drops the stored request bodies of everything but the
   * newest few turns. The file is rewritten rather than appended when pruning is
   * needed, which is the only way to remove a line from a text file.
   */
  appendTrace(id: string, event: TraceEvent): TraceEvent[] {
    const events = pruneTraceBodies([...this.loadTrace(id), event]);
    writeAtomic(
      this.tracePath(id),
      events.map((item) => JSON.stringify(item)).join('\n') + (events.length ? '\n' : ''),
    );
    return events;
  }

  clearTrace(id: string): void {
    rmSync(this.tracePath(id), { force: true });
  }

  // --- vectors (side files, see engine/vectors.ts) -------------------------

  vectorPath(id: string): string {
    return join(this.worldsDir, `${sanitizeId(id)}.vectors.json`);
  }

  loadVectorIndex(id: string): VectorIndex | null {
    const path = this.vectorPath(id);
    if (!existsSync(path)) return null;
    try {
      return coerceVectorIndex(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      // A truncated or hand-broken index is not a reason to fail a turn; the
      // book would simply have to be re-indexed, which the UI offers.
      return null;
    }
  }

  saveVectorIndex(id: string, index: VectorIndex): VectorIndex {
    writeAtomic(this.vectorPath(id), `${JSON.stringify(index, null, 2)}\n`);
    return index;
  }

  deleteVectorIndex(id: string): void {
    rmSync(this.vectorPath(id), { force: true });
  }
}

export function sanitizeId(id: string): string {
  return id
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\.+$/, '')
    .trim()
    .slice(0, 96) || 'unnamed';
}

/**
 * Merges the vector section one level deeper than the rest of the config: both
 * endpoints are stored at once, and a patch that only touches one of them (the
 * settings dialog sends the whole set, but a hand-rolled PUT may not) must not
 * wipe the other.
 */
function mergeVector(
  patch: Partial<TeahouseConfig['vector']> | undefined,
  stored: TeahouseConfig['vector'] = DEFAULT_CONFIG.vector,
): TeahouseConfig['vector'] {
  const base = { ...DEFAULT_CONFIG.vector, ...stored };
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    local: { ...base.local, ...(patch.local ?? {}) },
    remote: { ...base.remote, ...(patch.remote ?? {}) },
  };
}

/**
 * Reads the retrieval section. A config written before the mode existed maps its
 * old switches onto it once — vector storage or model selection stays on until
 * the mode is set explicitly — so saved intent is never silently dropped.
 */
function mergeRetrieval(
  patch: Partial<TeahouseConfig['retrieval']> | undefined,
  stored: Partial<TeahouseConfig>,
): TeahouseConfig['retrieval'] {
  const base = { ...DEFAULT_CONFIG.retrieval };
  if (patch) {
    const merged = { ...base, ...patch };
    // The two counts are user-typed numbers; clamp here so a hand-edited config
    // cannot ask for 999 rounds of provider calls.
    merged.agentMaxRounds = clampInt(merged.agentMaxRounds, 1, 8, base.agentMaxRounds);
    merged.agentMaxFiles = clampInt(merged.agentMaxFiles, 1, 20, base.agentMaxFiles);
    return merged;
  }
  if (stored.scan?.modelSelect === true) return { ...base, mode: 'select' };
  if (stored.vector?.enabled === true) return { ...base, mode: 'vector' };
  return base;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** Write to a sibling temp file and rename, so a crash never truncates data. */
export function writeAtomic(path: string, contents: string | Buffer): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(temp, contents);
  renameSync(temp, path);
}
