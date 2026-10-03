// Perceptual screenshot diff for the smoke baselines.
//
// Each pixel pair is compared by its YIQ distance (the measure pixelmatch
// uses, after Kotsarenko and Ramos, "Measuring perceived color difference
// using YIQ NTSC transmission color space"), so a change a person would see
// counts and a one step shift in a gray does not. A pixel counts as different
// when its distance passes `threshold` (0 to 1 of the largest possible
// distance, scaled like pixelmatch's: 0.1 is its default). Masked rectangles
// (clocks, relative times, anything that moves between two honest runs) are
// left out of both the count and the total. A shot fails when the different
// share of the compared pixels passes `maxRatio`.
//
// The diff image is the baseline faded to light gray, the different pixels
// red, the masked areas a blue wash: the same reading as a pixelmatch output.
import { readPng, writePng } from "../call-e2e/frames.mjs";

const MAX_YIQ = 35215; // the largest YIQ distance between two colors

function yiqDelta(a, i, b, j) {
  // Composite on white, so a transparent pixel reads as the page behind it.
  const blend = (c, alpha) => 255 + ((c - 255) * alpha) / 255;
  const r1 = blend(a[i], a[i + 3]), g1 = blend(a[i + 1], a[i + 3]), b1 = blend(a[i + 2], a[i + 3]);
  const r2 = blend(b[j], b[j + 3]), g2 = blend(b[j + 1], b[j + 3]), b2 = blend(b[j + 2], b[j + 3]);
  const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
  const iq = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
  const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
}

/**
 * Compare two PNG files. `masks` are { x, y, width, height } in image pixels.
 * Returns { ok, ratio, differing, compared, width, height, sizeChanged }, and
 * writes the diff image to `diffPath` when one is given and the shot fails.
 */
export function diffPng(baselinePath, currentPath, { masks = [], threshold = 0.1, maxRatio = 0.002, diffPath } = {}) {
  const A = readPng(baselinePath);
  const B = readPng(currentPath);
  const width = Math.max(A.width, B.width);
  const height = Math.max(A.height, B.height);
  const masked = new Uint8Array(width * height);
  for (const m of masks) {
    for (let y = Math.max(0, Math.floor(m.y)); y < Math.min(height, Math.ceil(m.y + m.height)); y++) {
      masked.fill(1, y * width + Math.max(0, Math.floor(m.x)), y * width + Math.min(width, Math.ceil(m.x + m.width)));
    }
  }
  const limit = MAX_YIQ * threshold * threshold;
  const out = new Uint8Array(width * height * 4);
  let differing = 0;
  let compared = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const o = p * 4;
      const inA = x < A.width && y < A.height;
      const inB = x < B.width && y < B.height;
      const ia = (y * A.width + x) * 4;
      // The faded baseline (or the current shot where the baseline has no pixel).
      const src = inA ? A.data : B.data;
      const si = inA ? ia : (y * B.width + x) * 4;
      const luma = (src[si] * 0.299 + src[si + 1] * 0.587 + src[si + 2] * 0.114) * 0.1 + 255 * 0.9;
      out[o] = out[o + 1] = out[o + 2] = luma;
      out[o + 3] = 255;
      if (masked[p]) {
        out[o] = luma * 0.75;
        out[o + 1] = luma * 0.85;
        continue;
      }
      compared++;
      const same = inA && inB && yiqDelta(A.data, ia, B.data, (y * B.width + x) * 4) <= limit;
      if (!same) {
        differing++;
        out[o] = 230;
        out[o + 1] = 40;
        out[o + 2] = 40;
      }
    }
  }
  const sizeChanged = A.width !== B.width || A.height !== B.height;
  const ratio = compared ? differing / compared : 0;
  const ok = !sizeChanged && ratio <= maxRatio;
  if (!ok && diffPath) writePng(diffPath, out, width, height);
  return { ok, ratio, differing, compared, width, height, sizeChanged, baseline: `${A.width}x${A.height}`, current: `${B.width}x${B.height}` };
}
