/**
 * Chat images: seeing pictures through the `deepseek-flash` vision input.
 *
 * The provider reads the format from the file content, not the name — so this
 * module sniffs magic bytes and rejects anything that is not JPEG, PNG, GIF
 * or WebP before it is stored. Files live beside everything else as
 * `data/images/<id>.<ext>` (original bytes, never re-encoded); a message only
 * carries references, which keeps the transcript small and deletable.
 *
 * Sending is base64-inline `image_url` blocks on the newest user message only:
 * history travels as text, because every image burns up to 1024 tokens and
 * re-sending old pictures buys nothing. Anything outside `user` messages is
 * refused by the provider with a 400, so assembly never puts them elsewhere.
 */

export interface ChatImageRef {
  /** File under `data/images/`, e.g. `m3-ab12cd.png`. */
  id: string;
  /** What the uploader called it. */
  name: string;
  mime: string;
  bytes: number;
}

/** 32 MiB: the provider's own per-image ceiling for inline images. */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

const SIGNATURES: { mime: string; ext: string; match: (head: Uint8Array) => boolean }[] = [
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    match: (head) => head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  },
  {
    mime: 'image/png',
    ext: 'png',
    match: (head) =>
      head.length >= 8 &&
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
      head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a,
  },
  {
    mime: 'image/gif',
    ext: 'gif',
    match: (head) =>
      head.length >= 6 &&
      head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38 &&
      (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61,
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    match: (head) =>
      head.length >= 12 &&
      head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50,
  },
];

/** Sniffs the format from the content. Null means "not an image we send". */
export function sniffImage(bytes: Uint8Array): { mime: string; ext: string } | null {
  for (const candidate of SIGNATURES) {
    try {
      if (candidate.match(bytes)) return { mime: candidate.mime, ext: candidate.ext };
    } catch {
      continue;
    }
  }
  return null;
}

export type ImageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** One user message with pictures becomes text-plus-image blocks. */
export function messageWithImages(text: string, images: { mime: string; base64: string }[]): string | ImageContentPart[] {
  if (images.length === 0) return text;
  return [
    { type: 'text', text },
    ...images.map((image) => ({
      type: 'image_url' as const,
      image_url: { url: `data:${image.mime};base64,${image.base64}` },
    })),
  ];
}
