/**
 * Context-overflow detection, and the window size an overflow can reveal.
 *
 * A successful response never says how big the window is — only how many tokens
 * this request used. An *overflow* error usually does say, and a request the
 * provider rejects is free, so an overflow is the one moment the window can be
 * learned without spending anything or guessing.
 *
 * Every provider words it differently, so this is a pattern list, not a parser.
 * The list mirrors pi's `packages/ai/src/utils/overflow.ts`, which tracks the
 * same set of vendors; the DeepSeek wording below was measured against the real
 * API for this project:
 *
 *   "This model's maximum context length is 1048576 tokens. However, you
 *    requested 1093247 tokens (700031 in the messages, 393216 in the
 *    completion). Please reduce the length of the messages or completion."
 *
 * Not every overflow names a number (`"Please reduce the length of the
 * messages"` is all Groq says), and a few providers never error at all (z.ai
 * accepts the overflow silently, Xiaomi MiMo truncates the input). Those keep
 * the warning and skip the learning.
 */

import { normalizeBaseUrl } from '../llm/openai-compat.ts';

/** Errors that mean "the input did not fit", by vendor wording. */
const OVERFLOW_PATTERNS: RegExp[] = [
  /prompt is too long/i, // Anthropic
  /request_too_large/i, // Anthropic (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI
  /exceeds (?:the )?(?:model'?s )?maximum context length/i, // OpenAI / DeepSeek / LiteLLM proxies
  /input token count.*exceeds the maximum/i, // Google Gemini
  /maximum prompt length is [\d,]+/i, // xAI
  /reduce the length of the messages/i, // Groq
  /maximum context length is [\d,]+ tokens/i, // OpenRouter and most backends
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter / Poolside
  /input \([\d,]+ tokens\) is longer than the model'?s context length/i, // Together
  /exceeds the limit of [\d,]+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with [\d,]+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4
  /prompt too long; exceeded (?:max )?context length/i, // Ollama
  /range of input length should be/i, // DashScope / Qwen
  /context[_ ]length[_ ]exceeded/i, // generic
  /too many tokens/i, // generic
  /token limit exceeded/i, // generic
];

/** Same wording as an overflow, but actually a throttling error. */
const NON_OVERFLOW_PATTERNS: RegExp[] = [
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
];

/** The window, in each vendor's wording order. First match wins. */
const WINDOW_PATTERNS: RegExp[] = [
  /maximum context length is ([\d,]+) tokens/i, // DeepSeek, OpenAI, OpenRouter, LiteLLM
  /maximum context length of ([\d,]+) tokens/i, // LiteLLM variants
  /maximum context length \(([\d,]+)\)/i, // OpenAI-compatible proxies
  /maximum prompt length is ([\d,]+)/i, // xAI
  /maximum number of tokens allowed \(([\d,]+)\)/i, // Google
  /model'?s context length \(([\d,]+) tokens\)/i, // Together
  /maximum allowed input length of ([\d,]+) tokens?/i, // OpenRouter / Poolside
  /configured context size is ([\d,]+) tokens?/i, // DS4
  /range of input length should be \[1, ([\d,]+)\]/i, // DashScope / Qwen
  /tokens?\s*>\s*([\d,]+)\s*maximum/i, // Anthropic: "213462 tokens > 200000 maximum"
  /exceeded model token limit: ([\d,]+)/i, // Kimi For Coding
  /exceeds the limit of ([\d,]+)/i, // GitHub Copilot
];

/** How many tokens the provider counted for the request we sent. */
const REQUESTED_PATTERNS: RegExp[] = [
  /([\d,]+) in the messages/i, // DeepSeek
  /your messages resulted in ([\d,]+) tokens/i, // OpenAI
  /the request contains ([\d,]+) tokens/i, // xAI
  /input length \(([\d,]+)\)/i, // OpenAI-compatible proxies
  /input token count \(([\d,]+)\)/i, // Google
  /prompt is too long: ([\d,]+) tokens/i, // Anthropic
  /the input \(([\d,]+) tokens\)/i, // Together
  /prompt has ([\d,]+) tokens/i, // DS4
  /requested ([\d,]+) tokens/i, // generic
];

export interface ContextFailure {
  /** The model's window, when the provider named it. */
  window: number | null;
  /** The provider's own count for the rejected request, when given. */
  requested: number | null;
}

function numberIn(pattern: RegExp, text: string): number | null {
  const match = pattern.exec(text);
  if (match === null) return null;
  const parsed = Number.parseInt(match[1].replace(/[,\s]/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function firstMatch(patterns: RegExp[], text: string): number | null {
  for (const pattern of patterns) {
    const value = numberIn(pattern, text);
    if (value !== null) return value;
  }
  return null;
}

/** True when the text is the provider saying "that was too long". */
export function isContextOverflow(message: string): boolean {
  if (typeof message !== 'string' || message === '') return false;
  if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))) return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The numbers an overflow error carries. Both are optional: many providers say
 * only "too long", and the caller must then keep the warning and move on.
 */
export function parseContextFailure(message: string): ContextFailure {
  return {
    window: firstMatch(WINDOW_PATTERNS, message),
    requested: firstMatch(REQUESTED_PATTERNS, message),
  };
}

/**
 * A stable key for "this model on this endpoint", so a window learned from one
 * chat is reused by every chat. The base URL goes through the same rule the
 * request itself uses, so `https://api.deepseek.com` and `.../v1` are one entry.
 */
export function limitKey(baseUrl: string, model: string): string {
  return `${normalizeBaseUrl(baseUrl ?? '')}#${(model ?? '').trim()}`;
}
