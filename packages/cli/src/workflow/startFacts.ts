// What a run knows of its repository before any station runs (flows.md FL4), and the start a flow routes on it.
// `ship_mode` says how the repository lands a change: "direct" straight onto its default branch with no pull request,
// "pr" (the default) through one. It is read from the default branch as origin has it, never from a working tree: a
// change cannot pick its own way past pull request, CI and the person's card by editing the files that say so. The
// library change flow's start routes on it, and that start is decided before the run, so the run carries, and its
// card draws, only the path it takes.
import { spawnSync } from "../proc.js";
import { parseCondition, evalCondition } from "./condition.js";
import { parseWorkflowSource } from "./parser.js";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates.js";
import type { WorkflowEdge, WorkflowGraph } from "./types.js";

/** The facts a start may be decided on, each with the values it takes: a condition over anything else is the run's. */
export const START_FACTS: Record<string, readonly string[]> = { ship_mode: ["pr", "direct"] };

/** The repository's own files on its default branch cannot be read as written: the run stops rather than guess. */
export class StartFactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartFactsError";
  }
}

/**
 * How a repository lands a change. Straight to the default branch only when the default branch says
 * `[ship] mode = "direct"` and runs no CI on GitHub: a repository with CI workflows lands by pull request on green
 * whatever its mode says, since its mode there is how `cast ship checkout` pushes, not a promise that nothing checks it.
 */
export function shipModeOf(declared: string | undefined, hasCi: boolean): "pr" | "direct" {
  return declared === "direct" && !hasCi ? "direct" : "pr";
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? String(r.stdout) : null;
}

/** The default branch as origin has it (origin/HEAD, else origin/main), or null when this checkout has neither. */
function defaultRef(cwd: string): string | null {
  const head = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.trim();
  const ref = head || "origin/main";
  return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) ? ref : null;
}

const isTable = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * The strings a run needs from one table of a TOML file on the default branch, read past everything else: a key a
 * newer cast writes elsewhere in the file never stops a run here. Null when the file is not there. Throws
 * StartFactsError when the file is not TOML, or the table or a key it needs is not what it must be.
 */
function readTable(cwd: string, ref: string, rel: string, table: string[], keys: string[], allowed: (key: string, v: string) => boolean = () => true): Record<string, string> | null {
  const where = `${ref}:${rel}`;
  const text = git(cwd, ["show", where]);
  if (text === null) return null;
  const refuse = (why: string) => new StartFactsError(`${where}: ${why}: fix it on ${ref.replace(/^origin\//, "")} before shipping from here`);
  let at: unknown;
  try {
    at = Bun.TOML.parse(text);
  } catch (err) {
    throw refuse(`invalid TOML (${err instanceof Error ? err.message : String(err)})`);
  }
  for (const part of table) {
    if (!isTable(at)) throw refuse(`[${table.join(".")}] must be a table`);
    at = (at as Record<string, unknown>)[part];
    if (at === undefined) return {};
  }
  if (!isTable(at)) throw refuse(`[${table.join(".")}] must be a table`);
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = at[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || !allowed(k, v)) throw refuse(`[${table.join(".")}] ${k} = ${JSON.stringify(v)} is not one this cast can ship by`);
    out[k] = v;
  }
  return out;
}

/**
 * The facts a checkout gives a run whose start routes on them, read from its default branch. One it cannot read (no
 * origin, no default branch) is a pull request repository. A direct one also carries the check and ship commands its
 * default branch's line profile names (`land_check`, `land_ship`), which the run uses in place of the working tree's.
 * Only `[ship] mode` and `[line.commands]` are read; a StartFactsError says one of those cannot be.
 */
export function startFacts(cwd: string): Record<string, string> {
  const ref = defaultRef(cwd);
  if (!ref) return { ship_mode: "pr" };
  const declared = readTable(cwd, ref, ".codecast/workspace.toml", ["ship"], ["mode"], (_k, v) => v === "pr" || v === "direct")?.mode;
  const workflows = git(cwd, ["ls-tree", "--name-only", `${ref}:.github/workflows`]) ?? "";
  const mode = shipModeOf(declared, workflows.split("\n").some((f) => /\.ya?ml$/.test(f.trim())));
  if (mode === "pr") return { ship_mode: "pr" };
  const commands = readTable(cwd, ref, ".codecast/line.toml", ["line", "commands"], ["check", "ship"]) ?? {};
  return { ship_mode: "direct", land_check: commands.check?.trim() ?? "", land_ship: commands.ship?.trim() ?? "" };
}

/**
 * The facts a run of this graph starts with: none unless its start routes on one, so a flow that never asks how the
 * repository lands never reads the files that say so (and a key it cannot read there stops only the flows that do).
 */
export function factsFor(graph: WorkflowGraph, cwd: string): Record<string, string> {
  // A graph already decided (cast workflow run pushed the cut) keeps its start edge's condition, so it reads them too.
  const start = startOf(graph);
  return start && graph.edges.some((e) => e.from === start.id && e.condition && readsOnlyFacts(e.condition)) ? startFacts(cwd) : {};
}

/** The facts for a view that draws a flow (the picker, `cast flow ls`): one the files cannot say decides nothing. */
export function safeStartFacts(cwd: string): Record<string, string> {
  try {
    return startFacts(cwd);
  } catch (err) {
    if (err instanceof StartFactsError) return {};
    throw err;
  }
}

/**
 * A direct run checks and lands with its default branch's own commands, never ones the change wrote: a change that
 * set `ship = "git push ..."` would land itself unreviewed. Applied wherever the runner reads the line profile.
 */
export function pinDirectCommands(context: Record<string, string>): void {
  if (context["ship_mode"] !== "direct") return;
  context["line.commands.check"] = context["land_check"] ?? "";
  context["line.commands.ship"] = context["land_ship"] ?? "";
}

/** Whether a condition reads only start facts, each compared with = or != to one of its own values. */
function readsOnlyFacts(condition: string): boolean {
  const walk = (n: any): boolean => {
    if (n.kind === "or" || n.kind === "and") return walk(n.left) && walk(n.right);
    if (n.kind === "not") return walk(n.inner);
    if (n.kind !== "cmp" || (n.op !== "=" && n.op !== "!=") || n.left.quoted) return false;
    return START_FACTS[n.left.text]?.includes(n.right.text) ?? false;
  };
  try {
    return walk(parseCondition(condition));
  } catch {
    return false;
  }
}

/** The start edge a run takes, as the runner picks it (resolveNextNode): the first condition that holds, else an edge with none. */
function taken(edges: WorkflowEdge[], context: Record<string, string>): WorkflowEdge | undefined {
  const sorted = [...edges].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  return sorted.find((e) => e.condition && evalCondition(e.condition, context)) ?? sorted.find((e) => !e.condition);
}

const startOf = (graph: WorkflowGraph) => [...graph.nodes.values()].find((n) => n.type === "start");

/** What a start edge leads to, the start included. */
function reach(graph: WorkflowGraph, edges: WorkflowEdge[], from: string): Set<string> {
  const kept = new Set([from]);
  for (let frontier = [from]; frontier.length; ) {
    frontier = edges.filter((e) => frontier.includes(e.from) && !kept.has(e.to)).map((e) => e.to);
    frontier.forEach((id) => kept.add(id));
  }
  return kept;
}

/** The graph with its start sent one way only: that edge, and what it reaches. */
function cutTo(graph: WorkflowGraph, startId: string, edge: WorkflowEdge): WorkflowGraph {
  const edges = graph.edges.filter((e) => e.from !== startId || e === edge);
  const kept = reach(graph, edges, startId);
  return { ...graph, nodes: new Map([...graph.nodes].filter(([id]) => kept.has(id))), edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)) };
}

/** A start that routes only on start facts: its edges, and the one a run with no facts takes. */
function decidable(graph: WorkflowGraph): { start: string; out: WorkflowEdge[]; plain: WorkflowEdge | undefined } | null {
  const start = startOf(graph);
  const out = start ? graph.edges.filter((e) => e.from === start.id) : [];
  if (out.length < 2 || !out.every((e) => !e.condition || readsOnlyFacts(e.condition))) return null;
  return { start: start!.id, out, plain: taken(out, {}) };
}

/**
 * The graph a run in this checkout carries: when the facts send the start another way than a run without them goes,
 * only that way and what it reaches; otherwise the graph as it is, so a flow these facts leave alone stays the
 * library's own (its hash, its card).
 */
export function decideStart(graph: WorkflowGraph, facts: Record<string, string>): WorkflowGraph {
  const d = decidable(graph);
  const edge = d ? taken(d.out, facts) : undefined;
  return d && edge && edge !== d.plain ? cutTo(graph, d.start, edge) : graph;
}

/**
 * A resumed run keeps the start it took, read from where it stands: the one start edge that reaches that station.
 * The checkout's facts now are never read again, so a pull request run parked at a wait resumes on the graph it ran.
 */
export function keepStart(graph: WorkflowGraph, at: string | null | undefined): WorkflowGraph {
  const d = decidable(graph);
  if (!d || !at) return graph;
  const ways = d.out.filter((e) => reach(graph, graph.edges.filter((x) => x.from !== d.start || x === e), d.start).has(at));
  return ways.length === 1 && ways[0] !== d.plain ? cutTo(graph, d.start, ways[0]) : graph;
}

const topOf = (id: string) => id.split("__")[0];

/**
 * The graph a run carries, or why it cannot start. On a resume it keeps the start the run took (keepStart). Otherwise
 * the facts decide it, and a flow that extends a library flow may not lose a station of its own that way: a station
 * a variant hung on the path the facts leave (`cast flow edit change add lint --after pr`) would never run, so the
 * run refuses and names it.
 */
export function runGraph(graph: WorkflowGraph, facts: Record<string, string>, opts: { resumeAt?: string | null } = {}): WorkflowGraph {
  if ("resumeAt" in opts) return keepStart(graph, opts.resumeAt);
  const decided = decideStart(graph, facts);
  if (decided === graph) return graph;
  const src = Object.prototype.hasOwnProperty.call(BUILTIN_WORKFLOW_TEMPLATES, graph.name) ? BUILTIN_WORKFLOW_TEMPLATES[graph.name] : null;
  const own = src ? new Set([...parseWorkflowSource(src).nodes.keys()].map(topOf)) : null;
  const lost = own ? [...new Set([...graph.nodes.keys()].filter((id) => !decided.nodes.has(id)).map(topOf))].filter((id) => !own.has(id)) : [];
  if (lost.length) {
    const names = lost.map((id) => `${graph.nodes.get(id)?.label ?? id} (${id})`).join(", ");
    throw new StartFactsError(`This repository ships straight to its default branch, so its ${graph.name} flow takes the path with no pull request, and ${names} ${lost.length === 1 ? "hangs" : "hang"} only on the pull request path, where ${lost.length === 1 ? "it" : "they"} would never run. Place ${lost.length === 1 ? "it" : "them"} on the direct path too, after its Check or Review (cast flow edit ${graph.name} add <station> --after direct_review), or take ${lost.length === 1 ? "it" : "them"} out.`);
  }
  return decided;
}

/**
 * The stations only one start edge reaches, for each start edge with a label (the change flow's "straight to main"):
 * a flow whose start routes on facts holds two paths, and a list of its stations names each apart.
 */
export function startPaths(graph: WorkflowGraph): Array<{ label: string; ids: Set<string> }> {
  const start = startOf(graph);
  const out = start ? graph.edges.filter((e) => e.from === start.id) : [];
  if (out.length < 2) return [];
  const via = (e: WorkflowEdge) => new Set([...reach(graph, graph.edges.filter((x) => x.from !== start!.id || x === e), start!.id)].map(topOf));
  const reached = out.map(via);
  return out.flatMap((e, i) => (e.label ? [{ label: e.label, ids: new Set([...reached[i]].filter((id) => id !== start!.id && !reached.some((r, j) => j !== i && r.has(id)))) }] : []));
}

/** The reviewer of the path a graph runs: Review on the pull request path, else the direct path's. */
export function reviewNodeOf(graph: WorkflowGraph): string | undefined {
  return ["review", "direct_review"].find((id) => graph.nodes.has(id));
}
