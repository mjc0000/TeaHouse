/**
 * Where a portrait wants to be looked at, as a vertical percent for
 * `background-position-y`. No dependencies and no DOM: the caller hands over
 * downscaled RGBA pixels (a 48px-wide canvas is plenty) and gets back where
 * the interesting rows are. The view analyses each sprite once and caches it.
 *
 * The score is deliberately dumb — saturated pixels, pixels far from middle
 * grey, and skin tones; no centre bias, because faces sit at the bottom of a
 * tall portrait as often as anywhere else. A flat image scores everywhere
 * alike and lands back in the middle.
 */

/** Saliency of one pixel, higher means look here. */
function pixelScore(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  const luminance = (r + g + b) / 3 / 255;
  let score = saturation * 2 + Math.abs(luminance - 0.5) * 2;
  if (r > 95 && g > 40 && b > 20 && max - min > 15 && r > g && r > b) score += 1.5;
  return score + 0.3;
}

/**
 * @param {ArrayLike<number>} data RGBA pixels, row-major, `4 * w * h` long
 * @param {number} w width in pixels
 * @param {number} h height in pixels
 * @returns {number} vertical focus, 0 (top) to 100 (bottom)
 */
export function focusFromPixels(data, w, h) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 50;
  let total = 0;
  let weighted = 0;
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      row += pixelScore(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    }
    total += row;
    weighted += (row * (y + 0.5)) / h;
  }
  if (!(total > 0)) return 50;
  return Math.min(100, Math.max(0, Math.round((weighted / total) * 100)));
}

/** A manual nudge in percentage points, clamped to the image. */
export function nudgeFocus(focus, dy) {
  const next = (Number.isFinite(focus) ? focus : 50) + (Number.isFinite(dy) ? dy : 0);
  return Math.min(100, Math.max(0, Math.round(next)));
}
