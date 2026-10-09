// The one writer of a task's field history (docs/architecture/task-graph.md
// TG11). Status, priority, title, assignee, parent, labels and the graph's
// fields (blocked_by, waits, found_during, superseded_by, related) all land
// here, so the timeline reads one row shape whatever wrote the change.

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { storeList } from "@codecast/shared/tasks";

/** Who made a change: a person, an agent (a role's session) or the system,
 *  and the session it came from. */
export type TaskChangeBy = {
  user_id?: Id<"users">;
  actor_type: "user" | "agent" | "system";
  conversation_id?: Id<"conversations">;
};

/** A person's own edit, when no session made it (the web, a test). */
export const byUser = (userId: Id<"users">): TaskChangeBy => ({ user_id: userId, actor_type: "user" });

/** A change codecast made on its own: a wait settling, an edge cut. */
export const bySystem: TaskChangeBy = { actor_type: "system" };

/** One field change: [field, old, new]. */
export type TaskFieldChange = readonly [field: string, oldValue: unknown, newValue: unknown];

/** How a value is stored: a list by storeList, nothing as "". */
function stored(value: unknown): string {
  if (Array.isArray(value)) return storeList(value);
  return value == null ? "" : String(value);
}

/** What a task write sets, for the fields both `tasks.update` and
 *  `tasks.webUpdate` can write. A key present means the write sets that
 *  field; `assignee`, `parent` and `found_during` are wrapped, so clearing one
 *  is still a write of it. */
export type TrackedWrite = {
  status?: string;
  priority?: string;
  title?: string;
  assignee?: { to?: string };
  parent?: { to?: Id<"tasks"> };
  found_during?: { to?: string };
  review_verdict?: string;
  labels?: string[];
};

/**
 * The history rows a task write records for the fields both CLI and web
 * updates share (TG11). One builder, because two hand-kept lists of what to
 * feed `recordTaskChange` drift: each caller appends only the field it alone
 * writes (`blocked_by` for the CLI's update, `execution_status` for the
 * web's). A row whose value did not move is dropped by `recordTaskChange`,
 * so a caller passes what it wrote, not what changed.
 */
export function trackedFieldChanges(
  task: {
    status?: string;
    priority?: string;
    title?: string;
    assignee?: string;
    parent_id?: Id<"tasks">;
    found_during?: string;
    review_verdict?: { verdict: string };
    labels?: string[];
  },
  next: TrackedWrite,
): TaskFieldChange[] {
  const changes: TaskFieldChange[] = [];
  if (next.status) changes.push(["status", task.status, next.status]);
  if (next.priority) changes.push(["priority", task.priority, next.priority]);
  if (next.title) changes.push(["title", task.title, next.title]);
  if (next.assignee) changes.push(["assignee", task.assignee || "", next.assignee.to || ""]);
  if (next.parent) changes.push(["parent", task.parent_id ?? "", next.parent.to ?? ""]);
  if (next.found_during) changes.push(["found_during", task.found_during, next.found_during.to]);
  if (next.review_verdict) changes.push(["review_verdict", task.review_verdict?.verdict ?? "", next.review_verdict]);
  if (next.labels) changes.push(["labels", task.labels, next.labels]);
  return changes;
}

/** One `task_history` row per change that really moved; a change whose old
 *  and new values store the same is skipped. */
export async function recordTaskChange(
  ctx: Pick<MutationCtx, "db">,
  taskId: Id<"tasks">,
  by: TaskChangeBy,
  changes: readonly TaskFieldChange[],
  at = Date.now(),
): Promise<void> {
  for (const [field, oldValue, newValue] of changes) {
    const [old_value, new_value] = [stored(oldValue), stored(newValue)];
    if (old_value === new_value) continue;
    await ctx.db.insert("task_history", {
      task_id: taskId,
      ...(by.user_id ? { user_id: by.user_id } : {}),
      actor_type: by.actor_type,
      action: "updated",
      field,
      old_value,
      new_value,
      ...(by.conversation_id ? { conversation_id: by.conversation_id } : {}),
      created_at: at,
    });
  }
}
