/**
 * Token accounting.
 *
 * Two modes:
 *   exact    - a real `tokenizer.json` is loaded, so counts come from the
 *              model's own vocabulary.
 *   estimate - no tokenizer available; a calibrated heuristic is used and the
 *              UI must label it as an estimate.
 *
 * Either way the provider tells us the truth after each request
 * (`usage.prompt_tokens`), so `calibrate()` folds that observation back in:
 *   - it learns the real per-message chat overhead
 *   - in estimate mode it also learns the text/token ratio
 *   - in exact mode a large divergence means the wrong tokenizer is loaded, and
 *     `stats.divergence` surfaces that instead of silently lying
 */

import { readFileSync } from 'node:fs';

import { HFTokenizer } from './hf-tokenizer.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string;
}

export type CountMode = 'exact' | 'estimate';

export interface TokenStats {
  mode: CountMode;
  /** Multiplier applied to raw text estimates (1 for exact mode). */
  textRatio: number;
  /** Learned chat framing cost per message. */
  perMessageOverhead: number;
  /** Fixed cost of priming the assistant reply. */
  replyPrimer: number;
  /** Observed / local from the last calibration; 1 means perfect agreement. */
  divergence: number;
  calibrations: number;
}

export interface MessageTokens {
  total: number;
  perMessage: number[];
  overhead: number;
  mode: CountMode;
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

/**
 * Heuristic for text without a tokenizer.
 * Latin text runs about 4 characters per token; CJK about 1.5 characters.
 */
export function estimateTextTokens(text: string): number {
  if (text === '') return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk++;
    else other++;
  }
  const tokens = cjk / 1.5 + other / 4;
  return Math.max(1, Math.ceil(tokens));
}

export class TokenCounter {
  private readonly tokenizer: HFTokenizer | null;
  private readonly stats: TokenStats;

  constructor(tokenizer: HFTokenizer | null = null, options: Partial<TokenStats> = {}) {
    this.tokenizer = tokenizer;
    this.stats = {
      mode: tokenizer ? 'exact' : 'estimate',
      textRatio: 1,
      perMessageOverhead: 4,
      replyPrimer: 3,
      divergence: 1,
      calibrations: 0,
      ...options,
    };
  }

  get mode(): CountMode {
    return this.stats.mode;
  }

  get tokenizerName(): string | null {
    return this.tokenizer ? `BPE vocab=${this.tokenizer.vocabSize}` : null;
  }

  getStats(): TokenStats {
    return { ...this.stats };
  }

  count(text: string): number {
    if (this.tokenizer) return this.tokenizer.count(text);
    return Math.max(text === '' ? 0 : 1, Math.ceil(estimateTextTokens(text) * this.stats.textRatio));
  }

  /**
   * Counts a full request body the way chat APIs bill it: every message carries
   * framing tokens, plus a small primer for the reply.
   */
  countMessages(messages: ChatMessage[]): MessageTokens {
    const perMessage = messages.map((message) => this.count(message.content) + (message.name ? 1 : 0));
    const body = perMessage.reduce((sum, value) => sum + value, 0);
    const overhead = this.stats.perMessageOverhead * messages.length + this.stats.replyPrimer;
    return {
      total: body + overhead,
      perMessage,
      overhead,
      mode: this.stats.mode,
    };
  }

  /**
   * Folds a real `usage.prompt_tokens` reading back into the model.
   * In estimate mode this learns both the text ratio and the framing cost.
   * Returns the divergence that was observed before updating.
   */
  calibrate(messages: ChatMessage[], observedPromptTokens: number): number {
    if (!Number.isFinite(observedPromptTokens) || observedPromptTokens <= 0 || messages.length === 0) {
      return this.stats.divergence;
    }

    const local = this.countMessages(messages);
    const observed = observedPromptTokens;
    const divergence = observed / local.total;

    // Text portion vs framing portion.
    const textPortion = local.perMessage.reduce((sum, value) => sum + value, 0);
    const framingPortion = local.total - textPortion;
    const observedFraming = Math.max(0, observed - textPortion * (this.tokenizer ? 1 : this.stats.textRatio));
    const perMessage = Math.max(0, (observedFraming - this.stats.replyPrimer) / messages.length);

    const smoothing = 0.3;
    this.stats.perMessageOverhead = this.stats.perMessageOverhead * (1 - smoothing) + perMessage * smoothing;

    if (!this.tokenizer && textPortion > 0) {
      const targetRatio = Math.max(0.2, (observed - observedFraming) / textPortion);
      this.stats.textRatio = this.stats.textRatio * (1 - smoothing) + targetRatio * smoothing;
    }

    this.stats.divergence = divergence;
    this.stats.calibrations++;
    return divergence;
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const cache = new Map<string, HFTokenizer>();

/** Loads a HuggingFace `tokenizer.json` from disk, caching by absolute path. */
export function loadTokenizer(path: string): HFTokenizer {
  const cached = cache.get(path);
  if (cached) return cached;

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read tokenizer at ${path}: ${(error as Error).message}`);
  }

  const tokenizer = HFTokenizer.fromJSON(json);
  cache.set(path, tokenizer);
  return tokenizer;
}

export function clearTokenizerCache(): void {
  cache.clear();
}
