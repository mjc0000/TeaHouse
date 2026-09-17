/**
 * Key syntax: splitting a key list, and telling a regex key from a plain one.
 *
 * This is format-level knowledge (it is about how keys are written), kept
 * separate from matching, which lives in the scanner.
 *
 * Why it is not `text.split(',')`: a key may be a slash-delimited regex, and a
 * regex may contain commas — `/a{1,2}/` is one key, not two. SillyTavern has a
 * dedicated tokenizer for this for the same reason.
 */

/**
 * ST's `parseRegexFromString`: a key is a regex when it is slash-delimited,
 * contains no unescaped delimiter of its own, and compiles.
 */
export function parseRegexFromString(input: string): RegExp | null {
  const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
  if (!match) return null;
  let [, pattern, flags] = match;
  if (pattern === undefined) return null;
  if (/(^|[^\\])\//.test(pattern)) return null;
  pattern = pattern.replace('\\/', '/');
  try {
    return new RegExp(pattern, flags ?? '');
  } catch {
    return null;
  }
}

export function isRegexKey(input: string): boolean {
  return parseRegexFromString(input) !== null;
}

/**
 * Splits one or more keys separated by commas, while a comma inside a
 * slash-delimited regex does not separate.
 *
 * A chunk that turns out not to be a valid regex is split on its commas again,
 * so a stray slash cannot swallow the rest of the list.
 */
export function splitKeyList(input: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let insideRegex = false;
  let regexClosed = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;

    if (char === '\\' && insideRegex) {
      current += char + (input[i + 1] ?? '');
      i++;
      continue;
    }

    if (char === '/') {
      if (!insideRegex) {
        insideRegex = true;
        regexClosed = false;
      } else if (!regexClosed) {
        regexClosed = true;
      }
      current += char;
      continue;
    }

    if (char === ',' && (!insideRegex || regexClosed)) {
      chunks.push(current);
      current = '';
      insideRegex = false;
      regexClosed = false;
      continue;
    }

    current += char;
  }
  chunks.push(current);

  const out: string[] = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (trimmed === '') continue;
    if (isRegexKey(trimmed)) {
      out.push(trimmed);
      continue;
    }
    for (const piece of trimmed.split(',')) {
      const key = piece.trim();
      if (key !== '') out.push(key);
    }
  }
  return out;
}
