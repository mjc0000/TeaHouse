/**
 * Zero-dependency PNG text-chunk reader/writer.
 *
 * Only what character cards need:
 *  - read tEXt (uncompressed Latin-1) and iTXt (uncompressed UTF-8)
 *  - write or replace a tEXt chunk before IEND
 *
 * PNG layout: 8-byte signature, then chunks of
 *   [4-byte big-endian length][4-byte type][data][4-byte CRC32 of type+data]
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface PngChunk {
  type: string;
  data: Buffer;
}

export function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

/** Throws if the buffer is not a well-formed PNG. */
export function readChunks(buf: Buffer): PngChunk[] {
  if (!isPng(buf)) throw new Error('not a PNG (bad signature)');
  const chunks: PngChunk[] = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) throw new Error(`truncated PNG chunk ${type}`);
    chunks.push({ type, data: buf.subarray(dataStart, dataEnd) });
    off = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

export function writeChunks(chunks: PngChunk[]): Buffer {
  const parts: Buffer[] = [SIGNATURE];
  for (const chunk of chunks) {
    const typeBuf = Buffer.from(chunk.type, 'latin1');
    const body = Buffer.concat([typeBuf, chunk.data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(chunk.data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    parts.push(head, body, crc);
  }
  return Buffer.concat(parts);
}

export interface TextChunk {
  keyword: string;
  text: string;
  /** Which chunk type it came from. */
  kind: 'tEXt' | 'iTXt';
}

function readTextChunkData(kind: string, data: Buffer): TextChunk | null {
  const sep = data.indexOf(0);
  if (sep < 1) return null;
  const keyword = data.toString('latin1', 0, sep);

  if (kind === 'tEXt') {
    return { keyword, text: data.toString('latin1', sep + 1), kind: 'tEXt' };
  }

  // iTXt: keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text
  const compressionFlag = data[sep + 1];
  if (compressionFlag !== 0) return null; // compressed iTXt is not supported
  let cursor = sep + 3;
  const langEnd = data.indexOf(0, cursor);
  if (langEnd < 0) return null;
  cursor = langEnd + 1;
  const translatedEnd = data.indexOf(0, cursor);
  if (translatedEnd < 0) return null;
  const text = data.toString('utf8', translatedEnd + 1);
  return { keyword, text, kind: 'iTXt' };
}

export function readTextChunks(buf: Buffer): TextChunk[] {
  const out: TextChunk[] = [];
  for (const chunk of readChunks(buf)) {
    if (chunk.type !== 'tEXt' && chunk.type !== 'iTXt') continue;
    const parsed = readTextChunkData(chunk.type, chunk.data);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Case-insensitive keyword lookup. */
export function getTextChunk(buf: Buffer, keyword: string): string | null {
  const wanted = keyword.toLowerCase();
  for (const chunk of readTextChunks(buf)) {
    if (chunk.keyword.toLowerCase() === wanted) return chunk.text;
  }
  return null;
}

/** Encoding of a tEXt payload: keyword \0 text. */
export function encodeTextChunkData(keyword: string, text: string): Buffer {
  const kw = Buffer.from(keyword, 'latin1');
  if (kw.length < 1 || kw.length > 79) throw new Error(`invalid tEXt keyword length: ${kw.length}`);
  return Buffer.concat([kw, Buffer.from([0]), Buffer.from(text, 'latin1')]);
}

/**
 * Replaces every tEXt chunk with the given keyword and inserts the new one
 * immediately before IEND (where SillyTavern and other tools expect it).
 */
export function writeTextChunk(buf: Buffer, keyword: string, text: string): Buffer {
  const wanted = keyword.toLowerCase();
  const chunks = readChunks(buf).filter((chunk) => {
    if (chunk.type !== 'tEXt') return true;
    const parsed = readTextChunkData('tEXt', chunk.data);
    return !parsed || parsed.keyword.toLowerCase() !== wanted;
  });

  const iendIndex = chunks.findIndex((chunk) => chunk.type === 'IEND');
  const insertAt = iendIndex === -1 ? chunks.length : iendIndex;
  chunks.splice(insertAt, 0, { type: 'tEXt', data: encodeTextChunkData(keyword, text) });
  return writeChunks(chunks);
}

/** Replaces all listed keywords at once, preserving everything else. */
export function writeTextChunks(buf: Buffer, items: { keyword: string; text: string }[]): Buffer {
  let out = buf;
  for (const item of items) out = writeTextChunk(out, item.keyword, item.text);
  return out;
}
