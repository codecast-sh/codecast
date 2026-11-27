// Board frames (pl-1145): theme frames that fold, reflow and get organized,
// shared by the web board, the CLI verbs and Scribe.
//
// Frame fields (board elements are free-form JSON, so no schema change):
//   ref?: string        a codecast short id (pri-N, in-N, pl-N, ct-N); the title renders as its chip, `title` is the fallback
//   status?: FrameStatus   the discussion tag: open | leaning | decided | parked
//   collapsed?: { w, h, holds }   present while folded: the expanded size and the keys the pill hides
//
// Containment stays geometric: an element belongs to the smallest visible,
// unfolded frame whose box holds it. A folded frame's holds are hidden:
// renderers, hit tests, containment, export and layout skip `hiddenKeys(view)`.
// Held elements keep their coordinates and travel with the pill, so they
// reappear where they were relative to the frame when it opens.
//
// A growing frame never swallows anything: at the top level, whatever it
// newly covers (frames and loose elements alike) moves down just clear of it,
// cascading. A shrink moves nothing; only organizeOps closes gaps.
//
// Every *Ops function returns one batch of set ops, holding only fields that change: apply it with a single
// `live.apply(ops)` (one undo step, one synced change).
//
//   foldedCount(el, get)             the pill's "(n)": held elements on the board, arrows aside
//   hiddenKeys(view)                 keys held by any folded frame (nested folds included)
//   carriedKeys(view, keys)          what moves with a selection: frame contents, nested frames, held keys, arrows whose ends both move
//   moveFrameOps(view, key, dx, dy)  move a frame (or any selection) with everything it carries
//   collapseFrameOps(view, key)      fold into a title pill; the enclosing frame reflows
//   expandFrameOps(view, key)        unfold; the enclosing frame reflows, or at the top level what it now covers moves down
//   reflowFrameOps(view, key)        lay out a frame's children and size it to fit, then settle its level the same way
//   organizeOps(view, opts)          the whole board: agenda frames in the top row, other frames below, loose items gridded under them
import type { ArtifactElement, ArtifactOp, Json } from "./core";
import type { ArtifactView } from "./spec";
import { contains, elementBounds, textWidth, type Box, type Pt } from "./boardGeometry";
import { squareCols, tidyBoxes } from "./boardLayout";

export const FRAME_STATUSES = ["open", "leaning", "decided", "parked"] as const;
export type FrameStatus = (typeof FRAME_STATUSES)[number];
export type FrameCollapsed = { w: number; h: number; holds: string[] };

/** Inside a frame: padding to its edge, the gap between children, and the extra room over the first row for the title. */
export const FRAME_PAD = 40;
export const FRAME_GAP = 24;
export const FRAME_TITLE_BAND = 24;
/** A folded frame is a pill this tall, at least this wide. */
export const FRAME_PILL_H = 48;
export const FRAME_PILL_MIN_W = 260;
/** Between frames on the board (titles draw above a frame's box). */
export const FRAME_SPACING = 80;

type View = Pick<ArtifactView, "elements" | "get">;

export function frameCollapsed(el: ArtifactElement | undefined): FrameCollapsed | null {
  const c = el?.kind === "frame" ? (el.collapsed as any) : null;
  if (!c || typeof c !== "object" || typeof c.w !== "number" || typeof c.h !== "number" || !Array.isArray(c.holds)) return null;
  return { w: c.w, h: c.h, holds: c.holds.filter((k: unknown): k is string => typeof k === "string") };
}

/** What a folded frame's "(n)" counts: the held elements still on the board, arrows aside. One rule for the pill, export and `cast board read`. */
export function foldedCount(el: ArtifactElement, get: (key: string) => ArtifactElement | undefined): number {
  return (frameCollapsed(el)?.holds ?? []).filter((k) => {
    const kind = get(k)?.kind;
    return !!kind && kind !== "connector";
  }).length;
}

export function frameStatus(el: ArtifactElement): FrameStatus | null {
  return (FRAME_STATUSES as readonly unknown[]).includes(el.status) ? (el.status as FrameStatus) : null;
}

export function frameRef(el: ArtifactElement): string | null {
  return typeof el.ref === "string" && el.ref ? el.ref : null;
}

/** Every key a folded frame hides, including what a folded frame inside a folded frame holds. */
export function hiddenKeys(view: Pick<ArtifactView, "elements">): Set<string> {
  const out = new Set<string>();
  for (const e of view.elements) {
    const c = frameCollapsed(e);
    if (c) for (const k of c.holds) if (k !== e.key) out.add(k);
  }
  return out;
}

/** The keys a folded frame hides, followed through folded frames it holds. */
function heldDeep(key: string, collapsedOf: (k: string) => FrameCollapsed | null, out = new Set<string>()): Set<string> {
  for (const k of collapsedOf(key)?.holds ?? []) {
    if (k === key || out.has(k)) continue;
    out.add(k);
    heldDeep(k, collapsedOf, out);
  }
  return out;
}

const area = (b: Box) => b.w * b.h;
const overlap = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0;
const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const inBox = (p: Pt, b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

/** A free connector end (not attached to an element), or null. */
function freeEnd(c: ArtifactElement, end: 1 | 2): Pt | null {
  if (typeof (end === 1 ? c.from : c.to) === "string") return null;
  const x = end === 1 ? c.x1 : c.x2, y = end === 1 ? c.y1 : c.y2;
  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

/**
 * What moves with `keys`: each unfolded frame's visible contents (nested
 * frames too), everything a folded frame among them holds, and arrows whose
 * two ends both move (attached to a moving element, or a free end inside a
 * moving frame). The web's drag and nudge use this as their moving set.
 */
export function carriedKeys(view: Pick<ArtifactView, "elements">, keys: readonly string[]): string[] {
  const hidden = hiddenKeys(view);
  const byKey = new Map(view.elements.map((e) => [e.key, e]));
  const set = new Set(keys);
  const frames: Box[] = [];
  for (const k of keys) {
    const el = byKey.get(k);
    if (el?.kind !== "frame" || hidden.has(k) || frameCollapsed(el)) continue;
    const fb = elementBounds(el);
    frames.push(fb);
    for (const o of view.elements) if (o.kind !== "connector" && o.kind !== "session" && !hidden.has(o.key) && o.key !== k && contains(fb, elementBounds(o))) set.add(o.key);
  }
  for (const k of [...set]) for (const h of heldDeep(k, (x) => frameCollapsed(byKey.get(x)))) set.add(h);
  for (const o of view.elements) {
    if (o.kind !== "connector" || set.has(o.key)) continue;
    const moves = (end: 1 | 2) => {
      const ref = end === 1 ? o.from : o.to;
      if (typeof ref === "string") return set.has(ref);
      const p = freeEnd(o, end);
      return !!p && frames.some((f) => inBox(p, f));
    };
    if (moves(1) && moves(2)) set.add(o.key);
  }
  return [...set];
}

/** Move a frame (or a selection) by dx, dy with everything it carries. */
export function moveFrameOps(view: Pick<ArtifactView, "elements">, key: string | readonly string[], dx: number, dy: number): ArtifactOp[] {
  if (!dx && !dy) return [];
  const byKey = new Map(view.elements.map((e) => [e.key, e]));
  const ops: ArtifactOp[] = [];
  for (const k of carriedKeys(view, typeof key === "string" ? [key] : key)) {
    const el = byKey.get(k);
    if (!el) continue;
    if (el.kind !== "connector") {
      ops.push({ k, set: { x: Math.round(num(el.x) + dx), y: Math.round(num(el.y) + dy) } });
      continue;
    }
    const set: Record<string, Json> = {};
    for (const end of [1, 2] as const) {
      const p = freeEnd(el, end);
      if (p) Object.assign(set, end === 1 ? { x1: p.x + dx, y1: p.y + dy } : { x2: p.x + dx, y2: p.y + dy });
    }
    if (Object.keys(set).length) ops.push({ k, set });
  }
  return ops;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** How wide a folded frame's pill is: room for its title (or ref chip) and status tag. */
export function pillWidth(el: ArtifactElement): number {
  const label = (typeof el.title === "string" && el.title) || frameRef(el) || "Frame";
  return Math.max(FRAME_PILL_MIN_W, Math.round(textWidth(label, 15) + 120));
}

/** Agenda frames: titled "Agenda…", "…agenda", or a person's name ("Ashot", "Ashot's topics"). */
export function isAgendaFrame(el: ArtifactElement, people: readonly string[] = []): boolean {
  const t = (typeof el.title === "string" ? el.title : "").trim().toLowerCase();
  if (!t) return false;
  if (/^agenda\b/.test(t) || /\bagenda$/.test(t)) return true;
  return people.some((p) => {
    const names = [p.trim().toLowerCase(), p.trim().split(/\s+/)[0].toLowerCase()].filter(Boolean);
    return names.some((n) => t === n || t.startsWith(`${n}'s`) || t.startsWith(`${n}’s`));
  });
}

type Node = {
  key: string;
  el: ArtifactElement;
  box: Box;
  /** The box at the start of this layout, for working out where free arrow ends sat. */
  orig: Box;
  kids: Node[];
  parent: Node | null;
  /** Stamps and pen marks sitting on this element: they move with it and are never laid out. */
  riders: string[];
};

/** Rows of boxes whose middles line up, top to bottom, each left to right (as tidyBoxes reads them). */
function readingSort(nodes: readonly Node[]): Node[] {
  const byY = [...nodes].sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2) || a.key.localeCompare(b.key));
  const rows: Node[][] = [];
  for (const n of byY) {
    const row = rows[rows.length - 1];
    const mid = n.box.y + n.box.h / 2;
    const tol = Math.min(row?.[0].box.h ?? 0, n.box.h) / 2;
    // A row is middles that line up, or tops that do (a reflowed row aligns tops), so reflowing twice keeps the order.
    if (row && (Math.abs(mid - (row[0].box.y + row[0].box.h / 2)) < tol || Math.abs(n.box.y - row[0].box.y) < tol)) row.push(n);
    else rows.push([n]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.box.x - b.box.x || a.key.localeCompare(b.key)));
}

/**
 * One layout pass over a board: a tree of visible elements built once from
 * geometry, then edited structurally (so a frame that grows over a sibling
 * never adopts it), then diffed into set ops.
 */
class FrameLayout {
  readonly root: Node;
  readonly nodes = new Map<string, Node>();
  private readonly els: Map<string, ArtifactElement>;
  private readonly delta = new Map<string, Pt>();
  private readonly fields = new Map<string, Record<string, Json>>();
  private readonly collapsedOverride = new Map<string, FrameCollapsed | null>();
  hidden: Set<string>;

  constructor(view: View) {
    this.els = new Map(view.elements.map((e) => [e.key, e]));
    this.hidden = hiddenKeys(view);
    const all = { x: -Infinity, y: -Infinity, w: Infinity, h: Infinity };
    this.root = { key: "", el: { key: "", kind: "root", rev: 0 } as unknown as ArtifactElement, box: all, orig: all, kids: [], parent: null, riders: [] };
    this.plant(this.root, view.elements.filter((e) => !this.hidden.has(e.key)));
  }

  collapsedOf = (key: string): FrameCollapsed | null =>
    this.collapsedOverride.has(key) ? this.collapsedOverride.get(key)! : frameCollapsed(this.els.get(key));

  /** Build the subtree under `root` from `els`: each element under the smallest unfolded frame holding it; stamps and pens on an element ride it. */
  private plant(root: Node, els: readonly ArtifactElement[]) {
    const made: Node[] = [];
    for (const el of els) {
      if (el.kind === "connector" || el.kind === "session") continue;
      const b = elementBounds(el);
      const n: Node = { key: el.key, el, box: { ...b }, orig: { ...b }, kids: [], parent: null, riders: [] };
      made.push(n);
      this.nodes.set(el.key, n);
    }
    const solids = made.filter((n) => n.el.kind !== "frame" && n.el.kind !== "stamp" && n.el.kind !== "pen");
    const frames = made.filter((n) => n.el.kind === "frame" && !this.collapsedOf(n.key));
    for (const n of made) {
      if (n.el.kind === "stamp" || n.el.kind === "pen") {
        const c = { x: n.box.x + n.box.w / 2, y: n.box.y + n.box.h / 2 };
        const on = solids.filter((s) => inBox(c, s.box)).sort((a, b) => area(a.box) - area(b.box))[0];
        if (on) { on.riders.push(n.key); continue; }
      }
      // A frame can hold another frame only if it is bigger (or the same size and earlier), so equal boxes never hold each other.
      const holder = frames
        .filter((f) => f !== n && contains(f.box, n.box) && (n.el.kind !== "frame" || area(f.box) > area(n.box) || (area(f.box) === area(n.box) && f.key < n.key)))
        .sort((a, b) => area(a.box) - area(b.box) || (a.key < b.key ? -1 : 1))[0];
      n.parent = holder ?? root;
      n.parent.kids.push(n);
    }
  }

  private nudge(key: string, dx: number, dy: number) {
    const d = this.delta.get(key) ?? { x: 0, y: 0 };
    this.delta.set(key, { x: d.x + dx, y: d.y + dy });
  }

  /** Move a node with its subtree, riders and (when folded) everything it holds. */
  translate(n: Node, dx: number, dy: number) {
    if (!dx && !dy) return;
    n.box = { ...n.box, x: n.box.x + dx, y: n.box.y + dy };
    this.nudge(n.key, dx, dy);
    for (const r of n.riders) this.nudge(r, dx, dy);
    for (const h of heldDeep(n.key, this.collapsedOf)) this.nudge(h, dx, dy);
    for (const k of n.kids) this.translate(k, dx, dy);
  }

  private setFields(key: string, f: Record<string, Json>) {
    this.fields.set(key, { ...this.fields.get(key), ...f });
  }

  private resize(n: Node, w: number, h: number) {
    n.box = { ...n.box, w: Math.round(w), h: Math.round(h) };
    this.setFields(n.key, { w: n.box.w, h: n.box.h });
  }

  frameNode(key: string, want: "open" | "folded" | "any" = "any"): Node {
    const n = this.nodes.get(key);
    if (!n || n.el.kind !== "frame") throw new Error(`${key} is not a visible frame`);
    const folded = !!this.collapsedOf(key);
    if (want === "open" && folded) throw new Error(`${key} is collapsed`);
    if (want === "folded" && !folded) throw new Error(`${key} is not collapsed`);
    return n;
  }

  /** Lay out a frame's children (text rows first, then a wrapping row flow, both in reading order) and size it to fit. Returns its box before, or null when nothing changed. */
  reflow(n: Node): Box | null {
    if (this.collapsedOf(n.key) || n.kids.length === 0) return null;
    const before = { ...n.box };
    const ordered = readingSort(n.kids);
    const texts = ordered.filter((k) => k.el.kind === "text");
    const rest = ordered.filter((k) => k.el.kind !== "text");
    const left = n.box.x + FRAME_PAD;
    const innerW = Math.max(n.box.w - FRAME_PAD * 2, ...ordered.map((k) => k.box.w));
    let y = n.box.y + FRAME_PAD + FRAME_TITLE_BAND;
    for (const t of texts) {
      this.translate(t, left - t.box.x, y - t.box.y);
      y += t.box.h + FRAME_GAP;
    }
    let x = left, rowH = 0;
    for (const r of rest) {
      if (x > left && x + r.box.w > left + innerW) { y += rowH + FRAME_GAP; x = left; rowH = 0; }
      this.translate(r, x - r.box.x, y - r.box.y);
      x += r.box.w + FRAME_GAP;
      rowH = Math.max(rowH, r.box.h);
    }
    const bottom = rest.length ? y + rowH : y - FRAME_GAP;
    this.resize(n, innerW + FRAME_PAD * 2, bottom + FRAME_PAD - n.box.y);
    return sameBox(before, n.box) ? null : before;
  }

  /**
   * After a frame changed size: its enclosing frame reflows; at the top level,
   * the push rule, judging what is newly covered against `judge` (the box the
   * frame had before the change; for an expand, the box it had before folding).
   */
  settle(n: Node, before: Box, judge: Box = before) {
    if (sameBox(before, n.box)) return;
    const p = n.parent;
    if (p && p !== this.root) {
      const pBefore = { ...p.box };
      this.reflow(p);
      this.settle(p, pBefore);
    } else this.push(n, judge);
  }

  /**
   * Push rule: whatever at the top level a grown frame newly overlaps, or now
   * wholly covers (frames and loose elements alike), moves down just clear of
   * it, and so on for what that then overlaps, so a frame never swallows a
   * person's sticky. A shrink covers nothing new, so it moves nothing.
   */
  push(grown: Node, before: Box) {
    const queue: { n: Node; before: Box }[] = [{ n: grown, before }];
    for (let guard = 0; queue.length && guard < 10_000; guard++) {
      const { n: p, before: pb } = queue.shift()!;
      for (const s of this.root.kids) {
        // Newly overlapped moves, and so does anything now wholly inside, whatever `before` says: a frame never takes in what is not its own.
        if (s === p || s === grown || !overlap(p.box, s.box) || (overlap(pb, s.box) && !contains(p.box, s.box))) continue;
        const dy = p.box.y + p.box.h + (s.el.kind === "frame" ? FRAME_SPACING : FRAME_GAP) - s.box.y;
        if (dy <= 0) continue;
        const sb = { ...s.box };
        this.translate(s, 0, dy);
        queue.push({ n: s, before: sb });
      }
    }
  }

  collapse(n: Node) {
    const before = { ...n.box };
    const holds = new Set<string>();
    const walk = (x: Node) => {
      for (const k of x.kids) { holds.add(k.key); walk(k); }
      for (const r of x.riders) holds.add(r);
    };
    walk(n);
    // Arrows go into the fold when both ends do: attached to a held element (or one a held fold hides), or a free end inside the frame.
    const inside = new Set(holds);
    for (const k of holds) for (const h of heldDeep(k, this.collapsedOf)) inside.add(h);
    for (const c of this.els.values()) {
      if (c.kind !== "connector" || this.hidden.has(c.key)) continue;
      const held = (end: 1 | 2) => {
        const ref = end === 1 ? c.from : c.to;
        if (typeof ref === "string") return inside.has(ref);
        const p = freeEnd(c, end);
        return !!p && inBox(p, before);
      };
      if (held(1) && held(2)) holds.add(c.key);
    }
    const c: FrameCollapsed = { w: before.w, h: before.h, holds: [...holds] };
    this.collapsedOverride.set(n.key, c);
    this.setFields(n.key, { collapsed: c as unknown as Json });
    for (const k of holds) this.hidden.add(k);
    n.kids = [];
    this.resize(n, pillWidth(n.el), FRAME_PILL_H);
    this.settle(n, before);
  }

  expand(n: Node) {
    const c = this.collapsedOf(n.key)!;
    const before = { ...n.box };
    const unfolded = { ...n.box, w: c.w, h: c.h };
    this.collapsedOverride.set(n.key, null);
    this.setFields(n.key, { collapsed: null });
    this.resize(n, c.w, c.h);
    n.orig = { ...n.orig, w: c.w, h: c.h };
    this.hidden = new Set<string>();
    for (const e of this.els.values()) if (e.kind === "frame") for (const h of heldDeep(e.key, this.collapsedOf)) this.hidden.add(h);
    const shown = c.holds.map((k) => this.els.get(k)).filter((e): e is ArtifactElement => !!e && !this.hidden.has(e.key));
    this.plant(n, shown);
    // A pill moved without its holds (an older client) leaves them outside: bring them back in, keeping their arrangement.
    const content = n.kids.map((k) => k.box);
    if (content.some((b) => !contains(n.box, b))) {
      const minX = Math.min(...content.map((b) => b.x)), minY = Math.min(...content.map((b) => b.y));
      const dx = n.box.x + FRAME_PAD - minX, dy = n.box.y + FRAME_PAD + FRAME_TITLE_BAND - minY;
      for (const k of n.kids) this.translate(k, dx, dy);
      const maxX = Math.max(...n.kids.map((k) => k.box.x + k.box.w)), maxY = Math.max(...n.kids.map((k) => k.box.y + k.box.h));
      this.resize(n, Math.max(n.box.w, maxX + FRAME_PAD - n.box.x), Math.max(n.box.h, maxY + FRAME_PAD - n.box.y));
    }
    this.settle(n, before, unfolded);
  }

  organize(people: readonly string[]) {
    const tops = this.root.kids;
    if (tops.length === 0) return;
    const origin = { x: Math.min(...tops.map((t) => t.box.x)), y: Math.min(...tops.map((t) => t.box.y)) };
    // Each frame tidies inside first, deepest first, so a parent lays out its children at their final size.
    const depth = (n: Node) => { let d = 0; for (let p = n.parent; p && p !== this.root; p = p.parent) d++; return d; };
    const open = [...this.nodes.values()].filter((n) => n.el.kind === "frame" && !this.hidden.has(n.key) && !this.collapsedOf(n.key));
    for (const f of open.sort((a, b) => depth(b) - depth(a))) this.reflow(f);

    const frames = readingSort(tops.filter((t) => t.el.kind === "frame"));
    const loose = tops.filter((t) => t.el.kind !== "frame");
    // Cards and pages sit beside the frame nearest to them; everything else loose goes in a grid below.
    const beside = new Map<Node, Node[]>(frames.map((f) => [f, []]));
    const strays: Node[] = [];
    // Nearest by the gap between boxes, so a card already beside a wide frame stays with it.
    const gap = (a: Box, b: Box) => Math.hypot(Math.max(0, a.x - b.x - b.w, b.x - a.x - a.w), Math.max(0, a.y - b.y - b.h, b.y - a.y - a.h));
    for (const l of readingSort(loose)) {
      if (frames.length && (l.el.kind === "card" || l.el.kind === "page")) {
        const near = frames.reduce((a, b) => (gap(b.box, l.box) < gap(a.box, l.box) ? b : a));
        beside.get(near)!.push(l);
      } else strays.push(l);
    }
    const blocks = frames.map((f) => {
      const side = beside.get(f)!;
      const sideW = Math.max(0, ...side.map((s) => s.box.w));
      const sideH = side.reduce((h, s) => h + s.box.h, 0) + Math.max(0, side.length - 1) * FRAME_GAP;
      return { f, side, w: f.box.w + (side.length ? FRAME_PAD + sideW : 0), h: Math.max(f.box.h, sideH) };
    });
    const agenda = blocks.filter((b) => isAgendaFrame(b.f.el, people));
    const topics = blocks.filter((b) => !agenda.includes(b));
    const rowW = (bs: typeof blocks) => bs.reduce((w, b) => w + b.w, 0) + Math.max(0, bs.length - 1) * FRAME_SPACING;
    const maxW = Math.max(rowW(agenda), rowW(topics.slice(0, squareCols(topics.length, 4))), ...blocks.map((b) => b.w));

    const place = (b: (typeof blocks)[number], x: number, y: number) => {
      this.translate(b.f, x - b.f.box.x, y - b.f.box.y);
      let sy = y;
      for (const s of b.side) {
        this.translate(s, x + b.f.box.w + FRAME_PAD - s.box.x, sy - s.box.y);
        sy += s.box.h + FRAME_GAP;
      }
    };
    let y = origin.y;
    if (agenda.length) {
      let x = origin.x;
      for (const b of agenda) { place(b, x, y); x += b.w + FRAME_SPACING; }
      y += Math.max(...agenda.map((b) => b.h)) + FRAME_SPACING;
    }
    let x = origin.x, rowH = 0;
    for (const b of topics) {
      if (x > origin.x && x - origin.x + b.w > maxW) { y += rowH + FRAME_SPACING; x = origin.x; rowH = 0; }
      place(b, x, y);
      x += b.w + FRAME_SPACING;
      rowH = Math.max(rowH, b.h);
    }
    if (rowH) y += rowH + FRAME_SPACING;

    if (strays.length) {
      const at = { x: Math.min(...strays.map((s) => s.box.x)), y: Math.min(...strays.map((s) => s.box.y)) };
      const spots = tidyBoxes(new Map(strays.map((s) => [s.key, s.box])), FRAME_GAP);
      for (const s of strays) {
        const p = spots.get(s.key) ?? at;
        this.translate(s, origin.x + (p.x - at.x) - s.box.x, y + (p.y - at.y) - s.box.y);
      }
    }
  }

  /** The changes as one batch of set ops. */
  ops(): ArtifactOp[] {
    const out = new Map<string, Record<string, Json>>();
    const put = (k: string, f: Record<string, Json>) => out.set(k, { ...out.get(k), ...f });
    const shiftEnds = (c: ArtifactElement, d1: Pt, d2: Pt) => {
      const a = freeEnd(c, 1), b = freeEnd(c, 2);
      if (a && (d1.x || d1.y)) put(c.key, { x1: Math.round(a.x + d1.x), y1: Math.round(a.y + d1.y) });
      if (b && (d2.x || d2.y)) put(c.key, { x2: Math.round(b.x + d2.x), y2: Math.round(b.y + d2.y) });
    };
    for (const [k, d] of this.delta) {
      const el = this.els.get(k);
      if (!el || (!d.x && !d.y)) continue;
      if (el.kind === "connector") shiftEnds(el, d, d);
      else put(k, { x: Math.round(num(el.x) + d.x), y: Math.round(num(el.y) + d.y) });
    }
    // A visible arrow's free end moves with the innermost frame it sat in.
    const frames = [...this.nodes.values()].filter((n) => n.el.kind === "frame" && !this.hidden.has(n.key) && !this.collapsedOf(n.key));
    const zero = { x: 0, y: 0 };
    const endDelta = (p: Pt | null) => {
      if (!p) return zero;
      const f = frames.filter((n) => inBox(p, n.orig)).sort((a, b) => area(a.orig) - area(b.orig))[0];
      return (f && this.delta.get(f.key)) || zero;
    };
    for (const c of this.els.values()) {
      if (c.kind !== "connector" || this.hidden.has(c.key) || this.delta.has(c.key)) continue;
      shiftEnds(c, endDelta(freeEnd(c, 1)), endDelta(freeEnd(c, 2)));
    }
    for (const [k, f] of this.fields) put(k, f);
    // Only what changes: a reflow of a frame already laid out writes nothing.
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const ops: ArtifactOp[] = [];
    for (const [k, f] of out) {
      const el = this.els.get(k);
      const set = Object.fromEntries(Object.entries(f).filter(([field, v]) => !el || !same(el[field], v)));
      if (Object.keys(set).length) ops.push({ k, set });
    }
    return ops;
  }
}

export function collapseFrameOps(view: View, key: string): ArtifactOp[] {
  const l = new FrameLayout(view);
  l.collapse(l.frameNode(key, "open"));
  return l.ops();
}

export function expandFrameOps(view: View, key: string): ArtifactOp[] {
  const l = new FrameLayout(view);
  l.expand(l.frameNode(key, "folded"));
  return l.ops();
}

export function reflowFrameOps(view: View, key: string): ArtifactOp[] {
  const l = new FrameLayout(view);
  const n = l.frameNode(key, "open");
  const before = l.reflow(n);
  if (before) l.settle(n, before);
  return l.ops();
}

/** The whole board in one batch: `people` names the team, so a frame titled with a person's name counts as their agenda. */
export function organizeOps(view: View, opts: { people?: readonly string[] } = {}): ArtifactOp[] {
  const l = new FrameLayout(view);
  l.organize(opts.people ?? []);
  return l.ops();
}
