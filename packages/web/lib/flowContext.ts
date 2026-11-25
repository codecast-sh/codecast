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
};

export type FlowFocus = { conversationId?: string | null; decisionId?: string | null; nodeId?: string | null };

export type FlowContext = {
  stations: FlowStation[];
  /** The station the run stands at (index), while it is alive. */
  at: number;
  /** The station the viewer is looking at (index): their session, their decision, else where the run stands. */
  focus: number;
  /** The run stands at a station the line's current graph no longer has: its order is the run's own history. */
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
  if (STRUCTURAL.has(r.id) || (graphType && STRUCTURAL.has(graphType))) return false;
  if (r.current || r.status === "failed" || r.id === gateNodeId || r.session || r.session_id) return true;
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
  run: { _id?: string; status?: string; current_node_id?: string; gate_node_id?: string; gate_decision_id?: string; gate_decision_short_id?: string; node_statuses?: any[] } | null | undefined,
  graph?: { nodes?: Array<{ id: string; label?: string; type?: string }> } | null,
  focus: FlowFocus = {},
): FlowContext {
  const empty = { stations: [], at: -1, focus: -1, lineChanged: false };
  if (!run) return empty;
  const alive = ALIVE.has(run.status ?? "");
  const standing = run.gate_node_id ?? run.current_node_id;
  const graphNodes = graph?.nodes ?? [];
  const lineChanged = !!standing && alive && graphNodes.length > 0 && !graphNodes.some((n) => n.id === standing);
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
    });
  }
  const at = stations.findIndex((s) => s.current);
  const mine = stations.findIndex((s) =>
    (!!focus.conversationId && s.sessionId === focus.conversationId) ||
    (!!focus.nodeId && s.id === focus.nodeId) ||
    (!!focus.decisionId && s.id === run.gate_node_id && (focus.decisionId === run.gate_decision_id || focus.decisionId === run.gate_decision_short_id)));
  return { stations, at, focus: mine >= 0 ? mine : at >= 0 ? at : stations.length - 1, lineChanged };
}

/** The nearest station before or after `from` that opens somewhere: what the step arrows go to. */
export function stepTarget(ctx: FlowContext, from: number, dir: -1 | 1): number {
  for (let i = from + dir; i >= 0 && i < ctx.stations.length; i += dir) if (ctx.stations[i].href) return i;
  return -1;
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
