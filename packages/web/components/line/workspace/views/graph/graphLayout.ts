// Where the Graph view draws each step (line-workspace.md LW1), computed from
// the graph so any project's line lays out well. Pure geometry over the
// model's graph: the canvas paints it, the tests read it, the keyboard walks it.
//
// The line reads as Studio drew AgentWatch: a lane per half (Diagnose, Fix),
// and in each lane the spine, the longest way through the steps, along one
// baseline. Steps off the spine (a person's other answers, a revise) sit in
// lanes under the spine step of their column. A run's ends are chips under
// the step that ends it (All steps) or words under it ("can end: dissolved 3",
// Essence). A lane wider than `wrap` folds onto rows, preferring a stage
// boundary, and the spine wraps between rows down the left channel. A loop or
// a skip along the spine arcs over the row; anything between rows curves.
// Column gaps grow to hold the branch words drawn in them.
//
// Essence draws scripts as dots and hides the long ways round (a loop back,
// a skip, an edge across rows) until a step they touch is hovered, selected
// or lit by a run; All steps draws
// every script as a mono box and every end as a chip.
import type { EdgeKind, LineGraphModel, LineHalf, ModelNode, StepKind } from "../../../../../lib/line/lineModel";
import type { GraphEnd } from "../../../../../lib/line/lineGraphs";
import { backOfWords } from "../../../../../lib/line/lineActions";

export type GraphMode = "essence" | "all";
export type LayoutOpts = { mode: GraphMode; /** Widest a row may grow before it folds, in canvas units. */ wrap?: number };

export type GNode = {
  id: string;
  kind: StepKind;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Essence draws a script as a dot, its name under it. */
  dot: boolean;
  /** A dot's name, folded onto at most two lines. */
  lines: string[];
  /** How many times runs ran it, loops counted: a script says "ran 25×". */
  ran: number;
  row: number;
  lane: number;
  spine: boolean;
  end: GraphEnd | null;
};

export type GEdgeShape = "next" | "skip" | "back" | "side" | "wrap" | "cross" | "end";
export type GLabel = { x: number; y: number; w: number; text: string };
export type GEdge = {
  id: string;
  from: string;
  to: string;
  d: string;
  shape: GEdgeShape;
  kind: EdgeKind;
  gate: boolean;
  words: string | null;
  count: number;
  /** Drawn only when a step it touches is hovered, selected or lit (Essence's script loops). */
  quiet: boolean;
  label: GLabel | null;
};

/** One end a step can send a run to: how many runs it sent there, and how many of those closed a problem that came back. */
export type GExit = { label: string; end: GraphEnd; count: number; back: number };

/** What came back of an end's closes (lineActions backOfWords). */
export const exitBackWords = (x: Pick<GExit, "count" | "back">) => backOfWords(x.count, x.back);
/** One end in words: "dissolved 6, 3 came back", "dissolved 6, all came back". */
export const exitWord = (x: GExit) => `${x.label}${x.count ? ` ${x.count}` : ""}${exitBackWords(x)}`;
/** A step's ends as GraphCanvas draws them after "can end:", so the layout gives them room. */
export const exitWords = (list: ReadonlyArray<GExit>) => list.map(exitWord).join(" · ");

/** Essence's exits: each drawn step's ends in words, read off the model's edges. The layout reads it for room and the canvas
 *  reads it again per model, since a layout is shared by every model of the same shape and its counts would be the first one's. */
export function essenceExits(g: Pick<LineGraphModel, "nodes" | "edges">, drawn: (id: string) => boolean): Map<string, GExit[]> {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const exits = new Map<string, GExit[]>();
  for (const e of g.edges) {
    const to = byId.get(e.to);
    if (!to || to.kind !== "end" || !drawn(e.from)) continue;
    const list = exits.get(e.from) ?? [];
    const label = to.label.toLowerCase();
    const had = list.find((x) => x.label === label);
    if (had) { had.count += e.count; had.back += e.back; }
    else list.push({ label, end: to.end ?? "stopped", count: e.count, back: e.back });
    exits.set(e.from, list);
  }
  return exits;
}
const EXIT_PX = 14;
export type GLane = { half: LineHalf; label: string; sub: string; x: number; y: number; w: number; h: number };
export type GStage = { label: string; x: number; y: number };
export type GTerminus = { x: number; y: number; label: string };

export type GraphLayout = {
  mode: GraphMode;
  nodes: Map<string, GNode>;
  list: GNode[];
  edges: GEdge[];
  /** Essence: the ends a step can send a run to, in words. */
  exits: Map<string, GExit[]>;
  lanes: GLane[];
  stages: GStage[];
  entry: GTerminus | null;
  finish: (GTerminus & { from: string; d: string }) | null;
  entryEdge: string | null;
  bounds: { x: number; y: number; w: number; h: number };
  /** Every drawn step in reading order (← →), and only its agents and people (⇧ ← →). */
  walk: string[];
  actors: string[];
};

// ── sizes ────────────────────────────────────────────────────────────────────

// Every node's words are sized to read at 12px or more at the smallest zoom a
// fit picks (usePanZoom FIT_MIN_K), so the sizes here follow the type.
const SIZE: Record<GraphMode, Record<"agent" | "person", [number, number]>> = {
  essence: { agent: [224, 74], person: [224, 66] },
  all: { agent: [204, 68], person: [208, 62] },
};
const DOT = 12;
/** A script box: its >_ glyph, its name, and "ran 25×" under it. */
const SCRIPT_H = 48;
export const SCRIPT_PX = 14;
const SCRIPT_GLYPH = 26;
const CHIP_H = 26;
export const CHIP_PX = 14;
/** Text widths, by the UI font's average advance at each size. */
export const textW = (s: string, px: number, mono = false) => Math.ceil(s.length * px * (mono ? 0.62 : 0.6));
export const LABEL_PX = 13;
export const labelW = (s: string) => textW(s, LABEL_PX) + 12;
export const DOT_PX = 14;
export const DOT_LINE = 18;

const ROW_X = 128;
const LANE_PAD_X = 22;
/** Where the spine's fold into the next lane runs down: left of every frame. */
const OUTER_CHANNEL_X = -18;
const COL_GAP = 46;
const LANE_PITCH: Record<GraphMode, number> = { essence: 118, all: 100 };
const TITLE_ROOM = 64;
const ROW_TOP = 26;
const ROW_FOOT = 28;
const ROW_GAP = 46;
const HALF_GAP = 30;
const EXIT_ROOM = 28;
const WRAP: Record<GraphMode, number> = { essence: 1950, all: 2900 };
const R = 14;

const HALF_WORDS: Record<LineHalf, { label: string; sub: string }> = {
  diagnose: { label: "Diagnose", sub: "Is there anything to fix, and what causes it?" },
  fix: { label: "Fix", sub: "A person approves, an agent builds, checks prove it, a person ships it." },
};

/** A dot's name on at most two lines of about fourteen characters. */
function foldName(s: string, max = 15): string[] {
  if (s.length <= max) return [s];
  const words = s.split(/\s+/);
  const lines: string[] = [""];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (!cur) lines[lines.length - 1] = w;
    else if (`${cur} ${w}`.length <= max) lines[lines.length - 1] = `${cur} ${w}`;
    else if (lines.length < 2) lines.push(w);
    else { lines[1] = `${lines[1]} ${w}`; }
  }
  if (lines[1] && lines[1].length > max) lines[1] = `${lines[1].slice(0, max - 1)}…`;
  return lines;
}

/** A script's run count in words, under its name. */
export const ranWords = (n: number) => `ran ${n}×`;

function sizeOf(n: ModelNode, mode: GraphMode): { w: number; h: number; dot: boolean; lines: string[] } {
  if (n.kind === "agent" || n.kind === "person") { const [w, h] = SIZE[mode][n.kind]; return { w, h, dot: false, lines: [] }; }
  if (n.kind === "end") return { w: Math.max(64, textW(n.label.toLowerCase(), CHIP_PX) + 24), h: CHIP_H, dot: false, lines: [] };
  if (mode === "essence") return { w: DOT, h: DOT, dot: true, lines: foldName(n.label) };
  return { w: Math.max(96, SCRIPT_GLYPH + Math.max(textW(n.label, SCRIPT_PX, true), textW(ranWords(n.visits), SCRIPT_PX)) + 24), h: SCRIPT_H, dot: false, lines: [] };
}

/** The room a node takes across its column: a dot's name is wider than the dot. */
const colWidthOf = (n: GNode) => (n.dot ? Math.max(28, ...n.lines.map((l) => textW(l, DOT_PX) + 8)) : n.w);
/** How far under a node's center its own marks reach (a dot's name). */
const footOf = (n: GNode) => (n.dot ? n.h / 2 + 8 + (n.lines.length + (n.ran ? 1 : 0)) * DOT_LINE : n.h / 2);

// ── geometry helpers ─────────────────────────────────────────────────────────

type Pt = { x: number; y: number };
const cubicMid = (p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt => ({ x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8, y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8 });
const r1 = (v: number) => Math.round(v * 10) / 10;
const cubic = (p0: Pt, p1: Pt, p2: Pt, p3: Pt) => `M${r1(p0.x)},${r1(p0.y)} C${r1(p1.x)},${r1(p1.y)} ${r1(p2.x)},${r1(p2.y)} ${r1(p3.x)},${r1(p3.y)}`;
const right = (n: GNode): Pt => ({ x: n.x + n.w / 2, y: n.y });
const left = (n: GNode): Pt => ({ x: n.x - n.w / 2, y: n.y });
const top = (n: GNode): Pt => ({ x: n.x, y: n.y - n.h / 2 });
const bottom = (n: GNode): Pt => ({ x: n.x, y: n.y + footOf(n) });

/** How high an arc over the row lifts for a span of `dx`. */
export const arcLift = (dx: number) => Math.min(112, 42 + Math.abs(dx) * 0.11);

// ── the cache ────────────────────────────────────────────────────────────────

/** The shape a layout depends on: steps, their kinds, columns, halves and labels, and the edges. Counts are not in it. */
export function graphShapeSig(g: LineGraphModel): string {
  return `${g.nodes.map((n) => `${n.id}:${n.kind}:${n.col}:${n.half}:${n.stage}:${n.label}`).join("|")}#${g.edges.map((e) => `${e.id}:${e.kind}:${e.words ?? ""}`).join("|")}`;
}

const byGraph = new WeakMap<LineGraphModel, Map<string, GraphLayout>>();
const byShape = new Map<string, GraphLayout>();
const SHAPE_CACHE = 24;

/** The layout of a graph, computed once per shape: a model rebuilt for new runs reuses it. */
export function graphLayout(g: LineGraphModel, opts: LayoutOpts): GraphLayout {
  const optKey = `${opts.mode}:${opts.wrap ?? ""}`;
  const hit = byGraph.get(g)?.get(optKey);
  if (hit) return hit;
  const sig = `${optKey}#${graphShapeSig(g)}`;
  let laid = byShape.get(sig);
  if (!laid) {
    laid = computeLayout(g, opts);
    byShape.set(sig, laid);
    if (byShape.size > SHAPE_CACHE) byShape.delete(byShape.keys().next().value!);
  }
  const per = byGraph.get(g) ?? new Map<string, GraphLayout>();
  per.set(optKey, laid);
  byGraph.set(g, per);
  return laid;
}

// ── the layout ───────────────────────────────────────────────────────────────

type ColSlot = { col: number; nodes: GNode[]; width: number; stage: string | null };

/** Fold a lane's columns onto rows: the fewest rows no wider than `wrap`,
 *  then rows of even width, then folds at a stage boundary. */
function foldRows(slots: ColSlot[], wrap: number, gapAfter: (a: ColSlot, b: ColSlot | undefined) => number): ColSlot[][] {
  const n = slots.length;
  const start = [0];
  for (let i = 0; i < n; i++) start.push(start[i] + slots[i].width + gapAfter(slots[i], slots[i + 1]));
  const width = (j: number, i: number) => start[i] - start[j] - gapAfter(slots[i - 1], slots[i]);
  const best: number[] = [0];
  const from: number[] = [0];
  for (let i = 1; i <= n; i++) {
    best[i] = Infinity;
    for (let j = 0; j < i; j++) {
      const w = width(j, i);
      if (w > wrap && i - j > 1) continue;
      const boundary = i === n || (slots[i].stage != null && slots[i - 1].stage != null && slots[i].stage !== slots[i - 1].stage);
      const cost = best[j] + 1e6 + (w / wrap) ** 2 * 1e5 + (boundary ? 0 : 2.5e4);
      if (cost < best[i]) { best[i] = cost; from[i] = j; }
    }
  }
  const out: ColSlot[][] = [];
  for (let i = n; i > 0; i = from[i]) out.unshift(slots.slice(from[i], i));
  return out;
}

export function computeLayout(g: LineGraphModel, opts: LayoutOpts): GraphLayout {
  const mode = opts.mode;
  const wrap = opts.wrap ?? WRAP[mode];
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const core = g.nodes.filter((n) => n.kind !== "end");
  const coreIds = new Set(core.map((n) => n.id));
  const orderIdx = new Map(g.nodes.map((n, i) => [n.id, i]));

  // ── the spine: from the first step, the successor with the longest way on ──
  const fwd = new Map<string, Array<{ to: string; count: number; flow: boolean }>>();
  for (const e of g.edges) {
    if (e.kind === "loop" || !coreIds.has(e.from) || !coreIds.has(e.to)) continue;
    const list = fwd.get(e.from) ?? [];
    list.push({ to: e.to, count: e.count, flow: e.kind === "flow" });
    fwd.set(e.from, list);
  }
  const height = new Map<string, number>();
  const visiting = new Set<string>();
  const heightOf = (id: string): number => {
    const h = height.get(id);
    if (h != null) return h;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let best = 0;
    for (const s of fwd.get(id) ?? []) best = Math.max(best, 1 + heightOf(s.to));
    visiting.delete(id);
    height.set(id, best);
    return best;
  };
  const firstCore = [...core].sort((a, b) => a.col - b.col || orderIdx.get(a.id)! - orderIdx.get(b.id)!)[0];
  const spine: string[] = [];
  const onSpine = new Set<string>();
  for (let cur = firstCore?.id; cur && !onSpine.has(cur);) {
    spine.push(cur);
    onSpine.add(cur);
    const next = [...(fwd.get(cur) ?? [])].filter((s) => !onSpine.has(s.to))
      .sort((a, b) => heightOf(b.to) - heightOf(a.to) || b.count - a.count || Number(b.flow) - Number(a.flow))[0];
    cur = next?.to;
  }
  const spineNext = new Set(spine.slice(1).map((id, i) => `${spine[i]}->${id}`));

  // ── nodes, sized ──
  const nodes = new Map<string, GNode>();
  for (const n of g.nodes) {
    if (n.kind === "end" && mode === "essence") continue;
    const s = sizeOf(n, mode);
    nodes.set(n.id, { id: n.id, kind: n.kind, label: n.label, x: 0, y: 0, w: s.w, h: s.h, dot: s.dot, lines: s.lines, ran: n.visits, row: 0, lane: 0, spine: onSpine.has(n.id), end: n.end });
  }

  // ── Essence's exits: a step's ends in words ──
  const exits = mode === "essence" ? essenceExits(g, (id) => nodes.has(id)) : new Map<string, GExit[]>();
  // A dot's "can end:" sits over its ends on a line of their own; a card's is one line.
  const exitRoom = (n: GNode) => (exits.has(n.id) ? EXIT_ROOM + (n.dot ? DOT_LINE : 0) : 0);

  // ── words drawn on an edge, and which ──
  const outDeg = new Map<string, number>();
  for (const e of g.edges) outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
  // Two steps handing on to one step for the same reason ("done" from Implement and from Build line) say it once:
  // on the edge from the step that ran most, so the words sit where the work went.
  const sayer = new Map<string, { id: string; ran: number }>();
  for (const e of g.edges) {
    if (!e.words) continue;
    const key = `${e.to}|${e.words}`;
    const ran = byId.get(e.from)?.visits ?? 0;
    const was = sayer.get(key);
    if (!was || ran > was.ran) sayer.set(key, { id: e.id, ran });
  }
  const labeled = (e: LineGraphModel["edges"][number]) => {
    if (!e.words) return false;
    if (sayer.get(`${e.to}|${e.words}`)?.id !== e.id) return false;
    const from = byId.get(e.from);
    if (!from || !nodes.has(e.to)) return false;
    if (from.kind === "agent" || from.kind === "person") return true;
    return mode === "all" && (outDeg.get(e.from) ?? 0) > 1;
  };

  // ── columns per half, folded onto rows ──
  const halves: LineHalf[] = ["diagnose", "fix"];
  const halfCols = new Map<LineHalf, ColSlot[]>();
  for (const half of halves) {
    const inHalf = core.filter((n) => n.half === half);
    const cols = [...new Set(inHalf.map((n) => n.col))].sort((a, b) => a - b);
    halfCols.set(half, cols.map((c) => {
      const ns = inHalf.filter((n) => n.col === c).sort((a, b) => Number(onSpine.has(b.id)) - Number(onSpine.has(a.id)) || orderIdx.get(a.id)! - orderIdx.get(b.id)!).map((n) => nodes.get(n.id)!);
      const sp = ns.find((n) => n.spine);
      // A dot's "can end:" words sit centered under it and take room across its
      // column, so two never run together; a card's start at its left edge and
      // stay within the gap after it.
      const widthOf = (n: GNode) => Math.max(colWidthOf(n), n.dot && exits.has(n.id) ? textW(exitWords(exits.get(n.id)!), EXIT_PX) + 8 : 0);
      return { col: c, nodes: ns, width: Math.max(...ns.map(widthOf)), stage: sp ? byId.get(sp.id)!.stage : null };
    }));
  }
  /** The gap after a column: room for the words of a spine edge drawn in it. */
  const gapAfter = (slot: ColSlot, next: ColSlot | undefined) => {
    if (!next) return 0;
    let need = COL_GAP;
    for (const e of g.edges) {
      if (!spineNext.has(e.id) || !labeled(e)) continue;
      if (slot.nodes.some((n) => n.id === e.from) && next.nodes.some((n) => n.id === e.to)) need = Math.max(need, labelW(e.words!) + 30);
    }
    return need;
  };

  type Row = { half: LineHalf; slots: ColSlot[]; first: boolean };
  const rows: Row[] = [];
  for (const half of halves) {
    const slots = halfCols.get(half)!;
    if (!slots.length) continue;
    for (const [k, part] of foldRows(slots, wrap, gapAfter).entries()) rows.push({ half, slots: part, first: k === 0 });
  }

  // ── x by column, lanes under the spine ──
  rows.forEach((row, ri) => {
    let x = ROW_X;
    row.slots.forEach((slot, j) => {
      const cx = x + slot.width / 2;
      let lane = 1;
      for (const n of slot.nodes) {
        n.x = cx;
        n.row = ri;
        if (n.spine) n.lane = 0;
        else n.lane = lane++;
      }
      x += slot.width + gapAfter(slot, row.slots[j + 1]);
    });
  });
  const rowWidth = rows.map((row) => row.slots.reduce((sum, s, j) => sum + s.width + gapAfter(s, row.slots[j + 1]), 0));

  // ── arcs over each row: room for the tallest ──
  const arcRoom = rows.map(() => 0);
  for (const e of g.edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b || a.row !== b.row || a.lane !== 0 || b.lane !== 0 || spineNext.has(e.id)) continue;
    arcRoom[a.row] = Math.max(arcRoom[a.row], arcLift(b.x - a.x) * 0.75 + (labeled(e) ? 12 : 4));
  }

  // ── y: rows stacked, a half's rows inside its lane ──
  const lanes: GLane[] = [];
  const stages: GStage[] = [];
  const pitch = LANE_PITCH[mode];
  let y = 0;
  let laneStart = 0;
  const maxRowW = Math.max(0, ...rowWidth);
  rows.forEach((row, ri) => {
    if (row.first && ri > 0) y += HALF_GAP;
    if (row.first) laneStart = y;
    const members = row.slots.flatMap((s) => s.nodes);
    const spineH = Math.max(0, ...members.filter((n) => n.lane === 0).map((n) => n.h));
    const head = (row.first ? TITLE_ROOM : ROW_TOP) + (mode === "all" ? 14 : 0);
    const baseline = y + head + Math.max(arcRoom[ri], 18) + spineH / 2;
    let bottomY = baseline;
    for (const n of members) {
      n.y = baseline + n.lane * pitch;
      bottomY = Math.max(bottomY, n.y + footOf(n) + exitRoom(n));
    }
    // Stage names over the row, where a stage's first spine step sits (All steps).
    if (mode === "all") {
      let last: string | null = null;
      for (const s of row.slots) {
        if (!s.stage || s.stage === last) continue;
        last = s.stage;
        const sp = s.nodes.find((n) => n.spine)!;
        const label = g.stages.find((st) => st.key === s.stage)?.label ?? s.stage;
        stages.push({ label, x: sp.x - sp.w / 2, y: baseline - spineH / 2 - Math.max(arcRoom[ri], 18) - 6 });
      }
    }
    // Ends: chips under the step that ends the run, spread side by side.
    if (mode === "all") {
      const placedRects: Array<{ x: number; y: number; w: number; h: number }> = members.map((n) => ({ x: n.x - colWidthOf(n) / 2, y: n.y - n.h / 2, w: colWidthOf(n), h: footOf(n) + n.h / 2 }));
      for (const p of members) {
        const ends = g.edges.filter((e) => e.from === p.id && byId.get(e.to)?.kind === "end" && !nodes.get(e.to)!.y).map((e) => nodes.get(e.to)!);
        if (!ends.length) continue;
        const total = ends.reduce((s, n) => s + n.w, 0) + (ends.length - 1) * 8;
        let ey = p.y + footOf(p) + 30 + CHIP_H / 2;
        const clash = (yy: number, x0: number) => placedRects.some((r) => x0 < r.x + r.w + 4 && x0 + total > r.x - 4 && yy - CHIP_H / 2 < r.y + r.h + 4 && yy + CHIP_H / 2 > r.y - 4);
        let x0 = p.x - total / 2;
        for (let tries = 0; tries < 4 && clash(ey, x0); tries++) ey += pitch * 0.62;
        for (const n of ends) {
          n.x = x0 + n.w / 2;
          n.y = ey;
          n.row = ri;
          n.lane = p.lane + 1;
          x0 += n.w + 8;
          placedRects.push({ x: n.x - n.w / 2, y: n.y - n.h / 2, w: n.w, h: n.h });
          bottomY = Math.max(bottomY, n.y + n.h / 2);
        }
      }
    }
    y = bottomY + ROW_FOOT;
    const lastOfHalf = !rows[ri + 1] || rows[ri + 1].half !== row.half;
    if (lastOfHalf) {
      lanes.push({ half: row.half, ...HALF_WORDS[row.half], x: 0, y: laneStart, w: ROW_X + maxRowW + 70 + LANE_PAD_X, h: y - laneStart });
    } else y += ROW_GAP;
  });
  // Ends no step in a row reached (an orphan end): under the last row.
  for (const n of nodes.values()) {
    if (n.kind === "end" && !n.y) { n.x = ROW_X + 40; n.y = y + 20; y += CHIP_H + 10; }
  }

  // ── edges ──
  const edges: GEdge[] = [];
  const channelX = 12;
  /** Between two rows, the y the spine's wrap runs along. */
  const gapBelow = (ri: number) => {
    const membersBelow = rows[ri + 1]?.slots.flatMap((s) => s.nodes) ?? [];
    const lowest = Math.max(...[...nodes.values()].filter((n) => n.row === ri).map((n) => n.y + footOf(n) + exitRoom(n)));
    const nextTop = Math.min(...membersBelow.map((n) => n.y - n.h / 2), lowest + 120);
    return (lowest + nextTop) / 2 - (rows[ri + 1]?.first ? 18 : 6);
  };
  for (const e of g.edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) continue;
    const words = e.words;
    const wantLabel = labeled(e);
    const fromKind = byId.get(e.from)?.kind;
    let quiet = mode === "essence" && e.kind === "loop" && fromKind === "script";
    let d: string;
    let shape: GEdgeShape;
    let at: Pt | null = null;
    let labelOk = wantLabel;
    if (b.kind === "end") {
      const p0 = bottom(a);
      const p3 = top(b);
      const my = (p0.y + p3.y) / 2;
      d = cubic(p0, { x: p0.x, y: my }, { x: p3.x, y: my }, p3);
      shape = "end";
      labelOk = false;
    } else if (a.row === b.row) {
      if (a.lane === 0 && b.lane === 0 && spineNext.has(e.id)) {
        const p0 = right(a);
        const p3 = left(b);
        d = `M${r1(p0.x)},${r1(p0.y)} L${r1(p3.x)},${r1(p3.y)}`;
        shape = "next";
        at = { x: (p0.x + p3.x) / 2, y: p0.y - 10 };
        if (p3.x - p0.x < labelW(words ?? "") + 10) labelOk = false;
      } else if (a.lane === 0 && b.lane === 0) {
        const back = b.x < a.x;
        const off = (n: GNode) => Math.min(24, n.w / 2 - 6);
        const p0 = { x: a.x + (back ? -off(a) : off(a)), y: a.y - a.h / 2 };
        const p3 = { x: b.x + (back ? off(b) : -off(b)), y: b.y - b.h / 2 };
        const lift = arcLift(p3.x - p0.x);
        const p1 = { x: p0.x, y: p0.y - lift };
        const p2 = { x: p3.x, y: p3.y - lift };
        d = cubic(p0, p1, p2, p3);
        shape = back ? "back" : "skip";
        at = cubicMid(p0, p1, p2, p3);
      } else if (Math.abs(a.x - b.x) < 30) {
        const down = b.y > a.y;
        const p0 = down ? bottom(a) : top(a);
        const p3 = down ? top(b) : bottom(b);
        d = `M${r1(p0.x)},${r1(p0.y)} L${r1(p3.x)},${r1(p3.y)}`;
        shape = "side";
        at = { x: p0.x + 8, y: (p0.y + p3.y) / 2 };
      } else if (b.x > a.x) {
        const roomy = left(b).x > right(a).x + 24;
        const p0 = roomy ? right(a) : b.y > a.y ? bottom(a) : top(a);
        const p3 = left(b);
        const p1 = roomy ? { x: (p0.x + p3.x) / 2, y: p0.y } : { x: p0.x, y: p3.y };
        const p2 = roomy ? { x: (p0.x + p3.x) / 2, y: p3.y } : { x: p0.x + 10, y: p3.y };
        d = cubic(p0, p1, p2, p3);
        shape = "side";
        at = cubicMid(p0, p1, p2, p3);
      } else {
        // Back and to another lane: out of the step's left, into the target's underside.
        const lower = a.y > b.y;
        const p0 = left(a);
        const p3 = lower ? { x: b.x, y: b.y + b.h / 2 } : top(b);
        const p1 = { x: p0.x - 50, y: p0.y };
        const p2 = { x: p3.x, y: p3.y + (lower ? 60 : -60) };
        d = cubic(p0, p1, p2, p3);
        shape = e.kind === "loop" ? "back" : "side";
        at = cubicMid(p0, p1, p2, p3);
      }
    } else if (spineNext.has(e.id) && b.row === a.row + 1) {
      // The spine folds onto the next row: out to the right, along the gap, down the left channel.
      const p0 = right(a);
      const xr = p0.x + 34;
      const gy = gapBelow(a.row);
      const p3 = left(b);
      // Into the next lane, the channel runs outside the frames, so it crosses the new frame's border rather than tracing it.
      const cx = rows[b.row]?.first ? OUTER_CHANNEL_X : channelX;
      d = `M${r1(p0.x)},${r1(p0.y)} L${r1(xr - R)},${r1(p0.y)} Q${r1(xr)},${r1(p0.y)} ${r1(xr)},${r1(p0.y + R)} L${r1(xr)},${r1(gy - R)} Q${r1(xr)},${r1(gy)} ${r1(xr - R)},${r1(gy)} L${r1(cx + R)},${r1(gy)} Q${r1(cx)},${r1(gy)} ${r1(cx)},${r1(gy + R)} L${r1(cx)},${r1(p3.y - R)} Q${r1(cx)},${r1(p3.y)} ${r1(cx + R)},${r1(p3.y)} L${r1(p3.x)},${r1(p3.y)}`;
      shape = "wrap";
      at = { x: (xr + channelX) / 2, y: gy - 9 };
    } else if (b.row > a.row) {
      const p0 = bottom(a);
      const p3 = top(b);
      d = cubic(p0, { x: p0.x, y: p0.y + 130 }, { x: p3.x, y: p3.y - 130 }, p3);
      shape = "cross";
      at = cubicMid(p0, { x: p0.x, y: p0.y + 130 }, { x: p3.x, y: p3.y - 130 }, p3);
    } else {
      // Back up to an earlier row: out of the top, into the target's underside.
      const p0 = top(a);
      const p3 = { x: b.x, y: b.y + footOf(b) + exitRoom(b) };
      const p1 = { x: p0.x, y: p0.y - 120 };
      const p2 = { x: p3.x, y: p3.y + 150 };
      d = cubic(p0, p1, p2, p3);
      shape = "back";
      at = cubicMid(p0, p1, p2, p3);
    }
    // Essence keeps the long ways round (back, skip, across rows) out of sight until a step they touch is hovered or selected.
    if (mode === "essence" && (shape === "back" || shape === "skip" || shape === "cross")) quiet = true;
    const label = labelOk && words && at ? { x: r1(at.x), y: r1(at.y), w: labelW(words), text: words } : null;
    edges.push({ id: e.id, from: e.from, to: e.to, d, shape, kind: e.kind, gate: e.gate, words, count: e.count, quiet, label });
  }

  spreadLabels(edges);

  // ── where a problem comes in, and where a fixed one leaves ──
  const firstNode = spine[0] ? nodes.get(spine[0]) : undefined;
  const lastNode = spine.length ? nodes.get(spine[spine.length - 1]) : undefined;
  const entry = firstNode ? { x: firstNode.x - colWidthOf(firstNode) / 2 - 44, y: firstNode.y, label: "a problem" } : null;
  const finish = lastNode && lastNode.id !== firstNode?.id ? (() => {
    const p0 = right(lastNode);
    const x = p0.x + 62;
    return { x, y: lastNode.y, label: "fixed", from: lastNode.id, d: `M${r1(p0.x + (lastNode.dot ? 4 : 0))},${r1(p0.y)} L${r1(x - 14)},${r1(p0.y)}` };
  })() : null;

  const list = [...nodes.values()].sort((p, q) => orderIdx.get(p.id)! - orderIdx.get(q.id)!);
  const xs = list.flatMap((n) => [n.x - colWidthOf(n) / 2, n.x + colWidthOf(n) / 2]);
  const maxX = Math.max(...lanes.map((l) => l.x + l.w), ...xs, finish ? finish.x + 30 : 0);
  const bounds = { x: OUTER_CHANNEL_X - 10, y: -10, w: maxX - OUTER_CHANNEL_X + 20, h: y + 10 };
  const walk = list.filter((n) => n.kind !== "end" || mode === "all").map((n) => n.id);
  return {
    mode, nodes, list, edges, exits, lanes, stages, entry, finish,
    entryEdge: firstNode && entry ? `M${r1(entry.x + 8)},${r1(entry.y)} L${r1(firstNode.x - firstNode.w / 2)},${r1(entry.y)}` : null,
    bounds, walk, actors: walk.filter((id) => { const k = nodes.get(id)!.kind; return k === "agent" || k === "person"; }),
  };
}

const LABEL_H = 17;

/**
 * Edge labels that would print over each other (parallel back edges whose
 * midpoints meet, as on Codecast's line's Fix band) step apart vertically:
 * each label, in reading order, moves to the nearest free row above or below
 * where it sat, so every one stays readable and close to its edge.
 */
export function spreadLabels(edges: GEdge[]): void {
  const placed: GLabel[] = [];
  const hits = (l: GLabel, y: number) => placed.some((p) => Math.abs(p.x - l.x) < (p.w + l.w) / 2 + 4 && Math.abs(p.y - y) < LABEL_H + 1);
  const labels = edges.map((e) => e.label).filter((l): l is GLabel => !!l).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const l of labels) {
    let y = l.y;
    for (let k = 1; hits(l, y) && k <= 12; k++) y = l.y + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (LABEL_H + 2);
    l.y = r1(y);
    placed.push(l);
  }
}

/** Do two drawn steps overlap (for tests and the fit check)? */
export function overlaps(a: Pick<GNode, "x" | "y" | "w" | "h">, b: Pick<GNode, "x" | "y" | "w" | "h">, pad = 0): boolean {
  return Math.abs(a.x - b.x) * 2 < a.w + b.w + pad * 2 && Math.abs(a.y - b.y) * 2 < a.h + b.h + pad * 2;
}

/** The ends' colors and their words: dissolved settles, a stop is a warning, a ship is the line's own warmth. */
export const END_TONE: Record<GraphEnd, "ok" | "warn" | "agent" | "plain" | "person"> = {
  dissolved: "ok", stopped: "warn", shipped: "agent", dropped: "plain", parked: "person",
};
