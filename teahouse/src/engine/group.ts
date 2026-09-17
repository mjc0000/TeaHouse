/**
 * Group chat: who speaks, and in what order.
 *
 * A fresh assistant turn in a group is one *round*: the server decides an
 * ordered list of members (the plan), pins the first and hands the rest to the
 * client, which chains one ordinary turn per name. How the list is built is the
 * group's mode (`GROUP_MODES`):
 *
 *   round    the original two-step dance: a small, unsaved call asks the model
 *            to name the next speaker, round-robin covers a mumble, and the
 *            rest of the cap is filled by walking the lineup — "in turn".
 *   natural  SillyTavern's Natural order: whoever the user named answers first,
 *            the rest roll against their talkativeness, and a random quiet one
 *            covers a silent roll.
 *   list     everyone, in lineup order.
 *   pooled   whoever has not spoken since the user's last message, preferring
 *            the quiet ones and avoiding the member who just spoke.
 *   manual   only the members the user named; with no name, nobody answers.
 *
 * Whatever the mode, an explicit pin from the client (`@Name`, a retry or a
 * regenerate of an existing reply) bypasses the plan entirely.
 */

import { chatOnce } from '../llm/openai-compat.ts';
import type { LlmConfig } from '../llm/openai-compat.ts';
import { GROUP_MODES, type GroupMode } from '../store/db.ts';

export interface GroupMember {
  id: string;
  name: string;
  /**
   * How readily this member speaks up in `natural`, 0–100 (50 when unset).
   * Not card data: see `effectiveTalkativeness` in the store.
   */
  talkativeness?: number;
}

export interface RecentLine {
  speaker: string;
  text: string;
}

/** One round's worth of input for the speaker policies. */
export interface GroupActivation {
  mode: GroupMode;
  members: GroupMember[];
  /**
   * The member whose line is on screen. Barred from speaking again unless
   * self-responses are allowed — and only on a turn the user did not start,
   * because after a user message the last line is the user's own.
   */
  lastSpeaker?: string | null;
  /** Assistant turns since the newest user message, oldest first (`pooled`). */
  spokenSinceUser?: string[];
  /** The newest user message; a name in it wins over every policy. */
  input?: string;
  /** False for a chained or automatic turn. */
  userInput?: boolean;
  /**
   * Hard cap on the plan's length: 1 (the default when unset) keeps one reply
   * per round, 0 means "as many as the mode names".
   */
  cap?: number;
  allowSelfResponses?: boolean;
  /** Injected for tests; `Math.random` in production. */
  random?: () => number;
  /** `round` only: the director's pick, expanded by round-robin to the cap. */
  first?: GroupMember | null;
}

/** Whether a caller's value names a group mode we know. */
export function isGroupMode(value: unknown): value is GroupMode {
  return typeof value === 'string' && (GROUP_MODES as readonly string[]).includes(value);
}

/** First member whose name appears in the answer; null when none does. */export function matchSpeakerName(answer: string, members: GroupMember[]): GroupMember | null {
  const lowered = answer.toLowerCase();
  // Longest name first, so "Valerie Vance" beats "Val" inside one answer.
  const ordered = [...members].sort((a, b) => b.name.length - a.name.length);
  for (const member of ordered) {
    if (member.name.trim() !== '' && lowered.includes(member.name.toLowerCase())) return member;
  }
  return null;
}

/** Who follows `lastId` in speaking order, wrapping around. */
export function nextRoundRobin(members: GroupMember[], lastId: string | null): GroupMember {
  const index = members.findIndex((member) => member.id === lastId);
  return members[(index + 1) % members.length]!;
}

/**
 * Asks the model to name the next speaker. Never throws: a failure means
 * round-robin, and the turn still happens.
 */
export async function pickSpeaker(
  llm: LlmConfig,
  members: GroupMember[],
  recent: RecentLine[],
  lastSpeakerId: string | null,
): Promise<GroupMember> {
  if (members.length === 0) throw new Error('no members to pick from');
  const fallback = nextRoundRobin(members, lastSpeakerId);
  const cast = recent
    .slice(-8)
    .map((line) => `${line.speaker}: ${line.text.slice(0, 200)}`)
    .join('\n');
  try {
    const result = await chatOnce(
      { ...llm, temperature: 0.3, maxTokens: 0, stop: [], requestUsage: false },
      [
        {
          role: 'system',
          content: `You are the director of a group roleplay. Cast: ${members.map((member) => member.name).join(', ')}. Reply with ONLY the name of who speaks next, nothing else.`,
        },
        { role: 'user', content: cast === '' ? '(the conversation just started)' : cast },
      ],
    );
    return matchSpeakerName(result.text, members) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * The members a text names, in lineup order. Used both for `manual` (only the
 * named members answer) and for `natural` (the named members answer first).
 */
export function namedSpeakers(input: string, members: GroupMember[], exclude?: string | null): GroupMember[] {
  if (input.trim() === '') return [];
  return members.filter((member) => member.id !== exclude && nameAppears(input, member.name));
}

/**
 * Builds one round's plan: the ordered members who answer, capped. Pure and
 * synchronous — `round`'s director call is made by the caller and arrives as
 * `first`, so a policy can never stall a turn on the network.
 */
export function activateGroupSpeakers(options: GroupActivation): GroupMember[] {
  const members = options.members;
  if (members.length === 0) return [];
  const random = options.random ?? Math.random;
  const cap = resolveCap(options.cap, members.length);
  // SillyTavern bars the previous speaker only when the turn was not the user's
  // own: after a user message the last line belongs to the user, so the member
  // who spoke before it may answer again.
  const banned = options.allowSelfResponses === true || options.userInput === true
    ? null
    : options.lastSpeaker ?? null;

  switch (options.mode) {
    case 'list':
      return members.slice(0, cap);
    case 'manual':
      return namedSpeakers(options.input ?? '', members, banned).slice(0, cap);
    case 'pooled':
      return pooledSpeakers(options, cap, random, banned);
    case 'natural':
      return naturalSpeakers(options, cap, random, banned);
    case 'round':
      return roundSpeakers(members, options.first ?? members[0]!, cap);
  }
}

/**
 * A missing cap is the default of one reply per round; 0 means "as many as the
 * mode names"; anything else is clamped to the lineup.
 */
function resolveCap(cap: number | undefined, count: number): number {
  if (cap === 0) return count;
  if (cap === undefined) return 1;
  return Math.max(1, Math.min(Math.floor(cap), count));
}

/** The director's pick, then the lineup in turn, each member once. */
function roundSpeakers(members: GroupMember[], first: GroupMember, cap: number): GroupMember[] {
  const out: GroupMember[] = [first];
  let cursor = first.id;
  while (out.length < cap) {
    const next = nextRoundRobin(members, cursor);
    if (out.some((member) => member.id === next.id)) break;
    out.push(next);
    cursor = next.id;
  }
  return out;
}

/**
 * Whoever has not spoken since the user's last message, picked at random; when
 * that pool is spent, whoever is not the member who just spoke. A user turn
 * behaves like an empty pool (the scan stops at the user's own message), so it
 * is a plain random pick — SillyTavern's Pooled order, extended to fill a cap.
 */
function pooledSpeakers(options: GroupActivation, cap: number, random: () => number, banned: string | null): GroupMember[] {
  const spent = new Set(options.userInput === true ? [] : options.spokenSinceUser ?? []);
  const out: GroupMember[] = [];
  const take = (pool: GroupMember[]): GroupMember | null => {
    const free = pool.filter((member) => !out.some((picked) => picked.id === member.id));
    return free.length === 0 ? null : free[Math.floor(random() * free.length)]!;
  };
  while (out.length < cap) {
    const quiet = options.members.filter((member) => !spent.has(member.id));
    const chosen = take(quiet)
      ?? take(options.members.filter((member) => member.id !== banned))
      ?? take(options.members);
    if (chosen === null) break;
    out.push(chosen);
    spent.add(chosen.id);
  }
  return out;
}

/**
 * SillyTavern's Natural order: the named members answer first, then everyone
 * rolls against their talkativeness (in random order), and if nothing fired one
 * talkative member is picked at random so the round is never empty.
 */
function naturalSpeakers(options: GroupActivation, cap: number, random: () => number, banned: string | null): GroupMember[] {
  const out = namedSpeakers(options.input ?? '', options.members, banned);
  const chatty: GroupMember[] = [];
  for (const member of shuffle(options.members, random)) {
    if (banned !== null && member.id === banned) continue;
    const chance = member.talkativeness ?? 50;
    if (chance >= random() * 100) out.push(member);
    if (chance > 0) chatty.push(member);
  }
  if (out.length === 0) {
    const pool = chatty.length > 0 ? chatty : options.members;
    out.push(pool[Math.floor(random() * pool.length)]!);
  }
  return dedupe(out).slice(0, cap);
}

function dedupe(members: GroupMember[]): GroupMember[] {
  const seen = new Set<string>();
  return members.filter((member) => (seen.has(member.id) ? false : (seen.add(member.id), true)));
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The whole name plus its words, so "Valerie Vance" answers to either. */
function nameParts(name: string): string[] {
  const whole = name.trim();
  if (whole === '') return [];
  const words = whole.split(/[\s_.\-]+/).filter((word) => word.length >= 2);
  return [whole, ...words];
}

function nameAppears(input: string, name: string): boolean {
  const text = input.toLowerCase();
  return nameParts(name).some((part) => {
    const needle = part.toLowerCase();
    if (needle === '') return false;
    // A name not spelled in Latin letters (Chinese, Japanese, …) has no word
    // boundaries to lean on; a plain substring is the honest test there.
    if (!/[a-z0-9]/i.test(needle)) return text.includes(needle);
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u').test(text);
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
