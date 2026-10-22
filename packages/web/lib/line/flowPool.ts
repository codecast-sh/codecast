// The pool of flows as the app reads it (docs/architecture/flows.md FL2,
// FL6): the flows the CLI ships (a generated snapshot, shippedFlows.generated.ts)
// and the workflows the team pushed. Each reads through the one fold
// (shared/contracts/flowPool.ts) the CLI's `cast flow ls` uses, so both say
// the same stations in the same order. Pure: no store, no React.
import { foldFlow, segmentTopOf, type FlowEdgeIn, type FlowNodeIn, type PoolFlowSummary } from "@codecast/shared/contracts/flowPool";
import type { LineGraphSource } from "./lineModel";
import { SHIPPED_FLOWS } from "./shippedFlows.generated";

export type ShippedFlow = PoolFlowSummary & { name: string; nodes: FlowNodeIn[]; edges: FlowEdgeIn[] };

export type AppFlow = ShippedFlow & {
  where: "shipped" | "pushed";
  /** The pushed row, for a flow the team published. */
  workflowId: string | null;
};

/** A pushed workflows row, as much of it as the pool reads. */
export type PushedFlowRow = {
  _id: string;
  slug: string;
  name: string;
  source?: string | null;
  nodes: ReadonlyArray<{ id: string; label: string; type: string; shape?: string }>;
  edges: ReadonlyArray<{ from: string; to: string; label?: string; condition?: string }>;
};

/** Graph attributes read from a DOT source's `graph [...]` line, for the few the pool shows. */
function graphAttr(source: string | null | undefined, key: string): string | null {
  const m = source?.match(new RegExp(`graph\\s*\\[[^\\]]*\\b${key}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

const titleOf = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** A pushed row in the pool's terms. Its stored nodes carry no segment fields, so its segments read from their ids. */
export function pushedFlow(row: PushedFlowRow): AppFlow {
  const nodes: FlowNodeIn[] = row.nodes.map((n) => {
    const top = segmentTopOf(n.id);
    const entry = top === n.id && row.nodes.some((x) => x.id.startsWith(`${n.id}__`));
    return { id: n.id, label: n.label, type: n.type, shape: n.shape, ...(top !== n.id ? { segment: top } : {}), ...(entry ? { segment_entry: true, segment_flow: n.id } : {}) };
  });
  const edges = row.edges.map((e) => ({ ...e }));
  const takes = graphAttr(row.source, "takes");
  return {
    slug: row.slug,
    name: row.name,
    kind: graphAttr(row.source, "kind") === "segment" ? "segment" : "line",
    label: graphAttr(row.source, "label") ?? titleOf(row.name),
    description: graphAttr(row.source, "description"),
    takes: takes ? takes.split(/[\s,]+/).filter(Boolean) : ["task"],
    ...foldFlow(nodes, edges),
    nodes,
    edges,
    where: "pushed",
    workflowId: row._id,
  };
}

/** The pool: every shipped flow, then each pushed one the shipped set does not already name. */
export function appPool(pushed: ReadonlyArray<PushedFlowRow> = []): AppFlow[] {
  const shipped = SHIPPED_FLOWS.map((f) => ({ ...f, where: "shipped" as const, workflowId: null }));
  const names = new Set(shipped.map((f) => f.slug));
  return [...shipped, ...pushed.filter((r) => !names.has(r.slug) && r.nodes.length).map(pushedFlow)];
}

export const flowBySlug = (pool: ReadonlyArray<AppFlow>, slug: string | null | undefined) => (slug ? pool.find((f) => f.slug === slug) ?? null : null);

const foldedCache = new WeakMap<ShippedFlow, LineGraphSource>();
const expandedCache = new WeakMap<ShippedFlow, LineGraphSource>();

/**
 * A flow's graph for the line's drawing (buildLineModel's `graph`). Folded,
 * each segment is one station named for it; expanded, every station a run
 * visits is there, so a run's path lights on it.
 */
export function flowGraphSource(flow: ShippedFlow, mode: "folded" | "expanded"): LineGraphSource {
  const cache = mode === "folded" ? foldedCache : expandedCache;
  const hit = cache.get(flow);
  if (hit) return hit;
  let src: LineGraphSource;
  if (mode === "expanded") {
    // A segment's entry and its plain exits only pass work on: drawn, they are steps that do nothing.
    const pass = new Set(flow.nodes.filter((n) => n.segment_entry || n.segment_exit === "done").map((n) => n.id));
    const nodes = flow.nodes.filter((n) => !pass.has(n.id));
    const via = (id: string, seen = new Set<string>()): string[] => {
      if (!pass.has(id)) return [id];
      if (seen.has(id)) return [];
      seen.add(id);
      return flow.edges.filter((e) => e.from === id).flatMap((e) => via(e.to, seen));
    };
    const edges: FlowEdgeIn[] = [];
    for (const e of flow.edges) {
      if (pass.has(e.from)) continue;
      for (const to of via(e.to)) if (!edges.some((x) => x.from === e.from && x.to === to)) edges.push({ ...e, to });
    }
    src = { nodes: nodes.map(drawnNode), edges, name: flow.name };
  } else {
    const keep = flow.nodes.filter((n) => segmentTopOf(n.id) === n.id);
    const edges: FlowEdgeIn[] = [];
    for (const e of flow.edges) {
      const from = segmentTopOf(e.from);
      const to = segmentTopOf(e.to);
      if (from === to || edges.some((x) => x.from === from && x.to === to)) continue;
      edges.push({ ...e, from, to });
    }
    src = { nodes: keep.map(drawnNode), edges, name: flow.name };
  }
  cache.set(flow, src);
  return src;
}

/** A node as the line's drawing reads one: a segment draws as the station it is. */
const drawnNode = (n: FlowNodeIn) => ({ id: n.id, label: n.label, type: n.segment_entry ? "agent" : n.type, shape: n.segment_entry ? "box" : n.shape ?? "box" });

/** The flow a run ran, from its workflow name or slug. */
export function flowOfRun(pool: ReadonlyArray<AppFlow>, run: { workflow_slug?: string | null; workflow_name?: string | null }): AppFlow | null {
  return flowBySlug(pool, run.workflow_slug ?? null) ?? flowBySlug(pool, run.workflow_name ?? null) ?? pool.find((f) => f.name === run.workflow_name) ?? null;
}
