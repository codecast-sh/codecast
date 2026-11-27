// The one read every rank comes from: a person's active priorities in one
// workspace, most recently active first, whole up to ACTIVE_GROUP_READ. A
// position (positionOf below, the pin line, a list) and a move
// (doMove) both order this same group (shared/contracts/priorities
// effectivePriorityOrder), so neither disagrees with the other however big
// the group is.

import type { Doc, Id } from "../_generated/dataModel";
import { priorityPositions } from "@codecast/shared/contracts/priorities";
import { stepKeyMax } from "./priorityPassSteps";

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
 * Each active priority's position among its owner's active ones in its
 * workspace (shared/contracts/priorities effectivePriorityOrder). `rows` must
 * hold every active priority of each owner and workspace it covers.
 */
export const positionsOf = (rows: Doc<"priorities">[]): Map<string, number> => priorityPositions(rows, (r) => String(r._id));

/**
 * One priority's position in its owner's whole active group, the same for
 * whoever reads it (null when not active): a teammate sees the owner's real
 * rank, counting priorities the teammate cannot see.
 */
export async function positionOf(ctx: { db: any }, p: Doc<"priorities">): Promise<number | null> {
  if (p.status !== "active") return null;
  return positionsOf(await activeGroup(ctx, p.user_id, p.workspace)).get(String(p._id)) ?? null;
}

/** The most sessions any one transaction reads off one priority; the rest is paged by scheduled runs (priorityPassRun SESSION_PAGE). */
export const MARK_SESSIONS_READ = 200;

/**
 * The highest milestone key a priority has spent (prioritiesSchema
 * step_key_max). A priority written before the mark existed has none until
 * the one-time backfill sets it (priorityStepKeyBackfill, from every session):
 * until then a write takes it from its milestones and its newest
 * MARK_SESSIONS_READ sessions' keys.
 */
export async function stepKeyMark(ctx: { db: any }, p: Doc<"priorities">): Promise<number> {
  if (p.step_key_max != null) return p.step_key_max;
  let mark = stepKeyMax(p.steps);
  const newest: Doc<"conversations">[] = await ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", p._id)).order("desc").take(MARK_SESSIONS_READ);
  for (const c of newest) if (c.priority_step_key) mark = stepKeyMax([{ key: c.priority_step_key }], mark);
  return mark;
}
