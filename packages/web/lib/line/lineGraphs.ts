// The graphs a project's work actually runs (docs/architecture/line-map.md
// LX5). A project's causes need not all run one graph: Union's Agent Quality
// causes mostly run Union's own AgentWatch graph, the rest codecast's line.
// Every run records the graph it ran (its workflow row, workflow_name,
// graph_nodes), so the graphs are read off the runs, never assumed. Pure: no
// store, no React.
//
// Also here: what a station is for and who does it, in one plain sentence
// each, for any graph's stations, and the shape a graph that is not
// codecast's line takes on the map (its terminal steps folded into the map's
// ends, its stations given a phase).
import { CARD_GATE_NODE_ID, LINE_END_NODES } from "@codecast/shared/contracts/changeCard";
import { DEFAULT_LINE_SLUG } from "@codecast/shared/contracts/orgProposal";
import { isRepoLineSlug } from "@codecast/shared/contracts/lineProfile";
import { choiceWords, stationWords, type LinePhaseKey } from "./runReport";
import { PHASE_ORDER, guessPhase } from "@codecast/shared/contracts/linePhases";
import { knownName } from "./sourceNames";
export { fileStepLabel, stepLabel } from "./runReport";

// ── which graphs a project runs ──────────────────────────────────────────────

export type GraphRun = {
  _id: string;
  task_id?: string;
  status: string;
  workflow_id?: string;
  workflow_slug?: string;
  workflow_name?: string;
  graph_nodes?: Array<{ id: string; h: string }>;
  created_at: number;
  updated_at: number;
};

/** codecast's own line: the shipped graph, a project's customized copy of it, or a repo's copy. */
export const CODECAST_LINE = DEFAULT_LINE_SLUG;

/** The graph a run ran exactly: its workflow slug, else its name. One process can have several of these (a trial, a second round). */
export function graphVersionOf(run: Pick<GraphRun, "workflow_slug" | "workflow_name">): string {
  return (run.workflow_slug || run.workflow_name || CODECAST_LINE).trim().toLowerCase() || CODECAST_LINE;
}

/** Words that name a copy of a graph (a trial, a round, a version), not a different route through it. */
const VERSION_WORD = /^(trial|r\d+|v\d+|round\d*|copy|test)$/;

/**
 * The process a graph version belongs to: one key per process, whatever copy
 * or trial ran. Codecast's line in any form (a project's customized copy, a
 * repo's) is codecast's line; a known product's graph with only version words
 * after its name ("agentwatch-trial-r2") is that product's process, and one
 * naming another route ("agentwatch_trial_judge") is that route's own process
 * ("agentwatch-judge"), drawn with its own steps.
 */
export function processKeyOf(version: string): string {
  const v = version.trim().toLowerCase() || CODECAST_LINE;
  if (isCodecastLine(v)) return CODECAST_LINE;
  const [first, ...rest] = v.split(/[-_\s]+/);
  if (!rest.length || !knownName(first)) return v;
  const route = rest.filter((w) => !VERSION_WORD.test(w));
  return route.length ? [first, ...route].join("-") : first;
}

/** The process a run belongs to (processKeyOf its graph version): the key every picker, count and filter reads. */
export function graphKeyOf(run: Pick<GraphRun, "workflow_slug" | "workflow_name">): string {
  return processKeyOf(graphVersionOf(run));
}

/** Whether a graph key is codecast's line in one of its forms. */
export const isCodecastLine = (key: string) => key === CODECAST_LINE || isRepoLineSlug(key) || key.startsWith(`${CODECAST_LINE}-`);

/** A graph's name as a reader says it. */
export function graphTitle(key: string, name?: string | null): string {
  if (key === CODECAST_LINE) return "Codecast's line";
  if (isRepoLineSlug(key)) return "This repo's own line";
  if (key.startsWith(`${CODECAST_LINE}-`)) return "Codecast's line, customized";
  // A process is named for itself, never for the version its newest run happened to run.
  const version = name?.trim().toLowerCase().replace(/\s+/g, "-");
  const raw = (version && version !== key && processKeyOf(version) === key ? key : name || key).replace(/[-_]+/g, " ").trim();
  const known = knownName(raw);
  if (known) return known;
  // A route of a known product's graph ("agentwatch judge") keeps the product's spelling and names what it works on.
  const [first, ...rest] = raw.split(/\s+/);
  const base = knownName(first);
  if (base && rest.length) return `${base} ${routeWords(rest.join(" "))}`;
  return raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A route's own words, plural: what its runs fix ("judge" reads "judges"). */
const routeWords = (route: string) => { const w = route.toLowerCase().trim(); return /s$/.test(w) ? w : `${w}s`; };

/** What each known product's process fixes, in a few words. */
const FIXES: Record<string, string> = { agentwatch: "Union's agents" };

/**
 * A process as the picker names it (line-workspace.md LW1): a short title, what it fixes in a few words, and the
 * process it is tooling for, if any. A route of a product's graph ("agentwatch-judge") is our own tooling for the
 * product's process (it fixes AgentWatch's judges), so it folds under that process rather than standing beside it.
 */
export function processName(key: string, name?: string | null): { title: string; fixes: string | null; parent: string | null } {
  if (isCodecastLine(key)) return { title: graphTitle(key, name), fixes: "codecast", parent: null };
  const [first, ...rest] = key.split("-");
  const base = knownName(first);
  if (base && rest.length) {
    const route = routeWords(rest.join(" "));
    return { title: route.charAt(0).toUpperCase() + route.slice(1), fixes: `${base}'s ${route}`, parent: first };
  }
  return { title: graphTitle(key, name), fixes: FIXES[key] ?? null, parent: null };
}

/** The processes in the order a picker lists them, which never moves with a filter: codecast's line first, then by name. */
export function graphPickOrder<G extends { key: string; title: string }>(graphs: ReadonlyArray<G>): G[] {
  return [...graphs].sort((a, b) => Number(isCodecastLine(b.key)) - Number(isCodecastLine(a.key)) || a.title.localeCompare(b.title));
}

/**
 * A graph's name where a person picks between a project's graphs: by place
 * and job, since every graph a project runs fixes problems and what tells them
 * apart is where the graph lives (learning-loop.md LL1, LL6). Codecast's own
 * line is "Fixes here"; a graph the product publishes is "Fixes in <product>".
 * Finding problems is the Find band's, so no tab claims it.
 */
export function graphPlaceTitle(key: string, product?: string | null): string {
  if (isCodecastLine(key)) return key.startsWith(`${CODECAST_LINE}-`) ? "Fixes here, customized" : "Fixes here";
  return `Fixes in ${product?.trim() || graphTitle(key)}`;
}

export type ProjectGraph = {
  key: string;
  title: string;
  /** The work that goes through it, in words: "21 causes, found by agentwatch". */
  work: string;
  runs: number;
  live: number;
  /** Distinct causes its runs worked on. */
  causes: number;
  /** Waiting causes whose newest run ran this graph, when the caller names the waiting set: each waiting cause counts on one graph only, so the graphs and the never-run rest sum to the queue. */
  waiting: number | null;
  lastAt: number;
  /** The newest run that names its workflow row: the graph is read through it. */
  runId: string | null;
  workflowId: string | null;
  /** The newest run's recorded station ids, for a graph whose row cannot be read. */
  nodeIds: string[];
  /** The graph versions this process ran (graphVersionOf), the newest first, with their runs: the newest is the one drawn. */
  versions: Array<{ key: string; runs: number }>;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "agentwatch", "agentwatch and union.eval", "agentwatch, union.eval and 2 more". */
export function namesList(names: string[], shown = 2): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const head = names.slice(0, shown);
  const rest = names.length - shown;
  return rest === 1 ? `${head.join(", ")} and ${names[shown]}` : `${head.join(", ")} and ${rest} more`;
}

/** Who found the problems a graph worked on, in words: the sources that filed
 *  their signals, the busiest first. A person filing reads as "people". */
export function foundBy(sources: Map<string, number>): string | null {
  const ranked = [...sources].sort((a, b) => b[1] - a[1]).map(([s]) => (s.toLowerCase() === "person" ? "people" : knownName(s) ?? s));
  if (!ranked.length) return null;
  return ranked.length === 1 && ranked[0] === "people" ? "filed by people" : `found by ${namesList(ranked)}`;
}

/** Each problem's newest run, by task id: the one ordering (created_at) every "newest run" reads. */
export function newestRunByTask<R extends { task_id?: string | null; created_at: number }>(runs: ReadonlyArray<R>): Map<string, R> {
  const newest = new Map<string, R>();
  for (const r of runs) {
    if (!r.task_id) continue;
    const had = newest.get(r.task_id);
    if (!had || r.created_at > had.created_at) newest.set(r.task_id, r);
  }
  return newest;
}

/** The graph each cause's newest run ran, by task id. */
export function newestGraphByTask(runs: ReadonlyArray<Pick<GraphRun, "task_id" | "workflow_slug" | "workflow_name" | "created_at">>): Map<string, string> {
  return new Map([...newestRunByTask(runs)].map(([t, r]) => [t, graphKeyOf(r)]));
}

/**
 * Which process each problem belongs to, the one rule every count reads: the
 * graph its newest run ran; a problem no run has taken yet, the graph its
 * project's runs mostly ran; with no project or no runs there, the first
 * process in the picker's order; with no runs at all, codecast's line.
 * So every problem sits under exactly one process, and per-process counts sum
 * to the whole.
 */
export function processIndex(runs: ReadonlyArray<Pick<GraphRun, "task_id" | "workflow_slug" | "workflow_name" | "created_at">>, projectOfTask: (taskId: string) => string | null | undefined) {
  const ofTask = newestGraphByTask(runs);
  const tally = new Map<string, Map<string, number>>();
  const overall = new Map<string, number>();
  for (const r of runs) {
    overall.set(graphKeyOf(r), (overall.get(graphKeyOf(r)) ?? 0) + 1);
    const p = r.task_id ? projectOfTask(r.task_id) : null;
    if (!p) continue;
    const m = tally.get(p) ?? new Map<string, number>();
    m.set(graphKeyOf(r), (m.get(graphKeyOf(r)) ?? 0) + 1);
    tally.set(p, m);
  }
  const busiest = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const ofProject = new Map([...tally].map(([p, m]) => [p, busiest(m)!]));
  // No project and no run: the first process in the picker's fixed order, never the busiest, so a problem does not
  // change process (and every count with it) as runs load.
  const fallback = graphPickOrder([...overall.keys()].map((key) => ({ key, title: graphTitle(key) })))[0]?.key ?? CODECAST_LINE;
  const project = (id: string | null | undefined) => (id ? ofProject.get(id) : undefined) ?? fallback;
  return {
    project,
    task: (taskId: string | null | undefined, projectId?: string | null) => (taskId ? ofTask.get(taskId) : undefined) ?? project(projectId ?? (taskId ? projectOfTask(taskId) : null)),
  };
}

/** The graphs a project's runs went through, the busiest first. `signals`
 *  names who found each problem, so a graph reads by the work it carries.
 *  `waiting` (the queue's task ids) makes each graph read by the waiting
 *  causes it holds, in the unit the queue's headline counts. */
export function projectGraphs(
  runs: ReadonlyArray<GraphRun>,
  signals: ReadonlyArray<{ task_id: string; source: string }> = [],
  names: ReadonlyMap<string, string> = new Map(),
  waiting?: ReadonlySet<string>,
): ProjectGraph[] {
  const graphOfTask = waiting ? newestGraphByTask(runs) : null;
  const byTask = new Map<string, Map<string, number>>();
  for (const s of signals) {
    const m = byTask.get(s.task_id) ?? new Map<string, number>();
    m.set(s.source, (m.get(s.source) ?? 0) + 1);
    byTask.set(s.task_id, m);
  }
  const groups = new Map<string, GraphRun[]>();
  for (const r of runs) groups.set(graphKeyOf(r), [...(groups.get(graphKeyOf(r)) ?? []), r]);
  const out: ProjectGraph[] = [];
  for (const [key, rs] of groups) {
    const newest = [...rs].sort((a, b) => b.updated_at - a.updated_at);
    const withRow = newest.find((r) => r.workflow_id);
    const tasks = new Set(rs.map((r) => r.task_id).filter((t): t is string => !!t));
    const sources = new Map<string, number>();
    for (const t of tasks) for (const [s, n] of byTask.get(t) ?? []) sources.set(s, (sources.get(s) ?? 0) + n);
    const who = foundBy(sources);
    const causes = tasks.size;
    const held = waiting && graphOfTask ? [...waiting].filter((t) => graphOfTask.get(t) === key).length : null;
    out.push({
      key,
      title: graphTitle(key, names.get(key) ?? newest[0]?.workflow_name),
      work: held != null ? `${held} waiting${who ? `, ${who}` : ""}` : causes ? `${plural(causes, "problem")}${who ? `, ${who}` : ""}` : plural(rs.length, "run"),
      runs: rs.length,
      live: rs.filter((r) => r.status === "running" || r.status === "paused" || r.status === "pending").length,
      causes,
      waiting: held,
      lastAt: newest[0]?.updated_at ?? 0,
      runId: withRow?._id ?? null,
      workflowId: withRow?.workflow_id ?? null,
      nodeIds: (newest.find((r) => r.graph_nodes?.length)?.graph_nodes ?? []).map((n) => n.id),
      versions: [...newest.reduce((m, r) => m.set(graphVersionOf(r), (m.get(graphVersionOf(r)) ?? 0) + 1), new Map<string, number>())].map(([k, n]) => ({ key: k, runs: n })),
    });
  }
  return out.sort((a, b) => b.runs - a.runs || b.lastAt - a.lastAt);
}

/** The graph to draw first: the one the URL names when the project runs it, else the one the person last picked
 *  (`last`), else the first in the picker's fixed order (graphPickOrder). Never the busiest: run counts move as
 *  runs load, and a default that follows them flips the process under the reader. With no runs at all, codecast's line. */
export function pickGraph(graphs: ReadonlyArray<ProjectGraph>, asked: string | null | undefined, last?: string | null): string {
  // An old link may name a version ("agentwatch-trial"): it opens on that version's process.
  for (const want of [asked, last]) {
    const key = want ? processKeyOf(want) : null;
    if (key && graphs.some((g) => g.key === key)) return key;
  }
  return graphPickOrder(graphs)[0]?.key ?? CODECAST_LINE;
}

const LAST_PROCESS_KEY = "line.lastProcess";
/** The process the person last picked on this device; null when none, or storage is closed. */
export function readLastProcess(): string | null {
  try { return localStorage.getItem(LAST_PROCESS_KEY); } catch { return null; }
}
export function rememberProcess(key: string) {
  try { localStorage.setItem(LAST_PROCESS_KEY, key); } catch { /* private mode */ }
}

// ── a graph that is not codecast's line, ready for the map ───────────────────

export type GraphNodeIn = { id: string; label?: string; type?: string; shape?: string; prompt?: string; script?: string; [attr: string]: unknown };
export type GraphEdgeIn = { from: string; to: string; label?: string; condition?: string };
export type GraphEnd = "dissolved" | "dropped" | "parked" | "stopped" | "shipped";

const isStartOrExit = (n: Pick<GraphNodeIn, "id" | "type">) => n.type === "start" || n.type === "exit" || n.id === "start" || n.id === "exit";

/** What a terminal step means, from its id and label: a step whose only way
 *  on is the graph's exit records how the run ended. */
function endOfStep(n: GraphNodeIn): GraphEnd {
  const known = LINE_END_NODES[n.id];
  if (known) return known;
  const words = `${n.id} ${n.label ?? ""}`.toLowerCase();
  if (/dissolv|owned elsewhere/.test(words)) return "dissolved";
  if (/\bdrop/.test(words)) return "dropped";
  if (/\bpark/.test(words)) return "parked";
  if (/\bwatch/.test(words)) return "shipped";
  return "stopped";
}

/** The steps whose every way on is the exit, with the end each records. */
export function terminalSteps(nodes: ReadonlyArray<GraphNodeIn>, edges: ReadonlyArray<GraphEdgeIn>): Map<string, GraphEnd> {
  const outs = new Map<string, string[]>();
  for (const e of edges) outs.set(e.from, [...(outs.get(e.from) ?? []), e.to]);
  const out = new Map<string, GraphEnd>();
  for (const n of nodes) {
    if (isStartOrExit(n)) continue;
    const to = outs.get(n.id) ?? [];
    if (to.length > 0 && to.every((t) => t === "exit")) out.set(n.id, endOfStep(n));
  }
  return out;
}

export { guessPhase };

/** A foreign graph as the map draws it: its terminal steps leave the station
 *  list and become the map's ends (`ends`, read by buildLineMap), and every
 *  station carries a phase. Watch and drop keep their stations, as on
 *  codecast's line. */
export function graphForMap<N extends GraphNodeIn, E extends GraphEdgeIn>(nodes: ReadonlyArray<N>, edges: ReadonlyArray<E>): {
  nodes: Array<N & { phase: LinePhaseKey }>;
  edges: E[];
  ends: Record<string, GraphEnd>;
} {
  const terminal = terminalSteps(nodes, edges);
  const ends: Record<string, GraphEnd> = {};
  for (const [id, end] of terminal) if (id !== "watch" && id !== "drop") ends[id] = end;
  // Phases read left to right: a station never sits in an earlier phase than
  // the stations that lead to it, loops aside.
  const phase = new Map(nodes.map((n) => [n.id, PHASE_ORDER.indexOf(guessPhase(n.id, n.label, true))]));
  const back = backEdgeSet(edges);
  const fwd = edges.filter((e) => !back.has(`${e.from}->${e.to}`) && phase.has(e.from) && phase.has(e.to));
  for (let pass = 0; pass <= fwd.length; pass++) {
    let moved = false;
    for (const e of fwd) if (phase.get(e.to)! < phase.get(e.from)!) { phase.set(e.to, phase.get(e.from)!); moved = true; }
    if (!moved) break;
  }
  return {
    nodes: nodes.map((n) => ({ ...n, phase: PHASE_ORDER[Math.max(0, phase.get(n.id) ?? 0)] })),
    edges: [...edges],
    ends,
  };
}

/** A graph known only from what its runs recorded (graph_nodes ids): the
 *  stations in the order the runs met them, one after another. */
export function graphFromIds(ids: ReadonlyArray<string>): { nodes: GraphNodeIn[]; edges: GraphEdgeIn[] } {
  const stations = ids.filter((id) => id !== "start" && id !== "exit");
  const label = (id: string) => id.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const nodes: GraphNodeIn[] = [{ id: "start", type: "start" }, ...stations.map((id) => ({ id, label: label(id), type: "" })), { id: "exit", type: "exit" }];
  const chain = ["start", ...stations, "exit"];
  return { nodes, edges: chain.slice(1).map((to, i) => ({ from: chain[i], to })) };
}

// ── what a station is for, and who does it ───────────────────────────────────

export type StationWho = "agent" | "script" | "person";

/** Who does the work at a station: a person answering (a gate), an agent
 *  following written instructions, or a script. */
export function stationWho(n: Pick<GraphNodeIn, "id" | "type" | "shape">): StationWho {
  if (n.type === "human" || n.shape === "hexagon" || n.id === CARD_GATE_NODE_ID || n.id === "plan_gate" || n.id === "ask") return "person";
  if (n.type === "command" || n.shape === "parallelogram" || n.type === "tool") return "script";
  return "agent";
}

/** Steps common to repo lines that codecast's own line does not have. */
const MORE_DOES: Record<string, string> = {
  shared: "Loads the answers people already gave on earlier problems, so no one is asked twice",
  bind: "Claims the problem, so no other run works on it at the same time",
  investigate: "Finds the real mechanism behind the problem",
  stamp: "Records the problem it found, unless another task already owns it",
  refine: "Regroups the problem's reports around the one mechanism found",
  propose: "Writes the fix it proposes, for you to approve before anything is built",
  park_proposal: "Saves the proposal where you can read it",
  approve_carried: "Uses a go-ahead you already gave on this problem",
  approve: "Records your approval and starts the build",
  revise_proposal: "Sends your note back to the proposal",
  build: "Builds the fix you approved",
  eval_scope: "Picks which evals the change needs",
  park_built: "Saves the finished fix and its report for you",
  revise_build: "Sends your note back to the build",
  refine_rejected: "Records that its explanation was wrong",
};

/** "You find the mechanism ..." becomes "Finds the mechanism ...". */
function thirdPerson(sentence: string): string {
  const s = sentence.trim();
  const m = /^You (are|have|do|go|\w+)\b(.*)$/.exec(s);
  if (!m) return s;
  const [, verb, rest] = m;
  const said = verb === "are" ? "Acts as" : verb === "have" ? "Has" : verb === "do" ? "Does" : verb === "go" ? "Goes" : /(s|sh|ch|x|z)$/.test(verb) ? `${verb}es` : /[^aeiou]y$/.test(verb) ? `${verb.slice(0, -1)}ies` : `${verb}s`;
  return `${said[0].toUpperCase()}${said.slice(1)}${rest}`;
}

/** The first sentence of an agent's instructions, when they open by saying what it does. */
function firstSentence(text: string | undefined): string | null {
  const flat = (text ?? "").replace(/^#.*$/gm, "").replace(/\s*\n\s*/g, " ").trim();
  if (!flat || flat.startsWith("$")) return null;
  const end = flat.search(/[.!?](\s|$)/);
  const one = (end > 0 ? flat.slice(0, end) : flat).trim();
  if (one.length < 12) return null;
  return one.length > 180 ? `${one.slice(0, 177).replace(/\s+\S*$/, "")}...` : one;
}

/** The answers a person can give at a gate, from the graph's edges out of it. */
export function gateOptions(id: string, edges: ReadonlyArray<GraphEdgeIn>): string[] {
  return edges.filter((e) => e.from === id && e.label).map((e) => choiceWords(e.label!));
}

/** One plain sentence: what the station is for. On another graph (`foreign`)
 *  a step that shares an id with codecast's line may do something else
 *  (AgentWatch's dissolve is its first look), so its own instructions speak first. */
export function stationPurpose(n: GraphNodeIn, edges: ReadonlyArray<GraphEdgeIn> = [], foreign = false): string {
  const who = stationWho(n);
  if (who === "person") {
    const options = gateOptions(n.id, edges);
    const said = n.id === CARD_GATE_NODE_ID
      ? "Read the finished change and its proof, then decide"
      : n.id === "plan_gate"
        ? "Read the plan before anything is built, then decide"
        : /propos/.test(`${n.id} ${n.label ?? ""}`.toLowerCase())
          ? "Read the proposed fix before anything is built, then decide"
          : "Answer here";
    const or = options.length > 1 ? `${options.slice(0, -1).join(", ")} or ${options[options.length - 1]}` : options[0];
    return options.length ? `${said}: ${or}.` : `${said}.`;
  }
  const own = who === "agent" ? firstSentence(n.prompt) : null;
  if (foreign && own) return `${thirdPerson(own)}.`;
  const known = stationWords(n.id) ?? MORE_DOES[n.id];
  if (known) return `${known}.`;
  if (own) return `${thirdPerson(own)}.`;
  return who === "script" ? `A script runs the ${(n.label || n.id).toLowerCase()} step.` : `An agent does the ${(n.label || n.id).toLowerCase()} step.`;
}

/** The edges a walk from the start meets going back to a station still on its path, as "from->to". */
export function backEdgeSet(edges: ReadonlyArray<GraphEdgeIn>): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  const state = new Map<string, 1 | 2>();
  const out = new Set<string>();
  const walk = (n: string) => {
    state.set(n, 1);
    for (const m of adj.get(n) ?? []) {
      if (state.get(m) === 1) out.add(`${n}->${m}`);
      else if (!state.has(m)) walk(m);
    }
    state.set(n, 2);
  };
  walk("start");
  for (const e of edges) if (!state.has(e.from)) walk(e.from);
  return out;
}

/** A station's text with the runner's template references said in words:
 *  "$propose.json.question" reads "(the question the Propose step wrote)". */
/** The href a template's step reference carries: the instructions panel
 *  opens that step's panel when one is clicked (stationRefOf reads it back). */
export const stationRefHref = (id: string) => `#station-${id}`;
export const stationRefOf = (href: string | null | undefined): string | null => href?.match(/^#station-([\w-]+)$/)?.[1] ?? null;

/**
 * A station's instructions as a reader reads them: each place where a run
 * inserts another step's output reads as what goes there and which step it
 * comes from, linked to that step. One alone on its line is a whole block
 * the run inserts, so it reads as a labelled block; one inside a sentence
 * reads as a short linked phrase.
 */
export function readableTemplate(text: string, nodes: ReadonlyArray<Pick<GraphNodeIn, "id" | "label">> = []): string {
  const label = (id: string) => nodes.find((n) => n.id === id)?.label || id.replace(/_/g, " ");
  const step = (id: string) => `[${label(id)}](${stationRefHref(id)})`;
  const what = (field: string) => field.replace(/_/g, " ");
  return text
    // A whole line that is one inserted value: a labelled block.
    .replace(/^[ \t]*\$([a-z_]+)\.json\.([a-z_]+)[ \t]*$/gim, (_, id: string, field: string) => `> **Inserted when it runs:** the ${what(field)} text from the ${step(id)} step.`)
    .replace(/^[ \t]*\$([a-z_]+)\.output[ \t]*$/gim, (_, id: string) => `> **Inserted when it runs:** what the ${step(id)} step printed.`)
    .replace(/\$([a-z_]+)\.json\.([a-z_]+)/gi, (_, id: string, field: string) => `*(the ${what(field)} from ${step(id)})*`)
    .replace(/\$([a-z_]+)\.output\b/gi, (_, id: string) => `*(what ${step(id)} printed)*`)
    .replace(/\$task_title\b/g, "*(the problem's title)*")
    .replace(/\$task_id\b/g, "*(the problem)*")
    .replace(/\$human_message\b/g, "*(your note)*")
    .replace(/\$run_id\b/g, "*(this run)*")
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    // Every other value the runner inserts, said as what it is: in prose a labelled placeholder, in code a marked one.
    .map((part, i) => part.replace(TEMPLATE_VAR, (_, name: string) => (i % 2 ? `‹${varWords(name)}›` : `*(${varWords(name)})*`)))
    .join("");
}

/** A runner variable the text above has not named: `$branch`, `$line.commands.prove`. Lowercase only, so a shell's `$HOME` stays. */
const TEMPLATE_VAR = /\$(?!\{)([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)\b/g;

const VAR_WORDS: Record<string, string> = {
  branch: "the fix's branch", default_branch: "the main branch", worktree: "the run's worktree", run_dir: "the run's files folder",
  project_path: "the project's folder", category: "the problem's category", task_short_id: "the problem's ref",
};

/** A runner variable in words: "$line.commands.prove" is "the project's prove command", "$category" "the problem's category". */
export function varWords(name: string): string {
  if (VAR_WORDS[name]) return VAR_WORDS[name];
  const parts = name.split(".");
  const words = (x: string) => x.replace(/_/g, " ");
  if (parts[0] === "line" && parts[1] === "commands" && parts[2]) return `the project's ${words(parts[2])} command`;
  if (parts[0] === "line" && parts[1]) return `the project's ${words(parts.slice(1).join(" "))}`;
  return `the ${words(parts.join(" "))}`;
}

/** The answers a person gives at a gate, each with what it does ("[A] Approve :: Build it"). */
export function gateAnswers(id: string, edges: ReadonlyArray<GraphEdgeIn>): Array<{ answer: string; does: string | null }> {
  return edges.filter((e) => e.from === id && e.label).map((e) => {
    const [, does] = e.label!.split("::");
    return { answer: choiceWords(e.label!), does: does?.trim() || null };
  });
}
