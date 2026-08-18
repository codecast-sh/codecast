// The daemon's report of the background work a session's harness still holds:
// the tasks that will re-invoke the agent when they finish (a run_in_background
// Bash, a command the harness moved to the background on timeout, a Monitor, a
// Workflow run). Scraped from the transcript, then — for the shell-backed kinds
// — checked against the live process table: the harness runs each as a child
// shell of the agent process, so a task whose shell is gone is dead however
// open the transcript still says it is (the harness loses a completion notice
// now and then, and a restart takes every child with it).
//
// Reported on every settle verdict and re-verified on the heartbeat reconcile,
// so `open_tasks_at` is fresh while a daemon is watching. It is what lets the
// inbox draw the "↳ Background …" row under a Dormant card without the
// conversation's messages loaded, and what makes a "waiting" status a checked
// claim instead of a transcript guess.
//
// PURE isomorphic data — consumed by the CLI (producer), Convex (validator +
// overlay) and the web (renderer).
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

// How long a daemon's open-task report vouches for a "waiting" status. The
// reconcile refreshes it every heartbeat while the session is parked, so a
// report older than this means the daemon stopped looking — the status decays
// like any unverified one.
export const OPEN_TASKS_FRESH_MS = 10 * 60 * 1000;

export function openTasksVouchForWaiting(openTasksAt: number | null | undefined, openTaskCount: number, now: number): boolean {
  return !!openTasksAt && openTaskCount > 0 && now - openTasksAt < OPEN_TASKS_FRESH_MS;
}
