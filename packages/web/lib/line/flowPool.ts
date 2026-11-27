// The pool of flows as the app reads it (docs/architecture/flows.md FL2,
// FL6): the flows the CLI ships (a generated snapshot, shippedFlows.generated.ts)
// and the workflows pushed to the store (the viewer's own, and the flows
// teammates published to the workspace's pool, workflows.webPool). Each reads through the one fold
// (shared/contracts/flowPool.ts) the CLI's `cast flow ls` uses, so both say
// the same stations in the same order. Pure: no store, no React.
import { defaultFlowOf, flowBase, flowFills, flowNodeAttrOf, flowRunAttr, flowPathWords, flowSlotsOf, foldFlow, publishableFlowSource, retiredFlowLine, segmentTopOf, takesSessionChange, workspacePool, type FlowEdgeIn, type FlowNodeIn, type PoolFlowSummary } from "@codecast/shared/contracts/flowPool";
import type { RepoFlow } from "@codecast/shared/contracts/repoFlows";
import { SHIPPED_FLOWS } from "./shippedFlows.generated";
import { sourceSaysOwnResults } from "@codecast/shared/contracts/ownResults";
import { DEFAULT_LINE_SLUG, DEFAULT_STEPS_LABEL } from "@codecast/shared/contracts/lineSlug";
import { stationsOfNodes, type FlowStations, type StationDetail } from "./flowStations";

export type ShippedFlow = PoolFlowSummary & { name: string; nodes: FlowNodeIn[]; edges: FlowEdgeIn[]; /** The flow it extends, as the generator reads it (cli workflow/flowPool.ts PoolFlow). */ extends?: string | null; /** A personal Ship (ownRound.ts): its source says `own_results=true`. */ own_results?: boolean };

export type AppFlow = ShippedFlow & {
  /** `team`: published to a team's pool; `pushed`: the viewer's own; `repo`: the session's repository's own (`.codecast/flows`). */
  where: "shipped" | "pushed" | "team" | "repo";
  /** The pushed row, for a flow the team published. */
  workflowId: string | null;
  /** The library flow it extends, by slug. */
  base?: string | null;
  /** Each station's words and settings, from the row it was pushed as. A shipped flow's load on demand (flowStations). */
  stationDetails?: FlowStations | null;
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
  nodes: ReadonlyArray<{ id: string; label: string; type: string; shape?: string } & StationDetail>;
  edges: ReadonlyArray<{ from: string; to: string; label?: string; condition?: string }>;
};

const titleOf = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** A pushed row in the pool's terms. Its stored nodes carry no segment fields, so its segments read from their ids. */
export function pushedFlow(row: PushedFlowRow): AppFlow {
  // A segment the graph wrote in place, and a slot it declares, read from its source (or the row's own list).
  const fills = new Set(row.fills ?? flowFills(row.source));
  const slots = flowSlotsOf(row.source);
  // A stored node carries no backend, visit limit or stop: the session's own stations, their limits and the run's
  // deliberate ends read from the source.
  const backends = flowNodeAttrOf(row.source, "backend");
  const maxVisits = flowNodeAttrOf(row.source, "max_visits");
  const machine = flowNodeAttrOf(row.source, "machine");
  const fold = flowNodeAttrOf(row.source, "fold");
  const asksIf = flowNodeAttrOf(row.source, "asks_if");
  const stops = flowNodeAttrOf(row.source, "stop");
  const nodes: FlowNodeIn[] = row.nodes.map((n) => {
    const top = segmentTopOf(n.id);
    const entry = top === n.id && row.nodes.some((x) => x.id.startsWith(`${n.id}__`));
    const written = fills.has(top);
    // A segment's exit is the one step inside it whose every route leaves it (parser.ts expandFlows writes it so).
    const out = top !== n.id ? row.edges.filter((e) => e.from === n.id) : [];
    const exit = out.length > 0 && out.every((e) => segmentTopOf(e.to) !== top) ? (out.every((e) => /\boutcome\s*=\s*failure\b/.test(e.condition ?? "")) ? "stop" : "done") : null;
    return {
      id: n.id, label: n.label, type: n.type, shape: n.shape,
      // The source's word, else the stored node's own (a flow whose source names its station in a file it extends).
      ...(backends[n.id] ?? (n as { backend?: string }).backend ? { backend: backends[n.id] ?? (n as { backend?: string }).backend } : {}),
      ...(Number(maxVisits[n.id]) > 0 ? { max_visits: Number(maxVisits[n.id]) } : {}),
      ...(machine[n.id] === "true" ? { machine: true } : {}),
      ...(fold[n.id] === "true" ? { fold: true } : {}),
      ...(asksIf[n.id] ? { asks_if: asksIf[n.id] } : {}),
      ...(stops[n.id] ? { stop: stops[n.id] } : {}),
      ...(top !== n.id ? { segment: top } : {}),
      ...(exit ? { segment_exit: exit } : {}),
      ...(entry ? { segment_entry: true, ...(written ? {} : { segment_flow: n.id }) } : {}),
      ...(written ? { segment_generated: true } : {}),
      ...(top === n.id && slots[n.id] ? { slot: slots[n.id] } : {}),
    };
  });
  const edges = row.edges.map((e) => ({ ...e }));
  // A variant's graph attributes are its base's where it sets none (Codecast's Change only extends the library's).
  const takes = flowRunAttr(row.source, "takes");
  return {
    slug: row.slug,
    name: row.name,
    kind: (row.kind ?? flowRunAttr(row.source, "kind")) === "segment" ? "segment" : "line",
    label: row.label ?? flowRunAttr(row.source, "label") ?? titleOf(row.name),
    description: flowRunAttr(row.source, "description"),
    takes: takes ? takes.split(/[\s,]+/).filter(Boolean) : ["task"],
    ...foldFlow(nodes, edges),
    nodes,
    edges,
    where: row.workspace?.startsWith("team:") ? "team" : "pushed",
    workflowId: row._id,
    base: flowBase(row),
    stationDetails: stationsOfNodes(row.nodes),
    ...(sourceSaysOwnResults(row.source) ? { own_results: true } : {}),
  };
}

/** The pool as `cast flow run` sees it in a repository (cli workflow/flowPool.ts poolFlows): the repository's own flows,
 *  then each shipped flow they do not override, then each published one neither names. */
// Every pill, fence and picker in a transcript asks for the pool over the
// same store rows, each through its own memo with its own array; building it
// parses every pushed graph's source. The answer is kept for the last few row
// lists, matched row by row. Callers read it and never change it.
const POOL_SLOTS = 4;
const poolMemo: { rows: ReadonlyArray<PushedFlowRow>; repo: ReadonlyArray<RepoFlow>; pool: AppFlow[] }[] = [];
const sameRows = <T,>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) => a.length === b.length && a.every((r, i) => r === b[i]);
export function appPool(pushed: ReadonlyArray<PushedFlowRow> = [], repo: ReadonlyArray<RepoFlow> = []): AppFlow[] {
  const hit = poolMemo.find((m) => sameRows(m.rows, pushed) && sameRows(m.repo, repo));
  if (hit) return hit.pool;
  const pool = buildPool(pushed, repo);
  poolMemo.unshift({ rows: pushed.slice(), repo: repo.slice(), pool });
  poolMemo.length = Math.min(poolMemo.length, POOL_SLOTS);
  return pool;
}

/** The shipped flow a checkout reported with its start decided there (cli workflow/startFacts.ts), by the report's own
 *  mark: a repository's flow that only looks like the library's stays the repository's. */
const cutOf = (f: RepoFlow): ShippedFlow | null => (f.decided_from === f.slug ? SHIPPED_FLOWS.find((s) => s.slug === f.slug) ?? null : null);

function buildPool(pushed: ReadonlyArray<PushedFlowRow>, repo: ReadonlyArray<RepoFlow>): AppFlow[] {
  // A cut of a shipped flow is that flow as this checkout runs it: the library's, with the path its start takes.
  const own: AppFlow[] = repo.map((f) => {
    const lib = cutOf(f);
    return lib ? { ...lib, nodes: f.nodes, edges: f.edges, ...foldFlow(f.nodes, f.edges), where: "shipped" as const, workflowId: null } : { ...f, ...foldFlow(f.nodes, f.edges), where: "repo" as const, workflowId: null };
  });
  const ownSlugs = new Set(own.map((f) => f.slug));
  // The shipped template's graph names no label of its own; people read it as the Standard steps.
  const local = [...own, ...SHIPPED_FLOWS.filter((f) => !ownSlugs.has(f.slug)).map((f) => ({ ...f, ...(f.slug === DEFAULT_LINE_SLUG && f.label === "Line" ? { label: DEFAULT_STEPS_LABEL } : {}), where: "shipped" as const, workflowId: null }))];
  const names = new Set(local.map((f) => f.slug));
  // A pushed graph joins the pool only when it says what kind of flow it is and is no session's draft, never a probe or a trial's copy,
  // and never under a name the library retired: a run of it left a row behind, which nothing shadows any more.
  const joins = pushed.filter((r) => !names.has(r.slug) && !retiredFlowLine(r.slug) && r.nodes.length && publishableFlowSource(r.source));
  const pushedFlows = joins.filter((r, i) => joins.findIndex((x) => x.slug === r.slug) === i).map((r) => ({ flow: pushedFlow(r), saysTakes: !!flowRunAttr(r.source, "takes") }));
  const all: AppFlow[] = [...local, ...pushedFlows.map((p) => p.flow)];
  // A flow that extends one only the pool holds (a team's own flow) and says nothing of what it takes takes what that
  // base takes; a library base already gave it its takes (flowRunAttr).
  for (const p of pushedFlows) {
    const base = !p.saysTakes && p.flow.base ? all.find((f) => f.slug === p.flow.base) : null;
    if (base) p.flow.takes = base.takes;
  }
  return all;
}

/** A repository's flow that replaces a library flow of its slug, named with the repository's short name ("Change ·
 *  union-mobile"), so it never reads as the library's own. `repository` is the session's, as its remote names it. */
export function namedForRepo(pool: ReadonlyArray<AppFlow>, repository: string | null): AppFlow[] {
  const name = repository?.split("/").pop();
  if (!name) return pool.slice();
  return pool.map((f) => (f.where === "repo" && SHIPPED_FLOWS.some((s) => s.slug === f.slug) ? { ...f, label: `${f.label} · ${name}` } : f));
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

/** The Ship picker's flows for a session (RunThroughFlow), its default first: the session's pool in its workspace's
 *  terms (a personal session ships through `personal` where the repository has no `change` of its own, as `cast flow
 *  run` there does), only the whole flows that take a session's change, the default by defaultFlowOf. */
/** Whether a session's Ship previews the personal Ship, as far as the web can tell what `cast flow run change` decides
 *  (cli directoryTeam.ts): no team shares the session, its checkout has an origin to land on, and no team of the
 *  person's knows that repository (convex workflows.repositoryKnownToTeams; `known` is undefined while it loads, which
 *  previews the team's flow until the answer says otherwise). */
export const previewsPersonal = (workspace: string | null | undefined, repository: string | null, known: boolean | undefined): boolean => !!workspace?.startsWith("user:") && !!repository && known === false;

export function shipPicks(pool: ReadonlyArray<AppFlow>, repository: string | null, workspaceSlug: string | null, personal: boolean): { pool: AppFlow[]; fallback: AppFlow | null } {
  // Flows only: a segment runs one part of a change, never the change to live.
  const all = namedForRepo(linesFirst(workspacePool(pool, personal).filter((f) => f.kind === "line" && takesSessionChange(f))), repository);
  const d = defaultFlowOf(all, workspaceSlug);
  return { pool: d ? [d, ...all.filter((f) => f !== d)] : all, fallback: d };
}
