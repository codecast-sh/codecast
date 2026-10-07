// A run outlives its runner (the-line.md L9). Runs wait at gates for hours, so
// a machine or daemon restart must not strand one: the runner checkpoints its
// state as it advances, holds a pid file while it drives the run, and a run
// whose pid file names no live process continues from the node it stood at
// (`cast workflow run-daemon <run_id>` on a mid-run row, which the daemon's
// sweep and the trace's Resume both reach).

import * as fs from "fs";
import * as path from "path";
import { codecastPath } from "../codecastDir.js";
import { isPidAlive } from "../workspace/chrome.js";
import type { NodeOutcome, WorkflowGraph, WorkflowRunState } from "./types";

// ─── The runner's claim on a run ──────────────────────────

export function runnerPidFile(runId: string): string {
  return codecastPath("workflow-runs", `${runId.replace(/[^\w-]/g, "")}.pid`);
}

/** The pid driving `runId` on this machine, or null when no live process does. */
export function liveRunnerPid(runId: string): number | null {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(runnerPidFile(runId), "utf-8")).pid);
    return isPidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Claim `runId` for this process: one runner per run, so a resume never
 * drives a run a live runner still holds. Returns the release, or the pid of
 * the live holder. A holder that died (SIGKILL, a reboot) leaves a pid file
 * naming no process, which the next claim takes over.
 */
export function claimRun(runId: string): { release: () => void } | { heldBy: number } {
  const held = liveRunnerPid(runId);
  if (held && held !== process.pid) return { heldBy: held };
  const file = runnerPidFile(runId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
  const release = () => {
    process.removeListener("exit", release);
    try {
      if (Number(JSON.parse(fs.readFileSync(file, "utf-8")).pid) === process.pid) fs.unlinkSync(file);
    } catch {}
  };
  process.once("exit", release);
  return { release };
}

// ─── The checkpoint ───────────────────────────────────────

/** What a runner needs to continue a run where it stood: written after every step. */
export interface RunCheckpoint {
  run_id: string;
  /** The node the run is at: running (`started`, its visit counted) or routed to next. */
  node_id: string;
  started: boolean;
  visit_counts: Record<string, number>;
  completed: string[];
  node_outcomes: Record<string, NodeOutcome>;
  context: Record<string, string>;
  at: number;
}

/** Beside the run's other files ($run_dir), one per run: a later run on the same cause shares the directory. */
export function checkpointPath(runDir: string, runId: string): string {
  return path.join(runDir, "runs", `${runId.replace(/[^\w-]/g, "")}.json`);
}

export function writeCheckpoint(runDir: string, runId: string, state: WorkflowRunState, nodeOutcomes: Record<string, NodeOutcome>, next?: string): void {
  const file = checkpointPath(runDir, runId);
  const body: RunCheckpoint = {
    run_id: runId,
    node_id: next ?? state.currentNodeId,
    started: !next,
    visit_counts: state.visitCounts,
    completed: state.completed,
    node_outcomes: nodeOutcomes,
    context: state.context,
    at: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Whole or not at all: a runner killed mid-write must not leave half a file.
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(body));
    fs.renameSync(`${file}.tmp`, file);
  } catch {}
}

export function readCheckpoint(runDir: string, runId: string): RunCheckpoint | null {
  try {
    const cp = JSON.parse(fs.readFileSync(checkpointPath(runDir, runId), "utf-8"));
    return cp?.run_id === runId && typeof cp.node_id === "string" && cp.context ? cp : null;
  } catch {
    return null;
  }
}

// ─── Where a run continues ────────────────────────────────

/** The run row's facts a resume reads (workflow_runs, via /cli/workflow-runs/get). */
export interface ResumeRow {
  status: string;
  current_node_id?: string | null;
  node_statuses?: Array<{ node_id: string; status: string; outcome?: string | null; session_id?: string | null; completed_at?: number | null }>;
  gate_node_id?: string | null;
  gate_response?: string | null;
}

/** A row is mid-run when it is live and a runner reported past its start. */
export function isMidRun(row: ResumeRow): boolean {
  return (row.status === "running" || row.status === "paused") && !!row.current_node_id
    && (row.node_statuses ?? []).some((n) => n.node_id !== row.current_node_id || n.status !== "pending");
}

export interface ResumePoint {
  node_id: string;
  /** Restored state; the node at `node_id` runs next and counts its visit then. */
  visit_counts: Record<string, number>;
  completed: string[];
  node_outcomes: Record<string, NodeOutcome>;
  context: Record<string, string>;
  /** The gate the run stood at: its answer when one arrived while nothing drove it; `open` when it still waits on one. */
  gate: { node_id: string; response: string | null; open: boolean } | null;
  /** The hand a session node had running when its runner died, to wait on again rather than start anew. */
  hand: string | null;
  from: "checkpoint" | "row";
}

/**
 * Where `row` continues in `graph`, from the runner's checkpoint when this
 * machine has one, else from what the row holds (each finished node's
 * outcome and session). The row decides the node: it is what every surface
 * shows, and a gate answered while nothing drove the run is answered there.
 * Null when the node the row stands at is not in the graph.
 */
export function resumePoint(graph: WorkflowGraph, row: ResumeRow, checkpoint: RunCheckpoint | null): ResumePoint | null {
  // A runner that died between finishing a node and reporting the next one
  // left the row on the finished node and the checkpoint on the next: the
  // checkpoint's route stands, so the finished node does not run twice.
  const rowNode = row.current_node_id || checkpoint?.node_id;
  const routedOn = !!checkpoint && !checkpoint.started && checkpoint.completed[checkpoint.completed.length - 1] === rowNode;
  const nodeId = routedOn ? checkpoint!.node_id : rowNode;
  if (!nodeId || !graph.nodes.has(nodeId)) return null;
  const node = graph.nodes.get(nodeId)!;
  const atCheckpoint = checkpoint?.node_id === nodeId ? checkpoint : null;

  let visit_counts: Record<string, number>;
  let completed: string[];
  let node_outcomes: Record<string, NodeOutcome>;
  let context: Record<string, string>;
  if (atCheckpoint) {
    ({ visit_counts, completed, node_outcomes, context } = structuredClone(atCheckpoint));
    // A started node counted its visit; it counts again when it runs.
    if (atCheckpoint.started && visit_counts[nodeId]) visit_counts[nodeId]--;
  } else {
    visit_counts = {};
    completed = [];
    node_outcomes = {};
    context = {};
    const done = (row.node_statuses ?? [])
      .filter((n) => n.node_id !== nodeId && (n.status === "completed" || n.status === "failed"))
      .sort((a, b) => (a.completed_at ?? 0) - (b.completed_at ?? 0));
    for (const n of done) {
      const outcome = n.outcome || (n.status === "failed" ? "failure" : "success");
      visit_counts[n.node_id] = 1;
      completed.push(n.node_id);
      node_outcomes[n.node_id] = outcome;
      context[`${n.node_id}.outcome`] = outcome;
      if (n.session_id) context[`${n.node_id}.session_id`] = n.session_id;
    }
    const last = done[done.length - 1];
    if (last) context["outcome"] = node_outcomes[last.node_id];
  }

  const asked = !routedOn && row.gate_node_id === nodeId;
  const gate = node.type === "human"
    ? { node_id: nodeId, response: asked && row.gate_response ? row.gate_response : null, open: asked && row.status === "paused" }
    : null;
  const hand = node.backend === "session" && atCheckpoint ? atCheckpoint.context[`${nodeId}.conversation_id`] ?? null : null;
  return { node_id: nodeId, visit_counts, completed, node_outcomes, context, gate, hand, from: atCheckpoint ? "checkpoint" : "row" };
}
