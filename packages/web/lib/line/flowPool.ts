// The pool of flows as the app reads it (docs/architecture/flows.md FL2,
// FL6): the flows the CLI ships (a generated snapshot, shippedFlows.generated.ts)
// and the workflows the team pushed. Each reads through the one fold
// (shared/contracts/flowPool.ts) the CLI's `cast flow ls` uses, so both say
// the same stations in the same order. Pure: no store, no React.
import { foldFlow, segmentTopOf, type FlowEdgeIn, type FlowNodeIn, type PoolFlowSummary } from "@codecast/shared/contracts/flowPool";
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

/** The flow a run ran, from its workflow name or slug. */
export function flowOfRun(pool: ReadonlyArray<AppFlow>, run: { workflow_slug?: string | null; workflow_name?: string | null }): AppFlow | null {
  return flowBySlug(pool, run.workflow_slug ?? null) ?? flowBySlug(pool, run.workflow_name ?? null) ?? pool.find((f) => f.name === run.workflow_name) ?? null;
}
