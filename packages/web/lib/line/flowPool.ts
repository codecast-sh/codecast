// The pool of flows as the app reads it (docs/architecture/flows.md FL2,
// FL6): the flows the CLI ships (a generated snapshot, shippedFlows.generated.ts)
// and the workflows pushed to the store (the viewer's own, and the flows
// teammates published to the workspace's pool, workflows.webPool). Each reads through the one fold
// (shared/contracts/flowPool.ts) the CLI's `cast flow ls` uses, so both say
// the same stations in the same order. Pure: no store, no React.
import { flowBase, flowFills, flowGraphAttr as graphAttr, flowPathWords, flowSlotsOf, foldFlow, publishableFlowSource, segmentTopOf, type FlowEdgeIn, type FlowNodeIn, type PoolFlowSummary } from "@codecast/shared/contracts/flowPool";
import { SHIPPED_FLOWS } from "./shippedFlows.generated";
import { DEFAULT_LINE_SLUG, DEFAULT_STEPS_LABEL } from "@codecast/shared/contracts/lineSlug";

export type ShippedFlow = PoolFlowSummary & { name: string; nodes: FlowNodeIn[]; edges: FlowEdgeIn[]; /** The flow it extends, as the generator reads it (cli workflow/flowPool.ts PoolFlow). */ extends?: string | null };

export type AppFlow = ShippedFlow & {
  /** `team`: published to a team's pool; `pushed`: the viewer's own. */
  where: "shipped" | "pushed" | "team";
  /** The pushed row, for a flow the team published. */
  workflowId: string | null;
  /** The library flow it extends, by slug. */
  base?: string | null;
};

/** A pushed workflows row, as much of it as the pool reads. */
export type PushedFlowRow = {
  _id: string;
  slug: string;
  name: string;
  source?: string | null;
  workspace?: string | null;
  /** The graph's own label, for a row that carries no source to read it from. */
  label?: string | null;
  kind?: "line" | "segment" | null;
  /** The nodes the graph fills with steps it wrote in place, for a row that carries no source. */
  fills?: ReadonlyArray<string> | null;
  variant_of?: string | null;
  nodes: ReadonlyArray<{ id: string; label: string; type: string; shape?: string }>;
  edges: ReadonlyArray<{ from: string; to: string; label?: string; condition?: string }>;
};

const titleOf = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** A pushed row in the pool's terms. Its stored nodes carry no segment fields, so its segments read from their ids. */
export function pushedFlow(row: PushedFlowRow): AppFlow {
  // A segment the graph wrote in place, and a slot it declares, read from its source (or the row's own list).
  const fills = new Set(row.fills ?? flowFills(row.source));
  const slots = flowSlotsOf(row.source);
  const nodes: FlowNodeIn[] = row.nodes.map((n) => {
    const top = segmentTopOf(n.id);
    const entry = top === n.id && row.nodes.some((x) => x.id.startsWith(`${n.id}__`));
    const written = fills.has(top);
    // A segment's exit is the one step inside it whose every route leaves it (parser.ts expandFlows writes it so).
    const out = top !== n.id ? row.edges.filter((e) => e.from === n.id) : [];
    const exit = out.length > 0 && out.every((e) => segmentTopOf(e.to) !== top) ? (out.every((e) => /\boutcome\s*=\s*failure\b/.test(e.condition ?? "")) ? "stop" : "done") : null;
    return {
      id: n.id, label: n.label, type: n.type, shape: n.shape,
      ...(top !== n.id ? { segment: top } : {}),
      ...(exit ? { segment_exit: exit } : {}),
      ...(entry ? { segment_entry: true, ...(written ? {} : { segment_flow: n.id }) } : {}),
      ...(written ? { segment_generated: true } : {}),
      ...(top === n.id && slots[n.id] ? { slot: slots[n.id] } : {}),
    };
  });
  const edges = row.edges.map((e) => ({ ...e }));
  const takes = graphAttr(row.source, "takes");
  return {
    slug: row.slug,
    name: row.name,
    kind: (row.kind ?? graphAttr(row.source, "kind")) === "segment" ? "segment" : "line",
    label: row.label ?? graphAttr(row.source, "label") ?? titleOf(row.name),
    description: graphAttr(row.source, "description"),
    takes: takes ? takes.split(/[\s,]+/).filter(Boolean) : ["task"],
    ...foldFlow(nodes, edges),
    nodes,
    edges,
    where: row.workspace?.startsWith("team:") ? "team" : "pushed",
    workflowId: row._id,
    base: flowBase(row),
  };
}

/** The pool: every shipped flow, then each published one the shipped set does not already name. */
export function appPool(pushed: ReadonlyArray<PushedFlowRow> = []): AppFlow[] {
  // The shipped template's graph names no label of its own; people read it as the Standard steps.
  const shipped = SHIPPED_FLOWS.map((f) => ({ ...f, ...(f.slug === DEFAULT_LINE_SLUG && f.label === "Line" ? { label: DEFAULT_STEPS_LABEL } : {}), where: "shipped" as const, workflowId: null }));
  const names = new Set(shipped.map((f) => f.slug));
  // A pushed graph joins the pool only when it says what kind of flow it is and is no session's draft, never a probe or a trial's copy.
  const joins = pushed.filter((r) => !names.has(r.slug) && r.nodes.length && publishableFlowSource(r.source));
  return [...shipped, ...joins.filter((r, i) => joins.findIndex((x) => x.slug === r.slug) === i).map(pushedFlow)];
}

export const flowBySlug = (pool: ReadonlyArray<AppFlow>, slug: string | null | undefined) => (slug ? pool.find((f) => f.slug === slug) ?? null : null);

/** The flow a run ran, from its workflow name or slug. */
export function flowOfRun(pool: ReadonlyArray<AppFlow>, run: { workflow_slug?: string | null; workflow_name?: string | null }): AppFlow | null {
  return flowBySlug(pool, run.workflow_slug ?? null) ?? flowBySlug(pool, run.workflow_name ?? null) ?? pool.find((f) => f.name === run.workflow_name) ?? null;
}

/** A flow's path for a list row; nothing when it only repeats the flow's own name (a one-step segment). */
export function flowRowPath(f: Pick<AppFlow, "label" | "stations">): string {
  const { path } = flowPathWords(f);
  return path && path !== f.label ? path : "";
}

/** Lines first, then segments, each in the pool's own order. */
export const linesFirst = (pool: ReadonlyArray<AppFlow>): AppFlow[] => [...pool.filter((f) => f.kind === "line"), ...pool.filter((f) => f.kind !== "line")];
