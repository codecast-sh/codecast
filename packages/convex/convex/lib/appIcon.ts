// The generated icon of an installed app whose page declares none
// (docs/architecture/installed-apps.md): the page title's initial, white, on
// a rounded tile in an accent picked from the slug. Drawn without a renderer
// or a font, in Convex's default runtime: the letters are stroke paths, and
// coverage and PNG encoding are lib/roleIconRaster's.

import { flattenRoleIconPath } from "@codecast/shared/contracts/roleIcon";
import { ACCENT_RGB, coverage, encodePng } from "./roleIconRaster";

/** Capitals and digits as strokes on a 6 x 10 box, y down. */
const GLYPHS: Record<string, string> = {
  A: "M0 10L3 0L6 10M1.1 6.5H4.9",
  B: "M0 0H3.6A2.4 2.4 0 0 1 3.6 4.8H0ZM0 4.8H3.8A2.6 2.6 0 0 1 3.8 10H0Z",
  C: "M6 1.8A3.4 5 0 1 0 6 8.2",
  D: "M0 0H2.5A3.5 5 0 0 1 2.5 10H0Z",
  E: "M6 0H0V10H6M0 5H4.5",
  F: "M6 0H0V10M0 5H4.5",
  G: "M6 1.8A3.4 5 0 1 0 6 8.2V5.5H3.5",
  H: "M0 0V10M6 0V10M0 5H6",
  I: "M3 0V10M1 0H5M1 10H5",
  J: "M5 0V7A2.5 3 0 0 1 0 7",
  K: "M0 0V10M6 0L0 6.5M2 4.6L6 10",
  L: "M0 0V10H6",
  M: "M0 10V0L3 6L6 0V10",
  N: "M0 10V0L6 10V0",
  O: "M3 0A3 5 0 0 0 3 10A3 5 0 0 0 3 0",
  P: "M0 10V0H3.5A2.5 2.6 0 0 1 3.5 5.2H0",
  Q: "M3 0A3 5 0 0 0 3 10A3 5 0 0 0 3 0M3.6 7L6 10.4",
  R: "M0 10V0H3.5A2.5 2.6 0 0 1 3.5 5.2H0M3 5.2L6 10",
  S: "M5.6 1.6A2.8 2.5 0 1 0 3 5A2.9 2.5 0 1 1 0.4 8.4",
  T: "M0 0H6M3 0V10",
  U: "M0 0V6.5A3 3.5 0 0 0 6 6.5V0",
  V: "M0 0L3 10L6 0",
  W: "M0 0L1.5 10L3 3.5L4.5 10L6 0",
  X: "M0 0L6 10M6 0L0 10",
  Y: "M0 0L3 5L6 0M3 5V10",
  Z: "M0 0H6L0 10H6",
  "0": "M3 0A2.6 5 0 0 0 3 10A2.6 5 0 0 0 3 0",
  "1": "M1.2 2L3.4 0V10M1 10H5.8",
  "2": "M0.4 2.4A2.8 2.6 0 0 1 5.6 2.6C5.6 5 0 7 0 10H6",
  "3": "M0.4 1.4A2.9 2.5 0 1 1 3 5A2.9 2.5 0 1 1 0.4 8.6",
  "4": "M4.5 10V0L0 7H6",
  "5": "M5.6 0H0.8L0.4 4.4A3 2.9 0 1 1 0.4 9",
  "6": "M5.2 0.4C2 0.8 0 3.6 0 6.8M3 3.8A3 3.1 0 0 1 3 10A3 3.1 0 0 1 3 3.8",
  "7": "M0 0H6L2 10",
  "8": "M3 0A2.6 2.4 0 0 0 3 4.8A2.6 2.4 0 0 0 3 0M3 4.8A3 2.6 0 0 0 3 10A3 2.6 0 0 0 3 4.8",
  "9": "M3 6.2A3 3.1 0 0 1 3 0A3 3.1 0 0 1 3 6.2M6 3.2C6 6.4 4 9.2 0.8 9.6",
};

/** The character the tile shows: the title's first letter or digit (accents dropped), else the slug's. */
export function monogramLetter(title: string, slug: string): string {
  const pick = (s: string) => s.normalize("NFD").toUpperCase().split("").find((c) => c in GLYPHS);
  return pick(title) ?? pick(slug) ?? "A";
}

const ACCENTS = Object.values(ACCENT_RGB);

/** The tile's accent, fixed per slug (FNV-1a), so a page keeps its colour when its title changes. */
export function monogramColor(slug: string): [number, number, number] {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) h = Math.imul(h ^ slug.charCodeAt(i), 0x01000193) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

// The macOS icon grid: an 824 unit body inside 1024, corner radius 185.
const INSET = 100 / 1024;
const RADIUS = 185 / 1024;
// Cap height as a share of the canvas, and stroke weight in letter units.
const CAP = 0.4;
const STROKE = 1.5;

/** The generated icon as a `size` x `size` RGBA PNG: transparent corners, so it reads as an app tile in the Dock and taskbar. */
export function monogramPng(title: string, slug: string, size: number): Uint8Array {
  const n = size * size;
  const px = new Float32Array(n * 4);
  const [r, g, b] = monogramColor(slug);
  const x0 = size * INSET, side = size - 2 * x0, rad = size * RADIUS, half = side / 2;
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    // A gentle top-lit gradient: 14% toward white at the top, 10% toward black at the bottom.
    const t = (y - x0) / side;
    const lift = (1 - t) * 0.14, shade = t * 0.1;
    const row: [number, number, number] = [r, g, b].map((v) => v + (255 - v) * lift - v * shade) as [number, number, number];
    for (let x = 0; x < size; x++) {
      const qx = Math.abs(x + 0.5 - c) - (half - rad), qy = Math.abs(y + 0.5 - c) - (half - rad);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
      const a = Math.max(0, Math.min(1, 0.5 - d));
      if (!a) continue;
      const i = (y * size + x) * 4;
      px[i] = row[0]; px[i + 1] = row[1]; px[i + 2] = row[2]; px[i + 3] = a * 255;
    }
  }
  // coverage() maps a 24 unit grid onto `gridSide` pixels; one letter unit is a tenth of the cap height.
  const unit = (size * CAP) / 10;
  const geo = { segs: flattenRoleIconPath(GLYPHS[monogramLetter(title, slug)]), dots: [] };
  const cov = coverage(geo, size, size, c - 3 * unit, c - 5 * unit, 24 * unit, STROKE);
  for (let k = 0; k < n; k++) {
    const a = cov[k];
    if (!a) continue;
    const i = k * 4;
    for (let ch = 0; ch < 3; ch++) px[i + ch] = px[i + ch] * (1 - a) + 255 * a;
  }
  return encodePng(size, size, px, 4);
}
