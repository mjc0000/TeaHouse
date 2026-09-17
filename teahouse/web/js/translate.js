/**
 * Translation helpers for the client.
 *
 * DOM-free: the same detection the server uses, so the transcript decides
 * locally which messages need a translation and only asks for those.
 * `test:web` runs both copies on the same inputs.
 */

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const LATIN_WORD = /[A-Za-z]{2,}/;
const CJK_TARGET = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]|中文|日文|日语|韩文|韩语|chinese|japanese|korean/i;

export function targetIsCjk(target) {
  return CJK_TARGET.test(String(target ?? ''));
}

export function needsTranslation(text, target) {
  const want = String(target ?? '').trim();
  if (want === '' || String(text ?? '').trim() === '') return false;
  const hasCjk = CJK.test(text);
  const hasLatin = LATIN_WORD.test(text);
  if (targetIsCjk(want)) return hasLatin && !hasCjk;
  return hasCjk && !hasLatin;
}

/** A stored translation is fresh for exactly the text and target it was made from. */
export function freshTranslation(entry, text, variant, target) {
  const cached = entry?.translation;
  if (!cached || cached.lang !== target) return null;
  if (cached.ofVariant !== variant) return null;
  if (cached.ofLength !== text.length || cached.ofHead !== text.slice(0, 128)) return null;
  return cached.text;
}

/**
 * Failed translations, remembered per session so a dead endpoint does not get
 * hammered forever: without this every transcript render re-fires a model call
 * for the same message, and each completion reloads the transcript that
 * re-fires it. The key covers the exact text, so editing retries naturally;
 * the message menu's manual retry clears it on purpose.
 */
const failedTranslations = new Set();

/** Identity of one attempt: entry, target and the text it was made from. */
export function translationAttemptKey(entry, text, variant, target) {
  return `${entry?.id ?? ''} ${variant ?? 0} ${String(target ?? '')} ${text.length} ${text.slice(0, 32)}`;
}

export function rememberTranslationFailure(key) {
  failedTranslations.add(key);
}

export function forgetTranslationFailure(entry, target) {
  for (const key of [...failedTranslations]) {
    if (key.startsWith(`${entry?.id ?? ''} `) && key.includes(` ${String(target ?? '')} `)) {
      failedTranslations.delete(key);
    }
  }
}

export function failedTranslation(key) {
  return failedTranslations.has(key);
}
