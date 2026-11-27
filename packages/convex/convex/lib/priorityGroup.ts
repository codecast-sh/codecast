// The one read every rank comes from: a person's active priorities in one
// workspace, most recently active first, whole up to ACTIVE_GROUP_READ. A
// position (positionOf below, the pin line, a list) and a move
// (doMove) both order this same group (shared/contracts/priorities
// effectivePriorityOrder), so neither disagrees with the other however big
// the group is.

import type { Doc, Id } from "../_generated/dataModel";
import { effectivePriorityOrder, priorityPositions } from "@codecast/shared/contracts/priorities";
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

/** Who a rank is read for: the viewer, and which of a teammate's priorities they can read (lib/priorityAccess Reader). */
export type RankReader = { viewer: Id<"users"> | string; canRead: (p: Doc<"priorities">) => Promise<boolean> };

/**
 * One owner's active priorities in one workspace, each with its position as
 * the reader sees it. The owner reads their real order. A teammate reads that
 * order over the ones they can read, numbered 1..n, so one hidden from them
 * (one that needs a rewrite, one whose sessions are not listed to them) leaves
 * no gap. A teammate's numbering stops once every id in `wanted` has its
 * number: each priority it judges costs a read, and those ranked below go
 * unread.
 */
export async function positionsFor(ctx: { db: any }, r: RankReader, owner: Id<"users">, workspace: string, wanted: ReadonlySet<string>): Promise<Map<string, number>> {
  const group = await activeGroup(ctx, owner, workspace);
  if (String(owner) === String(r.viewer)) return positionsOf(group);
  const out = new Map<string, number>();
  let left = group.filter((p) => wanted.has(String(p._id))).length;
  for (const p of effectivePriorityOrder(group)) {
    if (!left) break;
    if (!(await r.canRead(p))) continue;
    out.set(String(p._id), out.size + 1);
    if (wanted.has(String(p._id))) left--;
  }
  return out;
}

/** One priority's position as the reader sees it (positionsFor; null when not active): the same in a list, on the page, on the pin line and on a session's priority pill. */
export async function positionOf(ctx: { db: any }, r: RankReader, p: Doc<"priorities">): Promise<number | null> {
  if (p.status !== "active") return null;
  return (await positionsFor(ctx, r, p.user_id, p.workspace, new Set([String(p._id)]))).get(String(p._id)) ?? null;
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
