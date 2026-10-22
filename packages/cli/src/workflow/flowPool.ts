// The pool of flows a change can run through (docs/architecture/flows.md FL2):
// the flows the CLI ships and the repo's `.codecast/flows/*.cast`, each read
// through the parser so its kind, its stations and its segments are what the
// runner would run. Pure but for reading the repo's files.
import * as fs from "node:fs";
import * as path from "node:path";
import { foldFlow, flowPathWords, type FlowStation, type PoolFlowSummary } from "@codecast/shared/contracts/flowPool";
import { parseWorkflowSource, validateWorkflow } from "./parser.js";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates.js";
import { DEFAULT_LINE_SLUG } from "@codecast/shared/contracts/orgProposal";
import type { WorkflowGraph } from "./types.js";

export type PoolWhere = "shipped" | "repo" | "pushed";
export type PoolStation = FlowStation;

export type PoolFlow = PoolFlowSummary & {
  where: PoolWhere;
  file: string | null;
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
    if (own.has(slug) || !joinsPool(slug, src)) continue;
    out.push(describeFlow(slug, src, "shipped", null, dir ?? undefined));
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
