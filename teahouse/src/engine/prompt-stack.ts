/**
 * Prompt stack assembly.
 *
 * Mirrors SillyTavern's Prompt Manager model: an ordered list of blocks, where
 * most blocks are static text and a few are *markers* filled at generation time
 * (world info, chat history, character fields). Blocks can also be injected at
 * an absolute depth into the chat history instead of in their list position.
 *
 * Default order is ST's `promptManagerDefaultPromptOrder`:
 *   main, worldInfoBefore, personaDescription, charDescription, charPersonality,
 *   scenario, enhanceDefinitions, nsfw, worldInfoAfter, dialogueExamples,
 *   impersonate, chatHistory, jailbreak
 * (`language` and `impersonate` are our own blocks on top of ST's set.)
 *
 * Everything is returned with an itemization (per-block token cost and which
 * world book entries fired), which is what makes the stack debuggable.
 */

import type { CharacterCard, Role } from '../formats/types.ts';
import { notice, type Notice } from '../i18n.ts';
import { expandMacros, type MacroContext } from './macros.ts';
import { renderMemoryText } from './memory.ts';
import { applyPromptRegexes, type RegexRule } from './regex-rules.ts';
import { renderStoryTemplate, type StoryParams } from './story-template.ts';
import type { ChatMessage } from './tokens.ts';
import type { ScanHit, ScanResult } from './world-scan.ts';

export const MARKERS = [
  'chatHistory',
  'charDescription',
  'charPersonality',
  'scenario',
  'personaDescription',
  'dialogueExamples',
  'worldInfoBefore',
  'worldInfoAfter',
  'worldInfoANTop',
  'worldInfoANBottom',
  'worldInfoEMTop',
  'worldInfoEMBottom',
] as const;
export type MarkerKind = (typeof MARKERS)[number];

export const INJECTION_POSITION = { RELATIVE: 0, ABSOLUTE: 1 } as const;

export interface PromptBlock {
  identifier: string;
  name: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  marker: MarkerKind | null;
  system_prompt: boolean;
  enabled: boolean;
  /** 0 = keep list position, 1 = inject at `injection_depth` from the end. */
  injection_position: number;
  injection_depth: number;
  injection_order: number;
  /** The character card may not override this block. */
  forbid_overrides: boolean;
}

const ROLE_NAMES: Record<Role, 'system' | 'user' | 'assistant'> = {
  0: 'system',
  1: 'user',
  2: 'assistant',
};

function block(
  identifier: string,
  name: string,
  options: Partial<PromptBlock> = {},
): PromptBlock {
  return {
    identifier,
    name,
    role: 'system',
    content: '',
    marker: null,
    system_prompt: true,
    enabled: true,
    injection_position: INJECTION_POSITION.RELATIVE,
    injection_depth: 4,
    injection_order: 100,
    forbid_overrides: false,
    ...options,
  };
}

/** ST's default prompt set, in ST's default assembly order. */
export function defaultPromptStack(): PromptBlock[] {
  return [
    block('main', 'Main Prompt', {
      content: "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.",
      forbid_overrides: false,
    }),
    // Filled by `applyLanguage`: content when a reply language is configured,
    // disabled when it is not. Kept as a real block so it is visible, counted and
    // toggleable in the prompt panel like everything else.
    block('language', 'Reply Language', { content: '' }),
    block('worldInfoBefore', 'World Info (before)', { marker: 'worldInfoBefore' }),
    block('worldInfoANTop', 'World Info (author note top)', { marker: 'worldInfoANTop' }),
    block('worldInfoANBottom', 'World Info (author note bottom)', { marker: 'worldInfoANBottom' }),
    block('worldInfoEMTop', 'World Info (examples top)', { marker: 'worldInfoEMTop' }),
    block('worldInfoEMBottom', 'World Info (examples bottom)', { marker: 'worldInfoEMBottom' }),
    block('personaDescription', 'Persona Description', { marker: 'personaDescription' }),
    block('charDescription', 'Char Description', { marker: 'charDescription' }),
    block('charPersonality', 'Char Personality', { marker: 'charPersonality' }),
    block('scenario', 'Scenario', { marker: 'scenario' }),
    // The context template ("story string") renders the slow-changing fields
    // into one block. Empty by default, so the stack is exactly ST's order plus
    // our own language/impersonate blocks until the user writes a template.
    block('story', 'Context Template', { content: '' }),
    block('enhanceDefinitions', 'Enhance Definitions', {
      content:
        "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.",
    }),
    block('nsfw', 'Auxiliary Prompt', { content: '' }),
    block('worldInfoAfter', 'World Info (after)', { marker: 'worldInfoAfter' }),
    block('dialogueExamples', 'Chat Examples', { marker: 'dialogueExamples' }),
    // Only injected for impersonation turns (see applyImpersonate): it stays a
    // real block so the prompt panel can show, count and switch it off. Absolute
    // at depth 0 with role `user`: the last thing in the request, and the thing
    // the model must answer — which is what puts the reply on the player's side.
    block('impersonate', 'Impersonation prompt', {
      content: DEFAULT_IMPERSONATE_INSTRUCTION,
      role: 'user',
      injection_position: INJECTION_POSITION.ABSOLUTE,
      injection_depth: 0,
    }),
    block('chatHistory', 'Chat History', { marker: 'chatHistory' }),
    block('jailbreak', 'Post-History Instructions', { content: '' }),
  ];
}

/**
 * Default wording for the reply-language instruction. `{{language}}` is replaced
 * with the configured language; the user may override the whole sentence.
 */
export const DEFAULT_LANGUAGE_INSTRUCTION =
  'Always write your replies in {{language}}, including narration, dialogue and stage directions. Do not switch to another language even if the user writes in one.';

export interface LanguageSettings {
  outputLanguage?: string;
  languageInstruction?: string;
}

/** The instruction line for the current settings, or '' when none applies. */
export function renderLanguageInstruction(settings: LanguageSettings): string {
  const language = (settings.outputLanguage ?? '').trim();
  if (language === '') return '';
  const template = (settings.languageInstruction ?? '').trim() || DEFAULT_LANGUAGE_INSTRUCTION;
  return template.replaceAll('{{language}}', language);
}

/**
 * Applies the reply-language settings to a stack: fills the `language` block, or
 * disables it when no language is configured. A client-supplied stack that lost
 * the block gets it inserted after `main`, so the setting cannot be silently
 * dropped by a stale override.
 */
export function applyLanguage(stack: PromptBlock[], settings: LanguageSettings): PromptBlock[] {
  const text = renderLanguageInstruction(settings);
  const blocks = [...stack];

  let index = blocks.findIndex((candidate) => candidate.identifier === 'language');
  if (index === -1) {
    const afterMain = blocks.findIndex((candidate) => candidate.identifier === 'main');
    index = afterMain === -1 ? 0 : afterMain + 1;
    blocks.splice(index, 0, block('language', 'Reply Language', { content: '' }));
  }

  const existing = blocks[index]!;
  // The settings decide whether there is anything to inject; the panel decides
  // whether it goes in. Without the second half, switching the row off in the
  // prompt panel looked like it worked and did nothing: the next assembly put it
  // straight back on.
  blocks[index] = { ...existing, content: text, enabled: text !== '' && existing.enabled !== false };
  return blocks;
}

/**
 * Long-term memory, applied to the stack the same way the reply language is: a
 * real block the user can see, count and switch off, rather than text appended
 * behind the scenes.
 *
 * SillyTavern injects its memory as a system message a couple of messages from
 * the end (`setExtensionPrompt(..., IN_PROMPT, depth, ...)`), and that is exactly
 * what an absolute-position block does here, so the two line up.
 */
export interface MemoryBlockSettings {
  text: string;
  template: string;
  depth: number;
  role: 'system' | 'user' | 'assistant';
  enabled: boolean;
}

/** Fills (or inserts, or disables) the `memory` block. */
export function applyMemory(stack: PromptBlock[], memory: MemoryBlockSettings | null | undefined): PromptBlock[] {
  const blocks = [...stack];
  const text = memory ? renderMemoryText(memory.template, memory.text) : '';

  let index = blocks.findIndex((candidate) => candidate.identifier === 'memory');
  if (index === -1) {
    // Next to the other settings-driven block, so the panel reads the same way
    // for both; where it sits in the list does not affect assembly because it is
    // an absolute injection.
    const afterLanguage = blocks.findIndex((candidate) => candidate.identifier === 'language');
    index = afterLanguage === -1 ? blocks.length : afterLanguage + 1;
    blocks.splice(index, 0, block('memory', 'Memory', { content: '' }));
  }

  const existing = blocks[index]!;
  blocks[index] = {
    ...existing,
    // The content stays even when the feature is off, so the prompt panel can
    // still show what is stored; `enabled` is what decides injection, and a
    // disabled block contributes nothing at all to the request.
    content: text,
    // Same split as the reply language: the settings say whether a summary
    // exists, the panel row says whether it is injected.
    enabled: text !== '' && memory?.enabled !== false && existing.enabled !== false,
    injection_position: INJECTION_POSITION.ABSOLUTE,
    injection_depth: memory?.depth ?? existing.injection_depth,
    role: memory?.role ?? existing.role,
  };
  return blocks;
}

/** One document the agent read this turn. */
export interface AgentDocBlock {
  id: string;
  text: string;
}

/**
 * Files the agent asked to read, as a real block.
 *
 * Same reasoning as memory and the reply language: the request the user previews
 * has to be the request that is sent, so the reads get a block with a token cost
 * instead of being appended behind the scenes. An absolute injection keeps the
 * list position irrelevant and puts the material near the end, where it is most
 * salient.
 */
export function applyAgentDocs(stack: PromptBlock[], docs: AgentDocBlock[] | null | undefined): PromptBlock[] {
  const blocks = [...stack];
  const text = (docs ?? [])
    .filter((doc) => doc.text.trim() !== '')
    .map((doc) => `[skill file: ${doc.id}]\n${doc.text}`)
    .join('\n\n');

  let index = blocks.findIndex((candidate) => candidate.identifier === 'agentSkillFiles');
  if (index === -1) {
    const afterMemory = blocks.findIndex((candidate) => candidate.identifier === 'memory');
    const fresh = block('agentSkillFiles', 'Skill files (agent)', { content: '' });
    if (afterMemory === -1) {
      blocks.push(fresh);
      index = blocks.length - 1;
    } else {
      blocks.splice(afterMemory + 1, 0, fresh);
      index = afterMemory + 1;
    }
  }

  const existing = blocks[index]!;
  blocks[index] = {
    ...existing,
    content: text,
    // No docs this turn is the normal case in every other mode: keep the row
    // visible in the panel, but contribute nothing to the request.
    enabled: text.trim() !== '' && existing.enabled !== false,
    injection_position: INJECTION_POSITION.ABSOLUTE,
    injection_depth: existing.injection_depth,
    role: existing.role,
  };
  return blocks;
}

/** Default wording for the impersonation instruction. `{{user}}`/`{{char}}` expand like elsewhere. */
/**
 * The impersonation turn's instruction.
 *
 * Two things make this actually work, both measured against the real API:
 *
 *   1. It is an **absolute injection at depth 0** (`applyImpersonate`), so it is
 *      the last message — an instruction before the transcript is buried under
 *      the character's own last reply, and the model just continues that.
 *   2. Its role is **user**, not system. A trailing *system* message reads as
 *      background to a chat model, which keeps answering as the assistant (i.e.
 *      as the character). A trailing *user* message is the thing it must reply
 *      to, so its answer comes out on the player's side. A/B on the same chat:
 *      trailing system → wrote {{char}}, trailing user → wrote the player.
 *
 * The wording avoids "in the first person" on purpose: the player may narrate
 * themselves in whatever person they like, so the instruction points at their
 * recent messages instead. It also never leans on the persona *name* (a persona
 * literally called "我" would be read as the pronoun) — it says "the player".
 */
export const DEFAULT_IMPERSONATE_INSTRUCTION = [
  'Write the player\'s next message in this roleplay: you are writing as the player, not as {{char}}.',
  'Match the voice, person and length of the player\'s recent messages above (if the player writes "我…", keep that; if they write "你…", keep that).',
  '- Write only the player\'s words, thoughts and actions. Never write {{char}}\'s dialogue, actions, thoughts or reactions.',
  '- Do not narrate the scene from outside, and do not continue {{char}}\'s last message.',
  '- Stop when the player\'s message ends, so {{char}} can answer next.',
  'Output only the player\'s message.',
].join('\n');

/** Applies the impersonation mode to a stack: a real block the panel can show and switch off. */
export function applyImpersonate(stack: PromptBlock[], active: boolean): PromptBlock[] {
  const blocks = [...stack];
  let index = blocks.findIndex((candidate) => candidate.identifier === 'impersonate');
  if (index === -1) {
    const atHistory = blocks.findIndex((candidate) => candidate.identifier === 'chatHistory');
    const fresh = block('impersonate', 'Impersonation prompt', {
      content: DEFAULT_IMPERSONATE_INSTRUCTION,
    });
    if (atHistory === -1) {
      blocks.push(fresh);
      index = blocks.length - 1;
    } else {
      blocks.splice(atHistory, 0, fresh);
      index = atHistory;
    }
  }
  const existing = blocks[index]!;
  if (!active) {
    // Normal turns never inject it, but the stored content stays on the client copy.
    blocks[index] = { ...existing, enabled: false };
    return blocks;
  }
  blocks[index] = {
    ...existing,
    content: existing.content.trim() === '' ? DEFAULT_IMPERSONATE_INSTRUCTION : existing.content,
    // Same split as language/memory: the mode decides there is something to inject,
    // the panel row decides whether it goes in.
    enabled: existing.enabled !== false,
    // Depth 0 = the very last message, *after* the transcript, and role `user`
    // so the model answers on the player's side (see the constant's comment).
    injection_position: INJECTION_POSITION.ABSOLUTE,
    injection_depth: 0,
    role: 'user',
  };
  return blocks;
}

/** Fills (or inserts, or disables) the `story` block with the raw template. */
export function applyStory(stack: PromptBlock[], template: string | null | undefined): PromptBlock[] {
  const text = typeof template === 'string' ? template : '';
  const blocks = [...stack];
  let index = blocks.findIndex((candidate) => candidate.identifier === 'story');
  if (index === -1) {
    const afterScenario = blocks.findIndex((candidate) => candidate.identifier === 'scenario');
    const fresh = block('story', 'Context Template', { content: '' });
    if (afterScenario === -1) {
      blocks.push(fresh);
      index = blocks.length - 1;
    } else {
      blocks.splice(afterScenario + 1, 0, fresh);
      index = afterScenario + 1;
    }
  }
  const existing = blocks[index]!;
  // Same split as language/memory: the setting decides whether there is
  // anything to render, the panel row decides whether it is injected. The
  // template source stays on the block so the panel shows what it is.
  blocks[index] = { ...existing, content: text, enabled: text.trim() !== '' && existing.enabled !== false };
  return blocks;
}

export interface BuildInput {
  card: CharacterCard;
  persona?: string;
  personaName?: string;
  history: ChatMessage[];
  scan: ScanResult | null;
  stack?: PromptBlock[];
  tokenCounter: { count: (text: string) => number; mode: string };
  /** Model context window. */
  maxContext: number;
  /** Tokens held back for the reply. */
  responseReserve?: number;
  /** Persisted macro variables (chat-scoped). */
  variables?: Record<string, string>;
  /** Reply language, injected through the `language` block. */
  outputLanguage?: string;
  languageInstruction?: string;
  /** Long-term memory, injected through the `memory` block. */
  memory?: MemoryBlockSettings | null;
  /** Files the agent read this turn, injected through the `agentSkillFiles` block. */
  agentDocs?: AgentDocBlock[] | null;
  /** Impersonation turn: inject the `impersonate` block (otherwise forced off). */
  impersonate?: boolean;
  /** Context template source; rendered into the `story` block when non-empty. */
  storyTemplate?: string;
  /** Prompt-side regex rules, applied to the assembled messages before counting. */
  promptRegexes?: RegexRule[];
  /** Injectable RNG for `{{random}}` / `{{pick}}`. */
  random?: () => number;
}

export interface WorldItemization {
  uid: number;
  world: string;
  comment: string;
  tokens: number;
  activatedBy: string;
  /** Cosine similarity, when vector storage is what activated this entry. */
  score?: number;
  /** Which outside channel fired it: `vector`, `model` or `full`. */
  source?: 'vector' | 'model' | 'full';
  matchedKeys: string[];
  matchedSecondaryKeys: string[];
  loop: number;
}

export interface PromptItem {
  identifier: string;
  name: string;
  role: 'system' | 'user' | 'assistant';
  kind: 'static' | 'marker' | 'injection' | 'history';
  enabled: boolean;
  tokens: number;
  /** Final text after macro expansion (empty for the history block). */
  content: string;
  /** For the history block: per-message token costs. */
  messages?: { role: string; tokens: number; preview: string }[];
  /** Which world book entries contributed, when applicable. */
  worldHits?: WorldItemization[];
  /** Set when the block was dropped because it was empty. */
  skippedReason?: string;
  injectionDepth?: number;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  itemization: PromptItem[];
  totalTokens: number;
  /** History messages dropped to fit the context window. */
  trimmed: number;
  /** Outlet-position entries: exposed, never injected. */
  outlets: Record<string, WorldItemization[]>;
  /** Macro variables after `{{setvar}}` et al ran; persist these with the chat. */
  variables: Record<string, string>;
  warnings: Notice[];
}

function summarizeHits(hits: ScanHit[]): WorldItemization[] {
  return hits.map((hit) => ({
    uid: hit.uid,
    world: hit.world,
    comment: hit.comment,
    tokens: hit.tokens,
    activatedBy: hit.activatedBy,
    ...(hit.score === undefined ? {} : { score: hit.score }),
    ...(hit.source === undefined ? {} : { source: hit.source }),
    matchedKeys: hit.matchedKeys,
    matchedSecondaryKeys: hit.matchedSecondaryKeys,
    loop: hit.loop,
  }));
}

function joinHits(hits: ScanHit[]): string {
  return hits.map((hit) => hit.content).join('\n');
}

export function buildPrompt(input: BuildInput): BuiltPrompt {
  const { card, tokenCounter } = input;
  // The reply-language setting lives in the stack rather than appended behind the
  // scenes, so it shows up with its own token cost and can be switched off.
  const stack = applyImpersonate(
    applyStory(
      applyAgentDocs(
        applyMemory(
          applyLanguage(input.stack ?? defaultPromptStack(), {
            outputLanguage: input.outputLanguage,
            languageInstruction: input.languageInstruction,
          }),
          input.memory,
        ),
        input.agentDocs,
      ),
      input.storyTemplate,
    ),
    input.impersonate === true,
  );
  const reserve = input.responseReserve ?? 512;
  const limit = Math.max(0, input.maxContext - reserve);
  const warnings: Notice[] = [];
  const variables: Record<string, string> = { ...(input.variables ?? {}) };

  const macroContext: MacroContext = {
    char: card.name,
    user: input.personaName ?? 'You',
    persona: input.persona ?? '',
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    mesExamples: card.mes_example,
    variables,
    input: [...input.history].reverse().find((message) => message.role === 'user')?.content ?? '',
    random: input.random,
  };

  const scan = input.scan;
  const bucketHits: Record<string, ScanHit[]> = {
    worldInfoBefore: scan?.buckets.before ?? [],
    worldInfoAfter: scan?.buckets.after ?? [],
    worldInfoANTop: scan?.buckets.anTop ?? [],
    worldInfoANBottom: scan?.buckets.anBottom ?? [],
    worldInfoEMTop: scan?.buckets.emTop ?? [],
    worldInfoEMBottom: scan?.buckets.emBottom ?? [],
  };

  // Absolute injections, collected and merged by (depth, role).
  const injections = new Map<string, { depth: number; role: Role; order: number; parts: string[]; hits: ScanHit[] }>();

  const addInjection = (depth: number, role: Role, order: number, text: string, hits: ScanHit[] = []): void => {
    const key = `${depth}:${role}`;
    const entry = injections.get(key) ?? { depth, role, order, parts: [], hits: [] };
    entry.order = Math.min(entry.order, order);
    entry.parts.push(text);
    entry.hits.push(...hits);
    injections.set(key, entry);
  };

  // World book entries positioned at an absolute depth.
  for (const bucket of scan?.buckets.atDepth ?? []) {
    for (const hit of bucket.hits) {
      addInjection(bucket.depth, bucket.role, hit.order, hit.content, [hit]);
    }
  }

  // Character depth prompt, if the card carries one.
  const depthPrompt = card.depthPrompt;
  if (depthPrompt && depthPrompt.prompt.trim() !== '') {
    const role: Role = depthPrompt.role === 'user' ? 1 : depthPrompt.role === 'assistant' ? 2 : 0;
    addInjection(depthPrompt.depth, role, 100, depthPrompt.prompt);
  }

  const itemization: PromptItem[] = [];
  let systemMessages: ChatMessage[] = [];
  let historyMessages: ChatMessage[] = [];
  const preHistory: { role: ChatMessage['role']; content: string; identifier: string }[] = [];

  for (const current of stack) {
    if (!current.enabled) {
      itemization.push({
        identifier: current.identifier,
        name: current.name,
        role: current.role,
        kind: current.marker ? 'marker' : 'static',
        enabled: false,
        tokens: 0,
        content: '',
        skippedReason: 'disabled',
      });
      continue;
    }

    // Absolute-position blocks never occupy their list slot.
    if (current.injection_position === INJECTION_POSITION.ABSOLUTE) {
      const text = expandMacros(current.content, macroContext);
      if (text.trim() !== '') {
        addInjection(current.injection_depth, roleToNumber(current.role), current.injection_order, text);
      }
      itemization.push({
        identifier: current.identifier,
        name: current.name,
        role: current.role,
        kind: 'injection',
        enabled: true,
        tokens: tokenCounter.count(text),
        content: text,
        injectionDepth: current.injection_depth,
      });
      continue;
    }

    if (current.marker === 'chatHistory') {
      historyMessages = input.history.map((message) => ({ ...message }));
      itemization.push({
        identifier: current.identifier,
        name: current.name,
        role: current.role,
        kind: 'history',
        enabled: true,
        tokens: 0,
        content: '',
      });
      continue;
    }

    let text: string;
    let hits: ScanHit[] = [];

    if (current.marker) {
      hits = bucketHits[current.marker] ?? [];
      text = markerContent(current.marker, card, input.persona ?? '', hits);
    } else if (current.identifier === 'story') {
      // The block carries the template source (so the panel shows what it is);
      // the request gets the rendered story. Macros still expand afterwards,
      // so a template may mix `{{description}}` with `{{user}}`.
      const params: StoryParams = {
        system: card.system_prompt,
        description: card.description,
        personality: card.personality,
        scenario: card.scenario,
        persona: input.persona ?? '',
        char: card.name,
        user: input.personaName ?? 'You',
        wiBefore: joinHits(bucketHits.worldInfoBefore ?? []),
        wiAfter: joinHits(bucketHits.worldInfoAfter ?? []),
      };
      const rendered = renderStoryTemplate(current.content, params);
      warnings.push(...rendered.warnings);
      text = rendered.text;
    } else {
      text = current.content;
      // The card's own prompts take over the blocks that allow it.
      if (current.identifier === 'main' && !current.forbid_overrides && card.system_prompt.trim() !== '') {
        text = card.system_prompt;
      }
      if (current.identifier === 'jailbreak' && card.post_history_instructions.trim() !== '') {
        text = card.post_history_instructions;
      }
    }

    const expanded = expandMacros(text, macroContext);
    const tokens = tokenCounter.count(expanded);

    if (expanded.trim() === '') {
      itemization.push({
        identifier: current.identifier,
        name: current.name,
        role: current.role,
        kind: current.marker ? 'marker' : 'static',
        enabled: true,
        tokens: 0,
        content: '',
        worldHits: hits.length > 0 ? summarizeHits(hits) : undefined,
        skippedReason: 'empty',
      });
      continue;
    }

    itemization.push({
      identifier: current.identifier,
      name: current.name,
      role: current.role,
      kind: current.marker ? 'marker' : 'static',
      enabled: true,
      tokens,
      content: expanded,
      worldHits: hits.length > 0 ? summarizeHits(hits) : undefined,
    });

    if (current.marker === 'dialogueExamples') {
      preHistory.push({ role: roleName(current.role), content: expanded, identifier: current.identifier });
    } else {
      systemMessages.push({ role: roleName(current.role), content: expanded });
    }
  }

  // Insert the absolute injections into the history at their depth.
  // Depths are measured from the end of the *original* history, so inserting one
  // injection never shifts another one's position.
  const merged = [...historyMessages];
  const baseLength = merged.length;
  const ordered = [...injections.values()].sort(
    (a, b) => a.order - b.order || b.depth - a.depth || a.role - b.role,
  );
  for (const injection of ordered) {
    // Depth 0 means "the very end", so it must follow whatever deeper injections
    // already landed: `baseLength - 0` would be the *original* end and, once
    // another injection has been spliced in, that is one short of the end — an
    // instruction meant to be last would end up second-to-last.
    const index = injection.depth <= 0
      ? merged.length
      : Math.max(0, Math.min(merged.length, baseLength - injection.depth));
    merged.splice(index, 0, {
      role: ROLE_NAMES[injection.role],
      content: injection.parts.join('\n'),
    });
    const existing = itemization.find(
      (item) =>
        item.kind === 'injection' &&
        item.injectionDepth === injection.depth &&
        item.role === ROLE_NAMES[injection.role],
    );
    if (!existing) {
      itemization.push({
        identifier: `injection:${injection.depth}:${injection.role}`,
        name: `Injection @ depth ${injection.depth}`,
        role: ROLE_NAMES[injection.role],
        kind: 'injection',
        enabled: true,
        tokens: tokenCounter.count(injection.parts.join('\n')),
        content: injection.parts.join('\n'),
        injectionDepth: injection.depth,
        worldHits: injection.hits.length > 0 ? summarizeHits(injection.hits) : undefined,
      });
    }
  }

  // Build the final message list: pre-history (examples) then history.
  let messages: ChatMessage[] = [...systemMessages, ...preHistory, ...merged];

  // Prompt-side regex runs on the assembled messages — before counting, so the
  // budget and the trim that follows both see the rewritten text. The preview
  // shows exactly these messages, plus a warning naming what fired.
  const regexResult = applyPromptRegexes(
    messages.map((message) => message.content),
    input.promptRegexes ?? [],
  );
  if (regexResult.applied.length > 0) {
    messages = messages.map((message, index) => ({ ...message, content: regexResult.contents[index] ?? message.content }));
    for (const item of regexResult.applied) {
      const name = item.name.trim();
      warnings.push(name === ''
        ? notice('regex.rewrote', `正则改写了 ${item.count} 处`, { count: item.count })
        : notice('regex.rewroteNamed', `正则「${name}」改写了 ${item.count} 处`, { name, count: item.count }));
    }
  }

  // Trim the oldest history until the prompt fits.
  let totalTokens = countAll(messages, tokenCounter);
  let trimmed = 0;
  const historyStart = systemMessages.length + preHistory.length;
  while (totalTokens > limit && messages.length - historyStart > 1) {
    messages.splice(historyStart, 1);
    trimmed++;
    totalTokens = countAll(messages, tokenCounter);
  }
  if (trimmed > 0) {
    warnings.push(notice('prompt.trimmed', `trimmed ${trimmed} oldest history message(s) to fit ${limit} tokens`, { count: trimmed, limit }));
  }

  const historyItem = itemization.find((item) => item.kind === 'history');
  if (historyItem) {
    historyItem.messages = merged.map((message) => ({
      role: message.role,
      tokens: tokenCounter.count(message.content),
      preview: message.content.slice(0, 80),
    }));
    historyItem.tokens = merged.reduce((sum, message) => sum + tokenCounter.count(message.content), 0);
    if (trimmed > 0) historyItem.skippedReason = `trimmed ${trimmed} oldest message(s)`;
  }

  const outlets: Record<string, WorldItemization[]> = {};
  for (const [name, hits] of Object.entries(scan?.buckets.outlets ?? {})) {
    outlets[name] = summarizeHits(hits);
  }

  return { messages, itemization, totalTokens, trimmed, outlets, variables, warnings };
}

function countAll(messages: ChatMessage[], counter: { count: (text: string) => number }): number {
  return messages.reduce((sum, message) => sum + counter.count(message.content), 0);
}

function roleName(role: PromptBlock['role']): ChatMessage['role'] {
  return role;
}

function roleToNumber(role: PromptBlock['role']): Role {
  if (role === 'user') return 1;
  if (role === 'assistant') return 2;
  return 0;
}

function markerContent(
  marker: MarkerKind,
  card: CharacterCard,
  persona: string,
  hits: ScanHit[],
): string {
  switch (marker) {
    case 'charDescription':
      return card.description;
    case 'charPersonality':
      return card.personality;
    case 'scenario':
      return card.scenario;
    case 'personaDescription':
      return persona;
    case 'dialogueExamples':
      return card.mes_example;
    case 'worldInfoBefore':
    case 'worldInfoAfter':
    case 'worldInfoANTop':
    case 'worldInfoANBottom':
    case 'worldInfoEMTop':
    case 'worldInfoEMBottom':
      return joinHits(hits);
    case 'chatHistory':
      return '';
    default:
      return '';
  }
}

/** The identifiers of a stack, in assembly order. Useful for tests and the UI. */
export function stackOrder(stack: PromptBlock[]): string[] {
  return stack.map((item) => item.identifier);
}

/**
 * Validates a stack supplied by a client. Malformed blocks are dropped rather
 * than trusted, and an empty result means "use the default stack".
 *
 * This lives beside the stack model on purpose: the shape it accepts is defined
 * by this module, so the two cannot drift apart.
 */
export function coercePromptStack(value: unknown): PromptBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numberOr = (input: unknown, fallback: number): number => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const blocks: PromptBlock[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.identifier !== 'string' || item.identifier === '') continue;
    const role = item.role === 'user' || item.role === 'assistant' ? item.role : 'system';
    const marker = (MARKERS as readonly string[]).includes(String(item.marker))
      ? (item.marker as MarkerKind)
      : null;
    blocks.push({
      identifier: item.identifier,
      name: typeof item.name === 'string' && item.name !== '' ? item.name : item.identifier,
      role,
      content: typeof item.content === 'string' ? item.content : '',
      marker,
      system_prompt: item.system_prompt !== false,
      enabled: item.enabled !== false,
      injection_position: numberOr(item.injection_position, 0) === 1 ? 1 : 0,
      injection_depth: Math.max(0, Math.min(10000, numberOr(item.injection_depth, 4))),
      injection_order: numberOr(item.injection_order, 100),
      forbid_overrides: item.forbid_overrides === true,
    });
  }
  return blocks.length > 0 ? blocks : undefined;
}
