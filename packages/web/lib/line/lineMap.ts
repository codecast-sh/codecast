// The rows every line surface reads, and a run's visits (docs/architecture/
// line-workspace.md LW2): the shapes of the signals, runs and cards the store
// holds, the graph a project's line runs, and the stations a run visited in
// order, loops included. Pure: no store, no React. lib/line/lineModel builds
// the workspace's model over these.
import { verdictOfOption } from "@codecast/shared/contracts/changeCard";
import type { LineDecision, LineFlowRun, LineSignal } from "../lineFlow";
import type { LineEdge, LineNode } from "./lineStations";
import { choiceWords, runPath, type LinePhaseKey, type ReportRun, type StepState } from "./runReport";
import { SHIPPED_LINE } from "./shippedLine.generated";
import { stationWho, type GraphEnd } from "./lineGraphs";

// ── the rows a line reads ───────────────────────────────────────────────────

/** A signal as the store holds it. */
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

/** A run row (workflow_runs.enrichRun), the fields the line reads. */
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

/** The graph the project's line runs: the shipped line, its own copy, or a
 *  repo's own graph (lineGraphs). `phase` places a station a foreign graph
 *  names; `ends` says how a run that reached one of its terminal steps ended. */
export type LineGraph = {
  nodes: Array<Pick<LineNode, "id" | "label" | "type"> & { shape?: string; phase?: LinePhaseKey }>;
  edges: LineEdge[];
  ends?: Record<string, GraphEnd>;
};

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
/** The graph's edges by station; with `own`, only the stations a run's own graph had. */
const adjacency = (graph: LineGraph, own?: Set<string> | null): Adjacency => {
  const adj: Adjacency = new Map();
  const has = (id: string) => !own || id === "start" || id === "exit" || own.has(id);
  for (const e of graph.edges) if (has(e.from) && has(e.to)) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
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
  // A run is drawn through the stations its own graph had: a station the line
  // gained after it ran (rebase, the ask gate) is never inferred into its path.
  const own = run.graph_nodes?.length ? new Set(run.graph_nodes.map((n) => n.id)) : null;
  const adj = adjacency(graph, own);
  const states = stepStates(run, graph);
  // A person's step answered with a key ends "failed" with the key as its
  // outcome on any graph: that is an answer, not a failure.
  const asked = new Set(graph.nodes.filter((g) => stationWho(g) === "person").map((g) => g.id));
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
    state: asked.has(n.node_id) && n.status === "failed" && n.outcome ? "done" : states.get(n.node_id) ?? (n.status === "failed" ? "failed" : n.status === "running" ? "live" : "done"),
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
