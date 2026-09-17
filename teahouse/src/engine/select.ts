/**
 * Model-selected retrieval.
 *
 * The keyword scan and vector storage decide what a turn injects; this adds an
 * optional third channel: ask the chat's own model which of the available
 * entries it wants, then feed the answer through the same external-activation
 * path the other two use. One cheap non-streaming call per turn, and a failure
 * only costs this channel — the turn still happens.
 *
 * The catalog and the reply parser are pure functions so the prompt shape and
 * the (deliberately lenient) parsing can be tested without a provider.
 */

import { chatOnce } from '../llm/openai-compat.ts';
import { notice, type Notice } from '../i18n.ts';
import type { TeahouseConfig } from '../store/db.ts';
import type { ExternalActivation, ScanEntry } from './world-scan.ts';

const MAX_CATALOG_ENTRIES = 200;
const MAX_CATALOG_CHARS = 12_000;
const MAX_PREVIEW_CHARS = 140;
const MAX_MESSAGES = 4;
const MAX_MESSAGE_CHARS = 400;
const MIN_MAX = 1;
const MAX_MAX = 10;

export interface SelectionCatalog {
  /** One numbered line per candidate, in the order the model sees them. */
  lines: string[];
  /** Row number (1-based) -> the activation to inject when it is picked. */
  map: Map<number, ExternalActivation>;
  /** True when the entry or character cap cut the list short. */
  truncated: boolean;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The catalogue handed to the model: enabled, non-constant entries with a title,
 * their first keys, and a short preview. A constant entry is injected anyway, so
 * offering it would only waste a slot.
 */
export function buildCatalog(
  entries: ScanEntry[],
  entryLimit = MAX_CATALOG_ENTRIES,
  charBudget = MAX_CATALOG_CHARS,
): SelectionCatalog {
  const lines: string[] = [];
  const map = new Map<number, ExternalActivation>();
  let chars = 0;
  let truncated = false;

  for (const item of entries) {
    const entry = item.entry;
    if (entry.disable || entry.constant) continue;
    if (entry.content.trim() === '') continue;
    if (lines.length >= entryLimit) {
      truncated = true;
      break;
    }
    const title = oneLine(entry.comment) || entry.key[0] || `uid ${entry.uid}`;
    const preview = oneLine(entry.content).slice(0, MAX_PREVIEW_CHARS);
    const keys = entry.key.slice(0, 2).join(', ');
    const line = `${lines.length + 1}. [${item.world}#${entry.uid}] ${title} — ${preview}${keys === '' ? '' : ` (keys: ${keys})`}`;
    if (chars + line.length > charBudget) {
      truncated = true;
      break;
    }
    chars += line.length;
    lines.push(line);
    map.set(lines.length, { world: item.world, uid: entry.uid, source: 'model' });
  }

  return { lines, map, truncated };
}

/** The one instruction; the first sentence is also the tests' marker. */
export function selectionPrompt(max: number): string {
  return [
    'You choose optional background notes for a roleplay reply.',
    '"Background notes" is a numbered list; the recent conversation follows.',
    `Reply with ONLY a JSON array of the numbers whose notes would improve the next reply, most useful first, at most ${max}. Reply [] when none would help. No prose, no explanation.`,
    '',
    'Pick by meaning, not by exact wording: a note about a person, place, event or fact the scene touches is worth picking even when no key matches.',
  ].join('\n');
}

/** Catalogue plus the conversation tail, as one user message. */
export function selectionInput(
  catalog: SelectionCatalog,
  messages: { role: string; content: string }[],
): string {
  const tail = messages
    .filter((message) => message.role !== 'system')
    .slice(-MAX_MESSAGES)
    .map((message) => `${message.role}: ${oneLine(message.content).slice(0, MAX_MESSAGE_CHARS)}`);
  return `Background notes:\n${catalog.lines.join('\n')}\n\nRecent conversation:\n${tail.join('\n')}`;
}

/**
 * Reads a JSON array of numbers out of whatever the model wrote — fences and
 * stray prose included. Unknown or repeated numbers are dropped, and the answer
 * is capped at `max`.
 */
export function parseSelection(
  text: string,
  catalog: SelectionCatalog,
  max: number,
): ExternalActivation[] {
  const match = /\[[\s\S]*?\]/.exec(text);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const hits: ExternalActivation[] = [];
  const seen = new Set<number>();
  for (const raw of parsed) {
    const index = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (!Number.isInteger(index) || seen.has(index)) continue;
    const hit = catalog.map.get(index);
    if (!hit) continue;
    seen.add(index);
    hits.push(hit);
    if (hits.length >= max) break;
  }
  return hits;
}

/**
 * One call, one turn's worth of picks. Never throws: any failure leaves the turn
 * to the keyword scan, with a warning the preview can show.
 */
export async function selectExternal(
  config: TeahouseConfig,
  entries: ScanEntry[],
  messages: { role: string; content: string }[],
  model: string,
): Promise<{ hits: ExternalActivation[]; warning: Notice | null; ms: number }> {
  if (model === '') {
    return {
      hits: [],
      warning: notice('select.noModel', '模型自选条目已开启，但本会话没有可用模型'),
      ms: 0,
    };
  }

  const max = clamp(Math.round(config.scan.modelSelectMax || 5), MIN_MAX, MAX_MAX);
  const catalog = buildCatalog(entries);
  if (catalog.lines.length === 0) return { hits: [], warning: null, ms: 0 };

  const started = Date.now();
  try {
    const result = await chatOnce(
      {
        ...config,
        model,
        // The selection wants the boring answer, like a translation does.
        temperature: 0.2,
        maxTokens: 128,
        stop: [],
        requestUsage: false,
      },
      [
        { role: 'system', content: selectionPrompt(max) },
        { role: 'user', content: selectionInput(catalog, messages) },
      ],
    );
    const hits = parseSelection(result.text, catalog, max);
    const warning = catalog.truncated
      ? notice('select.tooMany', `模型自选条目：候选过多，只列出了前 ${catalog.lines.length} 条`, { count: catalog.lines.length })
      : null;
    return { hits, warning, ms: Date.now() - started };
  } catch (error) {
    const message = (error as Error).message;
    return {
      hits: [],
      warning: notice('select.failed', `模型自选条目失败，本轮按关键字处理：${message}`, { error: message }),
      ms: Date.now() - started,
    };
  }
}
