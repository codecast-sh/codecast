// The one writer of a task's field history (docs/architecture/task-graph.md
// TG11). Status, priority, title, assignee, parent, labels and the graph's
// fields (blocked_by, waits, found_during, superseded_by, related) all land
// here, so the timeline reads one row shape whatever wrote the change.

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Who made a change: a person, an agent (a role's session) or the system,
 *  and the session it came from. */
export type TaskChangeBy = {
  user_id?: Id<"users">;
  actor_type: "user" | "agent" | "system";
  conversation_id?: Id<"conversations">;
};

/** A person's own edit, when no session made it (the web, a test). */
export const byUser = (userId: Id<"users">): TaskChangeBy => ({ user_id: userId, actor_type: "user" });

/** One field change: [field, old, new]. */
export type TaskFieldChange = readonly [field: string, oldValue: unknown, newValue: unknown];

/** How a value is stored: a list joined by ", ", nothing as "". */
function stored(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  return value == null ? "" : String(value);
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
