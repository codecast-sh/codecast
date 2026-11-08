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
