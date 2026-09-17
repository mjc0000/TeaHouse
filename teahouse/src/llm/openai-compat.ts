/**
 * OpenAI-compatible chat client.
 *
 * One adapter covers DeepSeek, OpenAI, Ollama, LM Studio, vLLM, OpenRouter,
 * SiliconFlow, Moonshot and anything else exposing `/v1/chat/completions`.
 *
 * Usage reporting is requested when the provider supports it, because the token
 * counter calibrates itself from `usage.prompt_tokens`. Providers that reject
 * `stream_options` are retried once without it instead of failing the request.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: string[];
  /** Ask the provider to report token usage on streamed responses. */
  requestUsage?: boolean;
  /**
   * Ask the provider to skip its thinking phase.
   *
   * A reasoning model streams a separate `reasoning_content` channel before any
   * visible text: slower, and with a small `max_tokens` it can eat the whole
   * budget before a single character of the answer is written. Two spellings are
   * sent because providers disagree on which they honour. Measured against
   * api.deepseek.com: both work, and unknown parameters are ignored rather than
   * rejected — but a stricter endpoint could 400, so this stays off by default.
   */
  disableThinking?: boolean;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Plain text, or text-plus-image blocks for a user message with pictures. */
  content: string | ContentPart[];
  /** Speaker name, set for history turns in a group chat. */
  name?: string;
  /** An assistant turn that asked for tools; echoed back on the next round. */
  tool_calls?: LlmToolCallRequest[];
  /** A `role: 'tool'` result, tied to the call it answers. */
  tool_call_id?: string;
}

/** A tool call exactly as the provider wants it sent back. */
export interface LlmToolCallRequest {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** One call the model asked for, flattened out of the provider response. */
export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string, parsed by the caller (arguments shape is the caller's). */
  arguments: string;
}

/** A function the model may call. Only `function` tools are used. */
export interface LlmTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: LlmUsage }
  | { type: 'done'; finishReason: string | null }
  | { type: 'error'; message: string };

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

/**
 * The base URL to hit, with the one convenience rule the field needs: a bare
 * host gets `/v1` appended.
 *
 * A URL that already carries a path is left alone — `/v1`, `/api/paas/v4`,
 * `/v1beta/openai`, `/compatible-mode/v1` are all real bases, and appending
 * `/v1` to them produces a 404. Before this rule the check was "ends with /vN",
 * which mangled Google's OpenAI-compatible path.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '') return DEFAULT_BASE_URL;
  try {
    const url = new URL(trimmed);
    return url.pathname === '' || url.pathname === '/' ? `${trimmed}/v1` : trimmed;
  } catch {
    // No scheme (`localhost:11434`): keep the old ends-with-version heuristic.
    return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  }
}

function headers(config: LlmConfig): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey.trim() !== '') result.Authorization = `Bearer ${config.apiKey.trim()}`;
  return result;
}

function body(config: LlmConfig, messages: LlmMessage[], stream: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: config.model,
    messages,
    stream,
  };
  if (config.temperature !== undefined) payload.temperature = config.temperature;
  if (config.topP !== undefined) payload.top_p = config.topP;
  if (config.maxTokens !== undefined && config.maxTokens > 0) payload.max_tokens = config.maxTokens;
  if (config.presencePenalty !== undefined) payload.presence_penalty = config.presencePenalty;
  if (config.frequencyPenalty !== undefined) payload.frequency_penalty = config.frequencyPenalty;
  if (config.stop && config.stop.length > 0) payload.stop = config.stop;
  if (config.disableThinking === true) {
    // Two spellings of the same request: OpenAI's `reasoning_effort` and the
    // `thinking` object used by several Chinese providers and local runtimes.
    payload.reasoning_effort = 'none';
    payload.thinking = { type: 'disabled' };
  }
  if (stream && config.requestUsage !== false) payload.stream_options = { include_usage: true };
  return payload;
}

/** Flattens `choices[0].message.tool_calls`; anything malformed is dropped. */
function readToolCalls(payload: Record<string, unknown>): LlmToolCall[] {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices[0] == null) return [];
  const message = (choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined;
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: LlmToolCall[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const call = item as Record<string, unknown>;
    const fn = (call.function ?? {}) as Record<string, unknown>;
    const name = typeof fn.name === 'string' ? fn.name : '';
    if (name === '') continue;
    calls.push({
      id: typeof call.id === 'string' && call.id !== '' ? call.id : `call_${calls.length}`,
      name,
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
    });
  }
  return calls;
}

function readUsage(raw: unknown): LlmUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const usage = raw as Record<string, unknown>;
  const prompt = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const completion = Number(usage.completion_tokens ?? usage.completionTokens ?? 0);
  const total = Number(usage.total_tokens ?? usage.totalTokens ?? prompt + completion);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function extractDelta(payload: Record<string, unknown>): { text: string; reasoning: string; finish: string | null } {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { text: '', reasoning: '', finish: null };
  const choice = (choices[0] != null ? choices[0] : {}) as Record<string, unknown>;
  const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
  const text = typeof delta.content === 'string' ? delta.content : '';
  const reasoning =
    typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string'
        ? delta.reasoning
        : '';
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  return { text, reasoning, finish };
}

export interface StreamOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function* streamChat(
  config: LlmConfig,
  messages: LlmMessage[],
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;

  let response = await doFetch(url, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify(body(config, messages, true)),
    signal: options.signal,
  });

  // Some OpenAI-compatible servers reject `stream_options`. Retry once without it.
  if (!response.ok && response.status === 400) {
    const detail = await response.text();
    if (detail.includes('stream_options')) {
      response = await doFetch(url, {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify({ ...body(config, messages, true), stream_options: undefined }),
        signal: options.signal,
      });
    } else {
      yield { type: 'error', message: `provider returned ${response.status}: ${detail.slice(0, 500)}` };
      return;
    }
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    yield { type: 'error', message: `provider returned ${response.status}: ${detail.slice(0, 500)}` };
    return;
  }
  if (!response.body) {
    yield { type: 'error', message: 'provider returned no response body' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; tolerate lone newlines too.
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line === '' || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          yield { type: 'done', finishReason: null };
          return;
        }
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const usage = readUsage(payload.usage);
        if (usage) yield { type: 'usage', usage };
        const { text, reasoning, finish } = extractDelta(payload);
        if (reasoning !== '') yield { type: 'reasoning', text: reasoning };
        if (text !== '') yield { type: 'delta', text };
        if (finish !== null) {
          yield { type: 'done', finishReason: finish };
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: 'done', finishReason: null };
}

/**
 * Text completion (`POST /completions`): the same event shape as the chat
 * stream, but the provider only continues one flat prompt. Frames carry
 * `choices[0].text`; there is no thinking channel and no per-message roles.
 */
export async function* streamCompletion(
  config: LlmConfig,
  prompt: string,
  stop: string[],
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${normalizeBaseUrl(config.baseUrl)}/completions`;
  const payload: Record<string, unknown> = { model: config.model, prompt, stream: true };
  if (config.temperature !== undefined) payload.temperature = config.temperature;
  if (config.topP !== undefined) payload.top_p = config.topP;
  if (config.maxTokens !== undefined && config.maxTokens > 0) payload.max_tokens = config.maxTokens;
  if (stop.length > 0) payload.stop = stop;

  let response = await doFetch(url, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    yield { type: 'error', message: `provider returned ${response.status}: ${detail.slice(0, 500)}` };
    return;
  }
  if (!response.body) {
    yield { type: 'error', message: 'provider returned no response body' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line === '' || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          yield { type: 'done', finishReason: null };
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const usage = readUsage(parsed.usage);
        if (usage) yield { type: 'usage', usage };
        const choices = parsed.choices;
        // An empty choice list (usage-only frames carry `choices: []`) is not
        // an error and not text either — `extractDelta` guards the same way.
        const first = (Array.isArray(choices) && choices[0] != null ? choices[0] : {}) as Record<string, unknown>;
        const text = typeof first.text === 'string' ? first.text : '';
        if (text !== '') yield { type: 'delta', text };
        if (typeof first.finish_reason === 'string' && first.finish_reason !== '') {
          yield { type: 'done', finishReason: first.finish_reason };
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  yield { type: 'done', finishReason: null };
}

export async function chatOnce(
  config: LlmConfig,
  messages: LlmMessage[],
  options: StreamOptions = {},
  ): Promise<{ text: string; usage: LlmUsage | null }> {
    const doFetch = options.fetchImpl ?? fetch;
    // One-shot calls must end: without a signal a stalled provider holds the
    // route (and the client's waiting turn) forever. Streams watch for idle
    // frames instead, so a slow-but-talking model is never cut off.
    const signal = options.signal ?? AbortSignal.timeout(120_000);
    const response = await doFetch(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify(body(config, messages, false)),
      signal,
    });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`provider returned ${response.status}: ${detail.slice(0, 500)}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const { text } = extractDelta(payload);
  return { text, usage: readUsage(payload.usage) };
}

export interface ToolChatResult {
  /** Any prose the model wrote alongside its calls. */
  text: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage | null;
}

/**
 * One non-streaming call that offers tools. Used by the agent read loop: the
 * caller inspects `toolCalls`, answers them, and calls again — so this stays a
 * plain request/response and the streaming path is untouched.
 */
export async function chatWithTools(
  config: LlmConfig,
  messages: LlmMessage[],
  tools: LlmTool[],
  options: StreamOptions = {},
): Promise<ToolChatResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(120_000);
  const response = await doFetch(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify({ ...body(config, messages, false), tools, tool_choice: 'auto' }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`provider returned ${response.status}: ${detail.slice(0, 500)}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const { text } = extractDelta(payload);
  return { text, toolCalls: readToolCalls(payload), usage: readUsage(payload.usage) };
}

/** Lists model ids when the provider exposes `/models`. */
export async function listModels(config: LlmConfig, options: StreamOptions = {}): Promise<string[]> {
    const doFetch = options.fetchImpl ?? fetch;
    const response = await doFetch(`${normalizeBaseUrl(config.baseUrl)}/models`, {
      headers: headers(config),
      signal: options.signal ?? AbortSignal.timeout(120_000),
    });
  if (!response.ok) throw new Error(`provider returned ${response.status}`);
  const payload = (await response.json()) as { data?: { id?: string }[] };
  return (payload.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string')
    .sort();
}
