// The task page's relations (docs/architecture/task-graph.md TG12): what the
// Blocked by row lists, what the add-blocker and related palettes offer, and
// what a pick writes. Read from the store; written through the store actions
// addBlocker/addWait/relateTasks, whose side effects make the real write.
import {
  dependencyLoopChecker,
  isCleared,
  isTerminalTaskStatus,
  newWaitId,
  parseBlockerRef,
  sameWaitTarget,
  taskBlockerEntries,
  UNKNOWN_BLOCKER_STATUS,
  waitClause,
  type BlockerRef,
  type GraphTask,
  type StatusOf,
  type TaskWait,
  type WaitTarget,
} from "@codecast/shared/tasks";
import { localTimeZone } from "@codecast/shared/time";
import { useInboxStore, type TaskItem } from "../store/inboxStore";
import { counted, undoAsOne } from "../store/undo/labels";
import { storeStatusOf, type BoardTask } from "./taskBlockers";
import { filterByWorkspace, workspaceKeyOfRow } from "./workspaceScope";

// ---------------------------------------------------------------------------
// The Blocked by row
// ---------------------------------------------------------------------------

/**
 * One line of the Blocked by row. A task blocker is `open` while it holds the
 * task, `met` once it closed, `missing` when its id was looked up and names no
 * task, `unknown` when nothing the client holds answers for it (the row asks
 * the server). `raws` are the forms `blocked_by` stores it under, all of which
 * removal names. A wait carries its own state; a met one stays listed until removed.
 */
export type BlockerLine =
  | { key: string; kind: "task"; ref: string; raws: string[]; state: "open" | "met" | "missing" | "unknown"; status?: string }
  | { key: string; kind: "wait"; wait: TaskWait };

/** Every blocker of `task`, task blockers in `blocked_by` order then waits:
 *  the shared entries readiness filters, so this row and readiness agree. */
export function blockerLines(task: GraphTask, statusOf: StatusOf): BlockerLine[] {
  const lines: BlockerLine[] = taskBlockerEntries(task, statusOf).map(({ blocker: b, raws }) => {
    const state = "missing" in b ? "missing" : isCleared(b) ? "met" : b.status === UNKNOWN_BLOCKER_STATUS ? "unknown" : "open";
    const status = "status" in b && b.status !== UNKNOWN_BLOCKER_STATUS ? b.status : undefined;
    return { key: `task:${b.ref}`, kind: "task", ref: b.ref, raws, state, ...(status ? { status } : {}) };
  });
  for (const w of task.waits ?? []) lines.push({ key: `wait:${w.id}`, kind: "wait", wait: w });
  return lines;
}

/** The store's tasks that were found while working on `task` (TG5), in its workspace. */
export function foundHereOf(task: Pick<TaskItem, "short_id" | "workspace" | "team_id">, tasks: Record<string, TaskItem>): TaskItem[] {
  return sameWorkspace(tasks, task)
    .filter((t) => t.found_during === task.short_id)
    .sort((a, b) => a.created_at - b.created_at);
}

/** The store's tasks in `task`'s own workspace: what its relations may name. */
function sameWorkspace(tasks: Record<string, TaskItem>, task: Pick<TaskItem, "workspace" | "team_id">): TaskItem[] {
  return filterByWorkspace(Object.values(tasks), workspaceKeyOfRow(task));
}

/** Whether `task` already waits on `target`: the server would return that
 *  wait and write nothing, so a second one is never painted. A bare `#42`
 *  matches only another unresolved `#42`: which repository it names is the
 *  server's to say (addWaitCore compares the resolved targets). */
function alreadyWaits(task: Pick<TaskItem, "waits">, target: WaitTarget): boolean {
  const bare = (t: WaitTarget) => "repository" in t && !t.repository;
  return (task.waits ?? []).some((w) => w.state === "waiting" && bare(w) === bare(target) && sameWaitTarget(w, target));
}

// ---------------------------------------------------------------------------
// The palette (modes "blocker" and "related")
// ---------------------------------------------------------------------------

export type RelationMode = "blocker" | "related";

/** A palette row: a task to link, or (blocker) a wait parsed from the query. */
export type RelationItem = {
  key: string;
  label: string;
  hint?: string;
  pick: { kind: "task"; ref: string } | { kind: "wait"; target: WaitTarget };
};

/** The task links a mode edits on `t`. */
const linksOf = (t: TaskItem, mode: RelationMode): string[] => (mode === "blocker" ? t.blocked_by : t.related) ?? [];

/** The server finds a bare `#42` through the task's project (TG3). */
const hasProject = (t: TaskItem) => !!(t.project_path || (t as { project_id?: string }).project_id);

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The forms the add-blocker field reads (TG3), shown under it. A bare `#42`
 *  only when every target has a project to find it in; the date a few days
 *  ahead in the viewer's zone, so a copied example is never already past. */
export function blockerForms(targets: TaskItem[], now = Date.now()): string[] {
  const d = new Date(now + 3 * 86_400_000);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} 09:00`;
  const pr = targets.length > 0 && targets.every(hasProject) ? "#42" : "owner/repo#42";
  return ["ct-12", pr, `${pr}:checks`, "sd-4", "2h", date];
}

/** A parsed non-task ref as the target a wait stores. A bare `#42` keeps an
 *  empty repository, which the server resolves from the task's project. */
function targetOf(ref: Extract<BlockerRef, { ok: true }>): WaitTarget | null {
  switch (ref.kind) {
    case "task": return null;
    case "pr_merged":
    case "pr_checks_green": return { kind: ref.kind, repository: ref.repository ?? "", pr_number: ref.pr_number };
    case "decision": return { kind: ref.kind, decision: ref.decision };
    case "time": return { kind: ref.kind, at: ref.at };
  }
}

/** The query read as a ref: what to offer first, or why it reads as none.
 *  An error is only an error once no task title matches either. */
export function parseRelationQuery(search: string, mode: RelationMode, now = Date.now(), timeZone = localTimeZone()):
  { pick: RelationItem["pick"] } | { error: string } | null {
  const text = search.trim();
  if (!text) return null;
  const ref = parseBlockerRef(text, { now, timeZone });
  if (!ref.ok) return { error: ref.error };
  if (ref.kind === "task") return { pick: { kind: "task", ref: ref.ref } };
  if (mode === "related") return { error: `A related link is to a task (ct-12), not ${text}` };
  return { pick: { kind: "wait", target: targetOf(ref)! } };
}

/**
 * Why a target cannot wait on a ref, over the edges the server counts: the
 * target's workspace, done and dropped tasks left out (TG4). One index per
 * workspace, built on first use, so marking every candidate reads the
 * collection once.
 */
function loopChecker(tasks: Record<string, TaskItem>): (task: TaskItem, ref: string) => string | null {
  const byWorkspace = new Map<string | null, (task: string, blocker: string) => string | null>();
  return (task, ref) => {
    const key = workspaceKeyOfRow(task);
    let check = byWorkspace.get(key);
    if (!check) byWorkspace.set(key, (check = dependencyLoopChecker(sameWorkspace(tasks, task).filter((t) => !isTerminalTaskStatus(t.status)))));
    return check(task.short_id, ref);
  };
}

/** The palette rows for `targets`: the parsed ref first, then open tasks of
 *  the same workspace matching the query, without what is already linked. */
export function relationItems(
  mode: RelationMode,
  search: string,
  targets: TaskItem[],
  tasks: Record<string, TaskItem>,
  now = Date.now(),
  timeZone = localTimeZone(),
): RelationItem[] {
  const target = targets[0];
  if (!target) return [];
  const linked = new Set(targets.flatMap((t) => [t.short_id, ...linksOf(t, mode)]));
  const rows = sameWorkspace(tasks, target);
  const byShort = new Map(rows.map((t) => [t.short_id, t]));
  const loops = loopChecker(tasks);
  const q = search.trim().toLowerCase();
  const out: RelationItem[] = [];
  const parsed = parseRelationQuery(search, mode, now, timeZone);
  if (parsed && "pick" in parsed) {
    if (parsed.pick.kind === "wait") {
      const on = waitClause(parsed.pick.target, { now, timeZone, fullRef: "repository" in parsed.pick.target && !!parsed.pick.target.repository });
      const waiting = targets.every((t) => alreadyWaits(t, (parsed.pick as { target: WaitTarget }).target));
      out.push({ key: `wait:${search.trim()}`, label: `Wait ${on}`, ...(waiting ? { hint: "already waiting" } : {}), pick: parsed.pick });
    } else {
      // A pasted ref that is already linked is still listed, saying why a pick would change nothing.
      const ref = parsed.pick.ref;
      const self = targets.some((t) => t.short_id === ref);
      const already = targets.every((t) => linksOf(t, mode).includes(ref));
      const item = taskItem(mode, ref, byShort.get(ref)?.title, targets, loops);
      const hint = self ? "this task" : already ? (mode === "blocker" ? "already a blocker" : "already linked") : item.hint;
      out.push({ ...item, ...(hint ? { hint } : {}) });
    }
  }
  const loose = rows
    .filter((t) =>
      !linked.has(t.short_id) &&
      !out.some((i) => i.pick.kind === "task" && i.pick.ref === t.short_id) &&
      !isTerminalTaskStatus(t.status) &&
      !String(t._id).startsWith("temp_") &&
      (q === "" || t.title?.toLowerCase().includes(q) || t.short_id.toLowerCase().includes(q)))
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 8);
  for (const t of loose) out.push(taskItem(mode, t.short_id, t.title, targets, loops));
  return out;
}

function taskItem(mode: RelationMode, ref: string, title: string | undefined, targets: TaskItem[], loops: ReturnType<typeof loopChecker>): RelationItem {
  const loop = mode === "blocker" && targets.some((t) => t.short_id !== ref && loops(t, ref));
  return {
    key: `task:${ref}`,
    label: title ? `${ref}  ${title}` : ref,
    ...(loop ? { hint: "would close a loop" } : {}),
    pick: { kind: "task", ref },
  };
}

/**
 * Write a palette pick onto every target that lacks it, as one undo. A task
 * blocker that would close a loop is refused here with the server's own words
 * (dependencyLoopError), so nothing paints that the echo would take back.
 * Returns what to tell the person; `pending` when the server has yet to check
 * the target (a PR it may not see, a bare `#42` it may not place).
 */
export function applyRelationPick(mode: RelationMode, targets: TaskItem[], pick: RelationItem["pick"]): { ok: boolean; message: string; pending?: boolean } {
  const s = useInboxStore.getState();
  const nameOf = (ts: TaskItem[]) => (ts.length === 1 ? ts[0]!.short_id : `${ts.length} tasks`);
  const waits = (ts: TaskItem[]) => (ts.length === 1 ? "waits" : "wait");
  const names = nameOf(targets);
  if (pick.kind === "wait") {
    const on = waitClause(pick.target);
    const fresh = targets.filter((t) => !alreadyWaits(t, pick.target));
    if (!fresh.length) return { ok: false, message: `${names} already ${waits(targets)} ${on}` };
    undoAsOne(`Made ${counted(fresh.length, "task")} wait ${on}`, () => {
      for (const t of fresh) s.addWait(t.short_id, { id: newWaitId(), target: pick.target });
    });
    if (pick.target.kind === "pr_merged" || pick.target.kind === "pr_checks_green") {
      const pr = `${pick.target.repository}#${pick.target.pr_number}`;
      return { ok: true, pending: true, message: `Checking PR ${pr} for ${nameOf(fresh)}…` };
    }
    return { ok: true, message: `${nameOf(fresh)} ${waits(fresh)} ${on}` };
  }
  if (targets.some((t) => t.short_id === pick.ref)) return { ok: false, message: `A task can't ${mode === "blocker" ? "wait on" : "relate to"} itself` };
  const fresh = targets.filter((t) => !linksOf(t, mode).includes(pick.ref));
  if (!fresh.length) {
    return { ok: false, message: mode === "blocker" ? `${names} already ${waits(targets)} on ${pick.ref}` : `${names} already linked to ${pick.ref}` };
  }
  if (mode === "related") {
    undoAsOne(`Linked ${counted(fresh.length, "task")} to ${pick.ref}`, () => {
      for (const t of fresh) s.relateTasks(t.short_id, pick.ref);
    });
    return { ok: true, message: `Linked ${nameOf(fresh)} and ${pick.ref}` };
  }
  const loops = loopChecker(s.tasks as Record<string, TaskItem>);
  for (const t of fresh) {
    const loop = loops(t, pick.ref);
    if (loop) return { ok: false, message: loop };
  }
  undoAsOne(`Made ${counted(fresh.length, "task")} wait on ${pick.ref}`, () => {
    for (const t of fresh) s.addBlocker(t.short_id, pick.ref);
  });
  return { ok: true, message: `${nameOf(fresh)} ${waits(fresh)} on ${pick.ref}` };
}

/** The Blocked by row's lines for a task, read from the store. */
export function storeBlockerLines(task: BoardTask, tasks: Record<string, any>): BlockerLine[] {
  return blockerLines(task, storeStatusOf(tasks, task));
}
