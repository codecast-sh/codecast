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
 *  scrolling sideways. Without it a long line folds by phase (BAND_OF). */
export type LayoutOpts = { fitWidth?: number | null };

/** A row that would break before this share of the width breaks mid-phase instead. */
const PHASE_BREAK_MIN = 0.55;

export function layoutLineMap(map: Pick<LineMap, "nodes" | "edges">, opts: LayoutOpts = {}): MapLayout {
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
  const fit = opts.fitWidth && opts.fitWidth > 0 ? opts.fitWidth : null;
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
      const b = oneRow <= BAND_MIN_WIDTH ? 0 : Math.max(prev, own.length ? Math.max(...own) : prev);
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
  const yOfLane = (l: number) => l * LANE_PITCH;
  const place = (n: MapNode, cy: number, h: number, l: number) => {
    const w = widthOf(n);
    boxes.set(n.id, { id: n.id, x: colX.get(n.col)! + (colW.get(n.col)! - w) / 2, y: cy - h / 2, w, h, lane: l, col: n.col, band: bandOfCol.get(n.col) ?? 0 });
  };
  for (const n of map.nodes) if (lane.has(n.id)) place(n, yOfLane(lane.get(n.id)!), NODE_H, lane.get(n.id)!);
  // Sources stack down from the path's lane, in the order the map lists them,
  // at most half a pitch above it, so the path stays near the top.
  const sources = map.nodes.filter((n) => n.kind === "source");
  const above = Math.min(0.5, (sources.length - 1) / 2);
  sources.forEach((n, i) => place(n, (i - above) * SOURCE_PITCH, SOURCE_H, 0));
  const exp = map.nodes.find((n) => n.kind === "expectations");
  if (exp) {
    const fed = map.edges.filter((e) => e.from === exp.id).map((e) => boxes.get(e.to)).filter((b): b is NodeBox => !!b);
    const cy = fed.length ? fed.reduce((s, b) => s + b.y + b.h / 2, 0) / fed.length : 0;
    place(exp, cy, SOURCE_H, 0);
  }

  // ── edges ──
  const paths = new Map<string, EdgePath>();
  // Edges into an end ride one line under every node and its mark (a bus),
  // so a run stopping at any station never cuts across the rows to reach it.
  const busEdges = new Set<string>();
  const busOf = new Map<number, number>();
  /** Each path's row; an edge between two rows is drawn once the rows are stacked. */
  const bandOfPath = new Map<string, number>();
  const across: MapEdge[] = [];
  const routeEdges = () => {
    across.length = 0;
    const rows = new Map<number, NodeBox[]>();
    for (const o of boxes.values()) rows.set(o.band, [...(rows.get(o.band) ?? []), o]);
    for (const [k, r] of rows) busOf.set(k, Math.max(...r.map((o) => o.y + o.h)) + MARK_ROOM + ARC_CLEAR);
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
        // Under everything between the two ends, clear of the marks under them.
        const lo = Math.min(a.x, b.x);
        const hi = Math.max(a.x + a.w, b.x + b.w);
        const span = all.filter((o) => o.x + o.w > lo && o.x < hi && o.lane > 0 && o.lane <= Math.max(a.lane, b.lane));
        const key = `u${Math.round(lo)}`;
        const nth = arcsOver.get(key) ?? 0;
        arcsOver.set(key, nth + 1);
        const bottom = Math.max(a.y + a.h, b.y + b.h, ...span.map((o) => o.y + o.h)) + ARC_CLEAR + MARK_ROOM + nth * ARC_STEP;
        // It leaves and lands on the sides facing each other, low on the node,
        // so it never strikes through the mark under either end.
        const back = b.x + b.w / 2 < a.x + a.w / 2;
        const x1 = back ? a.x : a.x + a.w;
        const x2 = back ? b.x + b.w : b.x;
        const s1 = back ? -1 : 1;
        const d = `M ${x1} ${a.y + a.h * 0.72} C ${x1 + s1 * 28} ${bottom}, ${x2 - s1 * 28} ${bottom}, ${x2} ${b.y + b.h * 0.72}`;
        paths.set(e.id, { id: e.id, d, kind: e.kind, labelAt: { x: (x1 + x2) / 2, y: bottom - 4 } });
        continue;
      }
      if (byId.get(e.to)?.kind === "end" && (b.col - a.col > 1 || b.lane !== a.lane)) {
        // Out of the node's right side, down the gap after its column, along
        // the bus, and up into the end's dot from below.
        const x1 = a.x + a.w;
        const y1 = a.y + a.h / 2;
        const gx = x1 + COL_GAP / 2;
        // An end draws as a ringed dot at its top left (lineMap.css): the line lands under it.
        const bx = b.x + END_DOT.x;
        const r = 10;
        const dir = bx >= gx ? 1 : -1;
        const d = `M ${x1} ${y1} Q ${gx} ${y1}, ${gx} ${y1 + r} L ${gx} ${busY - r} Q ${gx} ${busY}, ${gx + dir * r} ${busY} L ${bx - dir * r} ${busY} Q ${bx} ${busY}, ${bx} ${busY - r} L ${bx} ${b.y + END_DOT.y}`;
        busEdges.add(e.id);
        paths.set(e.id, { id: e.id, d, kind: e.kind, labelAt: { x: gx, y: (y1 + busY) / 2 } });
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
      // A hop along one lane over a node in between bows under it.
      const blocked = y1 === y2 && all.some((o) => o.id !== a.id && o.id !== b.id && o.x > x1 && o.x + o.w < x2 && Math.abs(o.y + o.h / 2 - y1) < 1);
      const dx = Math.max(24, (x2 - x1) * 0.5);
      const d = blocked
        ? `M ${x1} ${y1} C ${x1 + dx} ${y1 + NODE_H * 1.15}, ${x2 - dx} ${y2 + NODE_H * 1.15}, ${x2} ${y2}`
        : `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      const labelAt = blocked ? { x: (x1 + x2) / 2, y: y1 + NODE_H * 0.86 } : { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      paths.set(e.id, { id: e.id, d, kind: e.kind, labelAt });
    }
  };
  routeEdges();

  // The sources take the height the arcs over the path leave free: a column
  // of pills rises as high as the highest arc, so the last of them ("+2 more
  // sources") stays inside the stage instead of hanging below it (LX2).
  if (sources.length > 1) {
    let arcs = Infinity;
    for (const p of paths.values()) if (p.kind === "loop" && (bandOfPath.get(p.id) ?? 0) === 0) arcs = Math.min(arcs, arcTop(p.d));
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
  for (const b of boxes.values()) grow(b.band, b.y, b.y + b.h);
  // A loop's count label sits on its arc's peak, its glyphs above it.
  for (const p of paths.values()) if (p.kind === "loop") grow(bandOfPath.get(p.id) ?? 0, Math.min(arcTop(p.d), (p.labelAt?.y ?? Infinity) - 10), arcBottom(p.d));
  for (const id of busEdges) { const k = bandOfPath.get(id) ?? 0; grow(k, busOf.get(k)!, busOf.get(k)!); }
  // Each row's shift, and where its stage names sit.
  const shiftOf = new Map<number, number>();
  const topOf = new Map<number, number>();
  let top = 0;
  for (let k = 0; k < bandCount; k++) {
    const e = extent.get(k);
    if (!e || !Number.isFinite(e.minY)) continue;
    topOf.set(k, top);
    shiftOf.set(k, top + PAD_TOP + 22 - e.minY);
    // The row is its content's box: the stage names over it, and under the
    // lowest node or arc only the room its one-line mark needs, so the height
    // left goes to the Now strip under the map (LX2).
    top += e.maxY - e.minY + PAD_TOP + 22 + MARK_ROOM + 14 + BAND_GAP;
  }
  const height = Math.max(0, top - BAND_GAP);
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
      const gx = x1 + COL_GAP / 3;
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
    const sx = x1 + 14;
    const d = `M ${x1} ${y1} Q ${sx} ${y1}, ${sx} ${y1 + 14} L ${sx} ${y1 + 30}`;
    const toLabel = into?.label ?? e.to;
    paths.set(e.id, { id: e.id, d, kind: e.kind, labelAt: { x: sx, y: y1 + 42 }, note: `${e.kind === "loop" ? "back to" : "to"} ${toLabel}` });
    bandOfPath.set(e.id, a.band);
  }
  placeLabels(map.edges, paths, [...boxes.values()]);

  // ── the phases a reader names, over the columns of their main nodes ──
  const phases: PhaseSpan[] = [];
  for (const n of map.nodes) {
    // A branch sits inside the phases around it; the phases read off the path.
    if (!(n.main || n.kind === "source" || n.kind === "expectations")) continue;
    const b = boxes.get(n.id)!;
    const last = phases[phases.length - 1];
    const y = topOf.get(b.band) ?? 0;
    if (last && last.key === n.phase && last.y === y) { const right = Math.max(last.x + last.w, b.x + b.w); last.x = Math.min(last.x, b.x); last.w = right - last.x; continue; }
    if (phases.some((p) => p.key === n.phase)) continue;
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

/** An edge label's half width at the map's 10px mono, as the map paints it (its words and the count). */
const LABEL_CH = 6.1;
const labelText = (e: MapEdge) => [e.label, e.count > 0 ? String(e.count) : null].filter(Boolean).join("  ");

/** Each edge label moved off any node or the mark under it: tried where it
 *  sits, then at other points along its curve, then nudged above or below. A
 *  label that fits nowhere stays where it was. */
function placeLabels(edges: MapEdge[], paths: Map<string, EdgePath>, boxes: NodeBox[]) {
  const taken: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  const hits = (x: number, y: number, half: number) => {
    const r = { x0: x - half, x1: x + half, y0: y - 10, y1: y + 3 };
    return boxes.some((b) => r.x1 > b.x && r.x0 < b.x + b.w && r.y1 > b.y && r.y0 < b.y + b.h + MARK_ROOM)
      || taken.some((t) => r.x1 > t.x0 && r.x0 < t.x1 && r.y1 > t.y0 && r.y0 < t.y1);
  };
  for (const e of edges) {
    const p = paths.get(e.id);
    if (!p?.labelAt || (!e.label && !p.note)) continue;
    const half = ((p.note ?? labelText(e)).length * LABEL_CH) / 2 + 3;
    const along = curvePoints(p.d);
    const tries = [p.labelAt, ...along, ...[-14, 14, -28, 28].map((dy) => ({ x: p.labelAt!.x, y: p.labelAt!.y + dy }))];
    const at = tries.find((q) => !hits(q.x, q.y, half)) ?? p.labelAt;
    p.labelAt = at;
    taken.push({ x0: at.x - half, x1: at.x + half, y0: at.y - 10, y1: at.y + 3 });
  }
}

/** Points along a single cubic ("M x y C ..."), middle first; none for any other path. */
function curvePoints(d: string): Array<{ x: number; y: number }> {
  if (!/^M [^A-Z]+ C [^A-Z]+$/.test(d)) return [];
  const n = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  if (n.length < 8) return [];
  const at = (t: number, i: number) => (1 - t) ** 3 * n[i] + 3 * (1 - t) ** 2 * t * n[i + 2] + 3 * (1 - t) * t ** 2 * n[i + 4] + t ** 3 * n[i + 6];
  return [0.4, 0.6, 0.3, 0.7, 0.2, 0.8].map((t) => ({ x: at(t, 0), y: at(t, 1) + 4 }));
}

function span(e: MapEdge, boxes: Map<string, NodeBox>): number {
  const a = boxes.get(e.from);
  const b = boxes.get(e.to);
  return a && b ? Math.abs(a.x - b.x) : 0;
}

/** The y a cubic's curve actually reaches at its parameter t (its control points reach further). */
const cubicY = (n: number[], t: number) => (1 - t) ** 3 * n[1] + 3 * (1 - t) ** 2 * t * n[3] + 3 * (1 - t) * t ** 2 * n[5] + t ** 3 * n[7];
/** The curve's own extremes, sampled: a loop's arc reaches about three
 *  quarters of the way to its control points, and the room kept is the curve's. */
const arcYs = (d: string) => {
  const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  return Array.from({ length: 21 }, (_, i) => cubicY(nums, i / 20));
};
const arcTop = (d: string) => Math.min(...arcYs(d));
const arcBottom = (d: string) => Math.max(...arcYs(d));

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
