// Board geometry (ct-91884): pure math the canvas, the CLI verbs and the
// describe text share. Coordinates are canvas pixels, x right, y down. An
// element's box is x, y, w, h; connectors and pens derive theirs.
import type { ArtifactElement } from "./core";

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };

/** Default sizes per kind, used when an element omits w/h. */
export const BOARD_DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  sticky: { w: 200, h: 160 },
  text: { w: 240, h: 32 },
  shape: { w: 180, h: 120 },
  frame: { w: 640, h: 420 },
  image: { w: 320, h: 220 },
  stamp: { w: 48, h: 48 },
  card: { w: 320, h: 168 },
  pen: { w: 0, h: 0 },
  connector: { w: 0, h: 0 },
};

/** Sticky and shape colors, by name. The web maps each to a theme token. */
export const BOARD_COLORS = ["yellow", "orange", "red", "pink", "violet", "blue", "cyan", "green", "gray"] as const;
export type BoardColor = (typeof BOARD_COLORS)[number];
export const BOARD_SHAPES = ["rect", "ellipse", "diamond", "pill"] as const;
export type BoardShape = (typeof BOARD_SHAPES)[number];

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Rough text width in pixels for the app's monospace face. */
export function textWidth(text: string, size: number): number {
  let longest = 0;
  for (const line of text.split("\n")) longest = Math.max(longest, line.length);
  return Math.ceil(longest * size * 0.6);
}

/** The height a text element takes when it wraps inside width w. */
export function textHeight(text: string, size: number, w: number): number {
  const perLine = Math.max(1, Math.floor(w / (size * 0.6)));
  let lines = 0;
  for (const line of (text || " ").split("\n")) lines += wrappedLines(line.replace(/\*\*|~~/g, ""), perLine);
  return Math.ceil(lines * size * 1.3);
}

/** Lines a paragraph takes in a monospace face, wrapped at spaces the way the page wraps it. */
function wrappedLines(line: string, perLine: number): number {
  return wrapLine(line, perLine).length;
}

/** A paragraph broken into lines of at most `perLine` characters, at spaces (a longer word breaks anywhere). */
export function wrapLine(line: string, perLine: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(" ")) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length <= perLine) { cur = next; continue; }
    if (cur) out.push(cur);
    let w = word;
    while (w.length > perLine) { out.push(w.slice(0, perLine)); w = w.slice(perLine); }
    cur = w;
  }
  out.push(cur);
  return out;
}

/** Flat [x0,y0,x1,y1,...] point list -> points. */
export function unflatten(points: unknown): Pt[] {
  if (!Array.isArray(points)) return [];
  const out: Pt[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i], y = points[i + 1];
    if (typeof x === "number" && typeof y === "number") out.push({ x, y });
  }
  return out;
}

export function boxOfPoints(pts: readonly Pt[]): Box {
  if (pts.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function center(b: Box): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export function intersects(a: Box, b: Box): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function contains(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/** Normalize a box with a possibly negative width/height (a marquee dragged up-left). */
export function normBox(a: Pt, b: Pt): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/**
 * The box of a box-shaped element (everything except connectors). Pens carry
 * x, y plus points relative to them; text grows to fit its words.
 */
export function elementBox(el: ArtifactElement): Box {
  const d = BOARD_DEFAULT_SIZE[el.kind] ?? { w: 120, h: 80 };
  const x = num(el.x, 0), y = num(el.y, 0);
  if (el.kind === "pen") {
    const b = boxOfPoints(unflatten(el.points));
    const pad = num(el.width, 4) / 2;
    return { x: x + b.x - pad, y: y + b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }
  if (el.kind === "stamp") {
    const s = num(el.size, d.w);
    return { x, y, w: s, h: s };
  }
  if (el.kind === "text") {
    const size = num(el.size, 20);
    const text = typeof el.text === "string" ? el.text : "";
    const w = num(el.w, Math.max(40, textWidth(text, size) + 4));
    return { x, y, w, h: num(el.h, textHeight(text, size, w)) };
  }
  return { x, y, w: num(el.w, d.w), h: num(el.h, d.h) };
}

/**
 * The axis-aligned box an element covers on the canvas, rotation included.
 * Culling, marquee, fit and snapping use this; layout uses the unrotated box.
 */
export function elementBounds(el: ArtifactElement): Box {
  const b = elementBox(el);
  const rot = typeof el.rot === "number" ? (el.rot * Math.PI) / 180 : 0;
  if (!rot) return b;
  const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  const w = b.w * c + b.h * s, h = b.w * s + b.h * c;
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
}

/** Where a ray from the box's center toward `toward` leaves the element's outline. */
export function anchorPoint(b: Box, shape: string | undefined, toward: Pt): Pt {
  const c = center(b);
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = b.w / 2, hh = b.h / 2;
  if (hw === 0 || hh === 0) return c;
  let t: number;
  if (shape === "ellipse") {
    t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  } else if (shape === "diamond") {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else {
    t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  }
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** `points`: the drawn path as a polyline (the route of an elbow, samples of a curve), for hit-testing and placing a label along it. */
export type ConnectorGeometry = { a: Pt; b: Pt; d: string; mid: Pt; box: Box; angleEnd: number; angleStart: number; points: Pt[] };

/**
 * A connector's drawn path. Attached ends follow their element (computed from
 * the live box every frame, so they stay attached as things move); free ends
 * use x1,y1 / x2,y2. Curved connectors leave each box along the axis the
 * other end lies on, like FigJam's.
 */
export function connectorGeometry(el: ArtifactElement, lookup: (key: string) => ArtifactElement | undefined, obstacles?: readonly Box[]): ConnectorGeometry | null {
  const fromEl = typeof el.from === "string" ? lookup(el.from) : undefined;
  const toEl = typeof el.to === "string" ? lookup(el.to) : undefined;
  // A rotated element is attached at the box it covers, so the arrow meets what is drawn.
  const fromBox = fromEl ? elementBounds(fromEl) : null;
  const toBox = toEl ? elementBounds(toEl) : null;
  const freeA: Pt | null = typeof el.x1 === "number" && typeof el.y1 === "number" ? { x: el.x1, y: el.y1 } : null;
  const freeB: Pt | null = typeof el.x2 === "number" && typeof el.y2 === "number" ? { x: el.x2, y: el.y2 } : null;
  const aRef = fromBox ? center(fromBox) : freeA;
  const bRef = toBox ? center(toBox) : freeB;
  if (!aRef || !bRef) return null;
  if (el.curve === "elbow") return elbowGeometry(fromBox ?? { ...aRef, w: 0, h: 0 }, toBox ?? { ...bRef, w: 0, h: 0 }, obstacles ?? [], el.label_at, { a: parseAnchor(el.from_at), b: parseAnchor(el.to_at) });
  const a = fromBox ? anchorPoint(pad(fromBox, 4), rotated(fromEl!) ? "rect" : shapeOf(fromEl!), bRef) : aRef;
  const b = toBox ? anchorPoint(pad(toBox, 4), rotated(toEl!) ? "rect" : shapeOf(toEl!), aRef) : bRef;
  const curved = el.curve === "curved";
  let d: string, mid: Pt, c1: Pt = a, c2: Pt = b;
  if (curved) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const k = (horizontal ? Math.abs(dx) : Math.abs(dy)) * 0.5;
    c1 = horizontal ? { x: a.x + Math.sign(dx) * k, y: a.y } : { x: a.x, y: a.y + Math.sign(dy) * k };
    c2 = horizontal ? { x: b.x - Math.sign(dx) * k, y: b.y } : { x: b.x, y: b.y - Math.sign(dy) * k };
    d = `M${r(a.x)},${r(a.y)} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(b.x)},${r(b.y)}`;
    mid = a;
  } else {
    d = `M${r(a.x)},${r(a.y)} L${r(b.x)},${r(b.y)}`;
    mid = a;
  }
  const points = curved ? Array.from({ length: 25 }, (_, i) => cubicAt(a, c1, c2, b, i / 24)) : [a, b];
  // The label sits `label_at` of the way along the drawn line, by length (the same measure a drag sets).
  mid = pointAlong(points, labelT(el.label_at));
  return {
    a, b, d, mid, points,
    box: boxOfPoints([a, b, c1, c2]),
    // Tangents at each end: from the control point for a curve, along the line for a straight one.
    angleEnd: curved ? Math.atan2(b.y - c2.y, b.x - c2.x) : Math.atan2(b.y - a.y, b.x - a.x),
    angleStart: curved ? Math.atan2(a.y - c1.y, a.x - c1.x) : Math.atan2(a.y - b.y, a.x - b.x),
  };
}

// ── Elbow connectors ──────────────────────────────────────────────────────

type Side = "n" | "e" | "s" | "w";
const SIDES: Side[] = ["n", "e", "s", "w"];
const STUB = 20;
const CLEAR = 16;

/**
 * Where a route leaves (or enters) side `side` of box b: in line with the
 * other end when it faces this side, so arrows into a wide box land apart and
 * drop straight in, else the side's middle.
 */
function sidePoint(b: Box, side: Side, toward?: Pt): Pt {
  const inset = (len: number) => Math.min(24, len * 0.2);
  const along = (lo: number, len: number, v: number | undefined) => (v === undefined || v <= lo + inset(len) || v >= lo + len - inset(len) ? lo + len / 2 : v);
  if (side === "n") return { x: along(b.x, b.w, toward?.x), y: b.y };
  if (side === "s") return { x: along(b.x, b.w, toward?.x), y: b.y + b.h };
  if (side === "w") return { x: b.x, y: along(b.y, b.h, toward?.y) };
  return { x: b.x + b.w, y: along(b.y, b.h, toward?.y) };
}

/** A fixed attachment: fractions across the box ([0.5, 1] is the bottom middle), and the side it sits on. */
export type Anchor = { fx: number; fy: number };

function anchorSide(a: Anchor): Side {
  const d = [["n", a.fy], ["s", 1 - a.fy], ["w", a.fx], ["e", 1 - a.fx]] as const;
  return [...d].sort((x, y) => x[1] - y[1])[0][0];
}

export function parseAnchor(v: unknown): Anchor | null {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { fx: Math.max(0, Math.min(1, v[0])), fy: Math.max(0, Math.min(1, v[1])) };
}

function stubOut(p: Pt, side: Side, d: number): Pt {
  return side === "n" ? { x: p.x, y: p.y - d } : side === "s" ? { x: p.x, y: p.y + d } : side === "w" ? { x: p.x - d, y: p.y } : { x: p.x + d, y: p.y };
}

/** Whether an axis-aligned segment crosses the inside of a box. */
function segHitsBox(p: Pt, q: Pt, b: Box): boolean {
  const x0 = Math.min(p.x, q.x), x1 = Math.max(p.x, q.x), y0 = Math.min(p.y, q.y), y1 = Math.max(p.y, q.y);
  return x0 < b.x + b.w && x1 > b.x && y0 < b.y + b.h && y1 > b.y;
}

/** Drop repeated points and points in the middle of a straight run. */
function tidy(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((Math.abs(prev.x - last.x) < 0.5 && Math.abs(last.x - p.x) < 0.5) || (Math.abs(prev.y - last.y) < 0.5 && Math.abs(last.y - p.y) < 0.5))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

function polyLength(pts: readonly Pt[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return n;
}

/** The point `t` (0..1) of the way along a polyline, by length. */
export function pointAlong(pts: readonly Pt[], t: number): Pt {
  const total = polyLength(pts);
  let left = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len && len > 0) { const k = left / len; return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }; }
    left -= len;
  }
  return pts[pts.length - 1] ?? { x: 0, y: 0 };
}

/**
 * An orthogonal route from box A to box B that leaves and enters on a side,
 * bends as little as it can, and goes around the other boxes on the board
 * (FigJam's elbow connector). A zero-size box is a free end. Candidates are
 * every pair of sides joined with one or two bends, the two-bend ones placed
 * on the midline or just outside any obstacle; the shortest clear one wins.
 */
export function elbowRoute(A: Box, B: Box, obstacles: readonly Box[], anchors: { a?: Anchor | null; b?: Anchor | null } = {}): Pt[] {
  const freeA = A.w === 0 && A.h === 0, freeB = B.w === 0 && B.h === 0;
  const span = unionBoxOf(A, B);
  const near = obstacles.filter((o) => !sameBox(o, A) && !sameBox(o, B) && o.x < span.x + span.w + 200 && o.x + o.w > span.x - 200 && o.y < span.y + span.h + 200 && o.y + o.h > span.y - 200).slice(0, 60);
  const blockers = near.map((o) => padBox(o, CLEAR / 2));
  const xs = new Set<number>(), ys = new Set<number>();
  for (const o of [...near, A, B]) { xs.add(o.x - CLEAR); xs.add(o.x + o.w + CLEAR); ys.add(o.y - CLEAR); ys.add(o.y + o.h + CLEAR); }
  let best: { pts: Pt[]; score: number } | null = null;
  const cA = { x: A.x + A.w / 2, y: A.y + A.h / 2 }, cB = { x: B.x + B.w / 2, y: B.y + B.h / 2 };
  const fixed = (b: Box, an: Anchor) => ({ x: b.x + an.fx * b.w, y: b.y + an.fy * b.h });
  const sidesA: Side[] = freeA ? ["e"] : anchors.a ? [anchorSide(anchors.a)] : SIDES;
  const sidesB: Side[] = freeB ? ["w"] : anchors.b ? [anchorSide(anchors.b)] : SIDES;
  for (const sa of sidesA) for (const sb of sidesB) {
    const p0 = freeA ? { x: A.x, y: A.y } : anchors.a ? fixed(A, anchors.a) : sidePoint(A, sa, cB);
    const p3 = freeB ? { x: B.x, y: B.y } : anchors.b ? fixed(B, anchors.b) : sidePoint(B, sb, p0);
    const p1 = freeA ? p0 : stubOut(p0, sa, STUB);
    const p2 = freeB ? p3 : stubOut(p3, sb, STUB);
    const mids: Pt[][] = [[{ x: p2.x, y: p1.y }], [{ x: p1.x, y: p2.y }]];
    for (const x of [(p1.x + p2.x) / 2, ...xs]) mids.push([{ x, y: p1.y }, { x, y: p2.y }]);
    for (const y of [(p1.y + p2.y) / 2, ...ys]) mids.push([{ x: p1.x, y }, { x: p2.x, y }]);
    for (const m of mids) {
      const pts = tidy([p0, p1, ...m, p2, p3]);
      let hits = 0;
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i];
        for (const o of blockers) if (segHitsBox(p, q, o)) hits++;
        // The route may not pass back through either end's own box (its first and last legs touch them).
        if (!freeA && i > 1 && segHitsBox(p, q, padBox(A, -1))) hits++;
        if (!freeB && i < pts.length - 1 && segHitsBox(p, q, padBox(B, -1))) hits++;
      }
      // A route doubling back on itself (a leg reversing the one before) reads as a glitch.
      let reversals = 0;
      for (let i = 2; i < pts.length; i++) {
        const d1 = { x: Math.sign(pts[i - 1].x - pts[i - 2].x), y: Math.sign(pts[i - 1].y - pts[i - 2].y) };
        const d2 = { x: Math.sign(pts[i].x - pts[i - 1].x), y: Math.sign(pts[i].y - pts[i - 1].y) };
        if (d1.x === -d2.x && d1.y === -d2.y) reversals++;
      }
      const score = polyLength(pts) + (pts.length - 2) * 24 + hits * 10000 + reversals * 5000;
      if (!best || score < best.score) best = { pts, score };
    }
  }
  return best!.pts;
}

function unionBoxOf(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
function sameBox(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
}
function padBox(b: Box, p: number): Box {
  return { x: b.x - p, y: b.y - p, w: b.w + p * 2, h: b.h + p * 2 };
}

/** An orthogonal polyline drawn with rounded corners. */
export function roundedPath(pts: readonly Pt[], radius = 10): string {
  if (pts.length === 0) return "";
  let d = `M${r(pts[0].x)},${r(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1], c = pts[i], n = pts[i + 1];
    const l1 = Math.hypot(c.x - p.x, c.y - p.y), l2 = Math.hypot(n.x - c.x, n.y - c.y);
    const k = Math.min(radius, l1 / 2, l2 / 2);
    if (k < 0.5) { d += ` L${r(c.x)},${r(c.y)}`; continue; }
    const a = { x: c.x + ((p.x - c.x) / l1) * k, y: c.y + ((p.y - c.y) / l1) * k };
    const b = { x: c.x + ((n.x - c.x) / l2) * k, y: c.y + ((n.y - c.y) / l2) * k };
    d += ` L${r(a.x)},${r(a.y)} Q${r(c.x)},${r(c.y)} ${r(b.x)},${r(b.y)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${r(last.x)},${r(last.y)}`;
}

/** Where along a connector its label sits, 0 (start) to 1 (end); the middle by default. */
function labelT(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0.05, Math.min(0.95, v)) : 0.5;
}

function elbowGeometry(A: Box, B: Box, obstacles: readonly Box[], labelAt: unknown, anchors: { a?: Anchor | null; b?: Anchor | null } = {}): ConnectorGeometry {
  // The ends' own boxes are not obstacles; the route starts just off their outline.
  const others = obstacles.filter((o) => !sameBox(o, A) && !sameBox(o, B) && !(o.x <= A.x && o.y <= A.y && o.x + o.w >= A.x + A.w && o.y + o.h >= A.y + A.h) && !(o.x <= B.x && o.y <= B.y && o.x + o.w >= B.x + B.w && o.y + o.h >= B.y + B.h));
  const pts = elbowRoute(padBox(A, A.w || A.h ? 4 : 0), padBox(B, B.w || B.h ? 4 : 0), others, anchors);
  const a = pts[0], b = pts[pts.length - 1];
  const pa = pts[1] ?? b, pb = pts[pts.length - 2] ?? a;
  return {
    a, b,
    d: roundedPath(pts),
    mid: pointAlong(pts, labelT(labelAt)),
    box: boxOfPoints(pts),
    angleEnd: Math.atan2(b.y - pb.y, b.x - pb.x),
    angleStart: Math.atan2(a.y - pa.y, a.x - pa.x),
    points: pts,
  };
}

function rotated(el: ArtifactElement): boolean {
  return typeof el.rot === "number" && el.rot % 180 !== 0;
}

function shapeOf(el: ArtifactElement): string | undefined {
  if (el.kind === "shape") return typeof el.shape === "string" ? el.shape : "rect";
  if (el.kind === "stamp") return "ellipse";
  return "rect";
}

function pad(b: Box, p: number): Box {
  return { x: b.x - p, y: b.y - p, w: b.w + p * 2, h: b.h + p * 2 };
}

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

const r = (n: number) => Math.round(n * 10) / 10;

/** A smooth SVG path through points (Catmull-Rom as cubic Béziers). Pens and timeline roads. */
export function smoothPath(pts: readonly Pt[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${r(pts[0].x)},${r(pts[0].y)} l0.01,0`;
  if (pts.length === 2) return `M${r(pts[0].x)},${r(pts[0].y)} L${r(pts[1].x)},${r(pts[1].y)}`;
  let d = `M${r(pts[0].x)},${r(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(p2.x)},${r(p2.y)}`;
  }
  return d;
}

/**
 * Drop points closer than `minDist` to the last kept one, and points that sit
 * on a straight run (Ramer-Douglas-Peucker with tolerance `eps`). Keeps a
 * freehand stroke small enough to sync.
 */
export function simplifyStroke(pts: readonly Pt[], eps = 1.2): Pt[] {
  if (pts.length <= 2) return [...pts];
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const dd = segDist(pts[i], pts[s], pts[e]);
      if (dd > maxD) { maxD = dd; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from a point to a polyline, for hit-testing pen strokes and connectors. */
export function distToPolyline(p: Pt, pts: readonly Pt[]): number {
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, segDist(p, pts[i], pts[i + 1]));
  return best;
}

// ── Snapping ───────────────────────────────────────────────────────────────

export type SnapGuide = { axis: "x" | "y"; at: number; from: number; to: number };

/**
 * Snap a moving box to the edges and centers of nearby boxes. Returns the
 * offset to add and the guide lines to draw. `threshold` is in canvas pixels
 * (the caller divides its screen tolerance by zoom).
 */
export function snapBox(moving: Box, others: readonly Box[], threshold: number): { dx: number; dy: number; guides: SnapGuide[] } {
  const xs = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
  const ys = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
  let bestX: { d: number; to: number } | null = null;
  let bestY: { d: number; to: number } | null = null;
  for (const o of others) {
    const oxs = [o.x, o.x + o.w / 2, o.x + o.w];
    const oys = [o.y, o.y + o.h / 2, o.y + o.h];
    for (const mx of xs) for (const ox of oxs) {
      const d = ox - mx;
      if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, to: ox };
    }
    for (const my of ys) for (const oy of oys) {
      const d = oy - my;
      if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, to: oy };
    }
  }
  const dx = bestX?.d ?? 0, dy = bestY?.d ?? 0;
  const snapped = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h };
  const guides: SnapGuide[] = [];
  if (bestX) guides.push(guideFor("x", bestX.to, snapped, others));
  if (bestY) guides.push(guideFor("y", bestY.to, snapped, others));
  return { dx, dy, guides };
}

function guideFor(axis: "x" | "y", at: number, moving: Box, others: readonly Box[]): SnapGuide {
  let from = axis === "x" ? moving.y : moving.x;
  let to = axis === "x" ? moving.y + moving.h : moving.x + moving.w;
  for (const o of others) {
    const edges = axis === "x" ? [o.x, o.x + o.w / 2, o.x + o.w] : [o.y, o.y + o.h / 2, o.y + o.h];
    if (!edges.some((e) => Math.abs(e - at) < 0.5)) continue;
    from = Math.min(from, axis === "x" ? o.y : o.x);
    to = Math.max(to, axis === "x" ? o.y + o.h : o.x + o.w);
  }
  return { axis, at, from, to };
}

// ── Align and distribute ──────────────────────────────────────────────────

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** New x/y per key that aligns the boxes on one edge or center line. */
export function alignBoxes(boxes: ReadonlyMap<string, Box>, mode: AlignMode): Map<string, Pt> {
  const all = unionBox([...boxes.values()]);
  const out = new Map<string, Pt>();
  if (!all) return out;
  for (const [k, b] of boxes) {
    let { x, y } = b;
    if (mode === "left") x = all.x;
    else if (mode === "right") x = all.x + all.w - b.w;
    else if (mode === "hcenter") x = all.x + all.w / 2 - b.w / 2;
    else if (mode === "top") y = all.y;
    else if (mode === "bottom") y = all.y + all.h - b.h;
    else y = all.y + all.h / 2 - b.h / 2;
    out.set(k, { x: Math.round(x), y: Math.round(y) });
  }
  return out;
}

/** New x/y per key that spaces the boxes evenly between the outermost two. */
export function distributeBoxes(boxes: ReadonlyMap<string, Box>, axis: "h" | "v"): Map<string, Pt> {
  const entries = [...boxes.entries()].sort((a, b) => (axis === "h" ? a[1].x - b[1].x : a[1].y - b[1].y));
  const out = new Map<string, Pt>();
  if (entries.length < 3) return out;
  const first = entries[0][1], last = entries[entries.length - 1][1];
  const span = axis === "h" ? last.x + last.w - first.x : last.y + last.h - first.y;
  const used = entries.reduce((s, [, b]) => s + (axis === "h" ? b.w : b.h), 0);
  const gap = (span - used) / (entries.length - 1);
  let cursor = axis === "h" ? first.x : first.y;
  for (const [k, b] of entries) {
    out.set(k, axis === "h" ? { x: Math.round(cursor), y: b.y } : { x: b.x, y: Math.round(cursor) });
    cursor += (axis === "h" ? b.w : b.h) + gap;
  }
  return out;
}

/** Sticky font size that fits `text` inside a w x h sticky (auto-fit text). */
export function stickyFontSize(text: string, w: number, h: number, max = 22, min = 9): number {
  const innerW = w - 28, innerH = h - 28;
  for (let size = max; size > min; size -= 1) {
    if (textHeight(text, size, innerW) <= innerH) return size;
  }
  return min;
}

/** The smallest type a sticky shrinks to before it grows taller instead. */
export const STICKY_MIN_FONT = 13;

/** How tall a sticky's illustration (or emoji) draws: painted art scales with the card's width. */
export function stickyIconHeight(icon: unknown, art: boolean, w: number, h: number): number {
  if (typeof icon !== "string" || !icon) return 0;
  return art ? Math.round(Math.min(96, w * 0.42)) : Math.round(Math.min(64, h * 0.32));
}

/**
 * The height a sticky needs so `text` reads at STICKY_MIN_FONT or larger: its
 * current height when that already fits, more when it does not (FigJam's
 * stickies grow with their text the same way).
 */
export function stickyFitHeight(text: string, w: number, h: number, iconH: number): number {
  const need = Math.ceil(28 + (iconH ? iconH + 6 : 0) + textHeight(text || " ", STICKY_MIN_FONT, w - 28));
  return Math.max(h, need);
}

/** How far along a polyline (0..1, by length) the point nearest `p` lies: where a dragged label lands. */
export function nearestAlong(pts: readonly Pt[], p: Pt): number {
  let total = 0, best = Infinity, at = 0;
  const lens: number[] = [];
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); lens.push(l); total += l; }
  if (total === 0) return 0.5;
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = lens[i - 1];
    const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (l * l))) : 0;
    const d = Math.hypot(a.x + (b.x - a.x) * t - p.x, a.y + (b.y - a.y) * t - p.y);
    if (d < best) { best = d; at = (run + t * l) / total; }
    run += l;
  }
  return at;
}

/** What elbow arrows route around: everything a line should not cross (frames hold things, pens and stamps sit on them). */
export function elbowObstacles(els: Iterable<ArtifactElement>): Box[] {
  const out: Box[] = [];
  for (const e of els) if (e.kind !== "connector" && e.kind !== "frame" && e.kind !== "pen" && e.kind !== "stamp") out.push(elementBounds(e));
  return out;
}

/**
 * How a sticky draws its illustration and words inside w x h: the
 * illustration at its full size when everything fits; when the words need the
 * room, the illustration gives it up first (down to a third of its size), then
 * the type shrinks, never below `floor`. The canvas and exports both use it.
 */
export function stickyLayout(text: string, w: number, h: number, icon: unknown, art: boolean, floor = 10): { iconH: number; size: number } {
  const full = stickyIconHeight(icon, art, w, h);
  const innerW = w - 28;
  const room = (ih: number) => h - 28 - (ih ? ih + 6 : 0);
  let iconH = full;
  if (full) {
    const need = textHeight(text || " ", STICKY_MIN_FONT, innerW);
    if (need > room(full)) iconH = Math.max(Math.round(full / 3), Math.min(full, h - 28 - 6 - need));
  }
  return { iconH, size: stickyFontSize(text || " ", w, h - (iconH ? iconH + 6 : 0), 17, floor) };
}
