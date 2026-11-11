// Board layout (ct-91884): turning a list of items into placed elements. The
// CLI verbs (boardVerbs.ts) and the web (paste a list, "Group into themes")
// both run these, so an agent and a person get the same clean layouts.
import type { ArtifactElement, ArtifactOp, Json } from "./core";
import { newElementKey } from "./spec";
import { boardArtFor, isBoardArt } from "./boardArt";
import type { ArtifactView } from "./spec";
import {
  BOARD_COLORS,
  BOARD_DEFAULT_SIZE,
  BOARD_SHAPES,
  elementBox,
  stickyFitHeight,
  stickyIconHeight,
  textHeight,
  textWidth,
  unionBox,
  type Box,
  type Pt,
} from "./boardGeometry";

/** One thing to place: what `place`, `add` and `timeline` read from a line. */
export type BoardItem = { kind: string; fields: Record<string, Json>; w: number; h: number };

const ITEM_KINDS = new Set(["sticky", "text", "shape", "frame", "stamp", "card", "image"]);
const ART_LEAD = /^:([a-z]+):\s+/;
const EMOJI_LEAD = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s+/u;

/** "title | body" or a literal "\n" become a line break. */
export function itemText(raw: string): string {
  return raw.replace(/\\n/g, "\n").split(/\s+\|\s+/).join("\n").trim();
}

/**
 * Parse one item line: `[kind[:variant...]] text`. The kind defaults to
 * sticky. Variants are a color, a shape name or a number (text size). A
 * sticky or shape whose text starts with an emoji, or `:name:` naming a
 * bundled illustration (boardArt.ts), gets it as its icon.
 *
 *   Lock flavor | Huckleberry it is        -> yellow sticky, two lines
 *   sticky:green 🫐 Lock flavor             -> green sticky with an icon
 *   sticky:blue :rocket: Launch            -> blue sticky with the painted rocket
 *   shape:diamond:blue Ship?               -> blue diamond
 *   text:36 Launch timeline                -> 36px text
 *   card ct-4102                           -> live task card
 *   stamp 🎉                               -> stamp
 */
export function parseItem(line: string): BoardItem | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const m = /^([a-z]+)((?::[A-Za-z0-9]+)*)(?:\s+(.*))?$/.exec(trimmed);
  let kind = "sticky";
  let variants: string[] = [];
  let rest = trimmed;
  if (m && ITEM_KINDS.has(m[1])) {
    kind = m[1];
    variants = m[2] ? m[2].slice(1).split(":") : [];
    rest = m[3] ?? "";
  } else if (m && m[2]) {
    // `circle:red Vote` is a mistyped kind, not a sticky that says so.
    throw new Error(`unknown kind "${m[1]}": use ${[...ITEM_KINDS].join(", ")} (a circle is shape:ellipse)`);
  }
  const fields: Record<string, Json> = {};
  let sizeW: number | null = null, sizeH: number | null = null;
  for (const v of variants) {
    if ((BOARD_COLORS as readonly string[]).includes(v)) fields.color = v;
    else if ((BOARD_SHAPES as readonly string[]).includes(v)) fields.shape = v;
    else if (/^\d+$/.test(v)) fields.size = Number(v);
    else if (/^w\d+$/.test(v)) sizeW = Number(v.slice(1));
    else if (/^h\d+$/.test(v)) sizeH = Number(v.slice(1));
  }
  const d = BOARD_DEFAULT_SIZE[kind];
  let w = sizeW ?? d.w, h = sizeH ?? d.h;
  if (kind === "card") {
    fields.ref = rest.trim();
    if (!fields.ref) return null;
  } else if (kind === "stamp") {
    fields.emoji = rest.trim() || "👍";
    w = h = typeof fields.size === "number" ? fields.size : sizeW ?? sizeH ?? d.w;
    if (sizeW !== null || sizeH !== null) fields.size = w;
  } else if (kind === "image") {
    fields.src = rest.trim();
    if (!fields.src) return null;
  } else if (kind === "frame") {
    fields.title = itemText(rest);
  } else {
    let text = rest;
    // A leading emoji or `:name:` (a bundled illustration) is the item's icon.
    const art = ART_LEAD.exec(text);
    const icon = art && isBoardArt(art[1]) ? art : EMOJI_LEAD.exec(text);
    if (icon && (kind === "sticky" || kind === "shape")) {
      fields.icon = icon[1];
      text = text.slice(icon[0].length);
    }
    fields.text = itemText(text);
    if (kind === "sticky") {
      if (fields.icon && sizeH === null) h = 200;
      // Long text grows the card rather than shrinking its type past reading size.
      h = stickyFitHeight(String(fields.text), w, h, stickyIconHeight(fields.icon, boardArtFor(fields.icon) !== null, w, h));
    }
    if (kind === "text") {
      const size = typeof fields.size === "number" ? fields.size : 20;
      w = sizeW ?? Math.min(Math.max(560, size * 26), Math.max(40, textWidth(String(fields.text), size) + 4));
      h = textHeight(String(fields.text), size, w);
    }
  }
  if (kind === "sticky" && !fields.color) fields.color = "yellow";
  return { kind, fields, w, h };
}

/** Give an item a new size; a sticky still grows to keep its text readable. */
export function resizeItem(item: BoardItem, w?: number, h?: number): BoardItem {
  const next = { ...item, w: w ?? item.w, h: h ?? item.h };
  if (item.kind === "stamp") {
    const size = w ?? h ?? item.w;
    return { ...item, w: size, h: size, fields: { ...item.fields, size } };
  }
  if (item.kind === "sticky") {
    next.h = stickyFitHeight(String(item.fields.text ?? ""), next.w, next.h, stickyIconHeight(item.fields.icon, boardArtFor(item.fields.icon) !== null, next.w, next.h));
  }
  if (item.kind === "text" && w !== undefined && h === undefined) {
    next.h = textHeight(String(item.fields.text ?? ""), typeof item.fields.size === "number" ? item.fields.size : 20, next.w);
  }
  return next;
}

export function parseItems(input: string): BoardItem[] {
  const out: BoardItem[] = [];
  for (const line of input.split("\n")) {
    const item = parseItem(line);
    if (item) out.push(item);
  }
  return out;
}

// ── Where things go ───────────────────────────────────────────────────────

/** The box around everything on the board, or null when it is empty. */
export function contentBox(view: Pick<ArtifactView, "elements">): Box | null {
  return unionBox(view.elements.filter((e) => e.kind !== "connector").map(elementBox));
}

/** The z just above every element. */
export function nextZ(view: Pick<ArtifactView, "elements">): number {
  let z = 0;
  for (const e of view.elements) if (typeof e.z === "number" && e.z >= z) z = e.z + 1;
  return z;
}

/** The z just below every element (for roads and frames that go under). */
export function bottomZ(view: Pick<ArtifactView, "elements">): number {
  let z = 0;
  for (const e of view.elements) if (typeof e.z === "number" && e.z <= z) z = e.z - 1;
  return z;
}

/** Where new content goes when no spot is named: below what is there, left-aligned. */
export function freeSpot(view: Pick<ArtifactView, "elements">, gap = 120): Pt {
  const b = contentBox(view);
  return b ? { x: Math.round(b.x), y: Math.round(b.y + b.h + gap) } : { x: 0, y: 0 };
}

export type GridOpts = { cols: number; gap: number; at: Pt };

/** Top-left of each item in a grid whose rows are as tall as their tallest item. */
export function gridPositions(sizes: readonly { w: number; h: number }[], opts: GridOpts): Pt[] {
  const cols = Math.max(1, Math.floor(opts.cols));
  const colW: number[] = [];
  const rowH: number[] = [];
  sizes.forEach((s, i) => {
    const c = i % cols, row = Math.floor(i / cols);
    colW[c] = Math.max(colW[c] ?? 0, s.w);
    rowH[row] = Math.max(rowH[row] ?? 0, s.h);
  });
  const colX: number[] = [];
  let x = opts.at.x;
  for (let c = 0; c < colW.length; c++) { colX[c] = x; x += colW[c] + opts.gap; }
  const rowY: number[] = [];
  let y = opts.at.y;
  for (let row = 0; row < rowH.length; row++) { rowY[row] = y; y += rowH[row] + opts.gap; }
  return sizes.map((_, i) => ({ x: colX[i % cols], y: rowY[Math.floor(i / cols)] }));
}

/** A near-square column count for n items, capped. */
export function squareCols(n: number, max = 6): number {
  return Math.max(1, Math.min(max, Math.ceil(Math.sqrt(n))));
}

/** Put ops for items at the given positions, each above the last. Returns keys in order. */
export function placeItems(items: readonly BoardItem[], at: readonly Pt[], z0: number): { ops: ArtifactOp[]; keys: string[] } {
  const ops: ArtifactOp[] = [];
  const keys: string[] = [];
  items.forEach((item, i) => {
    const k = newElementKey("el");
    keys.push(k);
    const sized: Record<string, Json> = item.kind === "stamp" ? {} : { w: item.w, h: item.h };
    ops.push({ k, put: { kind: item.kind, x: at[i].x, y: at[i].y, ...sized, ...item.fields, z: z0 + i } });
  });
  return { ops, keys };
}

// ── Timeline ──────────────────────────────────────────────────────────────

export type TimelineStop = { label: string; title: string; body?: string; icon?: string; color?: string };

/** `Day 1 | Lock flavor | Huckleberry it is | 🫐 | yellow` per line. Only label and title are required. */
export function parseTimeline(input: string): TimelineStop[] {
  const out: TimelineStop[] = [];
  for (const raw of input.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s*\|\s*/).map((p) => p.trim());
    const [label, title = "", body, icon, color] = parts;
    if (!label) continue;
    const art = icon ? /^:?([a-z]+):?$/.exec(icon) : null;
    out.push({
      label,
      title: title.replace(/\\n/g, "\n"),
      ...(body ? { body: body.replace(/\\n/g, "\n") } : {}),
      ...(icon ? { icon: art && isBoardArt(art[1]) ? art[1] : icon } : {}),
      ...(color && (BOARD_COLORS as readonly string[]).includes(color) ? { color } : {}),
    });
  }
  return out;
}

export type TimelineOpts = { at: Pt; step?: number; title?: string; subtitle?: string; road?: string; pill?: string; zBase: number; zRoad: number };

/**
 * An illustrated timeline like a launch plan: a winding road rising left to
 * right, a pill per stop on the road, and a card per stop alternating above
 * and below it on a short stem. Every stop is its own element, so people and
 * agents can move, recolor or replace any of them afterwards.
 */
export function timelineOps(stops: readonly TimelineStop[], opts: TimelineOpts): { ops: ArtifactOp[]; keys: string[] } {
  const ops: ArtifactOp[] = [];
  const keys: string[] = [];
  const n = stops.length;
  if (n === 0) return { ops, keys };
  const step = opts.step ?? 190;
  const cardW = 200;
  const hasIcon = stops.some((s) => s.icon);
  const cardH = hasIcon ? 196 : 148;
  const stem = 56;
  const rise = Math.min(200, 40 * (n - 1));
  const { x: x0, y: y0 } = opts.at;
  const headerH = opts.title ? (opts.subtitle ? 104 : 72) : 0;
  const base = y0 + headerH + cardH + stem + 40 + rise;
  const roadX = (i: number) => x0 + cardW / 2 + 40 + i * step;
  const roadY = (i: number) => {
    const t = n === 1 ? 0 : i / (n - 1);
    return Math.round(base - rise * t + (i % 2 === 0 ? 10 : -10));
  };
  let z = opts.zBase;
  const add = (op: ArtifactOp) => { ops.push(op); keys.push(op.k); };

  if (opts.title) {
    add({ k: newElementKey("el"), put: { kind: "text", x: x0, y: y0, text: opts.title, size: 36, weight: "bold", z: z++ } });
    if (opts.subtitle) add({ k: newElementKey("el"), put: { kind: "text", x: x0, y: y0 + 54, text: opts.subtitle, size: 16, color: "gray", z: z++ } });
  }

  // The road: one smooth stroke through every stop, overshooting both ends.
  const pts: number[] = [];
  const first = { x: roadX(0) - step * 0.7, y: roadY(0) + 14 };
  const last = { x: roadX(n - 1) + step * 0.7, y: roadY(n - 1) - 14 };
  const roadPts: Pt[] = [first, ...stops.map((_, i) => ({ x: roadX(i), y: roadY(i) })), last];
  const ox = Math.round(first.x), oy = Math.round(Math.min(...roadPts.map((p) => p.y)));
  for (const p of roadPts) pts.push(Math.round(p.x - ox), Math.round(p.y - oy));
  add({ k: newElementKey("el"), put: { kind: "pen", x: ox, y: oy, points: pts, width: 22, color: opts.road ?? "orange", opacity: 0.8, smooth: true, z: opts.zRoad } });

  stops.forEach((s, i) => {
    const cx = roadX(i), cy = roadY(i);
    const above = i % 2 === 0;
    const cardKey = newElementKey("el");
    // The last stop is the outcome the plan builds to: a bigger card, green unless named.
    const goal = n > 1 && i === n - 1;
    const text = s.body ? `${s.title}\n${s.body}` : s.title;
    const w = goal ? Math.round(cardW * 1.3) : cardW;
    const h0 = goal ? Math.round(cardH * 1.2) : cardH;
    const h = stickyFitHeight(text, w, h0, stickyIconHeight(s.icon, boardArtFor(s.icon) !== null, w, h0));
    const cardY = above ? cy - stem - 16 - h : cy + stem + 16;
    add({ k: cardKey, put: { kind: "sticky", x: Math.round(cx - w / 2), y: cardY, w, h, text, color: s.color ?? (goal ? "green" : "yellow"), ...(s.icon ? { icon: s.icon } : {}), z: z++ } });
    const pillW = Math.max(72, textWidth(s.label, 13) + 28);
    const pillKey = newElementKey("el");
    add({ k: pillKey, put: { kind: "shape", shape: "pill", x: Math.round(cx - pillW / 2), y: cy - 15, w: pillW, h: 30, text: s.label, color: opts.pill ?? "red", solid: true, z: z++ } });
    add({ k: newElementKey("el"), put: { kind: "connector", from: cardKey, to: pillKey, arrow: "none", color: "gray", z: opts.zRoad + 1 } });
  });
  return { ops, keys };
}

// ── Themes ────────────────────────────────────────────────────────────────

export type Theme = { title: string; keys: string[] };

/** `Theme name: el_a el_b el_c` per line. */
export function parseThemes(input: string): Theme[] {
  const out: Theme[] = [];
  for (const raw of input.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.lastIndexOf(":");
    if (i <= 0) continue;
    const keys = line.slice(i + 1).split(/[\s,]+/).filter(Boolean);
    if (keys.length) out.push({ title: line.slice(0, i).trim(), keys });
  }
  return out;
}

const THEME_COLORS = ["blue", "green", "violet", "orange", "cyan", "pink", "yellow", "red"] as const;

/**
 * Group elements into titled frames, one per theme, side by side, each
 * holding its members in a tidy grid. Members keep their keys, so connectors
 * and references to them stay intact.
 */
export function themesOps(view: ArtifactView, themes: readonly Theme[], at: Pt | null, zFrame: number): { ops: ArtifactOp[]; keys: string[]; missing: string[] } {
  const ops: ArtifactOp[] = [];
  const keys: string[] = [];
  const missing: string[] = [];
  const members = themes.map((t) => t.keys.map((k) => view.get(k)).filter((e): e is ArtifactElement => {
    return !!e && e.kind !== "connector";
  }));
  themes.forEach((t) => t.keys.forEach((k) => { if (!view.get(k)) missing.push(k); }));
  const allBoxes = members.flat().map(elementBox);
  const origin = at ?? (unionBox(allBoxes) ? { x: Math.round(unionBox(allBoxes)!.x), y: Math.round(unionBox(allBoxes)!.y) } : freeSpot(view));
  const pad = 32, head = 56, gap = 24, between = 64;
  let x = origin.x;
  themes.forEach((t, ti) => {
    const els = members[ti];
    if (els.length === 0) return;
    const sizes = els.map((e) => { const b = elementBox(e); return { w: b.w, h: b.h }; });
    const pos = gridPositions(sizes, { cols: Math.min(3, squareCols(els.length)), gap, at: { x: x + pad, y: origin.y + head } });
    const inner = unionBox(pos.map((p, i) => ({ x: p.x, y: p.y, w: sizes[i].w, h: sizes[i].h })))!;
    const frame = { x, y: origin.y, w: inner.x + inner.w + pad - x, h: inner.y + inner.h + pad - origin.y };
    const fk = newElementKey("el");
    ops.push({ k: fk, put: { kind: "frame", ...frame, title: t.title, color: THEME_COLORS[ti % THEME_COLORS.length], z: zFrame } });
    keys.push(fk);
    els.forEach((e, i) => {
      ops.push({ k: e.key, set: { x: pos[i].x, y: pos[i].y } });
      keys.push(e.key);
    });
    x += frame.w + between;
  });
  return { ops, keys, missing };
}

/** A frame that wraps the given elements, with room for its title. */
export function frameAround(boxes: readonly Box[], title: string, z: number, padding = 40, color?: string): ArtifactOp | null {
  const b = unionBox(boxes);
  if (!b) return null;
  return {
    k: newElementKey("el"),
    put: { kind: "frame", x: Math.round(b.x - padding), y: Math.round(b.y - padding - 24), w: Math.round(b.w + padding * 2), h: Math.round(b.h + padding * 2 + 24), title, ...(color ? { color } : {}), z },
  };
}

// ── Copy, paste, duplicate ────────────────────────────────────────────────

/**
 * Put ops for copies of `els` with fresh keys, shifted by (dx, dy) and
 * stacked above everything from `z0`. Connectors come along when both of
 * their ends do (re-pointed at the copies), or when the end they leave out
 * still exists on the board (`exists`). Groups get fresh ids, so a copy of
 * a group is its own group.
 */
export function cloneOps(els: readonly ArtifactElement[], dx: number, dy: number, z0: number, exists: (key: string) => boolean = () => false): { ops: ArtifactOp[]; keys: string[]; map: Map<string, string> } {
  const keyMap = new Map(els.map((e) => [e.key, newElementKey("el")]));
  const groupMap = new Map<string, string>();
  const ops: ArtifactOp[] = [];
  const sorted = [...els].sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0));
  let z = z0;
  for (const e of sorted) {
    const { key, kind, rev, by, at, ...fields } = e as any;
    const out: Record<string, Json> = { ...fields, z: z++ };
    if (kind === "connector") {
      const ends = ["from", "to"] as const;
      let ok = true;
      for (const end of ends) {
        const ref = fields[end];
        if (typeof ref !== "string") continue;
        if (keyMap.has(ref)) out[end] = keyMap.get(ref)!;
        else if (!exists(ref)) ok = false;
      }
      if (!ok) continue;
      for (const [fx, fy] of [["x1", "y1"], ["x2", "y2"]] as const) {
        if (typeof fields[fx] === "number") out[fx] = fields[fx] + dx;
        if (typeof fields[fy] === "number") out[fy] = fields[fy] + dy;
      }
    } else {
      if (typeof fields.x === "number") out.x = Math.round(fields.x + dx);
      if (typeof fields.y === "number") out.y = Math.round(fields.y + dy);
    }
    if (typeof fields.group === "string") {
      if (!groupMap.has(fields.group)) groupMap.set(fields.group, newElementKey("g"));
      out.group = groupMap.get(fields.group)!;
    }
    ops.push({ k: keyMap.get(key)!, put: { kind, ...out } as any });
  }
  return { ops, keys: ops.map((o) => o.k), map: keyMap };
}

/**
 * The offset that moves a block of new content (its box) off everything
 * already on the board: the nearest clear spot on a ring search outward,
 * preferring down and right. Pasted lists and dropped content land beside
 * what is there, never on top of it.
 */
export function clearOffset(block: Box, taken: readonly Box[], step = 40, maxRings = 30): Pt {
  const gap = 24;
  const hits = (dx: number, dy: number) => {
    const b = { x: block.x + dx - gap, y: block.y + dy - gap, w: block.w + gap * 2, h: block.h + gap * 2 };
    return taken.some((t) => t.x < b.x + b.w && b.x < t.x + t.w && t.y < b.y + b.h && b.y < t.y + t.h);
  };
  if (!hits(0, 0)) return { x: 0, y: 0 };
  for (let ring = 1; ring <= maxRings; ring++) {
    const d = ring * step;
    const candidates: Pt[] = [];
    for (let i = -ring; i <= ring; i++) {
      candidates.push({ x: i * step, y: d }, { x: d, y: i * step }, { x: i * step, y: -d }, { x: -d, y: i * step });
    }
    candidates.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y) || (b.x + b.y) - (a.x + a.y));
    for (const c of candidates) if (!hits(c.x, c.y)) return c;
  }
  return { x: 0, y: 0 };
}

// ── Matrix ────────────────────────────────────────────────────────────────

export type MatrixRow = { label: string; cells: (BoardItem | null)[] };

/** `Row label :: item :: item` per line; `-` leaves a cell empty. */
export function parseMatrix(input: string): MatrixRow[] {
  const out: MatrixRow[] = [];
  for (const raw of input.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [label, ...cells] = line.split(/\s*::\s*/);
    out.push({ label: label.trim(), cells: cells.map((c) => (c.trim() === "-" || !c.trim() ? null : parseItem(c))) });
  }
  return out;
}

export type MatrixOpts = { at: Pt; cols: readonly string[]; cell: { w: number; h: number }; gap: number; title?: string; colColor?: string; zFrame: number; z: number };

/**
 * A grid of rows by columns (a journey map, a comparison, a swimlane plan):
 * a header pill per column, then each row as a titled band holding one item
 * per column. Every cell in a column has the column's width; a row is as tall
 * as its tallest cell, so long text grows its row instead of overflowing.
 */
export function matrixOps(rows: readonly MatrixRow[], opts: MatrixOpts): { ops: ArtifactOp[]; keys: string[] } {
  const ops: ArtifactOp[] = [];
  let z = opts.z;
  const { at, cell, gap } = opts;
  const ncols = Math.max(opts.cols.length, ...rows.map((r) => r.cells.length));
  const pad = 24;
  let y = at.y;
  if (opts.title) {
    ops.push({ k: newElementKey("el"), put: { kind: "text", x: at.x, y, text: opts.title, size: 36, weight: "bold", z: z++ } });
    y += 76;
  }
  const colX = (c: number) => at.x + pad + c * (cell.w + gap);
  opts.cols.forEach((name, c) => {
    ops.push({ k: newElementKey("el"), put: { kind: "shape", shape: "pill", x: colX(c), y, w: cell.w, h: 36, text: name, color: opts.colColor ?? "blue", solid: true, z: z++ } });
  });
  if (opts.cols.length) y += 36 + 48;
  const width = pad * 2 + ncols * cell.w + (ncols - 1) * gap;
  for (const row of rows) {
    const sized = row.cells.map((it) => (it ? resizeItem(it, cell.w, it.kind === "sticky" || it.kind === "shape" ? cell.h : undefined) : null));
    const rowH = Math.max(cell.h, ...sized.map((it) => (it ? it.h : 0)));
    ops.push({ k: newElementKey("el"), put: { kind: "frame", x: at.x, y, w: width, h: rowH + pad * 2, title: row.label, color: "gray", z: opts.zFrame } });
    sized.forEach((it, c) => {
      if (!it) return;
      const k = newElementKey("el");
      const box: Record<string, Json> = it.kind === "stamp" ? {} : { w: it.w, h: it.kind === "sticky" || it.kind === "shape" ? rowH : it.h };
      ops.push({ k, put: { kind: it.kind, x: colX(c), y: y + pad, ...box, ...it.fields, z: z++ } });
    });
    y += rowH + pad * 2 + 52;
  }
  return { ops, keys: ops.map((o) => o.k) };
}
