// `cast workflow runs --task ct-N --wait [status|station]`: block until a
// run moves, instead of a loop of `workflow runs` and sleeps.

// workflow_runs.status in the schema. A cancel ends a run as "failed".
const RUN_STATUSES = ["pending", "running", "paused", "completed", "failed"];
const FINISHED = new Set(["completed", "failed"]);

export interface WaitRow {
  status: string;
  current_node_id?: string;
  current_node_label?: string;
}

/**
 * Whether the wait is over, and whether it ended as asked. With no target, any
 * change of status or station ends it (a run already finished ends it at
 * once). A target status or station ends it when reached; a run that finishes
 * elsewhere first ends it unmet.
 */
export function runWaitVerdict(start: WaitRow, now: WaitRow, target: string | true): { done: boolean; met: boolean } {
  const at = (row: WaitRow, station: string) => row.current_node_id === station || row.current_node_label === station;
  if (target === true) {
    if (FINISHED.has(now.status)) return { done: true, met: true };
    const moved = now.status !== start.status || now.current_node_id !== start.current_node_id;
    return { done: moved, met: moved };
  }
  if (RUN_STATUSES.includes(target)) {
    if (now.status === target) return { done: true, met: true };
    return { done: FINISHED.has(now.status), met: false };
  }
  if (at(now, target)) return { done: true, met: true };
  return { done: FINISHED.has(now.status), met: false };
}

/**
 * How long to sleep before the next poll, by how long the wait has run. A
 * move is likeliest in its first minutes, so polls start every 15 s and
 * stretch to a minute: a batch dispatcher holding ~100 waits of up to 45 min
 * polled 24k times an hour at a flat 15 s and helped saturate prod on
 * 2026-11-10.
 */
export function runWaitPollMs(elapsedMs: number): number {
  if (elapsedMs < 2 * 60_000) return 15_000;
  if (elapsedMs < 10 * 60_000) return 30_000;
  return 60_000;
}
