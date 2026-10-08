import {
  blockerLabel,
  blockersOf,
  isBlocking,
  isReady,
  parentStatusLookup,
  type Blocker,
  type GraphTask,
  type StatusOf,
} from "@codecast/shared/tasks";
import { lookup } from "./liveEntities";

// The task graph (docs/architecture/task-graph.md TG1) read from the store.
// The store holds every task the viewer can read, done ones included, so a
// blocker or parent it does not hold is treated as looked up and gone: it
// does not block. That is the web's one departure from the server, which
// fetches what its page left out.

type TaskRows = Record<string, any> | null | undefined;

/** A `StatusOf` over the store's tasks, by `_id` or short id. */
export function storeStatusOf(tasks: TaskRows): StatusOf {
  return (ref) => lookup(tasks, ref) ?? null;
}

/** The blockers holding `task` back, task blockers first, then waits. */
export function openBlockers(task: GraphTask, tasks: TaskRows): Blocker[] {
  return blockersOf(task, storeStatusOf(tasks)).filter(isBlocking);
}

/** The tasks board's `status` value for the Unblocked view (TG12). */
export const UNBLOCKED_VIEW = "unblocked";

/** What the web calls "unblocked" and the CLI "ready" (TG1): open, active,
 *  not superseded, its parent not being worked, and nothing holding it. */
export function isUnblockedInStore(task: GraphTask, tasks: TaskRows, viewer: string | null): boolean {
  const statusOf = storeStatusOf(tasks);
  return isReady(task, { statusOf, parentStatusOf: parentStatusLookup(statusOf), viewer });
}

export type BlockedMark = { count: number; failed: boolean; tip: string };

/** The row's blocked mark: how many things hold it, whether a wait failed (it
 *  needs re-planning, not patience), and the tooltip naming each one. */
export function blockedMark(blockers: Blocker[], now = Date.now()): BlockedMark | null {
  if (!blockers.length) return null;
  const failed = blockers.some((b) => b.kind !== "task" && b.state === "failed");
  const labels = blockers.map((b) => blockerLabel(b, { now }));
  return { count: blockers.length, failed, tip: `Blocked by ${labels.join(", ")}` };
}
