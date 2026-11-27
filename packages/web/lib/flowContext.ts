// A run's stations as one strip: the shape every surface born from a flow draws
// around itself (a station's session, a gate's decision, a task, a run card),
// so a person always sees which flow, every station in order, where the run
// stands, where they are, and can step to any station in one click. Pure, so
// web and phone order, name and link the stations the same way.

import { runNodeRows, type RunNodeRow } from "./workflowRun";

export type StationState = "done" | "failed" | "live" | "waiting" | "next";

export type FlowStation = {
  id: string;
  /** The station's name: its label, else its id read as words (`review__review` → "Review"). */
  label: string;
  /** The segment it belongs to, when the flow imports one (`review__review` → "Review"). */
  segment?: string;
  state: StationState;
  /** Where the run stands now, while it is alive. */
  current: boolean;
  /** Where a station opens: its session, else the decision it asked. */
  href?: string;
  /** The conversation that ran it, when one did. */
  sessionId?: string;
  started_at?: number;
  completed_at?: number;
  /** What the station said it did: its result as written (a command's output, an agent's reply), else what it was doing. */
  output?: string;
  /** The verdict it routed on, when one differs from plain success. */
  outcome?: string;
};

/** Where the run's work came from, read before its first station: the session the task was filed from, then the task. */
export type FlowOrigin = { key: "session" | "task"; label: string; ref?: string; href: string };

export type FlowFocus = { conversationId?: string | null; decisionId?: string | null; nodeId?: string | null };

export type FlowContext = {
  /** The stations the run reached, and the one it stands at, in order. */
  stations: FlowStation[];
  /** Stations of the flow still ahead of where the run stands, in graph order; branches it passed by are left out. */
  ahead: FlowStation[];
  /** The station the run stands at (index), while it is alive. */
  at: number;
  /** The station the viewer is looking at (index): their session, their decision, else where the run stands. */
  focus: number;
  /** The run ran a version of the flow the published graph no longer matches: its order is the run's own history. */
  lineChanged: boolean;
};

const STRUCTURAL = new Set(["start", "exit", "conditional", "parallel_fanout", "parallel_fanin"]);
const WORK = new Set(["agent", "prompt", "call", "command", "human"]);

const words = (id: string) => {
  const w = id.replace(/_/g, " ").trim();
  return w ? w[0].toUpperCase() + w.slice(1) : id;
};

/** A node id read as a name: the part after an imported segment's prefix (`ship__rebase` → "Rebase"). */
export function stationName(id: string, label?: string | null): string {
  const l = label?.trim();
  if (l) return l;
  const at = id.lastIndexOf("__");
  return words(at >= 0 ? id.slice(at + 2) : id);
}

const segmentOf = (id: string): string | undefined => {
  const at = id.indexOf("__");
  return at > 0 ? words(id.slice(0, at)) : undefined;
};

const ALIVE = new Set(["pending", "running", "paused"]);

/**
 * Whether a row is a station a person would name: work that ran (a session, a decision, a command that took time),
 * anything that failed or is where the run stands, and work not reached yet. A routing node the runner passed
 * through in an instant (a segment's entry, a branch, a pass mark) is plumbing, not a station.
 */
function isStation(r: RunNodeRow, graphType: string | undefined, gateNodeId: string | undefined): boolean {
  const type = graphType ?? r.type;
  // Where the run stands is always a station, even a fan-out waiting on its branches.
  if (r.current) return true;
  if (STRUCTURAL.has(r.id) || (graphType && STRUCTURAL.has(graphType))) return false;
  if (r.status === "failed" || r.id === gateNodeId || r.session || r.session_id) return true;
  if (graphType) return WORK.has(type) && (graphType !== "command" || r.status !== "completed" || took(r) >= 1000 || !!r.outcome && r.outcome !== "success");
  // No graph to say what a node is: it ran as something only if it took time.
  return r.status === "pending" ? false : took(r) >= 1000;
}

const took = (r: RunNodeRow) => (r.started_at != null && r.completed_at != null ? r.completed_at - r.started_at : 0);

/**
 * The run's stations in order. The order is the line's graph while the run stands somewhere that graph still has;
 * once the line was republished without it, the run's own history is the only true order.
 */
export function flowContext(
  run: { _id?: string; status?: string; current_node_id?: string; gate_node_id?: string; gate_decision_id?: string; gate_decision_short_id?: string; fail_reason?: string; node_statuses?: any[] } | null | undefined,
  graph?: { nodes?: Array<{ id: string; label?: string; type?: string }> } | null,
  focus: FlowFocus = {},
): FlowContext {
  const empty = { stations: [], ahead: [], at: -1, focus: -1, lineChanged: false };
  if (!run) return empty;
  const alive = ALIVE.has(run.status ?? "");
  // An empty gate id means no gate: the run stands at its current node.
  const standing = run.gate_node_id || run.current_node_id;
  const graphNodes = graph?.nodes ?? [];
  // The run ran another version of the flow when a station it reached, or the one it stands at, is not in the graph
  // as published now; live or ended, its own history is then the only true order.
  const inGraph = new Set(graphNodes.map((n) => n.id));
  const reachedIds = (run.node_statuses ?? []).filter((n: any) => n.status !== "pending").map((n: any) => n.node_id as string);
  const lineChanged = graphNodes.length > 0 && [...reachedIds, ...(alive && standing ? [standing] : [])].some((id) => !STRUCTURAL.has(id) && !inGraph.has(id));
  const types = new Map(graphNodes.map((n) => [n.id, n.type]));
  const labels = new Map(graphNodes.map((n) => [n.id, n.label]));
  const rows = runNodeRows(run, lineChanged ? null : graph);
  const stations: FlowStation[] = [];
  for (const r of rows) {
    if (!isStation(r, lineChanged ? undefined : types.get(r.id), run.gate_node_id)) continue;
    const isHuman = types.get(r.id) === "human" || r.id === run.gate_node_id;
    const current = alive && r.id === standing;
    const state: StationState = current && run.status === "paused" ? "waiting"
      : current || r.status === "running" ? "live"
      : r.status === "failed" ? "failed"
      : r.status === "completed" ? "done" : "next";
    const sessionId = r.session?._id ?? undefined;
    const handle = sessionId ?? r.session?.session_id ?? r.session_id;
    const decision = isHuman && r.id === run.gate_node_id ? (run.gate_decision_short_id ?? run.gate_decision_id) : undefined;
    stations.push({
      id: r.id,
      label: stationName(r.id, labels.get(r.id) ?? (r.label !== r.id ? r.label : undefined)),
      segment: segmentOf(r.id),
      state,
      current,
      ...(handle ? { href: `/conversation/${handle}`, sessionId } : decision ? { href: `/decisions/${decision}` } : {}),
      started_at: r.started_at,
      completed_at: r.completed_at,
      output: r.result_preview || r.activity || (r.status === "failed" && r.id === run.current_node_id ? run.fail_reason : undefined) || undefined,
      ...(r.outcome && r.outcome !== "success" && r.outcome !== "failure" ? { outcome: r.outcome } : {}),
    });
  }
  // What happened leads, in the order it ran; what has not happened folds: a station not reached that the graph lists
  // before the last one reached is a branch the run passed by, and the rest are still ahead.
  const graphAt = new Map(graphNodes.map((n, i) => [n.id, i]));
  const lastReached = stations.reduce((last, s) => (s.state !== "next" ? Math.max(last, graphAt.get(s.id) ?? -1) : last), -1);
  const ahead = stations.filter((s) => s.state === "next" && (graphAt.get(s.id) ?? Infinity) > lastReached);
  const shown = stations.filter((s) => s.state !== "next");
  stations.length = 0;
  stations.push(...shown);
  const at = stations.findIndex((s) => s.current);
  const mine = stations.findIndex((s) =>
    (!!focus.conversationId && s.sessionId === focus.conversationId) ||
    (!!focus.nodeId && s.id === focus.nodeId) ||
    (!!focus.decisionId && s.id === run.gate_node_id && (focus.decisionId === run.gate_decision_id || focus.decisionId === run.gate_decision_short_id)));
  return { stations, ahead, at, focus: mine >= 0 ? mine : at >= 0 ? at : stations.length - 1, lineChanged };
}

/** The station before or after `from`: what the step arrows go to. One with a session or decision opens it; one
 *  without opens in place, so every station of the run can be read, back to the first. */
export function stepTarget(ctx: FlowContext, from: number, dir: -1 | 1): number {
  const i = from + dir;
  return i >= 0 && i < ctx.stations.length ? i : -1;
}

/** Where the run's work came from: the session its task was filed from (with its title when known), then the task. */
export function flowOrigin(
  run: { task_short_id?: string; task_title?: string; task_origin_conversation_id?: string } | null | undefined,
  originTitle?: string | null,
): FlowOrigin[] {
  const out: FlowOrigin[] = [];
  if (!run) return out;
  if (run.task_origin_conversation_id) out.push({ key: "session", label: originTitle?.trim() || "Where it started", href: `/conversation/${run.task_origin_conversation_id}` });
  if (run.task_short_id) out.push({ key: "task", label: run.task_title?.trim() || run.task_short_id, ref: run.task_short_id, href: `/tasks/${run.task_short_id}` });
  return out;
}

const RUN_WORDS: Record<string, string> = { pending: "starting", running: "running", paused: "waiting", completed: "finished", failed: "stopped" };

/** Where the run stands, in a few words ("waiting at Decide"), and the state its tone follows. */
export function runStanding(run: { status?: string }, ctx: FlowContext): { words: string; state: StationState } {
  const where = ctx.at >= 0 ? ctx.stations[ctx.at] : null;
  const status = run.status ?? "";
  return {
    words: `${RUN_WORDS[status] ?? status}${where ? ` at ${where.label}` : ""}`,
    state: where?.state ?? (status === "failed" ? "failed" : status === "completed" ? "done" : "next"),
  };
}
