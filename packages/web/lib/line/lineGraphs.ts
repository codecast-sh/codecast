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
import { REPO_LINE_SLUG } from "@codecast/shared/contracts/lineProfile";
import { choiceWords, phaseOfStation, stationWords, type LinePhaseKey } from "./runReport";
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

/** The family a run's graph belongs to: its workflow slug, else its name. */
export function graphKeyOf(run: Pick<GraphRun, "workflow_slug" | "workflow_name">): string {
  return (run.workflow_slug || run.workflow_name || CODECAST_LINE).trim().toLowerCase() || CODECAST_LINE;
}

/** Whether a graph key is codecast's line in one of its forms. */
export const isCodecastLine = (key: string) => key === CODECAST_LINE || key === REPO_LINE_SLUG || key.startsWith(`${CODECAST_LINE}-`);

/** A graph's name as a reader says it. */
export function graphTitle(key: string, name?: string | null): string {
  if (key === CODECAST_LINE) return "Codecast's line";
  if (key === REPO_LINE_SLUG) return "This repo's own line";
  if (key.startsWith(`${CODECAST_LINE}-`)) return "Codecast's line, customized";
  const raw = (name || key).replace(/[-_]+/g, " ").trim();
  return raw.replace(/\b\w/g, (c) => c.toUpperCase());
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
  const ranked = [...sources].sort((a, b) => b[1] - a[1]).map(([s]) => (s.toLowerCase() === "person" ? "people" : s));
  if (!ranked.length) return null;
  return ranked.length === 1 && ranked[0] === "people" ? "filed by people" : `found by ${namesList(ranked)}`;
}

/** The graph each cause's newest run ran, by task id. */
function newestGraphByTask(runs: ReadonlyArray<GraphRun>): Map<string, string> {
  const newest = new Map<string, GraphRun>();
  for (const r of runs) {
    if (!r.task_id) continue;
    const had = newest.get(r.task_id);
    if (!had || r.updated_at > had.updated_at) newest.set(r.task_id, r);
  }
  return new Map([...newest].map(([t, r]) => [t, graphKeyOf(r)]));
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
      work: held != null ? `${held} waiting${who ? `, ${who}` : ""}` : causes ? `${plural(causes, "cause")}${who ? `, ${who}` : ""}` : plural(rs.length, "run"),
      runs: rs.length,
      live: rs.filter((r) => r.status === "running" || r.status === "paused" || r.status === "pending").length,
      causes,
      waiting: held,
      lastAt: newest[0]?.updated_at ?? 0,
      runId: withRow?._id ?? null,
      workflowId: withRow?.workflow_id ?? null,
      nodeIds: (newest.find((r) => r.graph_nodes?.length)?.graph_nodes ?? []).map((n) => n.id),
    });
  }
  return out.sort((a, b) => b.runs - a.runs || b.lastAt - a.lastAt);
}

/** The graph to draw first: the one the URL names when the project runs it,
 *  else the busiest. With no runs at all, codecast's line. */
export function pickGraph(graphs: ReadonlyArray<ProjectGraph>, asked: string | null | undefined): string {
  if (asked && graphs.some((g) => g.key === asked)) return asked;
  return graphs[0]?.key ?? CODECAST_LINE;
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

/** A phase for a station codecast's line does not name, from its words, so a
 *  foreign graph's map still reads Understand, Prove, Build, Check, Decide, Ship. */
const PHASE_WORDS: Array<[RegExp, LinePhaseKey]> = [
  [/ship|merge|watch|rebase|land/, "ship"],
  [/card|decide|drop/, "decide"],
  [/verify|green|eval|review|check|test/, "check"],
  [/propos|approv|build|implement|fix/, "build"],
  [/prove|\bred\b|reproduc/, "prove"],
];
const PHASE_ORDER: LinePhaseKey[] = ["understand", "prove", "build", "check", "decide", "ship"];
export function guessPhase(id: string, label = "", foreign = false): LinePhaseKey {
  // On another graph a shared id may sit elsewhere (AgentWatch's dissolve is
  // its first look), so there the words decide and the path keeps them in order.
  const known = foreign ? null : phaseOfStation(id);
  if (known) return known;
  const words = `${id.replace(/_/g, " ")} ${label}`.toLowerCase();
  return PHASE_WORDS.find(([re]) => re.test(words))?.[1] ?? "understand";
}

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

export const WHO_WORDS: Record<StationWho, string> = { agent: "An agent", script: "A script", person: "You" };

/** Steps common to repo lines that codecast's own line does not have. */
const MORE_DOES: Record<string, string> = {
  shared: "Loads the answers people already gave on earlier problems, so no one is asked twice",
  bind: "Claims the problem, so no other run works on it at the same time",
  investigate: "Finds the real mechanism behind the problem",
  stamp: "Records the cause it found, unless another task already owns it",
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
  refine_rejected: "Records that the cause it named was wrong",
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

/** One plain sentence: what the station is for. */
export function stationPurpose(n: GraphNodeIn, edges: ReadonlyArray<GraphEdgeIn> = []): string {
  const who = stationWho(n);
  if (who === "person") {
    const options = gateOptions(n.id, edges);
    const said = n.id === CARD_GATE_NODE_ID
      ? "You read the finished change and its proof, then decide"
      : n.id === "plan_gate"
        ? "You read the plan before anything is built, then decide"
        : /propos/.test(`${n.id} ${n.label ?? ""}`.toLowerCase())
          ? "You read the proposed fix before anything is built, then decide"
          : "You answer here";
    const or = options.length > 1 ? `${options.slice(0, -1).join(", ")} or ${options[options.length - 1]}` : options[0];
    return options.length ? `${said}: ${or}.` : `${said}.`;
  }
  const known = stationWords(n.id) ?? MORE_DOES[n.id];
  if (known) return `${known}.`;
  if (who === "agent") {
    const first = firstSentence(n.prompt);
    if (first) return `${thirdPerson(first)}.`;
  }
  return who === "script" ? `A script runs the ${(n.label || n.id).toLowerCase()} step.` : `An agent does the ${(n.label || n.id).toLowerCase()} step.`;
}

/** The edges a walk from the start meets going back to a station still on its path. */
function backEdgeSet(edges: ReadonlyArray<GraphEdgeIn>): Set<string> {
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
    .replace(/\$run_id\b/g, "*(this run)*");
}

/** The answers a person gives at a gate, each with what it does ("[A] Approve :: Build it"). */
export function gateAnswers(id: string, edges: ReadonlyArray<GraphEdgeIn>): Array<{ answer: string; does: string | null }> {
  return edges.filter((e) => e.from === id && e.label).map((e) => {
    const [, does] = e.label!.split("::");
    return { answer: choiceWords(e.label!), does: does?.trim() || null };
  });
}
