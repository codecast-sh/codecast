// The pool of flows a change can run through (docs/architecture/flows.md FL2):
// the flows the CLI ships and the repo's `.codecast/flows/*.cast`, each read
// through the parser so its kind, its stations and its segments are what the
// runner would run. Pure but for reading the repo's files.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseWorkflowSource, SEGMENT_SEP, validateWorkflow } from "./parser.js";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates.js";
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "./types.js";

export type PoolWhere = "shipped" | "repo" | "pushed";

export type PoolStation = {
  id: string;
  label: string;
  /** agent: a session works it; script: a command; person: a gate; segment: a flow run in place. */
  kind: "agent" | "script" | "person" | "segment" | "call";
  /** For a segment, the flow it runs and how many stations that is. */
  flow?: string;
  steps?: number;
  /** Where it sends work: the station (or end) and the words for when. */
  next: Array<{ to: string; when: string | null }>;
};

export type PoolFlow = {
  slug: string;
  kind: "line" | "segment";
  label: string;
  description: string | null;
  takes: string[];
  where: PoolWhere;
  file: string | null;
  /** The flow's own stations in the order work reaches them, segments folded to one each. */
  stations: PoolStation[];
  /** How the flow can end: its exits by label. */
  ends: string[];
  /** The segments it uses, by slug. */
  uses: string[];
  errors: string[];
};

/** The nearest `.codecast/flows` directory at or above `cwd`. */
export function repoFlowsDir(cwd: string): string | null {
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    const dir = path.join(d, ".codecast", "flows");
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    if (path.dirname(d) === d) return null;
  }
}

/** The pool as this checkout sees it: the repo's flows first, then the shipped ones it does not override. */
export function poolFlows(cwd: string): PoolFlow[] {
  const out: PoolFlow[] = [];
  const dir = repoFlowsDir(cwd);
  const own = new Set<string>();
  if (dir) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".cast")).sort()) {
      const slug = f.replace(/\.cast$/, "");
      own.add(slug);
      const file = path.join(dir, f);
      out.push(describeFlow(slug, fs.readFileSync(file, "utf-8"), "repo", file, dir));
    }
  }
  for (const [slug, src] of Object.entries(BUILTIN_WORKFLOW_TEMPLATES)) {
    if (!own.has(slug)) out.push(describeFlow(slug, src, "shipped", null, dir ?? undefined));
  }
  return out;
}

/** One flow in the pool's terms, from its source. A flow that does not parse is listed with why. */
export function describeFlow(slug: string, src: string, where: PoolWhere, file: string | null, dir?: string): PoolFlow {
  let graph: WorkflowGraph;
  try {
    graph = parseWorkflowSource(src, file ? path.dirname(file) : dir);
  } catch (err) {
    return { slug, kind: "line", label: slug, description: null, takes: [], where, file, stations: [], ends: [], uses: [], errors: [err instanceof Error ? err.message : String(err)] };
  }
  return {
    slug,
    kind: graph.kind ?? "line",
    label: graph.label ?? titleOf(slug),
    description: graph.description ?? null,
    takes: graph.takes ?? ["task"],
    where,
    file,
    ...folded(graph),
    errors: validateWorkflow(graph),
  };
}

const titleOf = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const topOf = (id: string) => id.split(SEGMENT_SEP)[0];

function kindOf(n: WorkflowNode): PoolStation["kind"] {
  if (n.segment_entry) return "segment";
  if (n.type === "human") return "person";
  if (n.type === "command") return "script";
  if (n.type === "call") return "call";
  return "agent";
}

/** Words for when an edge is taken: its option label, else its condition, else nothing (always). */
export function edgeWhen(e: Pick<WorkflowEdge, "label" | "condition">): string | null {
  if (e.label) return e.label.replace(/^\[\w+\]\s*/, "").split("::")[0].trim();
  if (!e.condition) return null;
  return e.condition.replace(/\s+/g, " ").trim();
}

/**
 * The graph as its own stations: a segment's stations fold into the node that
 * named it, and the order is the order work first reaches each station from
 * the start, following every edge.
 */
function folded(graph: WorkflowGraph): Pick<PoolFlow, "stations" | "ends" | "uses"> {
  const top = new Map<string, WorkflowNode>();
  const steps = new Map<string, number>();
  for (const n of graph.nodes.values()) {
    const t = topOf(n.id);
    if (t === n.id) top.set(t, n);
    else if (!n.segment_exit) steps.set(t, (steps.get(t) ?? 0) + 1);
  }
  const outOf = new Map<string, Array<{ to: string; when: string | null }>>();
  for (const e of graph.edges) {
    const from = topOf(e.from);
    const to = topOf(e.to);
    if (from === to) continue;
    const list = outOf.get(from) ?? [];
    const when = edgeWhen(e);
    if (!list.some((x) => x.to === to && x.when === when)) list.push({ to, when });
    outOf.set(from, list);
  }
  const start = [...top.values()].find((n) => n.type === "start");
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = start ? [start.id] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const { to } of outOf.get(id) ?? []) if (!seen.has(to)) queue.push(to);
  }
  for (const id of top.keys()) if (!seen.has(id)) order.push(id);
  const stations: PoolStation[] = [];
  const ends: string[] = [];
  const uses = new Set<string>();
  for (const id of order) {
    const n = top.get(id);
    if (!n || n.type === "start") continue;
    if (n.type === "exit") { ends.push(n.label); continue; }
    if (n.segment_flow) uses.add(n.segment_flow);
    const label = (to: string) => top.get(to)?.label ?? to;
    stations.push({
      id,
      label: n.label,
      kind: kindOf(n),
      ...(n.segment_entry ? { flow: n.segment_flow, steps: steps.get(id) ?? 0 } : {}),
      next: (outOf.get(id) ?? []).map((x) => ({ to: label(x.to), when: x.when })),
    });
  }
  // Exits inside a segment are the flow's ends too when a stop leaves the run there.
  for (const n of graph.nodes.values()) if (n.type === "exit" && n.segment && !ends.includes(n.label)) ends.push(n.label);
  return { stations, ends, uses: [...uses] };
}

/** One line for a flow: `check  segment  branch  Verify` style, for `cast flow ls`. */
export function flowLine(f: PoolFlow): string {
  const path = f.stations.map((s) => s.label).join(" → ") || "(no stations)";
  return `${f.slug.padEnd(16)} ${f.kind.padEnd(8)} ${f.takes.join(",").padEnd(12)} ${path}`;
}
