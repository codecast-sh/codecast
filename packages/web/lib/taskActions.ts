// Task write orchestration shared by every human surface (detail page,
// quick-add, palette, kanban, plan panels). These compose store actions with
// the shared guards so callers get local-first behavior plus the same
// refusals the server enforces — never a draft the echo will undo.
import { useInboxStore, type TaskItem } from "../store/inboxStore";
import { MAX_TASK_DEPTH, taskDepth, wouldCreateTaskCycle } from "@codecast/shared/tasks";

/** Direct children of a task that are still open, from the live store. */
export function openSubtasksOf(taskId: string): TaskItem[] {
  const tasks = useInboxStore.getState().tasks;
  return (Object.values(tasks) as TaskItem[]).filter(
    (t: any) =>
      t.parent_id &&
      String(t.parent_id) === String(taskId) &&
      t.status !== "done" &&
      t.status !== "dropped" &&
      t.triage_status !== "suggested" &&
      t.triage_status !== "dismissed",
  );
}

/**
 * The close gateway (never auto-close): call this instead of updateTask for
 * any human-driven move to done/dropped. Closes immediately when the parent
 * has no open subtasks; otherwise returns them so the caller can show the
 * shared three-way dialog and re-call with a resolution.
 */
export function closeTaskWithGuard(
  shortId: string,
  status: "done" | "dropped",
  resolution?: "cascade" | "only_parent",
): { needsConfirm: false } | { needsConfirm: true; openSubtasks: TaskItem[] } {
  const s = useInboxStore.getState();
  const task = (Object.values(s.tasks) as TaskItem[]).find((t) => t.short_id === shortId);
  if (task && !resolution) {
    const open = openSubtasksOf(task._id);
    if (open.length > 0) return { needsConfirm: true, openSubtasks: open };
  }
  s.updateTask(shortId, { status, subtask_resolution: resolution });
  return { needsConfirm: false };
}

/**
 * Re-parent with the shared guards run client-side first (pure mirrors of
 * resolveParentTask), so an invalid move is refused before any draft write
 * instead of silently reverting on the echo. Pass "" to detach.
 */
export function setTaskParent(shortId: string, parentShortId: string): { ok: true } | { ok: false; reason: string } {
  const s = useInboxStore.getState();
  const all = Object.values(s.tasks) as any[];
  const task = all.find((t) => t.short_id === shortId);
  if (!task) return { ok: false, reason: "Task not found" };
  if (!parentShortId) {
    s.updateTask(shortId, { parent: "" });
    return { ok: true };
  }
  const parent = all.find((t) => t.short_id === parentShortId || t._id === parentShortId);
  if (!parent) return { ok: false, reason: "Parent task not found" };
  if ((parent.team_id ?? null) !== (task.team_id ?? null)) {
    return { ok: false, reason: "Parent and subtask must live in the same workspace" };
  }
  const parentOf = (id: string) => {
    const row = all.find((t) => String(t._id) === String(id));
    return row?.parent_id ? String(row.parent_id) : undefined;
  };
  if (wouldCreateTaskCycle(String(task._id), String(parent._id), parentOf)) {
    return { ok: false, reason: `${parent.short_id} already sits below ${task.short_id}` };
  }
  const childHeight = subtreeHeight(all, String(task._id));
  const newDepth = taskDepth(String(parent._id), parentOf) + 1 + childHeight;
  if (newDepth > MAX_TASK_DEPTH) {
    return { ok: false, reason: `Too deep — subtasks nest at most ${MAX_TASK_DEPTH} levels` };
  }
  s.updateTask(shortId, { parent: parentShortId });
  return { ok: true };
}

function subtreeHeight(all: any[], rootId: string): number {
  let height = 0;
  let frontier = [rootId];
  let guard = 0;
  while (frontier.length > 0 && guard++ < 64) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const t of all) if (t.parent_id && String(t.parent_id) === id) next.push(String(t._id));
    }
    if (next.length === 0) break;
    height += 1;
    frontier = next;
  }
  return height;
}

/**
 * Local-first create with real identity handoff: writes the optimistic stub
 * (keyed by a minted client_key), awaits the dispatch ack, then rekeys the
 * stub onto the server row. Returns the server {id, short_id} for follow-ups.
 */
export async function createTaskAndAdopt(
  opts: Parameters<ReturnType<typeof useInboxStore.getState>["createTask"]>[0] extends infer O ? O & Record<string, any> : never,
): Promise<{ id: string; short_id: string } | null> {
  const s = useInboxStore.getState();
  const client_key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const result = await s.createTask({ ...opts, client_key });
  const server = result && result.id && result.short_id ? { id: String(result.id), short_id: String(result.short_id) } : null;
  if (server) useInboxStore.getState().adoptTaskStub(`temp_task_${client_key}`, server);
  return server;
}
