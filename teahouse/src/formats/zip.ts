/**
 * Minimal ZIP reader, for skill packages.
 *
 * Skills are shipped as folders or as a zip of that folder, so the importer has
 * to look inside one. Node ships `zlib`, so only the container has to be parsed
 * by hand — the same trade as `png-text.ts` (no third-party content, no build).
 *
 * Deliberately small: central-directory entries with STORE or DEFLATE only.
 * Zip64, encryption and the rarer compression methods are refused with a clear
 * message rather than guessed at, and entries are capped so a hostile archive
 * cannot exhaust memory.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** One decompressed entry. */
export interface ZipEntry {
  /** Path inside the archive, always with forward slashes. */
  name: string;
  bytes: Buffer;
}

const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export function isZip(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

/** Reads every file entry; directories are skipped (their names end with `/`). */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === -1) throw new Error('not a zip file (no end-of-central-directory record)');
  if (findZip64Locator(buffer, eocd) !== -1) throw new Error('zip64 archives are not supported');

  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset === 0xffffffff || count === 0xffff) {
    throw new Error('zip64 archives are not supported');
  }

  const entries: ZipEntry[] = [];
  let total = 0;
  let cursor = centralOffset;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('zip central directory is truncated or corrupt');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if ((flags & 0x0001) !== 0) throw new Error(`zip entry "${name}" is encrypted`);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('zip64 archives are not supported');
    }
    if (name.endsWith('/')) continue;

    const bytes = readEntry(buffer, localOffset, compressedSize, method, name);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('zip is too large to import');
    entries.push({ name, bytes });
  }
  return entries;
}

/**
 * Reads one entry by exact name and inflates only that one. `null` for anything
 * missing, encrypted or unsupported — the agent read loop treats that as "no
 * such file", never as an error worth failing a turn over.
 */
export function readZipEntry(buffer: Buffer, name: string): Buffer | null {
  if (!isZip(buffer)) return null;
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === -1) return null;
  if (findZip64Locator(buffer, eocd) !== -1) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset === 0xffffffff || count === 0xffff) return null;

  let cursor = centralOffset;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return null;
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryName = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (entryName !== name) continue;
    if ((flags & 0x0001) !== 0 || entryName.endsWith('/')) return null;
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) return null;
    return readEntry(buffer, localOffset, compressedSize, method, entryName);
  }
  return null;
}

function readEntry(
  buffer: Buffer,
  localOffset: number,
  compressedSize: number,
  method: number,
  name: string,
): Buffer {
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw new Error(`zip entry "${name}" has a bad local header`);
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + compressedSize;
  if (end > buffer.length) throw new Error(`zip entry "${name}" runs past the end of the file`);
  const raw = buffer.subarray(start, end);

  if (method === METHOD_STORE) {
    if (raw.length > MAX_ENTRY_BYTES) throw new Error(`zip entry "${name}" is too large`);
    return Buffer.from(raw);
  }
  if (method !== METHOD_DEFLATE) {
    throw new Error(`zip entry "${name}" uses compression method ${method}, which is not supported`);
  }
  const inflated = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
  return inflated;
}

/** Scans backwards for the EOCD record; the comment can be up to 64 KiB. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= earliest; at--) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  }
  return -1;
}

function findZip64Locator(buffer: Buffer, eocd: number): number {
  const at = eocd - 20;
  return at >= 0 && buffer.readUInt32LE(at) === ZIP64_LOCATOR_SIGNATURE ? at : -1;
}
