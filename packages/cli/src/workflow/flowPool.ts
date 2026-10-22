// The pool of flows a change can run through (docs/architecture/flows.md FL2):
// the flows the CLI ships, the repo's `.codecast/flows/*.cast`, and the flows
// published to the workspace's pool (/cli/workflows/pool), each read through
// the parser so its kind, its stations and its segments are what the runner
// would run. Pure but for reading the repo's files and writing published
// flows to this machine's cache.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { foldFlow, flowPathWords, type FlowStation, type PoolFlowSummary } from "@codecast/shared/contracts/flowPool";
import { parseWorkflowSource, validateWorkflow } from "./parser.js";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates.js";
import { DEFAULT_LINE_SLUG } from "@codecast/shared/contracts/orgProposal";
import type { WorkflowGraph } from "./types.js";

export type PoolWhere = "shipped" | "repo" | "pushed" | "team";
export type PoolStation = FlowStation;

export type PoolFlow = PoolFlowSummary & {
  /** The session whose draft it is, while it is one. */
  draft: string | null;
  where: PoolWhere;
  file: string | null;
  errors: string[];
  /** Who published it, for a flow from the workspace's pool. */
  by?: string | null;
};

/** A flow published to the workspace's pool, as /cli/workflows/pool returns it. */
export type PushedPoolRow = {
  _id: string;
  slug: string;
  name: string;
  source: string;
  workspace?: string | null;
  by?: string | null;
  mine?: boolean;
  /** Each station's text as pushed (its own file's text, includes taken in). */
  nodes: Array<{ id: string; prompt?: string; script?: string }>;
  /** Where the graph and its station files sat in the publisher's checkout, repo-relative. */
  origin?: { file: string; files: Array<{ node: string; prompt?: string; script?: string }> } | null;
};

/**
 * A published flow on this machine: its source and each station's file
 * written under `cacheRoot/<row id>/` at the paths the publisher's checkout
 * held them, so the parser and the runner read it as they would read that
 * checkout. A path that would leave the directory is not written. Returns the
 * graph file.
 */
export function materializePushedFlow(row: PushedPoolRow, cacheRoot = path.join(os.homedir(), ".codecast", "flows")): string {
  const dir = path.resolve(cacheRoot, row._id.replace(/[^\w-]/g, ""));
  const write = (rel: string, text: string): string | null => {
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) return null;
    if (fs.existsSync(abs) && fs.readFileSync(abs, "utf-8") === text) return abs;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
  };
  const file = write(row.origin?.file ?? `${row.slug}.cast`, row.source) ?? write(`${row.slug}.cast`, row.source)!;
  const byId = new Map(row.nodes.map((n) => [n.id, n]));
  for (const f of row.origin?.files ?? []) {
    const n = byId.get(f.node);
    if (f.prompt && n?.prompt !== undefined) write(f.prompt, n.prompt);
    if (f.script && n?.script !== undefined) write(f.script, n.script);
  }
  return file;
}

/** The nearest `.codecast/flows` directory at or above `cwd`. */
export function repoFlowsDir(cwd: string): string | null {
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    const dir = path.join(d, ".codecast", "flows");
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    if (path.dirname(d) === d) return null;
  }
}

/**
 * The pool as this checkout sees it: the repo's flows first, then the shipped ones it does not override, then the
 * published ones (`pushed`) neither names, each slug once. A draft (an import its session has not made general yet)
 * is offered only to that session (`session`, its id or short id).
 */
export function poolFlows(cwd: string, session?: string | null, pushed: ReadonlyArray<PushedPoolRow> = [], cacheRoot?: string): PoolFlow[] {
  const out: PoolFlow[] = [];
  const dir = repoFlowsDir(cwd);
  const own = new Set<string>();
  if (dir) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".cast")).sort()) {
      const slug = f.replace(/\.cast$/, "");
      own.add(slug);
      const file = path.join(dir, f);
      const flow = describeFlow(slug, fs.readFileSync(file, "utf-8"), "repo", file, dir);
      if (flow.draft && !(session && (session.startsWith(flow.draft) || flow.draft.startsWith(session)))) continue;
      out.push(flow);
    }
  }
  for (const [slug, src] of Object.entries(BUILTIN_WORKFLOW_TEMPLATES)) {
    if (own.has(slug) || !joinsPool(slug, src)) continue;
    out.push(describeFlow(slug, src, "shipped", null, dir ?? undefined));
  }
  const named = new Set(out.map((f) => f.slug));
  for (const row of pushed) {
    if (named.has(row.slug) || !row.source) continue;
    named.add(row.slug);
    const file = materializePushedFlow(row, cacheRoot);
    const where = row.workspace?.startsWith("team:") ? "team" : "pushed";
    out.push({ ...describeFlow(row.slug, row.source, where, file), by: row.mine ? null : row.by ?? null });
  }
  return out;
}

/**
 * Whether a graph is one of the pool's flows: it says what kind of flow it is
 * (`graph [kind=...]`), or it is codecast's own line. Other graphs (a probe, a
 * trial's copy, an old template) can still be run by name; they are not offered.
 */
export function joinsPool(slug: string, src: string): boolean {
  return slug === DEFAULT_LINE_SLUG || /graph\s*\[[^\]]*\bkind\s*=/.test(src);
}

/** One flow in the pool's terms, from its source. A flow that does not parse is listed with why. */
export function describeFlow(slug: string, src: string, where: PoolWhere, file: string | null, dir?: string): PoolFlow {
  let graph: WorkflowGraph;
  try {
    graph = parseWorkflowSource(src, file ? path.dirname(file) : dir);
  } catch (err) {
    return { slug, kind: "line", label: slug, description: null, takes: [], draft: null, where, file, stations: [], ends: [], uses: [], errors: [err instanceof Error ? err.message : String(err)] };
  }
  return {
    slug,
    kind: graph.kind ?? "line",
    label: graph.label ?? titleOf(slug),
    description: graph.description ?? null,
    takes: graph.takes ?? ["task"],
    draft: graph.draft ?? null,
    where,
    file,
    ...foldFlow([...graph.nodes.values()], graph.edges),
    errors: validateWorkflow(graph),
  };
}

const titleOf = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** One line for a flow: `check  segment  branch  Verify` style, for `cast flow ls`. */
export function flowLine(f: PoolFlow): string {
  const { path: main, side } = flowPathWords(f);
  const path = main || "(no stations)";
  return `${f.slug.padEnd(16)} ${f.kind.padEnd(8)} ${f.takes.join(",").padEnd(12)} ${path}${side ? `  (+${side} on side routes)` : ""}`;
}
