/**
 * The interface languages the server can emit text in.
 *
 * Mirrors the client's registry (`web/js/locales/`): the client passes its
 * choice as `?lang=`, and the routes that serve *labels* — the world entry field
 * metadata and the provider presets — answer in that language. The default is
 * the source language, so an old client keeps working.
 *
 * Only interface text goes through here. Prompt content (the reply-language
 * instruction, the memory prompt, the story template) is user data and is never
 * localized.
 */

export const INTERFACE_LANGUAGES = ['zh-CN', 'en'] as const;
export type InterfaceLanguage = (typeof INTERFACE_LANGUAGES)[number];

/** One string per interface language; `zh-CN` is the source and the fallback. */
export interface LocalizedText {
  'zh-CN': string;
  en: string;
}

export function localize(text: LocalizedText, lang: InterfaceLanguage): string {
  return text[lang] ?? text['zh-CN'];
}

export function isInterfaceLanguage(value: unknown): value is InterfaceLanguage {
  return typeof value === 'string' && (INTERFACE_LANGUAGES as readonly string[]).includes(value);
}

/** Normalizes a `?lang=` value, falling back to the source language. */
export function requestedLanguage(value: string | null | undefined): InterfaceLanguage {
  return isInterfaceLanguage(value) ? value : 'zh-CN';
}

/**
 * A message the *client* renders in its own language.
 *
 * The server does not translate its warnings and errors; it names them, and
 * carries the source-language sentence as `text` so a code the client does not
 * know still shows something readable. The client looks the code up under
 * `server.<code>` in its dictionary.
 */
export interface Notice {
  code: string;
  /** Values the sentence needs (`{name}` placeholders). */
  params?: Record<string, string | number>;
  /** The source-language wording, used when the client has no translation. */
  text: string;
}

export function notice(code: string, text: string, params?: Record<string, string | number>): Notice {
  return params === undefined ? { code, text } : { code, params, text };
}

