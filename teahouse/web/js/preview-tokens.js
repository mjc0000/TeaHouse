/**
 * Per-row token attribution for the request preview.
 *
 * The server's `totalTokens` is the only authoritative figure; this module only
 * splits it back onto the individual `messages` so the preview rows add up to the
 * same total instead of spreading it evenly. It is pure (no DOM, no state) so
 * both the view and `test:web` can call it.
 *
 * The assembly order is: every enabled, non-empty static/marker block first
 * (dialogue examples included), then the history — plus any depth injections that
 * were merged into it. The itemization already carries a token cost per block,
 * and a per-message cost for the history, so the two halves can be read straight
 * off it:
 *
 *   - the history's `messages` are measured against the *untrimmed* history, so
 *     the first `trimmed` entries are dropped before aligning from the end;
 *   - the blocks before history are matched to messages by content, which stays
 *     correct even though `dialogueExamples` is moved after the other blocks.
 */

/**
 * @param {object|null} preview response of POST /api/prompt/preview
 * @returns {number[]} token cost per `preview.messages` entry, same length
 */
export function attributeTokens(preview) {
  const messages = preview?.messages ?? [];
  const itemization = preview?.itemization ?? [];

  const history = itemization.find((item) => item.kind === 'history');
  const merged = history?.messages ?? [];
  const trimmed = Math.max(0, Number(preview?.trimmed) || 0);
  const surviving = merged.slice(trimmed);
  const preCount = Math.max(0, messages.length - surviving.length);

  // Block tokens are pooled by their (macro-expanded) content, so a message and
  // the block it came from line up whatever order the two lists are in. Duplicate
  // contents share a queue, which is safe because identical text costs the same.
  const pool = new Map();
  for (const item of itemization) {
    if (item.kind !== 'static' && item.kind !== 'marker') continue;
    if (item.enabled === false || item.skippedReason !== undefined) continue;
    if (typeof item.content !== 'string' || item.content === '') continue;
    const tokens = Number(item.tokens) || 0;
    const queue = pool.get(item.content) ?? [];
    queue.push(tokens);
    pool.set(item.content, queue);
  }

  const claimed = new Map();
  const rows = [];
  for (let index = 0; index < messages.length; index++) {
    if (index >= preCount) {
      const entry = surviving[index - preCount];
      rows.push(Number(entry?.tokens) || 0);
      continue;
    }
    const key = messages[index]?.content ?? '';
    const queue = pool.get(key);
    const used = claimed.get(key) ?? 0;
    if (queue && used < queue.length) {
      claimed.set(key, used + 1);
      rows.push(queue[used]);
    } else {
      rows.push(0);
    }
  }
  return rows;
}
