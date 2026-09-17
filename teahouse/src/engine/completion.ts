/**
 * Text-completion backend: flattening the assembled prompt into one plain
 * text the `/completions` family continues.
 *
 * The assembly (world scan, template, regex, macros, trim) is untouched — it
 * still produces `messages[]`. Flattening only changes the last mile: every
 * message becomes lines, speakers become `Name:` prefixes, and the prompt ends
 * with an open `Char:` the model completes. Stop strings close the other side:
 * the model must halt before it ventriloquises the next speaker.
 */

import type { ChatMessage } from './tokens.ts';

export interface FlattenedPrompt {
  prompt: string;
  stop: string[];
}

/**
 * Flattens assembled messages. `replyName` is who answers (the trailing open
 * line); `extraStop` is the configured stop list, kept first and verbatim.
 */
export function buildCompletionPrompt(
  messages: ChatMessage[],
  replyName: string,
  userName: string,
  extraStop: string[],
): FlattenedPrompt {
  const lines: string[] = [];
  for (const message of messages) {
    const text = message.content.trim();
    if (text === '') continue;
    // Group turns already carry their speaker; solo turns fall back to the
    // two names the caller passes.
    const who = typeof message.name === 'string' && message.name !== ''
      ? message.name
      : message.role === 'user' ? userName : replyName;
    if (message.role === 'system') lines.push(text);
    else lines.push(`${who}: ${text}`);
  }
  lines.push(`${replyName}:`);

  const stop = [...extraStop];
  for (const name of [userName, replyName]) {
    const marker = `\n${name}:`;
    if (name.trim() !== '' && !name.includes('\n') && !stop.includes(marker)) stop.push(marker);
  }
  return { prompt: `${lines.join('\n')}\n`, stop };
}
