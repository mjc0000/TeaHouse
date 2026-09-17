/**
 * Reply-language instruction.
 *
 * The authoritative rendering happens on the server, at assembly time, so the
 * prompt that is sent is built there. This module exists so the settings dialog
 * can show the exact line *before* it is used — and `test:web` asserts the two
 * implementations agree, so the preview cannot drift from the real prompt.
 */

/**
 * Kept byte-identical to `DEFAULT_LANGUAGE_INSTRUCTION` in
 * src/engine/prompt-stack.ts. The server sends its own copy with the stack, so
 * this is only a fallback when that has not arrived yet.
 */
export const FALLBACK_LANGUAGE_INSTRUCTION =
  'Always write your replies in {{language}}, including narration, dialogue and stage directions. Do not switch to another language even if the user writes in one.';

/**
 * @param {object} settings
 * @param {string} [settings.outputLanguage]
 * @param {string} [settings.languageInstruction]
 * @param {string} [settings.defaultInstruction] the server's default wording
 * @returns {string} the instruction line, or '' when no language is configured
 */
export function renderLanguageInstruction(settings = {}) {
  const language = String(settings.outputLanguage ?? '').trim();
  if (language === '') return '';
  const template =
    String(settings.languageInstruction ?? '').trim() ||
    String(settings.defaultInstruction ?? '').trim() ||
    FALLBACK_LANGUAGE_INSTRUCTION;
  return template.replaceAll('{{language}}', language);
}
