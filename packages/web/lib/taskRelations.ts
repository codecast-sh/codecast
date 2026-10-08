// The task page's relations (docs/architecture/task-graph.md TG12): what the
// Blocked by row lists, what the add-blocker and related palettes offer, and
// what a pick writes. Read from the store; written through the store actions
// addBlocker/addWait/relateTasks, whose side effects make the real write.
import {
  blockersOf,
  dependencyLoopError,
  isTerminalTaskStatus,
  parseBlockerRef,
  sameWaitTarget,
  UNKNOWN_BLOCKER_STATUS,
  waitLabel,
  type BlockerRef,
  type GraphTask,
  type StatusOf,
  type TaskWait,
  type WaitTarget,
} from "@codecast/shared/tasks";
import { useInboxStore, type TaskItem } from "../store/inboxStore";
import { newWaitId } from "../store/taskGraphDraft";
import { storeStatusOf, type BoardTask } from "./taskBlockers";
import { filterByWorkspace, workspaceKeyOfRow } from "./workspaceScope";

// ---------------------------------------------------------------------------
// The Blocked by row
// ---------------------------------------------------------------------------

/**
 * One line of the Blocked by row. A task blocker is `open` while it holds the
 * task, `met` once it closed, `missing` when its id was looked up and names no
 * task, `unknown` when nothing the client holds answers for it (the row asks
 * the server). `raw` is the id as `blocked_by` stores it, which removal names.
 * A wait carries its own state; a met one stays listed until removed.
 */
export type BlockerLine =
  | { key: string; kind: "task"; ref: string; raw: string; state: "open" | "met" | "missing" | "unknown"; status?: string }
  | { key: string; kind: "wait"; wait: TaskWait };

/** Every blocker of `task`, task blockers in `blocked_by` order then waits:
 *  blockersOf decides which hold it, so this row and readiness agree. */
export function blockerLines(task: GraphTask, statusOf: StatusOf): BlockerLine[] {
  const open = new Map(blockersOf(task, statusOf).flatMap((b) => (b.kind === "task" ? [[b.ref, b] as const] : [])));
  const lines: BlockerLine[] = [];
  const seen = new Set<string>();
  for (const raw of task.blocked_by ?? []) {
    const found = statusOf(raw);
    const info = typeof found === "string" ? { status: found } : found;
    const ref = info?.short_id || raw;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const b = open.get(ref);
    const state = !b ? "met" : "missing" in b ? "missing" : b.status === UNKNOWN_BLOCKER_STATUS ? "unknown" : "open";
    lines.push({ key: `task:${ref}`, kind: "task", ref, raw, state, ...(info?.status ? { status: info.status } : {}) });
  }
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
 *  wait and write nothing, so a second one is never painted. */
function alreadyWaits(task: Pick<TaskItem, "waits">, target: WaitTarget): boolean {
  return (task.waits ?? []).some((w) => w.state === "waiting" && sameWaitTarget(w, target));
}

// ---------------------------------------------------------------------------
// The palette (modes "blocker" and "related")
// ---------------------------------------------------------------------------

export type RelationMode = "blocker" | "related";

/** A palette row: a task to link, or (blocker mode) a wait parsed from the query. */
export type RelationItem = {
  key: string;
  label: string;
  hint?: string;
  pick: { kind: "task"; ref: string } | { kind: "wait"; target: WaitTarget };
};

/** The forms the add-blocker field reads (TG3), shown under it. */
export const BLOCKER_FORMS = ["ct-12", "#42", "owner/repo#42:checks", "sd-4", "2h", "2026-10-14 09:00"];

const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

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
export function parseRelationQuery(search: string, mode: RelationMode, now = Date.now(), timeZone = viewerTimeZone()):
  { pick: RelationItem["pick"] } | { error: string } | null {
  const text = search.trim();
  if (!text) return null;
  const ref = parseBlockerRef(text, { now, timeZone });
  if (!ref.ok) return { error: ref.error };
  if (ref.kind === "task") return { pick: { kind: "task", ref: ref.ref } };
  if (mode === "related") return { error: `A related link is to a task (ct-12), not ${text}` };
  return { pick: { kind: "wait", target: targetOf(ref)! } };
}

/** The palette rows for `targets`: the parsed ref first, then open tasks of
 *  the same workspace matching the query, without what is already linked. */
export function relationItems(
  mode: RelationMode,
  search: string,
  targets: TaskItem[],
  tasks: Record<string, TaskItem>,
  now = Date.now(),
  timeZone = viewerTimeZone(),
): RelationItem[] {
  const target = targets[0];
  if (!target) return [];
  const field = mode === "blocker" ? "blocked_by" : "related";
  const linked = new Set(targets.flatMap((t) => [t.short_id, ...((t as any)[field] ?? [])]));
  const rows = sameWorkspace(tasks, target);
  const byShort = new Map(rows.map((t) => [t.short_id, t]));
  const q = search.trim().toLowerCase();
  const out: RelationItem[] = [];
  const parsed = parseRelationQuery(search, mode, now, timeZone);
  if (parsed && "pick" in parsed) {
    if (parsed.pick.kind === "wait") {
      const label = waitLabel(parsed.pick.target, { now, timeZone, fullRef: "repository" in parsed.pick.target && !!parsed.pick.target.repository });
      const waiting = targets.every((t) => alreadyWaits(t, (parsed.pick as { target: WaitTarget }).target));
      out.push({ key: `wait:${search.trim()}`, label: `Wait until ${label.replace(/^until /, "")}`, ...(waiting ? { hint: "already waiting" } : {}), pick: parsed.pick });
    } else if (!linked.has(parsed.pick.ref)) {
      const row = byShort.get(parsed.pick.ref);
      out.push(taskItem(mode, parsed.pick.ref, row?.title, targets, tasks));
    }
  }
  const loose = rows
    .filter((t) =>
      !linked.has(t.short_id) &&
      !out.some((i) => i.pick.kind === "task" && i.pick.ref === t.short_id) &&
      t.status !== "done" && t.status !== "dropped" &&
      !String(t._id).startsWith("temp_") &&
      (q === "" || t.title?.toLowerCase().includes(q) || t.short_id.toLowerCase().includes(q)))
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 8);
  for (const t of loose) out.push(taskItem(mode, t.short_id, t.title, targets, tasks));
  return out;
}

/** Why `task` cannot wait on `ref`, over the edges the server counts: the
 *  task's workspace, done and dropped tasks left out (TG4). */
function loopError(tasks: Record<string, TaskItem>, task: TaskItem, ref: string): string | null {
  const live = sameWorkspace(tasks, task).filter((t) => !isTerminalTaskStatus(t.status));
  return dependencyLoopError(live, task.short_id, ref);
}

function taskItem(mode: RelationMode, ref: string, title: string | undefined, targets: TaskItem[], tasks: Record<string, TaskItem>): RelationItem {
  const loops = mode === "blocker" && targets.some((t) => loopError(tasks, t, ref));
  return {
    key: `task:${ref}`,
    label: title ? `${ref}  ${title}` : ref,
    ...(loops ? { hint: "would close a loop" } : {}),
    pick: { kind: "task", ref },
  };
}

/**
 * Write a palette pick onto every target. A task blocker that would close a
 * loop is refused here with the server's own words (dependencyLoopError), so
 * nothing paints that the echo would take back. Returns what to tell the person.
 */
export function applyRelationPick(mode: RelationMode, targets: TaskItem[], pick: RelationItem["pick"]): { ok: true; message: string } | { ok: false; message: string } {
  const s = useInboxStore.getState();
  const nameOf = (ts: TaskItem[]) => (ts.length === 1 ? ts[0]!.short_id : `${ts.length} tasks`);
  const names = nameOf(targets);
  if (pick.kind === "wait") {
    const until = waitLabel(pick.target).replace(/^until /, "");
    const fresh = targets.filter((t) => !alreadyWaits(t, pick.target));
    if (!fresh.length) return { ok: false, message: `${names} already ${targets.length === 1 ? "waits" : "wait"} until ${until}` };
    for (const t of fresh) s.addWait(t.short_id, { id: newWaitId(), target: pick.target });
    return { ok: true, message: `${nameOf(fresh)} ${fresh.length === 1 ? "waits" : "wait"} until ${until}` };
  }
  if (targets.some((t) => t.short_id === pick.ref)) return { ok: false, message: `A task can't ${mode === "blocker" ? "wait on" : "relate to"} itself` };
  if (mode === "related") {
    for (const t of targets) s.relateTasks(t.short_id, pick.ref);
    return { ok: true, message: `Linked ${names} and ${pick.ref}` };
  }
  for (const t of targets) {
    const loop = loopError(s.tasks as Record<string, TaskItem>, t, pick.ref);
    if (loop) return { ok: false, message: loop };
  }
  for (const t of targets) s.addBlocker(t.short_id, pick.ref);
  return { ok: true, message: `${names} waits on ${pick.ref}` };
}

/** The Blocked by row's lines for a task, read from the store. */
export function storeBlockerLines(task: BoardTask, tasks: Record<string, any>): BlockerLine[] {
  return blockerLines(task, storeStatusOf(tasks, task));
}
