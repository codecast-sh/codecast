// The task page as the line (docs/architecture/the-line.md L3, L5, L10):
// pure derivations the strip, the list chip and the run panel share. No
// store, no React, so a test feeds rows and reads answers.
import { resolveTaskStatus, type TeamTaskStatus } from "@codecast/shared/tasks";
import type { WorkState } from "@codecast/shared/contracts";
import { boardOrderedStatuses } from "./taskStatuses";

export type LineTask = {
  _id: string;
  short_id?: string;
  status?: string | null;
  status_id?: string | null;
  workflow_run_id?: string | null;
  review_verdict?: { verdict: string; at: number; note?: string } | null;
};

// The fields of a decision row a hold is judged on.
export type HoldCandidate = {
  _id: string;
  short_id?: string;
  status: string;
  blocking: boolean;
  task_id?: string;
  station?: string;
  created_at?: number;
};

export type RunNodeStatus = {
  node_id: string;
  status: string;
  session_id?: string;
  started_at?: number;
  completed_at?: number;
  label?: string;
  result_preview?: string;
  activity?: string;
  session?: { _id: string; title?: string; is_active?: boolean } | null;
};

export type LineRun = {
  _id: string;
  status: string;
  task_id?: string;
  current_node_id?: string;
  current_node_label?: string;
  workflow_name?: string;
  gate_decision_id?: string;
  gate_decision_short_id?: string;
  gate_node_id?: string;
  node_statuses?: RunNodeStatus[];
  started_at?: number;
  updated_at?: number;
};

export type LiveNode = {
  id: string;
  label: string;
  status: string;
  session_id?: string;
  session?: RunNodeStatus["session"];
  started_at?: number;
  result_preview?: string;
  activity?: string;
};

/** L3: a task's station is its status; the same key askCore stamps on a
 *  decision and the evidence query stamps on a page. */
export function stationOf(task: Pick<LineTask, "status" | "status_id">): string {
  return (task.status_id ?? task.status ?? "open") as string;
}

/** L3: the team's statuses in pipeline order are the stations (the board's
 *  column order, not the list's grouping order, which puts done first). */
export function stationOrder(statuses: TeamTaskStatus[]): TeamTaskStatus[] {
  return boardOrderedStatuses(statuses);
}

/** Where on the line the task stands. -1 only for an empty station list. */
export function currentStationIndex(task: Pick<LineTask, "status" | "status_id">, stations: TeamTaskStatus[]): number {
  if (stations.length === 0) return -1;
  const s = resolveTaskStatus(task, stations);
  const i = stations.findIndex((x) => x.id === s.id);
  return i >= 0 ? i : stations.findIndex((x) => x.category === s.category);
}

/** The name a station renders as: the team's status name, else the key. */
export function stationLabel(station: string | null | undefined, stations: TeamTaskStatus[]): string {
  if (!station) return "unfiled";
  const s = stations.find((x) => x.id === station) ?? stations.find((x) => x.category === station);
  return s?.name ?? station;
}

/** L5: the pending blocking decision bound to this task at its current
 *  station holds it there. Oldest first when several: the first ask is the
 *  one that blocked. A decision bound to another station does not hold. */
export function heldDecisionFor<D extends HoldCandidate>(task: Pick<LineTask, "_id" | "status" | "status_id">, decisions: D[]): D | undefined {
  const station = stationOf(task);
  let held: D | undefined;
  for (const d of decisions) {
    if (d.status !== "pending" || !d.blocking || d.task_id !== task._id) continue;
    if ((d.station ?? station) !== station) continue;
    if (!held || (d.created_at ?? 0) < (held.created_at ?? 0)) held = d;
  }
  return held;
}

/** The run's live node: the current node with its label, session and start.
 *  The label comes from the list row (server resolved), else the node status
 *  (dynamic runs carry their own), else the workflow graph, else the id. */
export function runLiveNode(run: LineRun | null | undefined, workflowNodes?: Array<{ id: string; label?: string }>): LiveNode | null {
  if (!run) return null;
  const id = run.current_node_id;
  if (!id) return null;
  const ns = run.node_statuses?.find((n) => n.node_id === id);
  const label = run.current_node_label ?? ns?.label ?? workflowNodes?.find((n) => n.id === id)?.label ?? id;
  return {
    id,
    label,
    status: ns?.status ?? run.status,
    session_id: ns?.session_id,
    session: ns?.session ?? null,
    started_at: ns?.started_at ?? run.started_at,
    result_preview: ns?.result_preview,
    activity: ns?.activity,
  };
}

/** A run still on the line: running or waiting at a gate. */
export function isLiveRun(run: Pick<LineRun, "status"> | null | undefined): boolean {
  return run?.status === "running" || run?.status === "paused";
}

/** The task's run out of the runs collection: the one the task names, else
 *  the newest live run bound to it. */
export function runForTask<R extends LineRun>(task: Pick<LineTask, "_id" | "workflow_run_id">, runs: Iterable<R>): R | undefined {
  let best: R | undefined;
  for (const r of runs) {
    if (task.workflow_run_id && r._id === task.workflow_run_id) return r;
    if (r.task_id !== task._id || !isLiveRun(r)) continue;
    if (!best || (r.updated_at ?? 0) > (best.updated_at ?? 0)) best = r;
  }
  return best;
}

/** L10: the list chip. "held at <station>" beats "at <station> · <node>";
 *  nothing when the task has neither a hold nor a live run. */
export function lineChipText(input: {
  station: string;
  held?: HoldCandidate | null;
  run?: LineRun | null;
  node?: LiveNode | null;
}): string | null {
  if (input.held) return `held at ${input.station}`;
  if (input.run && isLiveRun(input.run)) {
    const node = input.node ?? runLiveNode(input.run);
    return node ? `at ${input.station} · ${node.label}` : `at ${input.station}`;
  }
  return null;
}

/** Elapsed since a start, in the coarse words the strip shows. */
export function formatElapsed(startedAt: number | undefined, now: number): string | null {
  if (startedAt === undefined || startedAt === null) return null;
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The hand's state for its stripe: the live store row when we hold it,
 *  else the run's own enrichment (is_active). */
export function handWorkState(
  storeVerdict: { idle: boolean; waiting: boolean; rest: string } | null | undefined,
  nodeSession: { is_active?: boolean } | null | undefined,
): WorkState {
  if (storeVerdict) {
    if (!storeVerdict.idle) return "working";
    if (storeVerdict.waiting) return storeVerdict.rest as WorkState;
    return "idle";
  }
  if (nodeSession?.is_active) return "working";
  return "idle";
}
