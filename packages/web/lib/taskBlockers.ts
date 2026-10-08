import {
  blockerLabel,
  blockersOf,
  isBlocking,
  isReady,
  isTerminalTaskStatus,
  parentStatusLookup,
  waitingOnLabel,
  type Blocker,
  type GraphTask,
  type StatusOf,
} from "@codecast/shared/tasks";
import { lookup } from "./liveEntities";

// The task graph (docs/architecture/task-graph.md TG1) read from the store.
// The store does not hold every task a blocker or parent names (the bootstrap
// keeps the newest rows, the crawl skips dropped ones), so a ref it lacks is
// answered from the row's server snapshot, and one the snapshot never looked
// up stays unknown and blocks. Absence is never read as "finished".

type TaskRows = Record<string, any> | null | undefined;

/** A list row's view of its refs (tasks.ts enrichTasks, lib/taskGraph
 *  stampGraphStatus), and the detail's refs that name no task. */
export type BoardTask = GraphTask & {
  graph_status?: readonly { ref: string; short_id?: string; status: string | null }[] | null;
  graph_missing?: readonly string[] | null;
};

/** A `StatusOf` for `task`'s refs: the store's live row (by `_id` or short
 *  id), else the row's snapshot (`null`: names no task), else unknown. */
export function storeStatusOf(tasks: TaskRows, task?: BoardTask): StatusOf {
  return (ref) => {
    const live = lookup(tasks, ref);
    if (live) return live;
    const snap = task?.graph_status?.find((g) => g.ref === ref);
    if (snap) return snap.status === null ? null : { short_id: snap.short_id, status: snap.status };
    return task?.graph_missing?.includes(ref) ? null : undefined;
  };
}

/** The blockers holding `task` back, task blockers first, then waits. */
export function openBlockers(task: BoardTask, tasks: TaskRows): Blocker[] {
  return blockersOf(task, storeStatusOf(tasks, task)).filter(isBlocking);
}

/** The store's answer for each ref, as one string ("open,done,-,?"). */
function refsSig(task: BoardTask, refs: readonly string[], tasks: TaskRows): string {
  const statusOf = storeStatusOf(tasks, task);
  return refs
    .map((ref) => {
      const found = statusOf(ref);
      return found === null ? "-" : found === undefined ? "?" : typeof found === "string" ? found : found.status ?? "";
    })
    .join(",");
}

/** What a row's mark depends on beyond the row itself: the store's answer for
 *  each task blocker. Cheap enough to select on every store change. Empty for
 *  a closed task, which nothing holds. */
export function blockerStatusSig(task: BoardTask, tasks: TaskRows): string {
  if (!task.blocked_by?.length || isTerminalTaskStatus(task.status)) return "";
  return refsSig(task, task.blocked_by, tasks);
}

/** What `isUnblockedInStore` reads beyond the rows themselves, for a whole
 *  board: the store's answer for each open row's blocker and parent refs. A
 *  board selects it, so a write to a task none of them names reruns nothing. */
export function unblockedSig(rows: readonly BoardTask[], tasks: TaskRows): string {
  let sig = "";
  for (const t of rows) {
    if (t.status !== "open" || (!t.blocked_by?.length && !t.parent_id)) continue;
    sig += `${refsSig(t, [...(t.blocked_by ?? []), ...(t.parent_id ? [String(t.parent_id)] : [])], tasks)};`;
  }
  return sig;
}

/** The tasks board's `status` value for the Unblocked view (TG12). */
export const UNBLOCKED_VIEW = "unblocked";

/** What the web calls "unblocked" and the CLI "ready" (TG1): open, active,
 *  not superseded, its parent not being worked, and nothing holding it. */
export function isUnblockedInStore(task: BoardTask, tasks: TaskRows, viewer: string | null): boolean {
  const statusOf = storeStatusOf(tasks, task);
  return isReady(task, { statusOf, parentStatusOf: parentStatusLookup(statusOf), viewer });
}

export type BlockedMark = { count: number; failed: boolean; tip: string };

/** The row's blocked mark: how many things hold it, whether a wait failed (it
 *  needs re-planning, not patience), and the tooltip naming each one in the
 *  timeline's words: "Waiting on ct-12 · Waiting on PR #42 · Waiting until
 *  Sun 03:35". */
export function blockedMark(blockers: Blocker[], now = Date.now()): BlockedMark | null {
  if (!blockers.length) return null;
  const tasks = blockers.flatMap((b) => (b.kind === "task" ? [blockerLabel(b)] : []));
  const waits = blockers.flatMap((b) =>
    b.kind === "task" ? [] : [`${waitingOnLabel(b, { now })}${b.state === "failed" ? ` (failed${b.note ? `: ${b.note}` : ""})` : ""}`],
  );
  const phrases = [...(tasks.length ? [`Waiting on ${tasks.join(", ")}`] : []), ...waits];
  return { count: blockers.length, failed: blockers.some((b) => b.kind !== "task" && b.state === "failed"), tip: phrases.join(" · ") };
}
