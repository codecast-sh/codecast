// ForceAtlas2 layout, run in slices so the settling is watchable.
//
// This module is the engine; `graphLayout.worker.ts` is a thin message adapter
// over it and the renderer falls back to calling it directly when a worker
// can't be constructed. One force loop, two hosts.
//
// TWO PROPERTIES MATTER HERE:
//   * Determinism. Seed positions are points on a circle indexed by position
//     in the node array, never Math.random, so the same vault lays out the
//     same way every time — a graph that reshuffles on every visit teaches you
//     nothing about your notes.
//   * Yielding. The iterations run in chunks separated by setTimeout(0), not
//     in one blocking call. In the worker that keeps the message queue alive
//     so a cancel actually lands mid-layout; on the main-thread fallback it
//     keeps the page responsive. It also produces the animation: each chunk
//     ends with a positions tick.

import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";

export interface LayoutInput {
  /** Node ids, in the order tick positions will be indexed by. */
  nodes: string[];
  edges: [source: string, target: string][];
  /** Total iterations; more settles tighter. Default 300. */
  iterations?: number;
  /**
   * Starting positions, flat [x0, y0, x1, y1, …] aligned to `nodes`. Omit to
   * seed on the deterministic circle. Passing the picture that's already on
   * screen is what makes toggling a filter PERTURB the graph instead of
   * reshuffling it — nodes that were already there stay where the reader last
   * saw them. Entries that aren't finite fall back to the circle seed, which
   * is how a newly added node joins a settled layout.
   */
  positions?: Float32Array;
}

export interface LayoutTick {
  /** Flat [x0, y0, x1, y1, …] aligned to `LayoutInput.nodes` — one allocation
   *  per tick, so the worker can transfer the buffer instead of copying it. */
  positions: Float32Array;
  iteration: number;
  total: number;
  done: boolean;
}

export const DEFAULT_LAYOUT_ITERATIONS = 300;

/**
 * Wall-clock ceiling on a layout. ForceAtlas2 is O(n²) per iteration, so cost
 * grows quadratically with vault size. Measured on an M-series laptop, a full
 * 300 iterations take 0.05s at 240 notes, 0.8s at 1000, 4.7s at 2400 and 23s
 * at 5000. The budget lets every realistic vault finish and truncates only the
 * pathological ones, where a coarse graph now beats a perfect one in 20s.
 *
 * Under the budget — any vault up to roughly 2500 notes — every machine runs
 * the full iteration count, so the same vault lays out identically everywhere.
 * Past it, a faster machine gets a slightly more settled picture.
 */
const TIME_BUDGET_MS = 5000;

/** Iterations between position ticks. 15 is ~20 frames of settling over a
 *  300-iteration run: enough to read as motion, few enough that the posting
 *  overhead stays invisible. */
const CHUNK = 15;

/**
 * Where a node starts before any force is applied: a point on a circle, picked
 * by its index. Never Math.random — determinism lives here.
 *
 * The renderer seeds newly added nodes with this same function, so the first
 * painted frame is the ring the layout is about to expand, rather than every
 * node stacked on the origin until the first tick arrives.
 *
 * Radius grows with sqrt(n) so a big vault starts spread out instead of as a
 * dense ring the repulsion has to blow apart.
 */
export function seedPosition(index: number, count: number): { x: number; y: number } {
  const n = Math.max(count, 1);
  const radius = 10 * Math.sqrt(n);
  const angle = (2 * Math.PI * index) / n;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function seedPositions(graph: Graph, nodes: string[], given?: Float32Array): void {
  nodes.forEach((id, i) => {
    const x = given?.[i * 2];
    const y = given?.[i * 2 + 1];
    const usable = Number.isFinite(x) && Number.isFinite(y) && !(x === 0 && y === 0);
    graph.addNode(id, usable ? { x: x as number, y: y as number } : seedPosition(i, nodes.length));
  });
}

function snapshot(graph: Graph, nodes: string[]): Float32Array {
  const out = new Float32Array(nodes.length * 2);
  nodes.forEach((id, i) => {
    out[i * 2] = graph.getNodeAttribute(id, "x") as number;
    out[i * 2 + 1] = graph.getNodeAttribute(id, "y") as number;
  });
  return out;
}

/**
 * Start a layout. Ticks arrive via `onTick`, the last one with `done: true`.
 * Returns a cancel function; cancelling guarantees no further ticks.
 */
export function runGraphLayout(input: LayoutInput, onTick: (tick: LayoutTick) => void): () => void {
  const { nodes, edges } = input;
  const total = input.iterations ?? DEFAULT_LAYOUT_ITERATIONS;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };

  if (nodes.length === 0) {
    onTick({ positions: new Float32Array(0), iteration: total, total, done: true });
    return cancel;
  }

  const graph = new Graph({ type: "undirected" });
  seedPositions(graph, nodes, input.positions);
  for (const [source, target] of edges) {
    // Defensive: an edge naming a node that isn't in the list would throw and
    // lose the whole layout, which is a bad trade for one missing line.
    if (source === target) continue;
    if (!graph.hasNode(source) || !graph.hasNode(target)) continue;
    if (!graph.hasEdge(source, target)) graph.addEdge(source, target);
  }

  // A single node has nothing to repel against; FA2 would just divide by zero.
  if (nodes.length === 1) {
    graph.setNodeAttribute(nodes[0], "x", 0);
    graph.setNodeAttribute(nodes[0], "y", 0);
    onTick({ positions: snapshot(graph, nodes), iteration: total, total, done: true });
    return cancel;
  }

  // Seed-only mode. ForceAtlas2 throws on a non-positive iteration count, and
  // that throw would surface as an unhandled worker error rather than a
  // missing animation, so the case is handled here instead.
  if (total <= 0) {
    onTick({ positions: snapshot(graph, nodes), iteration: 0, total, done: true });
    return cancel;
  }

  // inferSettings scales gravity and repulsion to graph order. Its one
  // decision we override is Barnes-Hut, which it enables past ~2000 nodes:
  // this library's quadtree is SLOWER than brute force at every size measured
  // (60 iterations at 240 nodes: 16ms brute vs 263ms; at 1000 nodes: 279ms vs
  // 1647ms), so the "optimization" is a straight loss.
  const settings = { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: false };
  const startedAt = Date.now();
  let done = 0;

  const step = () => {
    if (cancelled) return;
    const slice = Math.min(CHUNK, total - done);
    forceAtlas2.assign(graph, { iterations: slice, settings, getEdgeWeight: null });
    done += slice;
    if (cancelled) return;
    const outOfTime = Date.now() - startedAt > TIME_BUDGET_MS;
    const finished = done >= total || outOfTime;
    onTick({ positions: snapshot(graph, nodes), iteration: done, total, done: finished });
    if (!finished) setTimeout(step, 0);
  };
  setTimeout(step, 0);

  return cancel;
}
