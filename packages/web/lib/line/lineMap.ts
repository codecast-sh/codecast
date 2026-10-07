// The line map (docs/architecture/line-map.md LX2): a project's line drawn
// left to right as the path work takes, from the world to a held fix, with the
// data of a window laid over it. Pure: no store, no React. The map's page feeds
// it the rows the store already holds and paints the answer; a test feeds
// fixture rows and reads nodes and edges.
//
//   Expectations ─> Sources ─> Signals ─> Causes ─> each station of the
//   project's graph, in order, with its branches (dissolve, the revise loop
//   back to implement, drop) ─> Decide ─> Ship ─> Watch ─> Held | Reopened
//                                    Dissolved | Dropped | Stopped
//
// Every count reads one home (the-line-model.md LM2): signals for intake, a
// run's node statuses for the stations, the card decisions for the gates, the
// cause task's watch fields for what happened after ship. The queue, the watch
// and a finder's silence come from buildLineFlow, so the map and the /line
// columns can never disagree.
import { CARD_GATE_NODE_ID, LINE_END_NODES, isLineRun, lineRunOutcome, verdictOfOption, type LineRunEnd } from "@codecast/shared/contracts/changeCard";
import { isExpectationId } from "@codecast/shared/contracts/expectations";
import type { LineFinderDecl } from "@codecast/shared/contracts/lineProfile";
import { DAY, WEEK, ageShort, buildLineFlow, isUndeclaredSource, quietWatchEnd, silentText, type LineCauseTask, type LineDecision, type LineFlowRun, type LineSignal } from "../lineFlow";
import type { LineEdge, LineNode } from "./lineStations";
import { choiceWords, isMainStation, phaseOfStation, runPath, type LinePhaseKey, type ReportRun, type StepState } from "./runReport";
import { SHIPPED_LINE } from "./shippedLine.generated";

// ── the rows the map reads ───────────────────────────────────────────────────

/** A signal as the store holds it, with the fields a trace also reads. */
export type MapSignal = LineSignal & { fingerprint?: string; detail_md?: string };

export type MapRunNode = {
  node_id: string;
  status: string;
  outcome?: string;
  session_id?: string;
  session?: { _id: string; title?: string } | null;
  started_at?: number;
  completed_at?: number;
  label?: string;
  result_preview?: string;
  activity?: string;
};

/** A run row (workflow_runs.enrichRun), the fields the map and trace read. */
export type MapRun = Omit<LineFlowRun, "node_statuses"> & Omit<ReportRun, "node_statuses" | "status" | "created_at" | "updated_at"> & {
  node_statuses?: MapRunNode[];
};

/** A decision row (session_decisions): a line card or a plan gate. */
export type MapDecision = LineDecision & {
  short_id?: string;
  question?: string;
  options?: Array<{ label: string; description?: string }>;
  answer_index?: number;
  answer_text?: string;
  resolved_at?: number;
  answered_by?: { kind: string; id: string } | null;
  card?: { headline?: string | null; change?: string | null; recommend?: { verdict: string; why?: string } | null } | null;
};

/** The graph the project's line runs: the shipped line or its own copy. */
export type LineGraph = { nodes: Array<Pick<LineNode, "id" | "label" | "type">>; edges: LineEdge[] };

// ── what the map is ──────────────────────────────────────────────────────────

export const LINE_MAP_WINDOWS = { "24h": DAY, "7d": WEEK, "30d": 30 * DAY } as const;
export type LineMapWindow = keyof typeof LINE_MAP_WINDOWS;

export type MapNodeKind = "source" | "expectations" | "signals" | "causes" | "station" | "decide" | "ship" | "watch" | "end";
/** Where a node sits: before the line admits work, a phase of the run (runReport LINE_PHASES), or an end. */
export type MapPhase = "sense" | "admit" | LinePhaseKey | "end";
/** held: the watch ended quiet. reopened: a signal came back during it.
 *  stopped: a run ended without a change and without a close (a reject, a
 *  failed ship, an eval that could not score, a run that failed). */
export type MapEnd = "held" | "reopened" | "dissolved" | "dropped" | "stopped";

export type MapItemKind = "signal" | "cause" | "run" | "decision";
/** One thing on the map. `ref` is what a trace takes (LX4): a short id when the row has one. */
export type MapItem = {
  kind: MapItemKind;
  id: string;
  ref: string;
  title: string;
  /** Since when it is here (now), or when it crossed (an edge). */
  at: number;
  taskId?: string;
  runId?: string;
  /** Past three times the node's usual time. */
  stuck?: boolean;
  /** A live run that has reported nothing for a day. */
  stalled?: boolean;
};

/** How an item left a node it passed through in the window. */
export type MapLeft = "moved" | "failed" | "live" | MapEnd | "parked";
export type MapPassed = { item: MapItem; at: number; durationMs: number | null; left: MapLeft; to: string | null };

/** `words` is the whole sentence (the panel's Health); `short` is what fits
 *  under the node, built from the same numbers so the two never disagree (LX3). */
export type MapMark = { level: "info" | "warn" | "fail"; words: string; short?: string };

/** A usual time in words: "under a minute", "40m", "2h". */
export const usualWords = (ms: number) => (ms < 60_000 ? "under a minute" : ageShort(ms));

export type MapNode = {
  id: string;
  kind: MapNodeKind;
  label: string;
  phase: MapPhase;
  /** Column, left to right: the longest path from the left edge, loops ignored. */
  col: number;
  /** On the path every cause takes; branches (park, dissolve, drop, a plan) are not. */
  main: boolean;
  /** Items here now, oldest first. */
  now: MapItem[];
  /** How many passed through in the window. */
  through: number;
  /** What passed, newest first: how each left and how long it stayed (stations). */
  passed: MapPassed[];
  marks: MapMark[];
  /** Median time a visit takes here, across every run the rows hold. */
  medianMs: number | null;
  /** Failed visits in the window. */
  failed: number;
  /** A source node's declaration, when the profile names it (LP3). */
  finder?: LineFinderDecl;
  /** A source filing while the profile declares finders but not it (lineFlow isUndeclaredSource). */
  undeclared?: boolean;
  /** A source node's name as signals carry it. */
  source?: string;
  end?: MapEnd;
};

export type MapEdgeKind = "flow" | "branch" | "loop";
export type MapEdge = {
  id: string;
  from: string;
  to: string;
  kind: MapEdgeKind;
  /** The graph's words for the edge ("checks failed", "Revise"), when it has some. */
  label?: string;
  /** Crossings in the window: a loop taken twice counts twice. */
  count: number;
  items: MapItem[];
};

export type LineMap = { nodes: MapNode[]; edges: MapEdge[]; window: { from: number; to: number; label: string } };

// ── node ids, shared with the trace ──────────────────────────────────────────

export const EXPECTATIONS_NODE = "expectations";
export const SIGNALS_NODE = "signals";
export const CAUSES_NODE = "causes";
export const sourceNodeId = (source: string) => `source:${source.toLowerCase()}`;
export const endNodeId = (end: MapEnd) => `end:${end}`;

export const END_LABEL: Record<MapEnd, string> = { held: "Held", reopened: "Reopened", dissolved: "Dissolved", dropped: "Dropped", stopped: "Stopped" };
/** Where a run that ended at an end station goes on the map. */
const END_OF_RUN: Record<LineRunEnd, string | null> = { dissolved: endNodeId("dissolved"), dropped: endNodeId("dropped"), parked: CAUSES_NODE, shipped: null };

const kindOf = (id: string): MapNodeKind => (id === CARD_GATE_NODE_ID ? "decide" : id === "ship" || id === "merge" ? "ship" : LINE_END_NODES[id] === "shipped" ? "watch" : "station");
const isGraphEnd = (n: Pick<LineNode, "id" | "type">) => n.type === "start" || n.type === "exit" || n.id === "start" || n.id === "exit";

// ── a run's visits, loops included ───────────────────────────────────────────

/** One visit of a run to a station. A run row keeps one status per station
 *  (the newest visit), so an earlier round of a loop is `inferred`: it has no
 *  time of its own, and `at` is the next timed visit's start. */
export type RunVisit = {
  node: string;
  at: number;
  startedAt: number | null;
  completedAt: number | null;
  state: StepState;
  inferred: boolean;
  outcome?: string;
};

type Adjacency = Map<string, string[]>;
const adjacency = (graph: LineGraph): Adjacency => {
  const adj: Adjacency = new Map();
  for (const e of graph.edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  return adj;
};

/** The cheapest way from `from` to `to` in the graph, through the stations
 *  the run is known to have reached where it can: the stations in between. */
function between(adj: Adjacency, from: string, to: string, reached: Set<string>): string[] | null {
  const cost = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const open = new Set([from]);
  while (open.size) {
    let cur = "";
    let best = Infinity;
    for (const n of open) if ((cost.get(n) ?? Infinity) < best) { best = cost.get(n)!; cur = n; }
    open.delete(cur);
    if (cur === to && cur !== from) break;
    for (const next of adj.get(cur) ?? []) {
      if (next === "exit") continue;
      const c = best + (reached.has(next) ? 1 : 4);
      if (c < (cost.get(next) ?? Infinity)) { cost.set(next, c); prev.set(next, cur); open.add(next); }
    }
  }
  if (!prev.has(to)) return null;
  const out: string[] = [];
  for (let n = prev.get(to)!; n !== from; n = prev.get(n)!) out.unshift(n);
  return out;
}

/**
 * The stations a run visited, in order, loops included. The timed visits are
 * the run's node statuses by start; a jump the graph has no edge for (red, then
 * reopen) is filled with the stations the run must have passed between them;
 * and a gate answered more often than the path shows (two cards on one run)
 * gets its earlier rounds back: each answer's branch, round to the gate again.
 */
export function runVisits(run: MapRun, graph: LineGraph = SHIPPED_LINE, decisions: ReadonlyArray<MapDecision> = []): RunVisit[] {
  const adj = adjacency(graph);
  const states = stepStates(run, graph);
  const statuses = (run.node_statuses ?? []).filter((n) => n.node_id !== "start" && n.node_id !== "exit" && (n.started_at != null || n.status !== "pending"));
  const timed = [...statuses].sort((a, b) => (a.started_at ?? Infinity) - (b.started_at ?? Infinity) || (a.completed_at ?? Infinity) - (b.completed_at ?? Infinity));
  const live = run.status === "running" || run.status === "paused" || run.status === "pending";
  if (live && run.current_node_id && run.current_node_id !== "start" && run.current_node_id !== "exit" && !timed.some((n) => n.node_id === run.current_node_id)) {
    timed.push({ node_id: run.current_node_id, status: "running", started_at: run.updated_at });
  }
  const reached = new Set(timed.map((n) => n.node_id));
  const visit = (n: MapRunNode): RunVisit => ({
    node: n.node_id,
    at: n.started_at ?? n.completed_at ?? run.updated_at,
    startedAt: n.started_at ?? null,
    completedAt: n.completed_at ?? null,
    state: states.get(n.node_id) ?? (n.status === "failed" ? "failed" : n.status === "running" ? "live" : "done"),
    inferred: false,
    ...(n.outcome ? { outcome: n.outcome } : {}),
  });
  const inferred = (node: string): RunVisit => ({ node, at: 0, startedAt: null, completedAt: null, state: "done", inferred: true });

  const path: RunVisit[] = [];
  let prev = "start";
  for (const n of timed) {
    const hop = (adj.get(prev) ?? []).includes(n.node_id) ? [] : between(adj, prev, n.node_id, reached) ?? [];
    path.push(...hop.map(inferred), visit(n));
    prev = n.node_id;
  }

  // Earlier rounds through a gate: one answered decision per visit.
  const gates = new Map<string, MapDecision[]>();
  for (const d of decisions) {
    if (d.workflow_run_id !== run._id || !d.gate_node_id || !rawAnswer(d)) continue;
    gates.set(d.gate_node_id, [...(gates.get(d.gate_node_id) ?? []), d]);
  }
  for (const [gate, asked] of gates) {
    const seen = path.filter((v) => v.node === gate).length;
    const missing = [...asked].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0)).slice(0, Math.max(0, asked.length - seen));
    for (const d of missing.reverse()) {
      const target = answerTarget(graph, gate, d);
      const first = path.findIndex((v) => v.node === gate);
      if (!target || first < 0) continue;
      const back = between(adj, target, gate, reached);
      if (!back) continue;
      path.splice(first, 0, ...[gate, target, ...back].map(inferred));
    }
  }

  // An inferred round happened before the next timed visit.
  let next = run.updated_at;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].inferred) path[i].at = next;
    else next = path[i].at;
  }
  return path;
}

/** The answer a decision was given, as its option reads; null while unanswered
 *  (pending, withdrawn, expired), which is no round through its gate. */
export function rawAnswer(d: MapDecision): string | null {
  return d.answer_text?.trim() || (d.answer_index != null ? d.options?.[d.answer_index]?.label : undefined) || null;
}

/** The station a gate's answer led to: the gate's edge whose option words match the answer. */
function answerTarget(graph: LineGraph, gate: string, d: MapDecision): string | null {
  const answer = rawAnswer(d);
  if (!answer) return null;
  const words = choiceWords(answer).toLowerCase();
  const verdict = verdictOfOption(answer);
  const edge = graph.edges.find((e) => e.from === gate && e.label && (choiceWords(e.label).toLowerCase() === words || (verdict && verdictOfOption(choiceWords(e.label)) === verdict)));
  return edge?.to ?? null;
}

/** Each station's state on its newest visit, as the run report reads it, so a
 *  gate answered with its key and a merge left to a person are no failures. */
function stepStates(run: MapRun, graph: LineGraph): Map<string, StepState> {
  const out = new Map<string, StepState>();
  for (const p of runPath(run as ReportRun, graph)) for (const s of [...p.steps, ...p.routine]) out.set(s.id, s.state);
  return out;
}

// ── the map ──────────────────────────────────────────────────────────────────

export type LineMapInput = {
  /** The project's line: its customized workflow, else the shipped line. */
  graph?: LineGraph | null;
  /** The project's declared finders (projects.line_profile.finders). */
  finders?: LineFinderDecl[];
  /** When the profile last changed (projects.line_profile.changed_at). */
  findersSince?: number;
  signals: MapSignal[];
  /** The project's tasks: its causes, and the tasks its line runs worked on. */
  tasks: LineCauseTask[];
  runs: MapRun[];
  decisions: MapDecision[];
  now: number;
  windowMs: number;
  cardsCap?: number;
};

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const UNDECLARED = "Files signals, but the profile does not declare it";

/** "24h", "7d", "30d": the window in the words its switch uses. */
export function windowLabel(windowMs: number): string {
  const hit = (Object.keys(LINE_MAP_WINDOWS) as LineMapWindow[]).find((k) => LINE_MAP_WINDOWS[k] === windowMs);
  return hit ?? ageShort(windowMs);
}

/** A stuck mark needs a usual time to compare with: this many finished visits. */
const STUCK_SAMPLES = 3;
const STUCK_FACTOR = 3;
/** Never stuck sooner than this, however quick the station usually is. */
const STUCK_FLOOR_MS = 15 * 60_000;
/** A queue reads as piling up once this many wait and this many more came than left. */
const QUEUE_MIN = 5;

export const signalItem = (s: MapSignal): MapItem => ({ kind: "signal", id: s._id, ref: s.short_id || s._id, title: s.title, at: s.created_at, taskId: s.task_id });
export const causeItem = (t: LineCauseTask, at: number): MapItem => ({ kind: "cause", id: t._id, ref: t.short_id || t._id, title: t.title, at, taskId: t._id });
const runItem = (r: MapRun, task: LineCauseTask | undefined, at: number): MapItem => ({ kind: "run", id: r._id, ref: r._id, title: task?.title ?? r.task_title ?? "A run", at, taskId: r.task_id, runId: r._id });

export function buildLineMap(input: LineMapInput): LineMap {
  const { now, windowMs } = input;
  const from = now - windowMs;
  const inWindow = (t: number | null | undefined) => typeof t === "number" && t >= from && t <= now;
  const graph = input.graph?.nodes?.length ? input.graph : SHIPPED_LINE;
  const label = windowLabel(windowMs);
  const flow = buildLineFlow({
    signals: input.signals, tasks: input.tasks, runs: input.runs as LineFlowRun[], decisions: input.decisions,
    initiatives: [], projects: [], now, cardsCap: input.cardsCap, finders: input.finders, findersSince: input.findersSince,
  });
  const taskById = new Map(input.tasks.map((t) => [t._id, t]));

  // ── nodes from the definition ──
  const nodes = new Map<string, MapNode>();
  const add = (n: Omit<MapNode, "now" | "through" | "passed" | "marks" | "medianMs" | "failed">) => {
    const node: MapNode = { ...n, now: [], through: 0, passed: [], marks: [], medianMs: null, failed: 0 };
    nodes.set(n.id, node);
    return node;
  };

  // Sources: one per declared finder, plus any source that filed without a declaration.
  const judged = new Set(input.signals.filter((s) => isExpectationId(s.subject)).map((s) => s.source.toLowerCase()));
  const sources = flow.sense.items;
  for (const f of input.finders ?? []) if (f.kind !== "any" && f.kind.includes("prompt_miss")) judged.add(f.source.toLowerCase());
  if (judged.size > 0) add({ id: EXPECTATIONS_NODE, kind: "expectations", label: "Expectations", phase: "sense", col: 0, main: false });
  for (const src of sources) {
    const node = add({ id: sourceNodeId(src.source), kind: "source", label: src.source, phase: "sense", col: 1, main: true, source: src.source, ...(src.finder ? { finder: src.finder } : {}) });
    if (src.silent) node.marks.push({ level: "warn", words: `Silent: ${silentText(src, now).replace(/^silent /, "nothing filed in ")}` });
    else if (src.undeclared) { node.undeclared = true; node.marks.push({ level: "info", words: UNDECLARED }); }
  }
  // The sense column keeps a week; a wider window still draws every source
  // that filed in it, so the sources add up to Signals.
  for (const s of input.signals) {
    if (!inWindow(s.created_at) || nodes.has(sourceNodeId(s.source))) continue;
    const node = add({ id: sourceNodeId(s.source), kind: "source", label: s.source, phase: "sense", col: 1, main: true, source: s.source });
    if (isUndeclaredSource(s.source, input.finders ?? [])) { node.undeclared = true; node.marks.push({ level: "info", words: UNDECLARED }); }
  }
  const sourceNames = [...nodes.values()].filter((n) => n.kind === "source").map((n) => n.source!);
  add({ id: SIGNALS_NODE, kind: "signals", label: "Signals", phase: "sense", col: 2, main: true });
  add({ id: CAUSES_NODE, kind: "causes", label: "Causes", phase: "admit", col: 3, main: true });

  // The graph's stations, with the exit split into the ends it means.
  const stations = graph.nodes.filter((n) => !isGraphEnd(n));
  const stationIds = new Set(stations.map((n) => n.id));
  const graphEdges: Array<{ from: string; to: string; label?: string }> = [];
  for (const e of graph.edges) {
    const from = e.from === "start" ? CAUSES_NODE : e.from;
    if (from !== CAUSES_NODE && !stationIds.has(from)) continue;
    const label = e.label ? choiceWords(e.label) : undefined;
    if (e.to !== "exit") { if (stationIds.has(e.to)) graphEdges.push({ from, to: e.to, ...(label ? { label } : {}) }); continue; }
    const end = LINE_END_NODES[from];
    if (end === "shipped") graphEdges.push({ from, to: endNodeId("held") }, { from, to: endNodeId("reopened") });
    else graphEdges.push({ from, to: (end && END_OF_RUN[end]) || endNodeId("stopped"), ...(label ? { label } : {}) });
  }
  const cols = columns(graphEdges);
  const main = mainStations(stations.map((n) => n.id), graphEdges);
  const base = 3;
  for (const n of stations) {
    add({ id: n.id, kind: kindOf(n.id), label: n.label || n.id, phase: phaseOfStation(n.id) ?? "build", col: base + (cols.get(n.id) ?? 1), main: main.has(n.id) });
  }
  const endsUsed = new Set(graphEdges.map((e) => e.to).filter((id) => id.startsWith("end:")));
  for (const end of ["held", "reopened", "dissolved", "dropped", "stopped"] as MapEnd[]) {
    const id = endNodeId(end);
    if (!endsUsed.has(id)) continue;
    add({ id, kind: "end", label: END_LABEL[end], phase: "end", col: base + (cols.get(id) ?? 1), main: end === "held", end });
  }

  // ── edges ──
  const edges = new Map<string, MapEdge>();
  const back = backEdges(graphEdges);
  const edge = (from: string, to: string, label?: string): MapEdge => {
    const id = `${from}->${to}`;
    let e = edges.get(id);
    if (!e) {
      const target = nodes.get(to);
      const kind: MapEdgeKind = back.has(id) ? "loop" : target && !target.main ? "branch" : "flow";
      e = { id, from, to, kind, ...(label ? { label } : {}), count: 0, items: [] };
      edges.set(id, e);
    }
    return e;
  };
  const cross = (from: string, to: string, item: MapItem) => {
    if (!nodes.has(from) || !nodes.has(to)) return;
    const e = edge(from, to);
    e.count++;
    if (!e.items.some((x) => x.kind === item.kind && x.id === item.id)) e.items.push(item);
  };
  if (nodes.has(EXPECTATIONS_NODE)) for (const s of sourceNames) if (judged.has(s.toLowerCase())) edge(EXPECTATIONS_NODE, sourceNodeId(s));
  for (const s of sourceNames) edge(sourceNodeId(s), SIGNALS_NODE);
  edge(SIGNALS_NODE, CAUSES_NODE);
  for (const e of graphEdges) edge(e.from, e.to, e.label);

  // ── intake: signals in the window ──
  const signals = nodes.get(SIGNALS_NODE)!;
  for (const s of input.signals) {
    if (!inWindow(s.created_at)) continue;
    const item = signalItem(s);
    const src = nodes.get(sourceNodeId(s.source));
    if (src) src.through++;
    if (isExpectationId(s.subject)) { cross(EXPECTATIONS_NODE, sourceNodeId(s.source), item); nodes.get(EXPECTATIONS_NODE)!.through++; }
    cross(sourceNodeId(s.source), SIGNALS_NODE, item);
    cross(SIGNALS_NODE, CAUSES_NODE, item);
    signals.through++;
  }

  // ── causes: the admission queue, read the way /line reads it ──
  const causes = nodes.get(CAUSES_NODE)!;
  for (const row of [...flow.causes.items, ...flow.causes.parked]) causes.now.push(causeItem(row.task, row.task.cause?.first_seen ?? row.task.created_at));
  causes.through = input.tasks.filter((t) => t.cause && inWindow(t.created_at)).length;
  if (flow.causes.state.kind === "paused") causes.marks.push({ level: "warn", words: `Admission paused: ${flow.causes.state.why}` });

  // ── the runs, station by station ──
  const lineRuns = input.runs.filter((r) => (r.task_id && taskById.get(r.task_id)?.cause) || isLineRun(r.node_statuses));
  const durations = new Map<string, number[]>();
  const stalled = new Set(flow.build.items.filter((b) => b.stalled).map((b) => b.run._id));
  for (const run of lineRuns) {
    const task = run.task_id ? taskById.get(run.task_id) : undefined;
    const visits = runVisits(run, graph, input.decisions);
    const live = run.status === "running" || run.status === "paused" || run.status === "pending";
    for (const v of visits) if (!v.inferred && v.startedAt != null && v.completedAt != null && v.state !== "live" && v.state !== "waiting") {
      durations.set(v.node, [...(durations.get(v.node) ?? []), v.completedAt - v.startedAt]);
    }
    // Where the run is now.
    if (live) {
      const at = visits[visits.length - 1];
      const node = at && nodes.has(at.node) ? nodes.get(at.node)! : causes;
      node.now.push({ ...runItem(run, task, at?.startedAt ?? run.created_at), ...(stalled.has(run._id) ? { stalled: true } : {}) });
    }
    // Crossings: admitted, each hop, and how the run ended.
    const item = (at: number) => runItem(run, task, at);
    let prev = CAUSES_NODE;
    for (let i = 0; i < visits.length; i++) {
      const v = visits[i];
      if (inWindow(v.at)) cross(prev, v.node, item(v.at));
      prev = v.node;
      const node = nodes.get(v.node);
      if (!node) continue;
      const left = leftOf(v, visits[i + 1], live);
      if (inWindow(v.at)) {
        node.through++;
        if (v.state === "failed") node.failed++;
        node.passed.push({ item: item(v.at), at: v.at, durationMs: v.startedAt != null && v.completedAt != null ? v.completedAt - v.startedAt : null, left: left.left, to: left.to });
      }
    }
    const last = visits[visits.length - 1];
    if (last && !live) {
      const end = lineRunOutcome(run.node_statuses);
      const to = end ? END_OF_RUN[end.kind] : endNodeId("stopped");
      const at = end?.at ?? run.updated_at;
      if (to && inWindow(at)) {
        cross(last.node, to, item(at));
        // A parked cause going back to the queue is not a new cause there.
        if (to !== CAUSES_NODE) bump(nodes.get(to));
      }
    }
  }

  // ── after ship: the watch, and how it ended ──
  const watchNode = [...nodes.values()].find((n) => n.kind === "watch");
  if (watchNode) {
    for (const w of flow.watching.items) watchNode.now.push(causeItem(w.task, w.task.closed_at ?? w.task.updated_at ?? w.until));
    const reopenedBy = new Map<string, MapSignal[]>();
    for (const s of input.signals) if (s.reopened) reopenedBy.set(s.task_id, [...(reopenedBy.get(s.task_id) ?? []), s]);
    for (const t of input.tasks) {
      if (!t.cause) continue;
      for (const s of reopenedBy.get(t._id) ?? []) if (inWindow(s.created_at)) { cross(watchNode.id, endNodeId("reopened"), causeItem(t, s.created_at)); bump(nodes.get(endNodeId("reopened"))); }
      // LE12: the watch ended quiet, swept or not yet.
      const quiet = quietWatchEnd(t, now);
      if (inWindow(quiet)) { cross(watchNode.id, endNodeId("held"), causeItem(t, quiet!)); bump(nodes.get(endNodeId("held"))); }
    }
  }

  // ── health, in words ──
  for (const node of nodes.values()) {
    node.now.sort((a, b) => a.at - b.at);
    node.passed.sort((a, b) => b.at - a.at);
    // Two ends mean the line did not deliver: a fix that came back, a run that
    // ended with nothing landed. They mark like a failing station, so the map
    // says so at a glance (LX2); held, dissolved and dropped are outcomes, not trouble.
    if (node.end === "reopened" && node.through > 0) node.marks.push({ level: "warn", words: `${plural(node.through, "fix", "fixes")} came back during the watch in the last ${label}` });
    if (node.end === "stopped" && node.through > 0) node.marks.push({ level: "warn", words: `${plural(node.through, "run")} stopped without a change in the last ${label}` });
    if (node.kind === "source" || node.kind === "end" || node.kind === "signals" || node.kind === "expectations") continue;
    const times = durations.get(node.id) ?? [];
    node.medianMs = median(times);
    if (node.medianMs != null && times.length >= STUCK_SAMPLES) {
      const limit = Math.max(STUCK_FLOOR_MS, node.medianMs * STUCK_FACTOR);
      for (const it of node.now) if (it.kind === "run" && now - it.at > limit) it.stuck = true;
      const stuck = node.now.filter((it) => it.stuck).length;
      if (stuck) node.marks.push({ level: "warn", words: `${plural(stuck, "run")} here past three times the usual ${ageShort(node.medianMs)}` });
    }
    const silent = node.now.filter((it) => it.stalled).length;
    if (silent) node.marks.push({ level: "warn", words: `${plural(silent, "run")} silent for a day` });
    if (node.failed > 0) {
      // The node shows the share; the window lives in the tooltip, since the
      // window switch above the map already names it (LX2).
      node.marks.push({ level: node.failed * 2 >= node.through ? "fail" : "warn", words: `${node.failed} of ${node.through} failed in the last ${label}`, short: `${node.failed} of ${node.through} failed` });
    }
  }

  // ── the queue's health (LX3): a pile-up is trouble even when nothing failed.
  // Its usual time is the wait from a cause's first sighting to its first run;
  // it grows when far more came in than left in the window.
  {
    const waits: number[] = [];
    const firstRun = new Map<string, number>();
    for (const r of lineRuns) if (r.task_id) firstRun.set(r.task_id, Math.min(firstRun.get(r.task_id) ?? Infinity, r.created_at));
    for (const [id, at] of firstRun) {
      const t = taskById.get(id);
      const seen = t?.cause?.first_seen ?? t?.created_at;
      if (seen != null && at >= seen) waits.push(at - seen);
    }
    causes.medianMs = median(waits);
    let stuck = 0;
    if (causes.medianMs != null && waits.length >= STUCK_SAMPLES) {
      const limit = Math.max(STUCK_FLOOR_MS, causes.medianMs * STUCK_FACTOR);
      for (const it of causes.now) if (now - it.at > limit) it.stuck = true;
      stuck = causes.now.filter((it) => it.stuck).length;
    }
    const left = [...edges.values()].filter((e) => e.from === CAUSES_NODE && e.kind !== "loop").reduce((n, e) => n + e.count, 0);
    const piling = causes.now.length >= QUEUE_MIN && causes.through - left >= QUEUE_MIN && causes.through > left * 2;
    // One mark from one set of numbers: the node, the Now list and Health all
    // read the oldest wait against the usual one, so none of them disagree.
    if (stuck || piling) {
      const oldest = causes.now.reduce((m, it) => Math.min(m, it.at), Infinity);
      const oldestAge = Number.isFinite(oldest) ? ageShort(Math.max(0, now - oldest)) : null;
      const head = piling ? `Piling up: ${causes.through} came in, ${left} left in the last ${label}` : `${plural(stuck, "cause")} waiting longer than usual`;
      const tail = oldestAge ? `Oldest has waited ${oldestAge}${causes.medianMs != null ? `; a cause usually starts within ${usualWords(causes.medianMs).replace("under a minute", "a minute")}` : ""}` : null;
      causes.marks.push({ level: "warn", words: [head, tail].filter(Boolean).join(". "), short: oldestAge ? `Oldest ${oldestAge}` : head });
    }
  }

  const order = [...nodes.values()].map((n, i) => ({ n, i })).sort((a, b) => a.n.col - b.n.col || a.i - b.i).map((x) => x.n);
  return { nodes: order, edges: [...edges.values()], window: { from, to: now, label } };
}

function bump(node: MapNode | undefined) {
  if (node) node.through++;
}

/** How a visit left its station: on to the next visit, or the run's end. */
function leftOf(v: RunVisit, next: RunVisit | undefined, live: boolean): { left: MapLeft; to: string | null } {
  if (next) return { left: v.state === "failed" ? "failed" : "moved", to: next.node };
  if (live) return { left: "live", to: null };
  if (v.state === "failed") return { left: "failed", to: endNodeId("stopped") };
  const end = LINE_END_NODES[v.node];
  if (end === "parked") return { left: "parked", to: CAUSES_NODE };
  if (end === "dissolved" || end === "dropped") return { left: end, to: endNodeId(end) };
  if (end === "shipped") return { left: "moved", to: null };
  return { left: "stopped", to: endNodeId("stopped") };
}

/** The edges that go back: found by a walk from Causes, an edge to a station
 *  still on the walk's path closes a loop. */
function backEdges(edges: Array<{ from: string; to: string }>): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  const out = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const walk = (n: string) => {
    state.set(n, 1);
    for (const m of adj.get(n) ?? []) {
      if (state.get(m) === 1) out.add(`${n}->${m}`);
      else if (!state.has(m)) walk(m);
    }
    state.set(n, 2);
  };
  walk(CAUSES_NODE);
  for (const e of edges) if (!state.has(e.from)) walk(e.from);
  return out;
}

/** The stations on the path every cause takes: the line's main stations
 *  (runReport isMainStation), and any station without which one of them could
 *  not be reached from Causes (the card's assembly steps, a station a project
 *  added between two main ones). A branch (plan, dissolve, reopen) can be cut
 *  and every main station is still reached. */
function mainStations(ids: string[], edges: Array<{ from: string; to: string }>): Set<string> {
  const back = backEdges(edges);
  const fwd = edges.filter((e) => !back.has(`${e.from}->${e.to}`));
  const reach = (without: string | null) => {
    const seen = new Set<string>([CAUSES_NODE]);
    const queue = [CAUSES_NODE];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of fwd) if (e.from === cur && e.to !== without && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
    return seen;
  };
  const core = ids.filter(isMainStation);
  const all = reach(null);
  const out = new Set(core);
  for (const id of ids) {
    if (out.has(id)) continue;
    const left = reach(id);
    if (core.some((m) => m !== id && all.has(m) && !left.has(m))) out.add(id);
  }
  return out;
}

/** Each node's column after Causes: its longest path from Causes, loops left out. */
function columns(edges: Array<{ from: string; to: string }>): Map<string, number> {
  const back = backEdges(edges);
  const fwd = edges.filter((e) => !back.has(`${e.from}->${e.to}`));
  const col = new Map<string, number>([[CAUSES_NODE, 0]]);
  // Relax until nothing moves: the graph is a DAG once loops are out, and small.
  for (let pass = 0; pass < fwd.length + 1; pass++) {
    let moved = false;
    for (const e of fwd) {
      const c = col.get(e.from);
      if (c == null) continue;
      if ((col.get(e.to) ?? -1) < c + 1) { col.set(e.to, c + 1); moved = true; }
    }
    if (!moved) break;
  }
  return col;
}
