// The one read every rank comes from: a person's active priorities in one
// workspace, most recently active first, whole up to ACTIVE_GROUP_READ. A
// position (priorities.ts positionOf, the pin line, a list), a move (doMove)
// and the rank backfill all order this same group (shared/contracts/priorities
// effectivePriorityOrder), so none of them disagrees with another however big
// the group is.

import type { Doc, Id } from "../_generated/dataModel";
import { stepKeyMax } from "./priorityPass";

/** The most of one person's active priorities in one workspace a rank reads; past it the oldest are left out, the same way for every read. */
export const ACTIVE_GROUP_READ = 1_000;

export function activeGroup(ctx: { db: any }, userId: Id<"users">, workspace: string): Promise<Doc<"priorities">[]> {
  return ctx.db
    .query("priorities")
    .withIndex("by_user_workspace_status_active", (q: any) => q.eq("user_id", userId).eq("workspace", workspace).eq("status", "active"))
    .order("desc")
    .take(ACTIVE_GROUP_READ);
}

/**
 * The highest milestone key a priority has spent (prioritiesSchema
 * step_key_max). A priority written before the mark existed has none: it is
 * worked out once from its milestones and every session still on one, so a
 * key a removed milestone's sessions hold is never handed out again.
 */
export async function stepKeyMark(ctx: { db: any }, p: Doc<"priorities">): Promise<number> {
  if (p.step_key_max != null) return p.step_key_max;
  let mark = stepKeyMax(p.steps);
  for await (const c of ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", p._id)) as AsyncIterable<Doc<"conversations">>) {
    if (c.priority_step_key) mark = stepKeyMax([{ key: c.priority_step_key }], mark);
  }
  return mark;
}
