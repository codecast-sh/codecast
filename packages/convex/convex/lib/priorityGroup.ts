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
 * workspace (shared/contracts/priorities effectivePriorityOrder), numbered
 * over `rows`: every active one of each owner and workspace it covers for the
 * real order, or the ones a teammate can read for theirs (priorityRead listFor).
 */
export const positionsOf = (rows: Doc<"priorities">[]): Map<string, number> => priorityPositions(rows, (r) => String(r._id));

/** Who a rank is read for: the viewer, and which of a teammate's priorities they can read (lib/priorityAccess Reader; `narrow` starts the judgment on fewer sessions). */
export type RankReader = { viewer: Id<"users"> | string; canRead: (p: Doc<"priorities">, narrow?: boolean) => Promise<boolean> };

/** How a rank reads an owner's active group: activeGroup, or a memo of it (groupMemo). */
export type GroupRead = (ctx: { db: any }, userId: Id<"users">, workspace: string) => Promise<Doc<"priorities">[]>;

/** activeGroup read once per owner and workspace for as long as the memo lives. */
export function groupMemo(): GroupRead {
  const seen = new Map<string, Promise<Doc<"priorities">[]>>();
  return (ctx, userId, workspace) => {
    const k = `${userId} ${workspace}`;
    if (!seen.has(k)) seen.set(k, activeGroup(ctx, userId, workspace));
    return seen.get(k)!;
  };
}

/** A teammate's group in the owner's order, numbered over what the reader can read as far as a call has walked it: null for one they cannot read. */
type Walk = { order: Doc<"priorities">[]; next: number; numbered: number; at: Map<string, number | null>; busy: Promise<unknown> };

/** What one call's ranks share: each owner's group read once, and each teammate's group walked once however many of its priorities the call ranks. */
export type RankMemo = { readGroup: GroupRead; walks: Map<string, Walk> };
export const rankMemo = (): RankMemo => ({ readGroup: groupMemo(), walks: new Map() });

/**
 * One priority's position as the reader sees it (null when not active), on
 * the page, the pin line and a session's priority pill. The owner reads their
 * real order. A teammate reads that order over the ones they can read,
 * numbered 1..n, so one hidden from them (one that needs a rewrite, one whose
 * sessions are not listed to them) leaves no gap. The walk judges the group
 * top down and stops at `p`, numbered or found unreadable, so those ranked
 * below it go unread, and each judgment starts narrow (Reader.canRead).
 *
 * A list numbers a teammate over the rows it judged instead (priorityRead
 * listFor), which reads nothing more: this number exceeds the list's only
 * when the list's teammate cap cut readable rows of that teammate.
 */
export async function positionOf(ctx: { db: any }, r: RankReader, p: Doc<"priorities">, memo: RankMemo = rankMemo()): Promise<number | null> {
  if (p.status !== "active") return null;
  const id = String(p._id);
  const group = await memo.readGroup(ctx, p.user_id, p.workspace);
  if (String(p.user_id) === String(r.viewer)) return positionsOf(group).get(id) ?? null;
  const k = `${p.user_id} ${p.workspace}`;
  let w = memo.walks.get(k);
  if (!w) memo.walks.set(k, (w = { order: effectivePriorityOrder(group), next: 0, numbered: 0, at: new Map(), busy: Promise.resolve() }));
  const walk = w;
  // One walk at a time per group: two pills awaiting the same walk would otherwise number out of order.
  const done = walk.busy.then(async () => {
    while (!walk.at.has(id) && walk.next < walk.order.length) {
      const q = walk.order[walk.next++];
      walk.at.set(String(q._id), (await r.canRead(q, true)) ? ++walk.numbered : null);
    }
    return walk.at.get(id) ?? null;
  });
  walk.busy = done;
  return done;
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
