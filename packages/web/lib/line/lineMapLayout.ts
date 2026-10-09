// Where each node of the line map sits and how each edge runs between them
// (docs/architecture/line-map.md LX2). Pure geometry over a LineMap: the map
// component paints it, the tests read it, and the keyboard walks it.
//
// Columns come from the map (lineMap `col`, the longest path from the left).
// The path every cause takes runs along the top lane, right under the phase
// names, so it is the first thing a reader meets. Branches sit under it: the
// ones that come back into the line (plan, park, reopen) in the lane just
// below, the ones that leave it (dissolve, drop, the ends) under those, and a
// lane nothing uses closes up (LX2). Sources stack down from the path's lane.
// A loop along the path arcs just over it; one that touches a lower lane arcs
// under the nodes it skips, so no arc reaches up past the path.
import { isMainStation } from "./runReport";
import type { LineMap, MapEdge, MapNode } from "./lineMap";

export const NODE_W = 104;
/** A step that only assembles the card, or a branch: narrower, so the path reads first. */
export const NODE_W_SMALL = 98;
/** A source or the expectations: a pill wide enough for a finder's name. */
export const NODE_W_SOURCE = 136;
export const NODE_H = 58;
export const SOURCE_H = 44;
const COL_GAP = 44;
/** Room under a node for its marks, in words. */
const LANE_PITCH = 112;
/** Between two branch lanes under the path: a node, its mark and a little air. */
const BRANCH_PITCH = 96;
const SOURCE_PITCH = 54;
/** The first column starts past the map's 24px left gutter at every scale a
 *  panel steps the map back to, down to LineMap's floor of 0.7. */
const PAD_X = 35;
/** Room between the stage names and the highest thing drawn under them, so
 *  the main row sits about 48px under its stage's name (LX2). */
const PAD_TOP = 14;
/** A loop's arc clears the nodes under it by this much, and a second loop over the same span by this. */
const ARC_CLEAR = 16;
const ARC_STEP = 12;
/** Room under a node for its one-line mark, which an arc under it must clear. */
const MARK_ROOM = 22;
/** A loop's run down a column gap sits this far past the gap's middle, beside the bus that ends take. */
const LOOP_CHANNEL = 3;
/** An end's ring reaches this far left of its dot's center: a line lands on the ring. */
const END_RING = 7;
/** Air under the lowest thing the canvas draws. */
const CANVAS_FOOT = 10;

/** `band`: the row of the map the node sits on, from 0 (bandOfCol). */
export type NodeBox = { id: string; x: number; y: number; w: number; h: number; lane: number; col: number; band: number };
/** `note`: words a short stub carries in place of a long edge ("to Dissolved",
 *  "back to Build"), for an edge between two rows of a banded map. */
export type EdgePath = { id: string; d: string; kind: MapEdge["kind"]; labelAt: { x: number; y: number } | null; note?: string };
export type PhaseSpan = { key: string; label: string; x: number; w: number; y: number };
export type MapLayout = { width: number; height: number; boxes: Map<string, NodeBox>; paths: Map<string, EdgePath>; phases: PhaseSpan[]; bands: number };

/** A line wider than this folds onto rows by phase, so it reads down the
 *  page instead of four screens sideways (LX2). */
export const BAND_MIN_WIDTH = 1500;
/** The rows a long line folds onto: what comes in, what is proved and
 *  built, what is decided and shipped. */
const BAND_OF: Record<string, number> = { sense: 0, admit: 0, understand: 0, prove: 1, build: 1, check: 1, decide: 2, ship: 2, end: 2 };
/** Room between two rows: the wrap of the path runs along its middle. */
const BAND_GAP = 44;

/** A line cause's own stations (line-map.md LX6) stand in for main ones, so they draw as wide. */
const STANDS_IN = new Set(["prove_line", "implement_line"]);

/** Narrow nodes: a branch, and the card's routine assembly steps. */
export const isSmallNode = (n: Pick<MapNode, "id" | "kind" | "main">) =>
  n.kind === "end" ? !n.main : n.kind === "station" && !STANDS_IN.has(n.id) && (!n.main || !isMainStation(n.id));

const PHASE_LABEL: Record<string, string> = {
  sense: "Sense", admit: "Admit", understand: "Understand", prove: "Prove", build: "Build", check: "Check", decide: "Decide", ship: "Ship", end: "Ends",
};

/** `fitWidth`: the width the map has on screen, in canvas units. A line wider
 *  than it folds onto as many rows as it needs, each as full as it fits,
 *  breaking at a phase where one is near, so every station shows without
 *  scrolling sideways. Without it a long line folds by phase (BAND_OF).
 *  `fitHeight`: the height the map's frame has. Rows that would stack taller
 *  than it would hide whole rows below the frame, so the line lays out as one
 *  row instead and scrolls sideways, its edge arrows naming what lies past
 *  each edge. `asks`: cards waiting at the decide gate, whose mark the map draws. */
export type LayoutOpts = { fitWidth?: number | null; fitHeight?: number | null; asks?: number };

/** A row that would break before this share of the width breaks mid-phase instead. */
const PHASE_BREAK_MIN = 0.75;

export function layoutLineMap(map: Pick<LineMap, "nodes" | "edges">, opts: LayoutOpts = {}): MapLayout {
  const wrapped = layoutRows(map, opts, false);
  if (wrapped.bands > 1 && opts.fitHeight && wrapped.height > opts.fitHeight) return layoutRows(map, opts, true);
  return wrapped;
}

function layoutRows(map: Pick<LineMap, "nodes" | "edges">, opts: LayoutOpts, oneRowOnly: boolean): MapLayout {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const forward = map.edges.filter((e) => e.kind !== "loop");
  const into = new Map<string, MapEdge[]>();
  const outOf = new Map<string, MapEdge[]>();
  for (const e of forward) {
    into.set(e.to, [...(into.get(e.to) ?? []), e]);
    outOf.set(e.from, [...(outOf.get(e.from) ?? []), e]);
  }

  // A branch that only leads out of the line sits below; one that returns sits above.
  const exits = new Map<string, boolean>();
  const leaves = (id: string, seen = new Set<string>()): boolean => {
    if (exits.has(id)) return exits.get(id)!;
    const n = byId.get(id);
    if (!n || seen.has(id)) return false;
    seen.add(id);
    const outs = (outOf.get(id) ?? []).map((e) => byId.get(e.to)).filter((m): m is MapNode => !!m);
    const v = n.kind === "end" ? n.end !== "held" : outs.length > 0 && outs.every((m) => !m.main && leaves(m.id, seen));
    exits.set(id, v);
    return v;
  };

  // ── lanes ──
  const lane = new Map<string, number>();
  const taken = new Set<string>();
  const take = (col: number, l: number) => taken.add(`${col}:${l}`);
  const free = (col: number, l: number) => !taken.has(`${col}:${l}`);
  for (const n of map.nodes) if (n.main && n.kind !== "source") { lane.set(n.id, 0); take(n.col, 0); }
  const cols = [...new Set(map.nodes.map((n) => n.col))].sort((a, b) => a - b);
  for (const c of cols) {
    for (const n of map.nodes.filter((m) => m.col === c && !lane.has(m.id) && m.kind !== "source" && m.kind !== "expectations")) {
      // Follow a branch's own predecessor, so plan and its gate share a lane.
      // Returning branches take lane 1; leaving ones start at lane 2.
      const first = leaves(n.id) ? 2 : 1;
      const pred = (into.get(n.id) ?? []).map((e) => lane.get(e.from)).find((l) => l != null && l >= first);
      const tries = [...(pred != null ? [pred, pred + 1] : []), first, first + 1, first + 2, 1, first + 3];
      const l = tries.find((t) => t > 0 && free(n.col, t)) ?? first + 4;
      lane.set(n.id, l);
      take(n.col, l);
    }
  }

  // A lane nothing uses closes up, so an empty branch lane leaves no gap.
  const used = [...new Set(lane.values())].sort((a, b) => a - b);
  for (const [id, l] of lane) lane.set(id, used.indexOf(l));

  // ── columns, left to right, each as wide as its widest node ──
  // A step where you decide carries a "you" tag beside its name, so it is wider.
  // A node is as wide as its whole name needs, never cut to "Investig...".
  const widthOf = (n: MapNode) => Math.max(
    n.kind === "source" || n.kind === "expectations" ? NODE_W_SOURCE : n.who === "person" ? NODE_W + 18 : isSmallNode(n) ? NODE_W_SMALL : NODE_W,
    nameWidth(n),
  );
  const colW = new Map<number, number>();
  for (const n of map.nodes) colW.set(n.col, Math.max(colW.get(n.col) ?? 0, widthOf(n)));
  // One row, unless the line is wider than a screen: then each column takes
  // the row of its phase (BAND_OF), never a row above the column before it,
  // and each row starts again at the left.
  const oneRow = cols.reduce((w, c) => w + colW.get(c)! + COL_GAP, PAD_X) - COL_GAP + PAD_X;
  const bandOfCol = new Map<number, number>();
  const fit = !oneRowOnly && opts.fitWidth && opts.fitWidth > 0 ? opts.fitWidth : null;
  if (fit && oneRow > fit) {
    // Greedy rows, like words on a line: a column that would overflow starts
    // the next row, at the latest phase change in the row when that leaves
    // the row at least PHASE_BREAK_MIN full.
    const phaseOf = (c: number) => {
      const at = map.nodes.filter((n) => n.col === c);
      return (at.find((n) => n.main) ?? at[0])?.phase ?? "";
    };
    let row: number[] = [];
    let w = PAD_X;
    let b = 0;
    for (const c of cols) {
      const cw = colW.get(c)! + COL_GAP;
      if (row.length && w + cw - COL_GAP + PAD_X > fit) {
        let cut = row.length;
        for (let i = row.length - 1; i > 0; i--) {
          if (phaseOf(row[i]) === phaseOf(row[i - 1])) continue;
          const kept = row.slice(0, i).reduce((t, k) => t + colW.get(k)! + COL_GAP, PAD_X);
          if (kept >= fit * PHASE_BREAK_MIN) cut = i;
          break;
        }
        const carried = row.slice(cut);
        b++;
        for (const k of carried) bandOfCol.set(k, b);
        row = carried;
        w = carried.reduce((t, k) => t + colW.get(k)! + COL_GAP, PAD_X);
      }
      bandOfCol.set(c, b);
      row.push(c);
      w += cw;
    }
  } else {
    let prev = 0;
    for (const c of cols) {
      const at = map.nodes.filter((n) => n.col === c);
      const lead = at.filter((n) => n.main || n.kind === "source" || n.kind === "expectations");
      const own = (lead.length ? lead : at).map((n) => BAND_OF[n.phase]).filter((b): b is number => b != null);
      const b = oneRowOnly || oneRow <= BAND_MIN_WIDTH ? 0 : Math.max(prev, own.length ? Math.max(...own) : prev);
      bandOfCol.set(c, b);
      prev = b;
    }
  }
  const colX = new Map<number, number>();
  let x = PAD_X;
  let width = 0;
  let band = 0;
  for (const c of cols) {
    if (bandOfCol.get(c)! !== band) { width = Math.max(width, x - COL_GAP + PAD_X); x = PAD_X; band = bandOfCol.get(c)!; }
    colX.set(c, x);
    x += colW.get(c)! + COL_GAP;
  }
  width = Math.max(width, x - COL_GAP + PAD_X);
  const bandCount = Math.max(...[...bandOfCol.values(), 0]) + 1;

  const boxes = new Map<string, NodeBox>();
  // The path's lane keeps room for loops arcing under it; branch lanes below sit closer, a node and its mark apart.
  const yOfLane = (l: number) => (l === 0 ? 0 : LANE_PITCH + (l - 1) * BRANCH_PITCH);
  const place = (n: MapNode, cy: number, h: number, l: number) => {
    const w = widthOf(n);
    boxes.set(n.id, { id: n.id, x: colX.get(n.col)! + (colW.get(n.col)! - w) / 2, y: cy - h / 2, w, h, lane: l, col: n.col, band: bandOfCol.get(n.col) ?? 0 });
  };
  for (const n of map.nodes) if (lane.has(n.id)) place(n, yOfLane(lane.get(n.id)!), NODE_H, lane.get(n.id)!);
  // Sources stack down from the path's lane, in the order the map lists them,
  // at most half a pitch above it, so the path stays near the top. A source
  // with words under it keeps room for them before the next.
  const sources = map.nodes.filter((n) => n.kind === "source");
  let sy = -Math.min(0.5, (sources.length - 1) / 2) * SOURCE_PITCH;
  for (const n of sources) {
    place(n, sy, SOURCE_H, 0);
    sy += SOURCE_PITCH + (markText(n) ? MARK_ROOM : 0);
  }
  const exp = map.nodes.find((n) => n.kind === "expectations");
  if (exp) {
    const fed = map.edges.filter((e) => e.from === exp.id).map((e) => boxes.get(e.to)).filter((b): b is NodeBox => !!b);
    const cy = fed.length ? fed.reduce((s, b) => s + b.y + b.h / 2, 0) / fed.length : 0;
    place(exp, cy, SOURCE_H, 0);
  }

  // ── edges ──
  // The middle of the gap after and before a column: nothing is drawn there
  // (a mark spills at most MARK_SPILL into it), so a line can run down it.
  const gapAfter = (c: number) => colX.get(c)! + colW.get(c)! + COL_GAP / 2;
  const gapBefore = (c: number) => colX.get(c)! - COL_GAP / 2;
  const asks = opts.asks ?? 0;
  const markOf = (o: NodeBox) => { const n = byId.get(o.id); return n ? markRect(n, o, n.kind === "decide" ? asks : 0) : null; };
  /** A node's lowest drawn point: its box, or the words under it. */
  const bottomOf = (o: NodeBox) => { const m = markOf(o); return m ? m.y + m.h : o.y + o.h; };
  const paths = new Map<string, EdgePath>();
  // Edges into an end ride one line under every node and its mark (a bus),
  // so a run stopping at any station never cuts across the rows to reach it.
  const busOf = new Map<number, number>();
  /** Each path's row; an edge between two rows is drawn once the rows are stacked. */
  const bandOfPath = new Map<string, number>();
  const across: MapEdge[] = [];
  const routeEdges = () => {
    across.length = 0;
    const rows = new Map<number, NodeBox[]>();
    for (const o of boxes.values()) rows.set(o.band, [...(rows.get(o.band) ?? []), o]);
    for (const [k, r] of rows) busOf.set(k, Math.max(...r.map(bottomOf)) + ARC_CLEAR);
    const arcsOver = new Map<string, number>();
    // Short loops first, so a long one rides over them.
    const ordered = [...map.edges].sort((a, b) => span(a, boxes) - span(b, boxes));
    for (const e of ordered) {
      const a = boxes.get(e.from);
      const b = boxes.get(e.to);
      if (!a || !b) continue;
      if (a.band !== b.band) { across.push(e); continue; }
      const all = rows.get(a.band)!;
      const busY = busOf.get(a.band)!;
      bandOfPath.set(e.id, a.band);
      if (e.kind === "loop" && (a.lane > 0 || b.lane > 0)) {
        // A loop off the path runs in the column gaps, where no node or mark
        // sits: out of the side facing the other end, low on the node, down
        // its gap, along under everything between the two ends and the words
        // under them, and up the other end's gap into its side.
        const key = `u${Math.min(a.col, b.col)}`;
        const nth = arcsOver.get(key) ?? 0;
        arcsOver.set(key, nth + 1);
        const off = LOOP_CHANNEL + Math.min(nth, 2) * 3;
        const y1 = a.y + a.h * 0.72;
        const y2 = b.y + b.h * 0.72;
        if (a.col === b.col) {
          // One above the other: up the gap after their column, side to side.
          const gx = gapAfter(a.col) + off;
          paths.set(e.id, { id: e.id, d: roundedPath([[a.x + a.w, y1], [gx, y1], [gx, y2], [b.x + b.w, y2]]), kind: e.kind, labelAt: { x: gx + 4, y: (y1 + y2) / 2 } });
          continue;
        }
        const back = b.col < a.col;
        const x1 = back ? a.x : a.x + a.w;
        const x2 = back ? b.x + b.w : b.x;
        const g1 = back ? gapBefore(a.col) - off : gapAfter(a.col) + off;
        const g2 = back ? gapAfter(b.col) + off : gapBefore(b.col) - off;
        const lo = Math.min(g1, g2);
        const hi = Math.max(g1, g2);
        const deepest = Math.max(a.lane, b.lane);
        const inRange = all.filter((o) => o.x + o.w > lo && o.x < hi);
        let bottom = Math.max(...[a, b, ...inRange.filter((o) => o.lane > 0 && o.lane <= deepest)].map(bottomOf)) + ARC_CLEAR + nth * ARC_STEP;
        // Never along a lower lane's nodes: past them, and their words, when the line would cut them.
        for (let guard = 0; guard < 8; guard++) {
          const cut = inRange.find((o) => o.y - 4 < bottom && bottomOf(o) + 4 > bottom);
          if (!cut) break;
          bottom = bottomOf(cut) + ARC_CLEAR;
        }
        paths.set(e.id, { id: e.id, d: roundedPath([[x1, y1], [g1, y1], [g1, bottom], [g2, bottom], [g2, y2], [x2, y2]]), kind: e.kind, labelAt: { x: (g1 + g2) / 2, y: bottom - 4 } });
        continue;
      }
      if (byId.get(e.to)?.kind === "end" && (b.col - a.col > 1 || b.lane !== a.lane)) {
        // Out of the node's right side, down the gap after its column, along
        // the bus under every node and its words, up the gap before the end's
        // column, and into the end's dot from its left (lineMap.css draws an
        // end as a ringed dot at its top left), so it never crosses the end's
        // own words.
        const x1 = a.x + a.w;
        const y1 = a.y + a.h / 2;
        const gx = gapAfter(a.col);
        const ex = gapBefore(b.col);
        const dot = { x: b.x + END_DOT.x - END_RING, y: b.y + END_DOT.y };
        const pts: Array<[number, number]> = Math.abs(ex - gx) < 1
          ? [[x1, y1], [gx, y1], [gx, dot.y], [dot.x, dot.y]]
          : [[x1, y1], [gx, y1], [gx, busY], [ex, busY], [ex, dot.y], [dot.x, dot.y]];
        paths.set(e.id, { id: e.id, d: roundedPath(pts), kind: e.kind, labelAt: { x: gx, y: (y1 + (pts.length > 4 ? busY : dot.y)) / 2 } });
        continue;
      }
      if (e.kind === "loop") {
        // Over everything between the two ends that sits at or above them.
        const lo = Math.min(a.x, b.x);
        const hi = Math.max(a.x + a.w, b.x + b.w);
        const under = all.filter((o) => o.id !== a.id && o.id !== b.id && o.x + o.w > lo && o.x < hi && o.y < Math.max(a.y, b.y) + 1);
        const key = `${Math.round(lo)}`;
        const nth = arcsOver.get(key) ?? 0;
        arcsOver.set(key, nth + 1);
        const top = Math.min(a.y, b.y, ...under.map((o) => o.y)) - ARC_CLEAR - nth * ARC_STEP;
        const x1 = a.x + a.w * 0.5;
        const x2 = b.x + b.w * 0.5;
        const d = `M ${x1} ${a.y} C ${x1} ${top}, ${x2} ${top}, ${x2} ${b.y}`;
        paths.set(e.id, { id: e.id, d, kind: e.kind, labelAt: { x: (x1 + x2) / 2, y: top + (Math.min(a.y, b.y) - top) * 0.25 } });
        continue;
      }
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const dx = Math.max(24, (x2 - x1) * 0.5);
      let d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      let labelAt = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      // A curve that would run through a node or the words under one (a hop
      // over a station, a branch reaching a far lane) takes the column gaps
      // instead, along the nearest clear corridor between them.
      const others = all.filter((o) => o.id !== a.id && o.id !== b.id);
      if (others.some((o) => crosses(d, o))) {
        const g1 = gapAfter(a.col);
        const g2 = gapBefore(b.col);
        const lo = Math.min(g1, g2);
        const hi = Math.max(g1, g2);
        const blocks = others.flatMap((o) => { const m = markOf(o); return m ? [o, m] : [o]; }).filter((r) => r.x < hi && r.x + r.w > lo);
        const clear = (y: number) => !blocks.some((r) => y > r.y - 4 && y < r.y + r.h + 4);
        const cands = [y1, y2, ...others.flatMap((o) => [o.y - ARC_CLEAR, bottomOf(o) + ARC_CLEAR]), busY];
        const cy = cands.filter(clear).sort((u, v) => Math.abs(u - y1) + Math.abs(u - y2) - (Math.abs(v - y1) + Math.abs(v - y2)))[0] ?? busY;
        d = roundedPath([[x1, y1], [g1, y1], [g1, cy], [g2, cy], [g2, y2], [x2, y2]]);
        labelAt = { x: (g1 + g2) / 2, y: cy - 4 };
      }
      paths.set(e.id, { id: e.id, d, kind: e.kind, labelAt });
    }
  };
  routeEdges();

  // The sources take the height the arcs over the path leave free: a column
  // of pills rises as high as the highest arc, so the last of them ("+2 more
  // sources") stays inside the stage instead of hanging below it (LX2).
  if (sources.length > 1) {
    let arcs = Infinity;
    for (const p of paths.values()) if (p.kind === "loop" && (bandOfPath.get(p.id) ?? 0) === 0) arcs = Math.min(arcs, ...pathPoints(p.d).map((q) => q.y));
    const top = Math.min(...sources.map((n) => boxes.get(n.id)!.y));
    if (Number.isFinite(arcs) && arcs < top) {
      const lift = top - arcs;
      for (const n of sources) boxes.get(n.id)!.y -= lift;
      if (exp) place(exp, boxes.get(exp.id)!.y + SOURCE_H / 2 - lift, SOURCE_H, 0);
      paths.clear();
      routeEdges();
    }
  }

  // ── fit: each row, arcs included, starts under its stage names; rows stack ──
  const extent = new Map<number, { minY: number; maxY: number }>();
  const grow = (k: number, lo: number, hi: number) => {
    const e = extent.get(k) ?? { minY: Infinity, maxY: -Infinity };
    extent.set(k, { minY: Math.min(e.minY, lo), maxY: Math.max(e.maxY, hi) });
  };
  for (const b of boxes.values()) grow(b.band, b.y, bottomOf(b));
  // Every line the row draws, and a loop's label riding over its arc.
  for (const p of paths.values()) {
    const ys = pathPoints(p.d).map((q) => q.y);
    grow(bandOfPath.get(p.id) ?? 0, Math.min(...ys, p.kind === "loop" && p.labelAt ? p.labelAt.y - 10 : Infinity), Math.max(...ys));
  }
  // Each row's shift, and where its stage names sit.
  const shiftOf = new Map<number, number>();
  const topOf = new Map<number, number>();
  let top = 0;
  for (let k = 0; k < bandCount; k++) {
    const e = extent.get(k);
    if (!e || !Number.isFinite(e.minY)) continue;
    topOf.set(k, top);
    shiftOf.set(k, top + PAD_TOP + 22 - e.minY);
    // The row is its content's box: the stage names over it and what it draws,
    // so the height left goes to the Now strip under the map (LX2).
    top += e.maxY - e.minY + PAD_TOP + 22 + BAND_GAP;
  }
  for (const b of boxes.values()) b.y += shiftOf.get(b.band) ?? 0;
  for (const p of paths.values()) {
    const dy = shiftOf.get(bandOfPath.get(p.id) ?? 0) ?? 0;
    p.d = shiftPath(p.d, dy);
    if (p.labelAt) p.labelAt = { x: p.labelAt.x, y: p.labelAt.y + dy };
  }

  // ── edges between rows ──
  // The path itself wraps like a line of text: out of the last station of a
  // row, along the gap under it, and into the first station of the next.
  // Anything else between rows (a loop back up, a run ending far below) is a
  // short stub under its own station naming where it goes, so no line drops
  // the height of the map.
  for (const e of across) {
    const a = boxes.get(e.from)!;
    const b = boxes.get(e.to)!;
    const into = byId.get(e.to);
    const r = 8;
    if (e.kind !== "loop" && into?.kind !== "end" && b.band === a.band + 1 && topOf.has(b.band)) {
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const gx = gapAfter(a.col);
      const cy = topOf.get(b.band)! - BAND_GAP / 2;
      const lx = b.x - 22;
      const y2 = b.y + b.h / 2;
      const d = `M ${x1} ${y1} L ${gx - r} ${y1} Q ${gx} ${y1}, ${gx} ${y1 + r} L ${gx} ${cy - r} Q ${gx} ${cy}, ${gx - r} ${cy} L ${lx + r} ${cy} Q ${lx} ${cy}, ${lx} ${cy + r} L ${lx} ${y2 - r} Q ${lx} ${y2}, ${lx + r} ${y2} L ${b.x} ${y2}`;
      paths.set(e.id, { id: e.id, d, kind: e.kind, labelAt: { x: (gx + lx) / 2, y: cy - 4 } });
      bandOfPath.set(e.id, a.band);
      continue;
    }
    // A stub out of the station's right side, curving down beside it.
    const x1 = a.x + a.w;
    const y1 = a.y + a.h * 0.72;
    // Down the gap's middle, clear of the words under the station.
    const sx = gapAfter(a.col);
    const d = `M ${x1} ${y1} Q ${sx} ${y1}, ${sx} ${y1 + 14} L ${sx} ${y1 + 30}`;
    const toLabel = into?.label ?? e.to;
    paths.set(e.id, { id: e.id, d, kind: e.kind, labelAt: { x: sx, y: y1 + 42 }, note: `${e.kind === "loop" ? "back to" : "to"} ${toLabel}` });
    bandOfPath.set(e.id, a.band);
  }
  placeLabels(map.edges, paths, [...boxes.values()].flatMap((o) => { const m = markOf(o); return m ? [o, m] : [o]; }), width);

  // The canvas is as tall as what it draws, so the room under it goes to the Now strip.
  let bottom = 0;
  for (const b of boxes.values()) bottom = Math.max(bottom, bottomOf(b));
  for (const p of paths.values()) bottom = Math.max(bottom, ...pathPoints(p.d).map((q) => q.y), p.labelAt ? p.labelAt.y + 4 : 0);
  const height = Math.ceil(bottom + CANVAS_FOOT);

  // ── the phases a reader names, over the columns of their main nodes ──
  const phases: PhaseSpan[] = [];
  for (const n of map.nodes) {
    // A branch sits inside the phases around it; the phases read off the path.
    if (!(n.main || n.kind === "source" || n.kind === "expectations")) continue;
    const b = boxes.get(n.id)!;
    const last = phases[phases.length - 1];
    const y = topOf.get(b.band) ?? 0;
    if (last && last.key === n.phase && last.y === y) { const right = Math.max(last.x + last.w, b.x + b.w); last.x = Math.min(last.x, b.x); last.w = right - last.x; continue; }
    // A phase that carries on into the next row is named again over it.
    if (phases.some((p) => p.key === n.phase && p.y === y)) continue;
    phases.push({ key: n.phase, label: PHASE_LABEL[n.phase] ?? n.phase, x: b.x, w: b.w, y });
  }

  return { width, height, boxes, paths, phases, bands: bandCount };
}

/** A node's name at the map's 11.5px mono (about 7px a glyph), with its
 *  padding, lamp, and the "you" tag a step where you decide carries. */
const NAME_CH = 7;
export const nameWidth = (n: Pick<MapNode, "label" | "who" | "kind">) =>
  n.kind === "end" ? 0 : Math.ceil(n.label.length * NAME_CH) + 36 + (n.who === "person" ? 30 : 0);

/** Where an end's dot sits in its box, and the ring's edge under it. */
const END_DOT = { x: 9.5, y: 27 };

/** An edge label's glyph width at the map's 10px mono, as the map paints it (its words and the count). */
const LABEL_CH = 6.1;
const labelText = (e: MapEdge) => [e.label, e.count > 0 ? String(e.count) : null].filter(Boolean).join("  ");

/** How far a node's mark may spill past it on each side (into most of the
 *  column gap), and its distance under the node, past the selected ring. */
export const MARK_SPILL = 18;
export const MARK_GAP = 8;
const MARK_LINE = 14;
const MARK_CH = 6.05;

/** The words a node's mark shows on the map: the first mark's short words, and "+N" for the rest. */
export function markText(n: Pick<MapNode, "marks">, asks = 0): string | null {
  const trouble = n.marks.some((m) => m.level !== "info");
  const first = asks > 0 && !trouble ? "Waiting on you" : n.marks[0] ? (n.marks[0].short ?? n.marks[0].words) : null;
  if (!first) return null;
  const count = n.marks.length + (asks > 0 && !trouble ? 1 : 0);
  return count > 1 ? `${first} +${count - 1}` : first;
}

/** Where a node's mark is drawn: centered under it, one line, no wider than the node and its spill. */
export function markRect(n: Pick<MapNode, "marks">, b: NodeBox, asks = 0): { id: string; x: number; y: number; w: number; h: number } | null {
  const text = markText(n, asks);
  if (!text) return null;
  const w = Math.min(text.length * MARK_CH, b.w + 2 * MARK_SPILL);
  return { id: `mark ${b.id}`, x: b.x + (b.w - w) / 2, y: b.y + b.h + MARK_GAP, w, h: MARK_LINE };
}

/** Where an edge's label is drawn, or null when it has none. */
export function labelRect(e: MapEdge, p: EdgePath | undefined): { x: number; y: number; w: number; h: number } | null {
  if (!p?.labelAt || (!e.label && !p.note)) return null;
  const half = ((p.note ?? labelText(e)).length * LABEL_CH) / 2 + 3;
  return { x: p.labelAt.x - half, y: p.labelAt.y - 10, w: 2 * half, h: 13 };
}

/** Each edge label moved off every node, the words under one and the labels
 *  placed before it, and kept inside the canvas: tried where it sits, then
 *  along its own line from the middle out, then nudged above or below. A
 *  label that fits nowhere stays where it was. */
function placeLabels(edges: MapEdge[], paths: Map<string, EdgePath>, obstacles: Array<{ x: number; y: number; w: number; h: number }>, width: number) {
  const taken = obstacles.map((o) => ({ x0: o.x, x1: o.x + o.w, y0: o.y, y1: o.y + o.h }));
  const hits = (x: number, y: number, half: number) => {
    const r = { x0: x - half, x1: x + half, y0: y - 10, y1: y + 3 };
    return r.x0 < 0 || r.x1 > width || r.y0 < 0 || taken.some((t) => r.x1 > t.x0 && r.x0 < t.x1 && r.y1 > t.y0 && r.y0 < t.y1);
  };
  for (const e of edges) {
    const p = paths.get(e.id);
    if (!p?.labelAt || (!e.label && !p.note)) continue;
    const half = ((p.note ?? labelText(e)).length * LABEL_CH) / 2 + 3;
    const pts = pathPoints(p.d);
    const mid = pts.length / 2;
    const along = pts.map((q, i) => ({ q, d: Math.abs(i - mid) })).sort((u, v) => u.d - v.d).map(({ q }) => ({ x: q.x, y: q.y + 4 }));
    const base = [p.labelAt, ...along];
    const tries = [...base, ...[-14, 14, -28, 28, -42, 42].flatMap((dy) => base.map((q) => ({ x: q.x, y: q.y + dy })))];
    // Inside the canvas first: a label at its edge slides in rather than cut.
    const clampX = (x: number) => Math.min(Math.max(x, half + 1), width - half - 1);
    const at = tries.map((q) => ({ x: clampX(q.x), y: q.y })).find((q) => !hits(q.x, q.y, half)) ?? { x: clampX(p.labelAt.x), y: p.labelAt.y };
    p.labelAt = at;
    taken.push({ x0: at.x - half, x1: at.x + half, y0: at.y - 10, y1: at.y + 3 });
  }
}

function span(e: MapEdge, boxes: Map<string, NodeBox>): number {
  const a = boxes.get(e.from);
  const b = boxes.get(e.to);
  return a && b ? Math.abs(a.x - b.x) : 0;
}

/** Points along a drawn path (M, L, Q and C segments): the curve itself, not its control points. */
export function pathPoints(d: string): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const tokens = d.match(/[MLQC]|-?\d+(\.\d+)?/g) ?? [];
  let i = 0;
  let at = { x: 0, y: 0 };
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") { at = { x: num(), y: num() }; out.push(at); continue; }
    const pts = [at];
    for (let k = 0, n = cmd === "L" ? 1 : cmd === "Q" ? 2 : 3; k < n; k++) pts.push({ x: num(), y: num() });
    const steps = cmd === "L" ? 1 : 20;
    for (let s = 1; s <= steps; s++) {
      let p = pts;
      while (p.length > 1) p = p.slice(1).map((q, j) => ({ x: p[j].x + (q.x - p[j].x) * (s / steps), y: p[j].y + (q.y - p[j].y) * (s / steps) }));
      out.push(p[0]);
    }
    at = pts[pts.length - 1];
  }
  return out;
}

/** Whether path `d` runs through box `r` (a few pixels in from its edge). */
function crosses(d: string, r: { x: number; y: number; w: number; h: number }): boolean {
  return pathPoints(d).some((q) => q.x > r.x + 2 && q.x < r.x + r.w - 2 && q.y > r.y + 2 && q.y < r.y + r.h - 2);
}

/** A line through `pts` with each corner rounded. */
function roundedPath(pts: Array<[number, number]>, r = 8): string {
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const rin = Math.min(r, Math.hypot(cx - px, cy - py) / 2);
    const rout = Math.min(r, Math.hypot(nx - cx, ny - cy) / 2);
    const ux = Math.sign(cx - px), uy = Math.sign(cy - py), vx = Math.sign(nx - cx), vy = Math.sign(ny - cy);
    d += ` L ${cx - ux * rin} ${cy - uy * rin} Q ${cx} ${cy}, ${cx + vx * rout} ${cy + vy * rout}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return `${d} L ${lx} ${ly}`;
}

function shiftPath(d: string, dy: number): string {
  let i = 0;
  return d.replace(/-?\d+(\.\d+)?/g, (m) => String(i++ % 2 === 1 ? Number(m) + dy : Number(m)));
}

/** Edge width in px: one for a path nothing crossed, up to ten for the busiest. */
export function edgeWidth(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 1;
  return 1.75 + 8 * Math.sqrt(count / max);
}

export type MapDirection = "left" | "right" | "up" | "down";

/** The node an arrow key moves to: the nearest one that way, a step along the
 *  lane counting for less than a step across it. */
export function neighbor(layout: MapLayout, from: string, dir: MapDirection): string | null {
  const a = layout.boxes.get(from);
  if (!a) return null;
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  let best: string | null = null;
  let bestCost = Infinity;
  const across = dir === "left" || dir === "right";
  // Sideways stays on the row; past a row's end it reads on like text, into
  // the next row's start (or back to the row before's end).
  const row = [...layout.boxes.values()].filter((b) => b.band === a.band);
  const onRow = row.some((b) => b.id !== from && (dir === "right" ? b.x + b.w / 2 - ax > 1 : dir === "left" ? b.x + b.w / 2 - ax < -1 : false));
  if (across && !onRow && layout.bands > 1) {
    const next = [...layout.boxes.values()].filter((b) => b.band === a.band + (dir === "right" ? 1 : -1));
    if (!next.length) return null;
    const lane = Math.min(...next.map((b) => b.lane));
    const main = next.filter((b) => b.lane === lane).sort((p, q) => p.x - q.x);
    return (dir === "right" ? main[0] : main[main.length - 1]).id;
  }
  for (const b of layout.boxes.values()) {
    if (b.id === from) continue;
    if (across && layout.bands > 1 && b.band !== a.band) continue;
    const dx = b.x + b.w / 2 - ax;
    const dy = b.y + b.h / 2 - ay;
    const ahead = dir === "right" ? dx > 1 : dir === "left" ? dx < -1 : dir === "down" ? dy > 1 : dy < -1;
    if (!ahead) continue;
    const along = dir === "left" || dir === "right" ? Math.abs(dx) : Math.abs(dy);
    const aside = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const cost = along + aside * 4;
    if (cost < bestCost) { bestCost = cost; best = b.id; }
  }
  return best;
}

/** The edges a path takes, each with how many times: two implement rounds cross verify -> implement twice. */
export function pathEdges(path: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < path.length; i++) {
    const id = `${path[i - 1]}->${path[i]}`;
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}
