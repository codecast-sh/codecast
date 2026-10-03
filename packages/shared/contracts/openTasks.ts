// The daemon's report of the background work a session's harness still holds:
// the tasks that will re-invoke the agent when they finish (a run_in_background
// Bash, a command the harness moved to the background on timeout, a Monitor, a
// Workflow run). Scraped from the transcript, then — for the shell-backed kinds
// — checked against the live process table: the harness runs each as a child
// shell of the agent process, so a task whose shell is gone is dead however
// open the transcript still says it is (the harness loses a completion notice
// now and then, and a restart takes every child with it).
//
// Reported on every settle verdict, and re-published whenever the heartbeat
// reconcile's re-verification changes it. It is what lets the
// inbox draw the "↳ Background …" row under a Dormant card without the
// conversation's messages loaded, and what makes a "waiting" status a checked
// claim instead of a transcript guess.
//
// PURE isomorphic data — consumed by the CLI (producer), Convex (validator +
// overlay) and the web (renderer).
import { HEARTBEAT_ALIVE_MS } from "./agentStatus";
export const OPEN_TASK_KINDS = ["background", "promoted", "monitor", "workflow"] as const;
export type OpenTaskKind = (typeof OPEN_TASK_KINDS)[number];

export type OpenTaskReport = {
  id: string;
  kind: OpenTaskKind;
  description?: string;
  // First line of the command, for the row's subtext. Never the whole script.
  command?: string;
  started_at?: number;
  tool_use_id?: string;
};

// Whether a daemon's open-task report vouches for a "waiting" status: the
// report names work, and the daemon that made it is still heartbeating the
// session. Every settle rewrites the report (an empty list included), so a
// non-empty one stands until the daemon publishes otherwise; a daemon that died
// or let the session go stops heartbeating, and the vouch lapses with it.
// Liveness is the heartbeat's job, not the report's age: the re-verification
// rides the slow maintenance pass, which under load reaches a session minutes
// late, and an age window there flipped parked workflow sessions to needs
// input every time a pass ran behind (2026-10-03).
export function openTasksVouchForWaiting(
  openTasksAt: number | null | undefined,
  openTaskCount: number,
  lastHeartbeat: number | null | undefined,
  now: number,
): boolean {
  return !!openTasksAt && openTaskCount > 0 && lastHeartbeat != null && now - lastHeartbeat < HEARTBEAT_ALIVE_MS;
}
