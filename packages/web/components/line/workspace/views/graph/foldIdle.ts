// The live graph's folds (the Flows stage): a long flow drawn whole sprawls
// past any screen, while the part a person reads is where runs stand. Each
// quiet region (nothing standing there, entered at one step and left to one:
// a branch that fans out and joins again, or a straight stretch) folds into one step
// that says how many it holds, so the busy part of the flow sits close
// together. Pressing a fold opens it. Pure.
import type { LineGraphModel, ModelEdge, ModelNode } from "../../../../../lib/line/lineModel";

export const FOLD_PREFIX = "fold:";
/** The shortest stretch worth folding: one idle step reads fine as itself. */
const MIN_FOLD = 2;

export const isFold = (id: string) => id.startsWith(FOLD_PREFIX);

/**
 * `g` with each straight idle stretch of MIN_FOLD or more steps (inside one half) folded into one step, its id the
 * stretch's first step's prefixed with FOLD_PREFIX. `busy` keeps a step out of every fold (runs stand there, or it is
 * open); `open` names the folds (by that id) a person opened. Edges into and out of a stretch meet its fold; the
 * edges inside it go. The same graph comes back when nothing folds.
 */
export function foldIdle(g: LineGraphModel, busy: (id: string) => boolean, open: ReadonlySet<string> = new Set()): LineGraphModel {
  const ins = new Map<string, ModelEdge[]>();
  const outs = new Map<string, ModelEdge[]>();
  for (const e of g.edges) {
    if (e.from === e.to) continue;
    (outs.get(e.from) ?? outs.set(e.from, []).get(e.from)!).push(e);
    (ins.get(e.to) ?? ins.set(e.to, []).get(e.to)!).push(e);
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const idle = (n: ModelNode | undefined): n is ModelNode =>
    !!n && n.kind !== "end" && !busy(n.id) && (ins.get(n.id)?.length ?? 0) === 1 && (outs.get(n.id)?.length ?? 0) === 1;
  const prevOf = (n: ModelNode) => byId.get(ins.get(n.id)![0].from);
  const nextOf = (n: ModelNode) => byId.get(outs.get(n.id)![0].to);

  const foldOf = new Map<string, string>();
  const folds: Array<{ id: string; nodes: ModelNode[] }> = [];
  const fold = (members: ModelNode[]) => {
    const id = `${FOLD_PREFIX}${members[0].id}`;
    if (members.length < MIN_FOLD || open.has(id)) return;
    folds.push({ id, nodes: members });
    for (const c of members) foldOf.set(c.id, id);
  };

  // Regions first: from each quiet step (nothing standing there, not an end) in turn, the quiet steps it leads to in its
  // half. When work enters that region only at its start, from at most one step, and leaves it to one step (a branch
  // that fans out and joins again, a straight run), the region is one fold. A way back (a loop edge) is neither a way in
  // nor a way out: the fold keeps it.
  const quiet = (n: ModelNode | undefined): n is ModelNode => !!n && n.kind !== "end" && !busy(n.id) && !foldOf.has(n.id);
  const forward = g.edges.filter((e) => e.kind !== "loop" && e.from !== e.to);
  for (const s0 of g.nodes) {
    if (!quiet(s0)) continue;
    const inside = new Set([s0.id]);
    const queue = [s0.id];
    while (queue.length) {
      const at = queue.shift()!;
      for (const e of forward) {
        if (e.from !== at || inside.has(e.to)) continue;
        const next = byId.get(e.to);
        if (quiet(next) && next.half === s0.half) { inside.add(next.id); queue.push(next.id); }
      }
    }
    if (inside.size < MIN_FOLD) continue;
    const from = new Set<string>(), to = new Set<string>();
    let entersElsewhere = false;
    for (const e of forward) {
      if (inside.has(e.to) && !inside.has(e.from)) { from.add(e.from); if (e.to !== s0.id) entersElsewhere = true; }
      if (inside.has(e.from) && !inside.has(e.to)) to.add(e.to);
    }
    if (entersElsewhere || from.size > 1 || to.size > 1) continue;
    fold(g.nodes.filter((n) => inside.has(n.id)));
  }

  // Then the straight stretches inside what no region took.
  for (const n of g.nodes) {
    if (foldOf.has(n.id) || !idle(n)) continue;
    // From the stretch's first step, forward while the next is idle, in the same half, and not seen.
    let first = n;
    const back = new Set([n.id]);
    for (let p = prevOf(first); idle(p) && p.half === n.half && !foldOf.has(p.id) && !back.has(p.id); p = prevOf(p)) { first = p; back.add(p.id); }
    const chain: ModelNode[] = [];
    const seen = new Set<string>();
    for (let c: ModelNode | undefined = first; idle(c) && c.half === n.half && !seen.has(c.id) && !foldOf.has(c.id); c = nextOf(c)) {
      chain.push(c);
      seen.add(c.id);
    }
    fold(chain);
  }
  if (!folds.length) return g;

  const firstOf = new Map(folds.map((f) => [f.nodes[0].id, f]));
  const nodes: ModelNode[] = [];
  for (const n of g.nodes) {
    const f = firstOf.get(n.id);
    if (f) nodes.push({ ...n, id: f.id, label: `${f.nodes.length} steps`, fileLabel: null, kind: "script", end: null, visits: 0, runs: 0, failed: 0, cutOff: 0, medianMs: null });
    else if (!foldOf.has(n.id)) nodes.push(n);
  }
  const at = (id: string) => foldOf.get(id) ?? id;
  const edges: ModelEdge[] = [];
  const kept = new Set<string>();
  for (const e of g.edges) {
    const from = at(e.from);
    const to = at(e.to);
    if (from === to && foldOf.has(e.from)) continue;
    const id = `${from}->${to}`;
    if (kept.has(id)) continue;
    kept.add(id);
    edges.push(from === e.from && to === e.to ? e : { ...e, id, from, to });
  }
  const stages = g.stages.map((s) => ({ ...s, nodes: [...new Set(s.nodes.map(at))] }));
  return { ...g, nodes, edges, stages };
}
