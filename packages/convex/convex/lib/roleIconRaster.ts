// Rasterizes role icons (shared/contracts/roleIcon) without a renderer
// dependency: the generator's similarity check and the contact sheet the
// judge reads both draw through here, in Convex's default runtime and in tests.
//
// It is exact for the house style rather than an approximation of SVG: a
// stroke with round caps and round joins covers exactly the points within
// half the stroke width of the path, so each shape is flattened to segments
// and a pixel's coverage is its distance to the nearest one. Filled dots are
// discs. Nothing else is ever drawn (roleIconProblems forbids fills).

import { zlibSync } from "fflate";
import { type RoleIcon, type RoleIconAccent, type RoleIconShape, roleIconStroke, ROLE_ICON_TILE } from "@codecast/shared/contracts/roleIcon";

type Seg = [number, number, number, number];
type Geometry = { segs: Seg[]; dots: Array<{ cx: number; cy: number; r: number }> };

const CURVE_STEPS = 16;
const RING_STEPS = 48;

// ── Flattening ──────────────────────────────────────────────────────────────

/** A path's `d`, read with a cursor so arc flags written without separators ("a2 2 0 012 2") parse. */
function flattenPath(d: string, out: Seg[]): void {
  let i = 0;
  const skip = () => { while (i < d.length && /[\s,]/.test(d[i])) i++; };
  const num = (): number => {
    skip();
    const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(d.slice(i));
    if (!m) throw new Error(`bad number at ${i} in path`);
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = (): number => { skip(); const ch = d[i++]; if (ch !== "0" && ch !== "1") throw new Error("bad arc flag"); return Number(ch); };

  let x = 0, y = 0, sx = 0, sy = 0;
  let cx2 = 0, cy2 = 0; // last control point, for S and T
  let prev = "";
  const line = (nx: number, ny: number) => { out.push([x, y, nx, ny]); x = nx; y = ny; };
  const cubic = (x1: number, y1: number, x2: number, y2: number, nx: number, ny: number) => {
    const x0 = x, y0 = y;
    for (let k = 1; k <= CURVE_STEPS; k++) {
      const t = k / CURVE_STEPS, u = 1 - t;
      line(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * nx, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ny);
    }
    cx2 = x2; cy2 = y2;
  };
  const quad = (x1: number, y1: number, nx: number, ny: number) => {
    const x0 = x, y0 = y;
    for (let k = 1; k <= CURVE_STEPS; k++) {
      const t = k / CURVE_STEPS, u = 1 - t;
      line(u * u * x0 + 2 * u * t * x1 + t * t * nx, u * u * y0 + 2 * u * t * y1 + t * t * ny);
    }
    cx2 = x1; cy2 = y1;
  };
  for (;;) {
    skip();
    if (i >= d.length) break;
    let cmd = d[i];
    if (/[a-zA-Z]/.test(cmd)) i++;
    else if (prev && prev.toLowerCase() !== "z") cmd = prev === "M" ? "L" : prev === "m" ? "l" : prev; // implicit repeat
    else throw new Error(`path must start with a command at ${i}`);
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M": { x = num() + ox; y = num() + oy; sx = x; sy = y; break; }
      case "L": line(num() + ox, num() + oy); break;
      case "H": line(num() + ox, y); break;
      case "V": line(x, num() + oy); break;
      case "C": { const a = num() + ox, b = num() + oy, c = num() + ox, e = num() + oy; cubic(a, b, c, e, num() + ox, num() + oy); break; }
      case "S": {
        const smooth = /[CcSs]/.test(prev);
        const a = smooth ? 2 * x - cx2 : x, b = smooth ? 2 * y - cy2 : y;
        const c = num() + ox, e = num() + oy;
        cubic(a, b, c, e, num() + ox, num() + oy);
        break;
      }
      case "Q": { const a = num() + ox, b = num() + oy; quad(a, b, num() + ox, num() + oy); break; }
      case "T": {
        const smooth = /[QqTt]/.test(prev);
        quad(smooth ? 2 * x - cx2 : x, smooth ? 2 * y - cy2 : y, num() + ox, num() + oy);
        break;
      }
      case "A": {
        const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag();
        arcTo(x, y, rx, ry, rot, large, sweep, num() + ox, num() + oy, line);
        break;
      }
      case "Z": line(sx, sy); break;
      default: throw new Error(`unknown path command ${cmd}`);
    }
    prev = cmd;
  }
}

// SVG arc from endpoint form (SVG 1.1 appendix F.6.5), flattened.
function arcTo(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: number, sweep: number, x2: number, y2: number, line: (x: number, y: number) => void) {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) { line(x2, y2); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil((Math.abs(dt) / (2 * Math.PI)) * RING_STEPS));
  for (let k = 1; k <= steps; k++) {
    const t = t1 + (dt * k) / steps;
    line(k === steps ? x2 : cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, k === steps ? y2 : cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos);
  }
}

function ring(cx: number, cy: number, rx: number, ry: number, out: Seg[]) {
  for (let k = 0; k < RING_STEPS; k++) {
    const a = (k / RING_STEPS) * 2 * Math.PI, b = ((k + 1) / RING_STEPS) * 2 * Math.PI;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a), cx + rx * Math.cos(b), cy + ry * Math.sin(b)]);
  }
}

function polyline(points: number[], closed: boolean, out: Seg[]) {
  for (let k = 2; k < points.length; k += 2) out.push([points[k - 2], points[k - 1], points[k], points[k + 1]]);
  if (closed && points.length >= 4) out.push([points[points.length - 2], points[points.length - 1], points[0], points[1]]);
}

function shapeGeometry(s: RoleIconShape, g: Geometry) {
  switch (s.t) {
    case "path": flattenPath(s.d, g.segs); break;
    case "circle": if (s.fill) g.dots.push({ cx: s.cx, cy: s.cy, r: s.r }); else ring(s.cx, s.cy, s.r, s.r, g.segs); break;
    case "ellipse": ring(s.cx, s.cy, s.rx, s.ry, g.segs); break;
    case "line": g.segs.push([s.x1, s.y1, s.x2, s.y2]); break;
    case "polyline": polyline(s.points, false, g.segs); break;
    case "polygon": polyline(s.points, true, g.segs); break;
    case "rect": {
      const { x, y, width: w, height: h } = s;
      const r = Math.min(s.rx ?? 0, w / 2, h / 2);
      if (!r) { polyline([x, y, x + w, y, x + w, y + h, x, y + h], true, g.segs); break; }
      flattenPath(`M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`, g.segs);
      break;
    }
  }
}

/** An icon's strokes as line segments and its dots as discs, in grid units. */
export function iconGeometry(icon: Pick<RoleIcon, "shapes">): Geometry {
  const g: Geometry = { segs: [], dots: [] };
  for (const s of icon.shapes) shapeGeometry(s, g);
  return g;
}

// ── Coverage ────────────────────────────────────────────────────────────────

function segDist(px: number, py: number, s: Seg): number {
  const [ax, ay, bx, by] = s;
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  const dx = px - ax - t * vx, dy = py - ay - t * vy;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Coverage (0..1 per pixel) of `geo` drawn into a `w` x `h` canvas, the 24
 * grid mapped onto the square at (ox, oy) of side `side` pixels, stroked
 * `stroke` grid units wide. Anti-aliased by distance, one pixel of ramp.
 */
export function coverage(geo: Geometry, w: number, h: number, ox: number, oy: number, side: number, stroke: number, into?: Float32Array): Float32Array {
  const cov = into ?? new Float32Array(w * h);
  const k = side / 24;
  const half = (stroke / 2) * k;
  const paint = (x0: number, y0: number, x1: number, y1: number, cov1: (px: number, py: number) => number) => {
    for (let py = Math.max(0, Math.floor(y0)); py <= Math.min(h - 1, Math.ceil(y1)); py++) {
      for (let px = Math.max(0, Math.floor(x0)); px <= Math.min(w - 1, Math.ceil(x1)); px++) {
        const c = cov1(px + 0.5, py + 0.5);
        if (c > cov[py * w + px]) cov[py * w + px] = c;
      }
    }
  };
  for (const s of geo.segs) {
    const p: Seg = [ox + s[0] * k, oy + s[1] * k, ox + s[2] * k, oy + s[3] * k];
    paint(Math.min(p[0], p[2]) - half - 1, Math.min(p[1], p[3]) - half - 1, Math.max(p[0], p[2]) + half + 1, Math.max(p[1], p[3]) + half + 1,
      (x, y) => Math.max(0, Math.min(1, half - segDist(x, y, p) + 0.5)));
  }
  for (const d of geo.dots) {
    const cx = ox + d.cx * k, cy = oy + d.cy * k, r = d.r * k;
    paint(cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1, (x, y) => Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5)));
  }
  return cov;
}

/**
 * The icon's alpha mask at 24 px and the house weight: a pixel is in when
 * it is mostly covered. Two glyphs whose masks overlap by more than
 * SILHOUETTE_TOO_CLOSE read as one shape at sidebar size.
 */
export function iconMask(icon: Pick<RoleIcon, "shapes">, stroke = 2): Uint8Array {
  const cov = coverage(iconGeometry(icon), 24, 24, 0, 0, 24, stroke);
  const mask = new Uint8Array(24 * 24);
  for (let n = 0; n < mask.length; n++) mask[n] = cov[n] >= 0.5 ? 1 : 0;
  return mask;
}

/** Above this IoU a candidate is refused as the same silhouette as a sibling.
 *  Measured on the house set: the closest hand-drawn pair (coin and target,
 *  both a ring around a mark) is 0.70, the next 0.60; a glyph moved half a
 *  unit scores 0.81 against itself. */
export const SILHOUETTE_TOO_CLOSE = 0.7;

/** Intersection over union of two masks; 0 when both are empty. */
export function maskIoU(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, union = 0;
  for (let n = 0; n < a.length; n++) { inter += a[n] & b[n]; union += a[n] | b[n]; }
  return union ? inter / union : 0;
}

// ── Tiles, sheets and PNG ───────────────────────────────────────────────────

/** The solarized accents and themes the web and phone tint tiles with. */
export const ACCENT_RGB: Record<RoleIconAccent, [number, number, number]> = {
  blue: [0x26, 0x8b, 0xd2], cyan: [0x2a, 0xa1, 0x98], green: [0x85, 0x99, 0x00], yellow: [0xb5, 0x89, 0x00],
  orange: [0xcb, 0x4b, 0x16], red: [0xdc, 0x32, 0x2f], magenta: [0xd3, 0x36, 0x82], violet: [0x6c, 0x71, 0xc4],
};
type RGB = [number, number, number];
export type SheetTheme = { bg: RGB; alt: RGB; text: RGB; tileMix: number };
export const SHEET_THEMES: Record<"light" | "dark", SheetTheme> = {
  light: { bg: [0xfd, 0xf6, 0xe3], alt: [0xee, 0xe8, 0xd5], text: [0x07, 0x36, 0x42], tileMix: 0.2 },
  dark: { bg: [0x00, 0x2b, 0x36], alt: [0x07, 0x36, 0x42], text: [0xee, 0xe8, 0xd5], tileMix: 0.28 },
};
const mix = (a: RGB, b: RGB, f: number): RGB => [a[0] * f + b[0] * (1 - f), a[1] * f + b[1] * (1 - f), a[2] * f + b[2] * (1 - f)];

/** An RGB canvas the sheet is painted on. */
export class Canvas {
  readonly px: Float32Array;
  constructor(readonly w: number, readonly h: number, fill: RGB) {
    this.px = new Float32Array(w * h * 3);
    for (let n = 0; n < w * h; n++) this.px.set(fill, n * 3);
  }
  rect(x: number, y: number, w: number, h: number, color: RGB) {
    for (let py = Math.max(0, y); py < Math.min(this.h, y + h); py++)
      for (let px = Math.max(0, x); px < Math.min(this.w, x + w); px++) this.px.set(color, (py * this.w + px) * 3);
  }
  /** Blends `color` through a coverage layer the size of the canvas. */
  blend(cov: Float32Array, color: RGB) {
    for (let n = 0; n < cov.length; n++) {
      const a = cov[n];
      if (!a) continue;
      for (let c = 0; c < 3; c++) this.px[n * 3 + c] = this.px[n * 3 + c] * (1 - a) + color[c] * a;
    }
  }
  /** A filled rounded square with a one pixel border, as the web draws a tile. */
  tile(x: number, y: number, side: number, fill: RGB, border: RGB) {
    const r = side * ROLE_ICON_TILE.radius;
    const sd = (px: number, py: number) => {
      const cx = x + side / 2, cy = y + side / 2, half = side / 2 - 0.5;
      const qx = Math.abs(px - cx) - (half - r), qy = Math.abs(py - cy) - (half - r);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    };
    for (let py = Math.floor(y); py < Math.ceil(y + side); py++) {
      for (let px = Math.floor(x); px < Math.ceil(x + side); px++) {
        if (px < 0 || py < 0 || px >= this.w || py >= this.h) continue;
        const d = sd(px + 0.5, py + 0.5);
        const inside = Math.max(0, Math.min(1, 0.5 - d));
        if (!inside) continue;
        const edge = Math.max(0, Math.min(1, 1 - Math.abs(d + 0.5)));
        const c = mix(border, fill, edge);
        const n = (py * this.w + px) * 3;
        for (let k = 0; k < 3; k++) this.px[n + k] = this.px[n + k] * (1 - inside) + c[k] * inside;
      }
    }
  }
  png(): Uint8Array { return encodePng(this.w, this.h, this.px); }
}

/** Paints one icon tile the way the web does: tinted square, glyph at 76% in the accent mixed toward the text colour. `side` is in canvas pixels, `cssSide` the size the web would lay it out at, which picks the stroke. */
export function paintTile(canvas: Canvas, icon: Pick<RoleIcon, "shapes" | "accent">, x: number, y: number, side: number, theme: SheetTheme, cssSide = side) {
  const accent = ACCENT_RGB[icon.accent];
  canvas.tile(x, y, side, mix(accent, theme.alt, theme.tileMix), mix(accent, theme.bg, 0.45));
  const glyph = side * ROLE_ICON_TILE.glyph;
  const cov = coverage(iconGeometry(icon), canvas.w, canvas.h, x + (side - glyph) / 2, y + (side - glyph) / 2, glyph, roleIconStroke(cssSide));
  canvas.blend(cov, mix(accent, theme.text, 0.3));
}

/** Strokes `d` (a path on a 10 unit tall letter box) at (x, y), `size` pixels tall: the sheet's row labels, since it carries no font. */
export function paintLabel(canvas: Canvas, letter: string, x: number, y: number, size: number, color: RGB) {
  const d = LETTERS[letter];
  if (!d) return;
  const g: Geometry = { segs: [], dots: [] };
  flattenPath(d, g.segs);
  // The letter box is 10 units tall and coverage maps 24 units onto `side`;
  // the stroke is 1.6 px whatever the size.
  const side = (size / 10) * 24;
  canvas.blend(coverage(g, canvas.w, canvas.h, x, y, side, (1.6 * 24) / side), color);
}

// Row labels drawn as strokes on a 7 x 10 box.
const LETTERS: Record<string, string> = {
  A: "M0 10L3.5 0L7 10M1.3 6.5H5.7",
  B: "M0 0H4.5A2.5 2.5 0 0 1 4.5 5H0ZM0 5H5A2.5 2.5 0 0 1 5 10H0Z",
  C: "M7 1.5A5 5 0 1 0 7 8.5",
  D: "M0 0H3A4 5 0 0 1 3 10H0Z",
  E: "M7 0H0V10H7M0 5H5",
  F: "M7 0H0V10M0 5H5",
  S: "M6.5 1.2A3.5 2.6 0 1 0 3.5 5A3.5 2.6 0 1 1 0.5 8.8",
};

// ── PNG ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let n = 0; n < bytes.length; n++) c = CRC_TABLE[(c ^ bytes[n]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8 bit RGB PNG of float pixels (0..255). */
export function encodePng(w: number, h: number, rgb: Float32Array): Uint8Array {
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(rgb[y * w * 3 + x])));
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w); v.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
