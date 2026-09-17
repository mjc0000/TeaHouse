/**
 * Embedding client: one OpenAI-compatible request shape for both interfaces.
 *
 * A remote service (OpenAI, SiliconFlow, …) and a local one (Ollama, LM Studio,
 * llama.cpp, vLLM) differ only in address, key and model — all of them answer
 * `POST {base}/embeddings` with `{ model, input: [...] }`. So this is one client
 * and two sets of settings, rather than two code paths.
 *
 * Zero dependencies, so "local" means a server already running on this machine;
 * the model itself is never bundled.
 */

import { normalizeBaseUrl } from './openai-compat.ts';

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Texts per request. Servers accept batches; too large a batch gets rejected. */
  batchSize?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dims: number;
  /** How many HTTP requests it took, for the "why was indexing slow" question. */
  requests: number;
  /** Batches that had to be retried one text at a time. */
  singles: number;
}

export interface EmbedOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const DEFAULT_BATCH = 64;
const DEFAULT_TIMEOUT_MS = 60_000;

function headers(config: EmbeddingConfig): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json' };
  if ((config.apiKey ?? '').trim() !== '') {
    result.Authorization = `Bearer ${(config.apiKey ?? '').trim()}`;
  }
  return result;
}

/** Pulls `data[].embedding` out of either shape a server may answer with. */
function readVectors(payload: unknown, expected: number): number[][] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as Record<string, unknown>;
  const data = raw.data;
  if (Array.isArray(data)) {
    const vectors: number[][] = [];
    for (const item of data) {
      const embedding =
        typeof item === 'object' && item !== null
          ? ((item as Record<string, unknown>).embedding as unknown)
          : null;
      if (!Array.isArray(embedding)) return null;
      vectors.push(embedding.map((value) => Number(value)));
    }
    if (vectors.length === expected) return vectors;
    // Some servers answer with a different count; that is worse than a clear
    // failure, because the vectors would be silently mismatched with the texts.
    return null;
  }
  // Ollama's native shape, for the (still supported) non-OpenAI endpoint.
  if (Array.isArray(raw.embedding)) return [(raw.embedding as unknown[]).map((value) => Number(value))];
  return null;
}

async function requestBatch(
  config: EmbeddingConfig,
  texts: string[],
  options: EmbedOptions,
): Promise<{ vectors: number[][]; model: string }> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${normalizeBaseUrl(config.baseUrl)}/embeddings`;
  const timeout = AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await doFetch(url, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify({ model: config.model, input: texts.length === 1 ? texts[0] : texts }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(describeFailure(response.status, detail));
  }
  const payload = (await response.json()) as unknown;
  const vectors = readVectors(payload, texts.length);
  if (vectors === null) throw new Error('embedding endpoint answered with an unexpected shape');
  const model =
    typeof (payload as Record<string, unknown>).model === 'string'
      ? ((payload as Record<string, unknown>).model as string)
      : config.model;
  return { vectors, model };
}

/**
 * Turns a provider failure into something a user can act on. A 404 here is the
 * common one: the chat provider is not an embedding provider, which is exactly
 * why the two are configured separately.
 */
function describeFailure(status: number, detail: string): string {
  const trimmed = detail.trim().slice(0, 300);
  if (status === 404) {
    return `这个地址没有 /embeddings 接口（HTTP 404）。向量服务需要单独配置：本机跑一个（Ollama 等）或换一个带 embedding 的远程服务${trimmed ? `：${trimmed}` : ''}`;
  }
  if (status === 401 || status === 403) {
    return `向量服务拒绝了这次请求（HTTP ${status}），检查它的 Key${trimmed ? `：${trimmed}` : ''}`;
  }
  return `向量服务返回 HTTP ${status}${trimmed ? `：${trimmed}` : ''}`;
}

/**
 * Embeds `texts`, in batches. A batch rejected with a 4xx is retried one text at
 * a time, because a few OpenAI-compatible servers accept only a single string —
 * that costs more requests but turns "this endpoint refuses arrays" from a dead
 * feature into a slower one.
 */
export async function embedTexts(
  config: EmbeddingConfig,
  texts: string[],
  options: EmbedOptions = {},
): Promise<EmbeddingResult> {
  if (texts.length === 0) {
    return { vectors: [], model: config.model, dims: 0, requests: 0, singles: 0 };
  }
  const batchSize = Math.max(1, Math.min(256, config.batchSize ?? DEFAULT_BATCH));
  const vectors: number[][] = [];
  let requests = 0;
  let singles = 0;
  let model = config.model;

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    try {
      requests++;
      const answer = await requestBatch(config, batch, options);
      model = answer.model;
      vectors.push(...answer.vectors);
    } catch (error) {
      const message = (error as Error).message;
      const isClientError = /HTTP 4\d\d/.test(message);
      if (!isClientError || batch.length === 1) throw error;
      for (const text of batch) {
        requests++;
        singles++;
        const answer = await requestBatch(config, [text], options);
        model = answer.model;
        vectors.push(...answer.vectors);
      }
    }
  }

  const dims = vectors[0]?.length ?? 0;
  const ragged = vectors.find((vector) => vector.length !== dims);
  if (ragged) throw new Error(`向量服务返回了不一致的维度（${dims} 与 ${ragged.length}）`);
  return { vectors, model, dims, requests, singles };
}

/** One tiny text, for the settings dialog's "test connection". */
export async function probeEmbeddings(
  config: EmbeddingConfig,
  options: EmbedOptions = {},
): Promise<{ ok: boolean; model: string; dims: number; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const result = await embedTexts(config, ['ping'], { ...options, });
    return {
      ok: result.dims > 0,
      model: result.model,
      dims: result.dims,
      ms: Date.now() - started,
      ...(result.dims > 0 ? {} : { error: '服务返回了空向量' }),
    };
  } catch (error) {
    return { ok: false, model: config.model, dims: 0, ms: Date.now() - started, error: (error as Error).message };
  }
}
