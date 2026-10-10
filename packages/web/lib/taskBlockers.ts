import {
  blockersHoldingBack,
  blockerWaitingLabel,
  isFailedWait,
  isReady,
  isTerminalTaskStatus,
  parentStatusLookup,
  type Blocker,
  type GraphRefStatus,
  type GraphTask,
  type StatusOf,
  type WaitTone,
} from "@codecast/shared/tasks";
import { truncateEntityLabel } from "@codecast/shared/entities";
import { lookup } from "./liveEntities";
import { workspaceKeyOfRow } from "./workspaceScope";

// The task graph (docs/architecture/task-graph.md TG1) read from the store.
// The store does not hold every task a blocker or parent names (the bootstrap
// keeps the newest rows, the crawl skips dropped ones), so a ref it lacks is
// answered from the row's server snapshot, and one the snapshot never looked
// up stays unknown and blocks. Absence is never read as "finished". A live
// row in another workspace is not an answer either: the server never reads
// across workspaces (graphOutside), so such a ref stays unknown here too.

type TaskRows = Record<string, any> | null | undefined;

/** A list row's view of its refs (tasks.ts enrichTasks, lib/taskGraph
 *  stampGraphStatus), and the detail's refs that name no task. */
export type BoardTask = GraphTask & {
  workspace?: string | null;
  team_id?: string | null;
  graph_status?: readonly GraphRefStatus[] | null;
  graph_missing?: readonly string[] | null;
};

/** A `StatusOf` for `task`'s refs: the store's live row (by `_id` or short
 *  id) in `task`'s workspace, else the row's snapshot (`null`: names no
 *  task), else unknown. */
export function storeStatusOf(tasks: TaskRows, task?: BoardTask): StatusOf {
  const home = task && workspaceKeyOfRow(task);
  return (ref) => {
    const live = lookup(tasks, ref);
    if (live && (!task || workspaceKeyOfRow(live) === home)) return live;
    const snap = task?.graph_status?.find((g) => g.ref === ref);
    if (snap) return snap.status === null ? null : { short_id: snap.short_id, status: snap.status };
    return task?.graph_missing?.includes(ref) ? null : undefined;
  };
}

/** The store's answer for each ref, as one string ("open,done,-,?"), each
 *  live row's title after its status ("open|Fix it") when `titled`. */
function refsSig(task: BoardTask, refs: readonly string[], tasks: TaskRows, titled = false): string {
  const statusOf = storeStatusOf(tasks, task);
  return refs
    .map((ref) => {
      const found = statusOf(ref);
      if (found === null) return "-";
      if (found === undefined) return "?";
      const title = titled ? (found as { title?: string }).title : undefined;
      return title ? `${found.status ?? ""}|${title}` : found.status ?? "";
    })
    .join(",");
}

/** What a row's mark depends on beyond the row itself: the store's answer for
 *  each task blocker, and its title, which the tooltip names. Cheap enough to
 *  select on every store change. Empty for a closed task, which nothing holds. */
export function blockerStatusSig(task: BoardTask, tasks: TaskRows): string {
  if (!task.blocked_by?.length || isTerminalTaskStatus(task.status)) return "";
  return refsSig(task, task.blocked_by, tasks, true);
}

/** What `isReadyInStore` reads beyond the rows themselves, for a whole
 *  board: the store's answer for each open row's blocker and parent refs. A
 *  board selects it, so a write to a task none of them names reruns nothing. */
const readySigCache = new WeakMap<object, WeakMap<object, string>>();
const emptyTaskRows = {};

export function readySig(rows: readonly BoardTask[], tasks: TaskRows): string {
  let byTasks = readySigCache.get(rows);
  const cacheKey = tasks ?? emptyTaskRows;
  const cached = byTasks?.get(cacheKey);
  if (cached !== undefined) return cached;
  let sig = "";
  for (const t of rows) {
    if (t.status !== "open" || (!t.blocked_by?.length && !t.parent_id)) continue;
    sig += `${refsSig(t, [...(t.blocked_by ?? []), ...(t.parent_id ? [String(t.parent_id)] : [])], tasks)};`;
  }
  if (!byTasks) { byTasks = new WeakMap(); readySigCache.set(rows, byTasks); }
  byTasks.set(cacheKey, sig);
  return sig;
}

/** How each wait tone (`waitTone`) draws on every web surface (the row mark,
 *  the task page's lines, the timeline, the plan graph): its sol token for
 *  SVG and its text class. */
export const WAIT_TONE_STYLE: Record<WaitTone, { token: string; text: string }> = {
  waiting: { token: "--sol-orange", text: "text-sol-orange" },
  met: { token: "--sol-green", text: "text-sol-green" },
  failed: { token: "--sol-red", text: "text-sol-red" },
  dim: { token: "--sol-text-dim", text: "text-sol-text-dim" },
};

/** The tasks board's `status` value for the Unblocked view (TG12). */
export const UNBLOCKED_VIEW = "unblocked";

/** What the web calls "unblocked" and the CLI "ready" (TG1): open, active,
 *  not superseded, its parent not being worked, and nothing holding it. */
export function isReadyInStore(task: BoardTask, tasks: TaskRows, viewer: string | null): boolean {
  const statusOf = storeStatusOf(tasks, task);
  return isReady(task, { statusOf, parentStatusOf: parentStatusLookup(statusOf), viewer });
}

export type BlockedMark = { count: number; failed: boolean; tip: string };

/** The row's blocked mark: how many things hold it, whether a wait failed (it
 *  needs re-planning, not patience), and the tooltip naming each one in the
 *  timeline's words, a task blocker with its title when `titleOf` knows it:
 *  "Waiting on ct-12 Fix the auth race · Waiting on PR #42 · Waiting until
 *  Sun 03:35". */
export function blockedMark(blockers: Blocker[], opts: { now?: number; titleOf?: (ref: string) => string | undefined } = {}): BlockedMark | null {
  if (!blockers.length) return null;
  const { now = Date.now(), titleOf } = opts;
  const phrases = blockers.map((b) => {
    const title = b.kind === "task" ? titleOf?.(b.ref) : undefined;
    const phrase = blockerWaitingLabel(b, { now });
    return title ? `${phrase} ${truncateEntityLabel(title)}` : phrase;
  });
  return { count: blockers.length, failed: blockers.some(isFailedWait), tip: phrases.join(" · ") };
}

/** `task`'s blocked mark read from the store, its task blockers titled. */
export function storeBlockedMark(task: BoardTask, tasks: TaskRows, now = Date.now()): BlockedMark | null {
  const statusOf = storeStatusOf(tasks, task);
  const titleOf = (ref: string) => {
    const row = statusOf(ref);
    return row && typeof row === "object" ? (row as { title?: string }).title : undefined;
  };
  return blockedMark(blockersHoldingBack(task, statusOf), { now, titleOf });
}
