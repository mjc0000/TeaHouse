/**
 * Message translation: showing a message in the preset reply language when it
 * was written in another one (an English greeting under a 中文 preset is the
 * classic case).
 *
 * The model already configured for the chat does the translating — one extra
 * non-streaming call per message, cached on the entry — so there is no second
 * provider to configure and no new dependency. What is stored is a derivative:
 * the transcript keeps the original text, and the translation rides along as
 * `entry.translation`, re-done when the source or the target moves.
 */

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const LATIN_WORD = /[A-Za-z]{2,}/;
const CJK_TARGET = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]|中文|日文|日语|韩文|韩语|chinese|japanese|korean/i;

/** The target language wants CJK characters. */
export function targetIsCjk(target: string): boolean {
  return CJK_TARGET.test(target);
}

/**
 * Whether showing `text` as-is would leave a reader of `target` stranded:
 * Latin words with no CJK under a CJK target, or CJK with no Latin under a
 * Latin target. Empty texts and empty targets never need anything.
 */
export function needsTranslation(text: string, target: string): boolean {
  const want = target.trim();
  if (want === '' || text.trim() === '') return false;
  const hasCjk = CJK.test(text);
  const hasLatin = LATIN_WORD.test(text);
  if (targetIsCjk(want)) return hasLatin && !hasCjk;
  return hasCjk && !hasLatin;
}

export interface TranslationPrompt {
  system: string;
  user: string;
}

/** The one extra call, shaped so the answer is usable verbatim. */
export function buildTranslationPrompt(text: string, target: string): TranslationPrompt {
  return {
    system: `Translate the following roleplay chat message into ${target}. Return only the translation, with nothing added and nothing explained. Keep Markdown markers, names and line breaks exactly where they are.`,
    user: text,
  };
}
