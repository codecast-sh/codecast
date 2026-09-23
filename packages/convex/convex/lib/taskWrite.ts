// The one way to move a task's synced fields (docs/architecture/issue-sync.md S5).
//
// A task backed by a Linear or GitHub issue pushes the fields a write actually
// moved. Every status, assignee, title, labels, priority or description write
// on a task row goes through `patchTask`, which patches and then schedules the
// push, so a new write site cannot forget the provider the way the cascade
// close, the parent roll-up and the batch mutations once did (a task closed by
// `--cascade` stayed open on Linear). `lib/__tests__/taskWrite.guard.test.ts`
// holds the door: a raw `ctx.db.patch` of a synced field on a task fails it.
//
// The inbound path (issueSync.applyRemote) patches tasks directly and never
// schedules a push: that asymmetry is what keeps provider and codecast from
// echoing at each other (S4.1). This module is for OUR writes only.

import { internal } from "../_generated/api";

export const SYNCED_EXTERNAL_FIELDS = ["title", "description", "status", "priority", "assignee", "labels", "parent_id"] as const;

/** Which synced fields this patch really changes; empty means nothing to push. */
export function changedExternalFields(task: any, updates: Record<string, any>): string[] {
  const changed: string[] = [];
  for (const field of SYNCED_EXTERNAL_FIELDS) {
    if (!(field in updates)) continue;
    if (field === "labels") {
      const before = [...new Set<string>(task.labels ?? [])].sort().join("\u0000");
      const after = [...new Set<string>(updates.labels ?? [])].sort().join("\u0000");
      if (before !== after) changed.push(field);
      continue;
    }
    if ((updates[field] ?? "") !== (task[field] ?? "")) changed.push(field);
  }
  return changed;
}

export async function schedulePushTask(ctx: any, task: any, updates: Record<string, any>): Promise<void> {
  if (!task?.external) return;
  const fields = changedExternalFields(task, updates);
  if (fields.length === 0) return;
  await ctx.scheduler.runAfter(0, internal.issueSync.pushTask, { task_id: task._id, fields });
}

/**
 * Patch a task row and push whatever synced field the patch moved. `task` is
 * the row as read BEFORE the write: the diff against it is what decides the
 * push, so a write that changes nothing the provider shows costs no call.
 */
export async function patchTask(ctx: any, task: any, updates: Record<string, any>): Promise<void> {
  await ctx.db.patch(task._id, updates);
  await schedulePushTask(ctx, task, updates);
}
