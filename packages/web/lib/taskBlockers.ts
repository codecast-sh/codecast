import { Ban, Check, Hourglass, type LucideIcon } from "lucide-react";
import {
  blockersHoldingBack,
  blockerWaitingLabel,
  isFailedWait,
  isReady,
  isTerminalTaskStatus,
  parentStatusLookup,
  waitTone,
  type Blocker,
  type GraphRefStatus,
  type GraphTask,
  type StatusOf,
  type WaitState,
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
  _id?: unknown;
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

/** The store's LIVE copy of a row, by `_id`. A list row is the snapshot its
 *  collection handed back when membership or `updated_at` last moved, and a
 *  graph draft (store/taskGraphDraft) leaves `updated_at` to the server's
 *  echo, so the row a board renders can be a round-trip behind its own graph
 *  fields. A row the store does not hold under its own `_id` (a plan's server
 *  snapshot, an optimistic stub) answers for itself. */
export function liveTaskRow(task: BoardTask, tasks: TaskRows): BoardTask {
  return (task._id === undefined ? undefined : (tasks?.[String(task._id)] as BoardTask | undefined)) ?? task;
}

/** What a row's mark depends on: the row's own graph fields (`ownGraphSig`,
 *  read from the store's live copy, since a graph write moves nothing the
 *  collection's default signature watches) and the store's answer for each
 *  task blocker, with its title, which the tooltip names. Cheap enough to
 *  select on every store change. Empty for a closed task, which nothing
 *  holds, as `storeBlockedMark` draws nothing for one. */
export function blockerStatusSig(task: BoardTask, tasks: TaskRows): string {
  const t = liveTaskRow(task, tasks);
  if (isTerminalTaskStatus(t.status)) return "";
  return `${ownGraphSig(t)}|${refsSig(t, t.blocked_by ?? [], tasks, true)}`;
}

/** A row's OWN inputs to `isReady`. A graph draft write (store/taskGraphDraft)
 *  deliberately leaves `updated_at` to the server's echo, so these fields move
 *  without the collection's default wake signature moving: a board that
 *  projected only its blockers' statuses would paint an added blocker or wait
 *  no sooner than the echo. */
function ownGraphSig(t: BoardTask): string {
  const waits = (t.waits ?? []).map((w) => `${w.id}:${w.state}`).join(",");
  return [
    t.status ?? "",
    (t.blocked_by ?? []).join(","),
    waits,
    t.parent_id ? String(t.parent_id) : "",
    t.superseded_by ?? "",
    t.triage_status ?? "",
    t.ephemeral ? "1" : "",
  ].join("|");
}

/** What `isReadyInStore` reads, for a whole board: each row's own graph fields
 *  and the store's answer for the blocker and parent refs they name. A board
 *  selects it, so a write to a task none of them names reruns nothing.
 *
 *  Every field is read from the store's LIVE copy of the row, by `_id`, not
 *  from `rows`: the board's array is the snapshot `useWorkspaceCollection`
 *  handed back when membership or `updated_at` last moved, and a graph write
 *  moves neither. A row the store does not hold under its own `_id` (a
 *  server-snapshot row from a plan, an optimistic stub) answers for itself. */
export function readySig(rows: readonly BoardTask[], tasks: TaskRows): string {
  let sig = "";
  for (const row of rows) {
    const t = liveTaskRow(row, tasks);
    sig += ownGraphSig(t);
    if (t.status === "open" && (t.blocked_by?.length || t.parent_id)) {
      sig += refsSig(t, [...(t.blocked_by ?? []), ...(t.parent_id ? [String(t.parent_id)] : [])], tasks);
    }
    sig += ";";
  }
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

/** A wait that can no longer clear, wherever one is drawn: a "no entry" sign,
 * never the warning triangle, which marks urgent priority on the same rows. */
const FailedWaitIcon = Ban;

const WAIT_ICON: Record<WaitState, LucideIcon> = { waiting: Hourglass, met: Check, failed: FailedWaitIcon };

/** `tone` is the `waitTone` the style came from, so a caller that also dims
 *  the whole line reads the one decision instead of re-deriving it. */
export type WaitStyle = { icon: LucideIcon; tone: WaitTone; token: string; text: string };

/** Each wait state's glyph in its own colour (`WAIT_TONE_STYLE`). Where it
 *  sits on a task, read `waitStateStyle`. */
export const WAIT_STATE_STYLE = Object.fromEntries(
  Object.entries(WAIT_ICON).map(([state, icon]) => [state, { icon, tone: state as WaitState, ...WAIT_TONE_STYLE[state as WaitState] }]),
) as Record<WaitState, WaitStyle>;

/** A wait's glyph on a task in `status`, in its `waitTone`: its state's
 *  colour while it holds something, dim past that. */
export function waitStateStyle(state: WaitState, status: string | null | undefined, opts?: { untilClosed?: boolean }): WaitStyle {
  const tone = waitTone(state, status, opts);
  return { icon: WAIT_ICON[state], tone, ...WAIT_TONE_STYLE[tone] };
}

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

/** A ref's title from the same answer as its status, so a ref the lookup
 *  refuses (another workspace, a snapshot without the row) is nameless and a
 *  line never mixes a real title with "status unknown". The web's row mark
 *  and the phone's task graph both name blockers through this. */
export function storeTitleOf(statusOf: StatusOf): (ref: string) => string | undefined {
  return (ref) => (statusOf(ref) as { title?: string } | null | undefined)?.title;
}

/** `task`'s blocked mark read from the store, its task blockers titled, built
 *  from the same live row `blockerStatusSig` watched so the glyph and the
 *  signature can never disagree. A closed task is held by nothing. */
export function storeBlockedMark(task: BoardTask, tasks: TaskRows, now = Date.now()): BlockedMark | null {
  const t = liveTaskRow(task, tasks);
  if (isTerminalTaskStatus(t.status)) return null;
  const statusOf = storeStatusOf(tasks, t);
  return blockedMark(blockersHoldingBack(t, statusOf), { now, titleOf: storeTitleOf(statusOf) });
}
