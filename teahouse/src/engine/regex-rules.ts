/**
 * Regex rules: user-defined find/replace that runs either on what is shown
 * (display side, client) or on what is sent (prompt side, server), or both.
 *
 * Two deliberate limits, both SillyTavern-compatible in spirit:
 *
 *   - Storage is always the original text. Display rewrites never touch the
 *     transcript; prompt rewrites never touch it either — they apply to the
 *     assembled messages only, so the next assembly starts from the same truth.
 *   - Replacement uses native `String.replace` semantics (`$1…$99`, `$&`, `$$`)
 *     because that is zero-dependency and already documented behaviour.
 */

export type RegexScope = 'display' | 'prompt' | 'both';

export interface RegexRule {
  id: string;
  name: string;
  pattern: string;
  flags: string;
  replacement: string;
  scope: RegexScope;
  enabled: boolean;
}

export interface RegexFile {
  version: 1;
  rules: RegexRule[];
}

export const EMPTY_REGEX_FILE: RegexFile = { version: 1, rules: [] };

const SCOPES: RegexScope[] = ['display', 'prompt', 'both'];

/** The flags JavaScript itself accepts on `new RegExp`. */
const VALID_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);

function problemsFor(rule: RegexRule, index: number): string[] {
  const where = rule.name.trim() !== '' ? `「${rule.name}」` : `第 ${index + 1} 条`;
  const problems: string[] = [];
  if (typeof rule.pattern !== 'string' || rule.pattern === '') {
    problems.push(`${where}没有表达式`);
    return problems;
  }
  if (typeof rule.flags !== 'string' || [...rule.flags].some((flag) => !VALID_FLAGS.has(flag))) {
    problems.push(`${where}的标志不合法：${rule.flags}`);
  }
  if (!SCOPES.includes(rule.scope)) problems.push(`${where}的作用域不合法：${String(rule.scope)}`);
  try {
    // eslint-disable-next-line no-new
    new RegExp(rule.pattern, rule.flags);
  } catch (error) {
    problems.push(`${where}不是合法正则：${(error as Error).message}`);
  }
  return problems;
}

function coerceRule(raw: unknown): RegexRule {
  const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof item.id === 'string' ? item.id : '',
    name: typeof item.name === 'string' ? item.name : '',
    pattern: typeof item.pattern === 'string' ? item.pattern : '',
    flags: typeof item.flags === 'string' ? item.flags : '',
    replacement: typeof item.replacement === 'string' ? item.replacement : '',
    scope: item.scope === 'display' || item.scope === 'prompt' || item.scope === 'both'
      ? item.scope
      : 'display',
    enabled: item.enabled !== false,
  };
}

/**
 * Validates a whole file for saving. Invalid rules are rejected with reasons —
 * a rule that cannot compile must never be stored, because the prompt side
 * would then throw in the middle of an assembly.
 */
export function coerceRegexFile(body: unknown): { file: RegexFile; problems: string[] } {
  const root = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const raws = Array.isArray(root.rules) ? root.rules : Array.isArray(body) ? body : [];
  const rules = raws.map(coerceRule);
  const problems: string[] = [];
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    if (rule.id !== '') {
      if (seen.has(rule.id)) problems.push(`有两条规则用了同一个 id：${rule.id}`);
      seen.add(rule.id);
    }
    if (rule.enabled) problems.push(...problemsFor(rule, index));
    else if (rule.pattern !== '') {
      // A disabled rule is still parsed on load, so a typo surfaces the moment
      // it is switched on — but only the compiler check, not the empty-pattern
      // complaint (an unfinished draft may legitimately have no pattern yet).
      try {
        // eslint-disable-next-line no-new
        new RegExp(rule.pattern, rule.flags);
      } catch (error) {
        problems.push(`${rule.name.trim() !== '' ? `「${rule.name}」` : `第 ${index + 1} 条`}不是合法正则：${(error as Error).message}`);
      }
    }
  });
  return { file: { version: 1, rules }, problems };
}

export interface AppliedRegex {
  id: string;
  name: string;
  count: number;
}

function withGlobal(flags: string): string {
  return flags.includes('g') ? flags : `${flags}g`;
}

function applyOne(text: string, rule: RegexRule): { text: string; count: number } {
  const counter = new RegExp(rule.pattern, withGlobal(rule.flags));
  const matches = text.match(counter);
  if (!matches) return { text, count: 0 };
  return { text: text.replace(new RegExp(rule.pattern, rule.flags), rule.replacement), count: matches.length };
}

/**
 * Prompt side: rewrites assembled message contents. Returns new strings; the
 * inputs are never mutated, and the transcript underneath is untouched.
 */
export function applyPromptRegexes(
  contents: string[],
  rules: RegexRule[],
): { contents: string[]; applied: AppliedRegex[] } {
  const live = rules.filter((rule) => rule.enabled && (rule.scope === 'prompt' || rule.scope === 'both'));
  if (live.length === 0) return { contents, applied: [] };
  const applied: AppliedRegex[] = [];
  let current = contents;
  for (const rule of live) {
    let count = 0;
    current = current.map((text) => {
      const result = applyOne(text, rule);
      count += result.count;
      return result.text;
    });
    if (count > 0) applied.push({ id: rule.id, name: rule.name, count });
  }
  return { contents: current, applied };
}

/** Display side: the same rewrite over a single shown text. */
export function applyDisplayRegexes(text: string, rules: RegexRule[]): { text: string; applied: AppliedRegex[] } {
  const live = rules.filter((rule) => rule.enabled && (rule.scope === 'display' || rule.scope === 'both'));
  if (live.length === 0) return { text, applied: [] };
  const applied: AppliedRegex[] = [];
  let current = text;
  for (const rule of live) {
    const result = applyOne(current, rule);
    if (result.count > 0) applied.push({ id: rule.id, name: rule.name, count: result.count });
    current = result.text;
  }
  return { text: current, applied };
}

/** One rule against one sample, for the editor's "试一条" — nothing is stored. */
export function tryRegexRule(
  pattern: string,
  flags: string,
  replacement: string,
  text: string,
): { result: string; count: number } {
  const compiled = new RegExp(pattern, flags);
  const count = (text.match(new RegExp(pattern, withGlobal(flags))) ?? []).length;
  return { result: text.replace(compiled, replacement), count };
}
