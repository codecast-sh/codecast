// The one read every rank comes from: a person's active priorities in one
// workspace, most recently active first, whole up to ACTIVE_GROUP_READ. A
// position (priorities.ts positionOf, the pin line, a list), a move (doMove)
// and the rank backfill all order this same group (shared/contracts/priorities
// effectivePriorityOrder), so none of them disagrees with another however big
// the group is.

import type { Doc, Id } from "../_generated/dataModel";

/** The most of one person's active priorities in one workspace a rank reads; past it the oldest are left out, the same way for every read. */
export const ACTIVE_GROUP_READ = 1_000;

export function activeGroup(ctx: { db: any }, userId: Id<"users">, workspace: string): Promise<Doc<"priorities">[]> {
  return ctx.db
    .query("priorities")
    .withIndex("by_user_workspace_status_active", (q: any) => q.eq("user_id", userId).eq("workspace", workspace).eq("status", "active"))
    .order("desc")
    .take(ACTIVE_GROUP_READ);
}
