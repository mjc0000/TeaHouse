/**
 * HuggingFace `tokenizer.json` reader (BPE).
 *
 * Goal: exact token counts for whatever model the user actually runs, with no
 * dependencies. The provider's own `usage.prompt_tokens` is used to reconcile.
 *
 * Implemented against the real thing (validated with Meta's llama3 tokenizer
 * that ships inside SillyTavern):
 *   - model.type = "BPE", `vocab` + `merges`, honouring `ignore_merges`
 *   - `added_tokens` (special tokens) matched greedily before pretokenization
 *   - normalizers: null / NFC / NFD / NFKC / NFKD / Lowercase / Strip / Replace / Prepend / Sequence
 *   - pre_tokenizers: Sequence / Split(Regex) / ByteLevel / Whitespace / Punctuation / Digits / Metaspace
 *   - decoder: ByteLevel (so encode -> decode round-trips)
 *
 * Node's RegExp supports inline modifier groups (`(?i:...)`), so HF pretokenizer
 * regexes are used verbatim rather than rewritten.
 */

export interface AddedToken {
  id: number;
  content: string;
  lstrip?: boolean;
  rstrip?: boolean;
  special?: boolean;
}

interface NormalizerSpec {
  type: string;
  [key: string]: unknown;
}

interface PreTokenizerSpec {
  type: string;
  [key: string]: unknown;
}

export interface TokenizerJSON {
  added_tokens?: AddedToken[];
  normalizer?: NormalizerSpec | null;
  pre_tokenizer?: PreTokenizerSpec | null;
  decoder?: PreTokenizerSpec | null;
  model: {
    type: string;
    vocab: Record<string, number>;
    merges: string[] | [string, string][];
    unk_token?: string | null;
    byte_fallback?: boolean;
    ignore_merges?: boolean;
    continuing_subword_prefix?: string | null;
    end_of_word_suffix?: string | null;
  };
}

const BYTE_TO_UNICODE = (() => {
  const bytes: number[] = [];
  for (let i = 0x21; i <= 0x7e; i++) bytes.push(i);
  for (let i = 0xa1; i <= 0xac; i++) bytes.push(i);
  for (let i = 0xae; i <= 0xff; i++) bytes.push(i);
  const chars = bytes.slice();
  let extra = 0;
  for (let byte = 0; byte < 256; byte++) {
    if (!bytes.includes(byte)) {
      bytes.push(byte);
      chars.push(256 + extra);
      extra++;
    }
  }
  const forward = new Map<number, string>();
  const reverse = new Map<string, number>();
  for (let i = 0; i < bytes.length; i++) {
    const char = String.fromCodePoint(chars[i]!);
    forward.set(bytes[i]!, char);
    reverse.set(char, bytes[i]!);
  }
  return { forward, reverse };
})();

/** The GPT-2 style pattern used by ByteLevel when `use_regex` is true. */
const BYTE_LEVEL_REGEX =
  /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

/**
 * Exposes the byte<->character table used by ByteLevel BPE, so
 * `scripts/make-fixtures.ts` can build a small self-contained tokenizer fixture.
 * That keeps the tokenizer suite runnable without any third-party file.
 */
export function byteLevelAlphabet(): { forward: Map<number, string>; reverse: Map<string, number> } {
  return { forward: BYTE_TO_UNICODE.forward, reverse: BYTE_TO_UNICODE.reverse };
}

function utf8Bytes(text: string): number[] {
  return Array.from(Buffer.from(text, 'utf8'));
}

export class HFTokenizer {
  readonly vocab: Map<string, number>;
  readonly ranks: Map<string, number>;
  readonly vocabSize: number;
  readonly unkToken: string | null;
  readonly byteFallback: boolean;
  readonly ignoreMerges: boolean;
  readonly warnings: string[] = [];

  private readonly addedTokens: AddedToken[];
  private readonly addedByContent: Map<string, AddedToken>;
  private readonly specialIds: Set<number>;
  private readonly idToToken: Map<number, string>;
  private readonly json: TokenizerJSON;

  constructor(json: TokenizerJSON) {
    if (json.model?.type !== 'BPE') {
      throw new Error(`unsupported tokenizer model type: ${json.model?.type} (only BPE)`);
    }
    this.json = json;
    this.vocab = new Map(Object.entries(json.model.vocab));
    this.vocabSize = this.vocab.size;
    this.unkToken = json.model.unk_token ?? null;
    this.byteFallback = json.model.byte_fallback ?? false;
    this.ignoreMerges = json.model.ignore_merges ?? false;

    this.ranks = new Map();
    for (let i = 0; i < json.model.merges.length; i++) {
      const merge = json.model.merges[i]!;
      const key = Array.isArray(merge) ? `${merge[0]} ${merge[1]}` : merge;
      this.ranks.set(key, i);
    }

    this.addedTokens = [...(json.added_tokens ?? [])].sort((a, b) => b.content.length - a.content.length);
    this.addedByContent = new Map(this.addedTokens.map((token) => [token.content, token]));
    this.specialIds = new Set(this.addedTokens.filter((token) => token.special).map((token) => token.id));

    this.idToToken = new Map();
    for (const [token, id] of this.vocab) this.idToToken.set(id, token);
    for (const token of this.addedTokens) this.idToToken.set(token.id, token.content);
  }

  static fromJSON(json: unknown): HFTokenizer {
    return new HFTokenizer(json as TokenizerJSON);
  }

  // -------------------------------------------------------------------------
  // Encoding
  // -------------------------------------------------------------------------

  encode(text: string): number[] {
    return this.encodeWithSpecials(text).ids;
  }

  /** Encodes and reports which ids came from `added_tokens`. */
  encodeWithSpecials(text: string): { ids: number[]; specials: number[] } {
    const ids: number[] = [];
    const specials: number[] = [];

    for (const chunk of this.splitOnAddedTokens(text)) {
      if (typeof chunk !== 'string') {
        ids.push(chunk.id);
        if (chunk.special) specials.push(chunk.id);
        continue;
      }
      if (chunk === '') continue;
      const normalized = this.normalize(chunk);
      for (const piece of this.preTokenize(normalized)) {
        for (const token of this.bpe(piece)) {
          const id = this.vocab.get(token);
          if (id !== undefined) {
            ids.push(id);
          } else if (this.byteFallback) {
            ids.push(...this.byteFallbackIds(token));
          } else if (this.unkToken !== null && this.vocab.has(this.unkToken)) {
            ids.push(this.vocab.get(this.unkToken)!);
          } else {
            this.warn(`token not in vocab and no fallback: ${JSON.stringify(token)}`);
          }
        }
      }
    }

    return { ids, specials };
  }

  count(text: string): number {
    return this.encode(text).length;
  }

  /** Splits text into plain chunks and added tokens, longest match first. */
  private splitOnAddedTokens(text: string): (string | AddedToken)[] {
    if (this.addedTokens.length === 0) return [text];

    const out: (string | AddedToken)[] = [];
    let buffer = '';
    let index = 0;

    while (index < text.length) {
      let matched: AddedToken | null = null;
      for (const token of this.addedTokens) {
        if (text.startsWith(token.content, index)) {
          matched = token;
          break; // list is sorted by descending length
        }
      }

      if (matched === null) {
        buffer += text[index];
        index++;
        continue;
      }

      if (matched.lstrip) buffer = buffer.replace(/\s+$/, '');
      if (buffer !== '') {
        out.push(buffer);
        buffer = '';
      }
      out.push(matched);
      index += matched.content.length;
      if (matched.rstrip) {
        while (index < text.length && /\s/.test(text[index]!)) index++;
      }
    }

    if (buffer !== '') out.push(buffer);
    return out;
  }

  // -------------------------------------------------------------------------
  // Normalization
  // -------------------------------------------------------------------------

  private normalize(text: string): string {
    return this.applyNormalizer(text, this.json.normalizer ?? null);
  }

  private applyNormalizer(text: string, spec: NormalizerSpec | null): string {
    if (!spec) return text;
    switch (spec.type) {
      case 'NFC':
        return text.normalize('NFC');
      case 'NFD':
        return text.normalize('NFD');
      case 'NFKC':
        return text.normalize('NFKC');
      case 'NFKD':
        return text.normalize('NFKD');
      case 'Lowercase':
        return text.toLowerCase();
      case 'Strip': {
        let out = text;
        if (spec.left !== false) out = out.replace(/^\s+/, '');
        if (spec.right !== false) out = out.replace(/\s+$/, '');
        return out;
      }
      case 'Prepend': {
        const prepend = typeof spec.prepend === 'string' ? spec.prepend : '';
        return prepend + text;
      }
      case 'Replace': {
        const pattern = spec.pattern as { String?: string; Regex?: string } | undefined;
        const content = typeof spec.content === 'string' ? spec.content : '';
        if (pattern?.String !== undefined) {
          return text.split(pattern.String).join(content);
        }
        if (pattern?.Regex !== undefined) {
          try {
            return text.replace(new RegExp(pattern.Regex, 'gu'), content);
          } catch {
            this.warn(`unsupported Replace regex: ${pattern.Regex}`);
            return text;
          }
        }
        return text;
      }
      case 'Sequence': {
        const list = (spec.normalizers as NormalizerSpec[] | undefined) ?? [];
        return list.reduce((acc, item) => this.applyNormalizer(acc, item), text);
      }
      default:
        this.warn(`unsupported normalizer type: ${spec.type}`);
        return text;
    }
  }

  // -------------------------------------------------------------------------
  // Pre-tokenization
  // -------------------------------------------------------------------------

  private preTokenize(text: string): string[] {
    return this.applyPreTokenizer(text, this.json.pre_tokenizer ?? null);
  }

  private applyPreTokenizer(text: string, spec: PreTokenizerSpec | null): string[] {
    if (!spec || text === '') return text === '' ? [] : [text];

    switch (spec.type) {
      case 'Sequence': {
        let pieces = [text];
        for (const item of (spec.pretokenizers as PreTokenizerSpec[] | undefined) ?? []) {
          const next: string[] = [];
          for (const piece of pieces) next.push(...this.applyPreTokenizer(piece, item));
          pieces = next;
        }
        return pieces;
      }
      case 'Split': {
        const pattern = spec.pattern as { Regex?: string; String?: string } | undefined;
        const behavior = typeof spec.behavior === 'string' ? spec.behavior : 'Isolated';
        const invert = spec.invert === true;
        if (pattern?.String !== undefined) {
          const parts = text.split(pattern.String);
          return invert ? [text] : parts;
        }
        if (pattern?.Regex === undefined) return [text];
        let regex: RegExp;
        try {
          regex = new RegExp(pattern.Regex, 'gu');
        } catch (error) {
          this.warn(`unsupported Split regex (${(error as Error).message}): ${pattern.Regex}`);
          return [text];
        }
        regex.lastIndex = 0;
        if (behavior === 'Isolated') {
          const matches = text.match(regex) ?? [];
          return invert ? this.invertMatches(text, regex) : matches;
        }
        // Removed / MergedWithNext / Contiguous behave like a plain split.
        return text.split(regex).filter((part) => part !== '');
      }
      case 'ByteLevel': {
        const useRegex = spec.use_regex === true;
        const chunks = useRegex ? (text.match(BYTE_LEVEL_REGEX) ?? [text]) : [text];
        return chunks.map((chunk) => this.bytesToUnicode(chunk));
      }
      case 'Whitespace': {
        const prependScheme = spec.prepend_scheme;
        const withSpace = prependScheme === 'always' ? ` ${text}` : text;
        return withSpace.split(/\w+|\S+/).filter((piece) => piece !== '');
      }
      case 'Punctuation': {
        const behavior = typeof spec.behavior === 'string' ? spec.behavior : 'Isolated';
        if (behavior !== 'Isolated') return [text];
        return text.match(/\p{P}+|[^\p{P}]+/gu) ?? [text];
      }
      case 'Digits': {
        const individual = spec.individual_digits === true;
        return text.match(individual ? /\p{N}|[^\p{N}]+/gu : /\p{N}+|[^\p{N}]+/gu) ?? [text];
      }
      case 'Metaspace': {
        const replacement = typeof spec.replacement === 'string' ? spec.replacement : '\u2581';
        const prepend = spec.prepend_scheme === 'always' || spec.add_prefix_space === true;
        const replaced = text.replace(/ /g, replacement);
        return [prepend && !replaced.startsWith(replacement) ? replacement + replaced : replaced];
      }
      default:
        this.warn(`unsupported pre_tokenizer type: ${spec.type}`);
        return [text];
    }
  }

  private invertMatches(text: string, regex: RegExp): string[] {
    const out: string[] = [];
    let last = 0;
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > last) out.push(text.slice(last, match.index));
      last = match.index + match[0].length;
      if (match[0].length === 0) regex.lastIndex++;
    }
    if (last < text.length) out.push(text.slice(last));
    return out.filter((piece) => piece !== '');
  }

  private bytesToUnicode(text: string): string {
    let out = '';
    for (const byte of utf8Bytes(text)) out += BYTE_TO_UNICODE.forward.get(byte)!;
    return out;
  }

  // -------------------------------------------------------------------------
  // BPE
  // -------------------------------------------------------------------------

  private bpe(token: string): string[] {
    if (this.ignoreMerges && this.vocab.has(token)) return [token];

    let symbols = Array.from(token);
    if (symbols.length === 0) return [];

    while (symbols.length > 1) {
      let bestRank = Number.POSITIVE_INFINITY;
      let bestIndex = -1;

      for (let i = 0; i < symbols.length - 1; i++) {
        const rank = this.ranks.get(`${symbols[i]} ${symbols[i + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestIndex = i;
        }
      }

      if (bestIndex === -1) break;
      symbols = [
        ...symbols.slice(0, bestIndex),
        symbols[bestIndex]! + symbols[bestIndex + 1]!,
        ...symbols.slice(bestIndex + 2),
      ];
    }

    return symbols;
  }

  private byteFallbackIds(token: string): number[] {
    const ids: number[] = [];
    for (const char of token) {
      const byte = BYTE_TO_UNICODE.reverse.get(char);
      if (byte === undefined) continue;
      const key = `<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`;
      const id = this.vocab.get(key);
      if (id !== undefined) ids.push(id);
      else this.warn(`byte fallback token missing: ${key}`);
    }
    return ids;
  }

  // -------------------------------------------------------------------------
  // Decoding
  // -------------------------------------------------------------------------

  decode(ids: number[], options: { skipSpecialTokens?: boolean } = {}): string {
    const skipSpecial = options.skipSpecialTokens ?? true;
    const bytes: number[] = [];
    const parts: string[] = [];

    const flush = () => {
      if (bytes.length > 0) {
        parts.push(Buffer.from(bytes).toString('utf8'));
        bytes.length = 0;
      }
    };

    for (const id of ids) {
      if (skipSpecial && this.specialIds.has(id)) continue;
      const token = this.idToToken.get(id);
      if (token === undefined) continue;

      const added = this.addedByContent.get(token);
      if (added !== undefined) {
        flush();
        parts.push(added.content);
        continue;
      }

      for (const char of token) {
        const byte = BYTE_TO_UNICODE.reverse.get(char);
        if (byte === undefined) {
          // Not a byte-level token (e.g. a word-level vocab); emit as text.
          flush();
          parts.push(char);
        } else {
          bytes.push(byte);
        }
      }
    }

    flush();
    return parts.join('');
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }
}
