/**
 * Display-side regex: the same rewrite the server applies to requests, but over
 * the shown text and in the browser.
 *
 * DOM-free on purpose: `test:web` runs this module against the server's
 * `regex-rules.ts` on the same inputs and asserts they agree, so the two
 * copies cannot silently drift apart.
 */

function withGlobal(flags) {
  const text = String(flags ?? '');
  return text.includes('g') ? text : `${text}g`;
}

/**
 * Compiled patterns, keyed by flags and pattern.
 *
 * A transcript render applies every display rule to every message, and each
 * application used to compile the same two `RegExp` objects again. Both
 * `String#match` and `String#replace` reset `lastIndex` themselves, so one
 * instance per rule is safe to reuse. Compilation is only cached on success —
 * a bad pattern still throws for the caller to skip.
 */
const compiledPatterns = new Map();

function compiled(pattern, flags) {
  const key = `${flags}\u0000${pattern}`;
  let regex = compiledPatterns.get(key);
  if (regex === undefined) {
    regex = new RegExp(pattern, flags);
    compiledPatterns.set(key, regex);
  }
  return regex;
}

function applyOne(text, rule) {
  // Fresh like the old per-call compile: `lastIndex` is 0 for every use. It
  // matters for a sticky (`y`) rule, which reads it, while `match`/`replace`
  // reset it themselves for the global form.
  const counter = compiled(rule.pattern, withGlobal(rule.flags));
  counter.lastIndex = 0;
  const matches = String(text).match(counter);
  if (!matches) return { text, count: 0 };
  const replacer = compiled(rule.pattern, rule.flags);
  replacer.lastIndex = 0;
  return { text: String(text).replace(replacer, rule.replacement), count: matches.length };
}

/** Rules here are the server's `{ pattern, flags, replacement, scope, enabled }`. */
export function applyDisplayRules(text, rules) {
  const live = (Array.isArray(rules) ? rules : []).filter(
    (rule) => rule && rule.enabled !== false && (rule.scope === 'display' || rule.scope === 'both'),
  );
  let current = String(text ?? '');
  let count = 0;
  for (const rule of live) {
    try {
      const result = applyOne(current, rule);
      current = result.text;
      count += result.count;
    } catch {
      // A rule the server rejected can never be stored; a hand-edited
      // regex.json with a broken one must not blank the transcript.
      continue;
    }
  }
  return { text: current, count };
}
