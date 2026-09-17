/**
 * Teahouse icons, generated with nothing but Node's `zlib` — the project
 * ships no third-party content and no image tooling.
 *
 * The mark is the same steaming teacup as `web/logo.svg` and
 * `src-tauri/icons/teahouse.svg`: an amber cup, handle and saucer with two
 * grey steam curls, drawn here as distance-field strokes so even the 16px
 * ICO entry stays legible.
 *
 * Run `node scripts/make-icons.mjs` from `teahouse-desktop/`. To redo the
 * whole set from artwork instead, `cargo tauri icon <file.png>` does it.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, '..', 'src-tauri', 'icons');

const AMBER = [217, 119, 6, 255];
const STONE = [120, 113, 108, 255];
const CLEAR = [0, 0, 0, 0];

/** Design space: the SVG viewBox is 64 units wide; strokes are 3.5 wide. */
const STROKE = 3.5;

/** Sample a cubic bezier into a polyline. */
function cubic(p0, c1, c2, p1, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s = 1 - t;
    pts.push([
      s * s * s * p0[0] + 3 * s * s * t * c1[0] + 3 * s * t * t * c2[0] + t * t * t * p1[0],
      s * s * s * p0[1] + 3 * s * s * t * c1[1] + 3 * s * t * t * c2[1] + t * t * t * p1[1],
    ]);
  }
  return pts;
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Minimum distance to a polyline; closed joins round themselves. */
function distPoly(px, py, pts, closed) {
  let m = Infinity;
  const last = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < last; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const d = distSeg(px, py, a[0], a[1], b[0], b[1]);
    if (d < m) m = d;
  }
  return m;
}

/* The four strokes, in 64-space. */
const CUP = [[17, 27], [47, 27], [43.8, 41.5], [39.9, 44.6], [24.1, 44.6], [20.2, 41.5]];
const HANDLE = cubic([47, 29.5], [52.5, 29.5], [52.5, 38.5], [47, 39], 20);
const SAUCER = [[13, 51.5], [51, 51.5]];
const STEAM1 = cubic([25, 21], [21.5, 17], [28.5, 14.5], [25, 10], 20);
const STEAM2 = cubic([37, 21], [33.5, 17], [40.5, 14.5], [37, 10], 20);

/** Porter-Duff source-over; inputs are 0-255 straight (non-premultiplied). */
function over(fg, fgA, bg) {
  const bgA = bg[3] / 255;
  const a = fgA + bgA * (1 - fgA);
  if (a === 0) return CLEAR;
  const mix = (f, b) => Math.round(((f / 255) * fgA + (b / 255) * bgA * (1 - fgA)) / a * 255);
  return [mix(fg[0], bg[0]), mix(fg[1], bg[1]), mix(fg[2], bg[2]), Math.round(a * 255)];
}

/** One pixel of the mark: coverage of each stroke anti-aliased over ~1px. */
function pixel(x, y, size) {
  const unit = 64 / size; // design units per device pixel
  const px = x * unit;
  const py = y * unit;
  const cover = (d) => Math.max(0, Math.min(1, (STROKE / 2 - d) / unit + 0.5));
  let out = CLEAR;
  out = over(STONE, cover(distPoly(px, py, STEAM1, false)), out);
  out = over(STONE, cover(distPoly(px, py, STEAM2, false)), out);
  out = over(AMBER, cover(distPoly(px, py, CUP, true)), out);
  out = over(AMBER, cover(distPoly(px, py, HANDLE, false)), out);
  out = over(AMBER, cover(distPoly(px, py, SAUCER, false)), out);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA rows made of `pixel` → a real PNG. */
function png(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const at = y * stride + 1 + x * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** One DIB (BITMAPINFOHEADER + BGRA + AND mask) for an ICO entry. */
function dib(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    // ICO rows run bottom-up.
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const at = ((size - 1 - y) * size + x) * 4;
      pixels[at] = b;
      pixels[at + 1] = g;
      pixels[at + 2] = r;
      pixels[at + 3] = a;
    }
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const mask = Buffer.alloc((size * Math.ceil(size / 8) + 3) & ~3);
  return Buffer.concat([header, pixels, mask]);
}

function ico(sizes) {
  const images = sizes.map((size) => dib(size));
  const dir = Buffer.alloc(6 + sizes.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);
  let offset = dir.length;
  sizes.forEach((size, index) => {
    const at = 6 + index * 16;
    dir[at] = size >= 256 ? 0 : size;
    dir[at + 1] = size >= 256 ? 0 : size;
    dir[at + 2] = 0;
    dir[at + 3] = 0;
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(images[index].length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += images[index].length;
  });
  return Buffer.concat([dir, ...images]);
}

mkdirSync(iconsDir, { recursive: true });
for (const size of [32, 128, 256, 512]) {
  writeFileSync(join(iconsDir, `${size}x${size}.png`), png(size));
}
writeFileSync(join(iconsDir, '128x128@2x.png'), png(256));
writeFileSync(join(iconsDir, 'icon.png'), png(512));
writeFileSync(join(iconsDir, 'icon.ico'), ico([16, 32, 48, 256]));
console.log(`icons written to ${iconsDir}`);
