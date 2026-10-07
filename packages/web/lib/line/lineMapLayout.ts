// Where each node of the line map sits and how each edge runs between them
// (docs/architecture/line-map.md LX2). Pure geometry over a LineMap: the map
// component paints it, the tests read it, and the keyboard walks it.
//
// Columns come from the map (lineMap `col`, the longest path from the left).
// The path every cause takes runs along one lane in the middle. A branch sits
// above it when it comes back into the line (plan, park, reopen) and below it
// when it leaves the line (dissolve, drop, the ends), so a reader sees work
// that returns above and work that exits below. Sources stack in their column.
// A loop (an edge going back) arcs over the nodes it skips.
import { isMainStation } from "./runReport";
import type { LineMap, MapEdge, MapNode } from "./lineMap";

export const NODE_W = 104;
/** A step that only assembles the card, or a branch: narrower, so the path reads first. */
export const NODE_W_SMALL = 84;
export const NODE_H = 58;
export const SOURCE_H = 44;
const COL_GAP = 44;
/** Room under a node for its marks, in words. */
const LANE_PITCH = 112;
const SOURCE_PITCH = 54;
const PAD_X = 28;
const PAD_Y = 36;
/** A loop's arc clears the nodes under it by this much, and a second loop over the same span by this. */
const ARC_CLEAR = 16;
const ARC_STEP = 12;

export type NodeBox = { id: string; x: number; y: number; w: number; h: number; lane: number; col: number };
export type EdgePath = { id: string; d: string; kind: MapEdge["kind"]; labelAt: { x: number; y: number } | null };
export type PhaseSpan = { key: string; label: string; x: number; w: number };
export type MapLayout = { width: number; height: number; boxes: Map<string, NodeBox>; paths: Map<string, EdgePath>; phases: PhaseSpan[] };

/** Narrow nodes: a branch, and the card's routine assembly steps. */
export const isSmallNode = (n: Pick<MapNode, "id" | "kind" | "main">) =>
  n.kind === "end" ? !n.main : n.kind === "station" && (!n.main || !isMainStation(n.id));

const PHASE_LABEL: Record<string, string> = {
  sense: "Sense", admit: "Admit", understand: "Understand", prove: "Prove", build: "Build", check: "Check", decide: "Decide", ship: "Ship", end: "Ends",
};

export function layoutLineMap(map: Pick<LineMap, "nodes" | "edges">): MapLayout {
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
      const side = leaves(n.id) ? 1 : -1;
      const pred = (into.get(n.id) ?? []).map((e) => lane.get(e.from)).find((l) => l != null && Math.sign(l) === side);
      const tries = pred != null ? [pred, pred + Math.sign(pred), side, side * 2, -side, -side * 2, side * 3] : [side, side * 2, -side, -side * 2, side * 3];
      const l = tries.find((t) => t !== 0 && free(n.col, t)) ?? side * 4;
      lane.set(n.id, l);
      take(n.col, l);
    }
  }

  // ── columns, left to right, each as wide as its widest node ──
  const widthOf = (n: MapNode) => (isSmallNode(n) ? NODE_W_SMALL : NODE_W);
  const colW = new Map<number, number>();
  for (const n of map.nodes) colW.set(n.col, Math.max(colW.get(n.col) ?? 0, widthOf(n)));
  const colX = new Map<number, number>();
  let x = PAD_X;
  for (const c of cols) { colX.set(c, x); x += colW.get(c)! + COL_GAP; }
  const width = x - COL_GAP + PAD_X;

  const boxes = new Map<string, NodeBox>();
  const yOfLane = (l: number) => l * LANE_PITCH;
  const place = (n: MapNode, cy: number, h: number, l: number) => {
    const w = widthOf(n);
    boxes.set(n.id, { id: n.id, x: colX.get(n.col)! + (colW.get(n.col)! - w) / 2, y: cy - h / 2, w, h, lane: l, col: n.col });
  };
  for (const n of map.nodes) if (lane.has(n.id)) place(n, yOfLane(lane.get(n.id)!), NODE_H, lane.get(n.id)!);
  // Sources stack around the lane, in the order the map lists them.
  const sources = map.nodes.filter((n) => n.kind === "source");
  sources.forEach((n, i) => place(n, (i - (sources.length - 1) / 2) * SOURCE_PITCH, SOURCE_H, 0));
  const exp = map.nodes.find((n) => n.kind === "expectations");
  if (exp) {
    const fed = map.edges.filter((e) => e.from === exp.id).map((e) => boxes.get(e.to)).filter((b): b is NodeBox => !!b);
    const cy = fed.length ? fed.reduce((s, b) => s + b.y + b.h / 2, 0) / fed.length : 0;
    place(exp, cy, SOURCE_H, 0);
  }

  // ── edges ──
  const paths = new Map<string, EdgePath>();
  const all = [...boxes.values()];
  const arcsOver = new Map<string, number>();
  // Short loops first, so a long one rides over them.
  const ordered = [...map.edges].sort((a, b) => span(a, boxes) - span(b, boxes));
  for (const e of ordered) {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) continue;
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

  // ── fit: everything, arcs included, starts at the padding ──
  let minY = Infinity;
  let maxY = -Infinity;
  for (const b of boxes.values()) { minY = Math.min(minY, b.y); maxY = Math.max(maxY, b.y + b.h); }
  for (const p of paths.values()) if (p.kind === "loop") minY = Math.min(minY, arcTop(p.d));
  if (!Number.isFinite(minY)) { minY = 0; maxY = 0; }
  // Marks under the lowest node, then the phase names along the top.
  const shift = PAD_Y + 22 - minY;
  for (const b of boxes.values()) b.y += shift;
  for (const p of paths.values()) {
    p.d = shiftPath(p.d, shift);
    if (p.labelAt) p.labelAt = { x: p.labelAt.x, y: p.labelAt.y + shift };
  }
  const height = maxY - minY + PAD_Y * 2 + 22 + 34;

  // ── the phases a reader names, over the columns of their main nodes ──
  const phases: PhaseSpan[] = [];
  for (const n of map.nodes) {
    // A branch sits inside the phases around it; the phases read off the path.
    if (!(n.main || n.kind === "source" || n.kind === "expectations")) continue;
    const b = boxes.get(n.id)!;
    const last = phases[phases.length - 1];
    if (last && last.key === n.phase) { const right = Math.max(last.x + last.w, b.x + b.w); last.x = Math.min(last.x, b.x); last.w = right - last.x; continue; }
    if (phases.some((p) => p.key === n.phase)) continue;
    phases.push({ key: n.phase, label: PHASE_LABEL[n.phase] ?? n.phase, x: b.x, w: b.w });
  }

  return { width, height, boxes, paths, phases };
}

function span(e: MapEdge, boxes: Map<string, NodeBox>): number {
  const a = boxes.get(e.from);
  const b = boxes.get(e.to);
  return a && b ? Math.abs(a.x - b.x) : 0;
}

const arcTop = (d: string) => {
  const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  // M x y C cx1 cy1, cx2 cy2, x y: the control points' y is the arc's reach.
  return Math.min(nums[1], nums[3], nums[5], nums[7]);
};

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
  for (const b of layout.boxes.values()) {
    if (b.id === from) continue;
    const dx = b.x + b.w / 2 - ax;
    const dy = b.y + b.h / 2 - ay;
    const ahead = dir === "right" ? dx > 1 : dir === "left" ? dx < -1 : dir === "down" ? dy > 1 : dy < -1;
    if (!ahead) continue;
    const along = dir === "left" || dir === "right" ? Math.abs(dx) : Math.abs(dy);
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const cost = along + across * 4;
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
