// The one way to say "this user's Lock Screen picture may have changed".
//
// Kept apart from liveActivity.ts so the write sites that call it (a status
// change in managedSessions, a pinned state in conversations, a kill) import
// nothing heavier than the api reference: the refresh itself pulls in the
// verdict derivation and the whole notifications module.
//
// The refresh is ONE job per user. The row carries the due stamp of the job
// that owns the next fire; a fire whose stamp no longer matches stands down.
// Urgent (a status changed) fires now and supersedes whatever was pending;
// routine (a title moved, a sweep) fires no sooner than the push interval, and
// yields to a pending fire that is already due at or before then.

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { LIVE_ACTIVITY_PUSH_INTERVAL_MS } from "@codecast/shared/contracts";

// Users already given a refresh in this transaction (a heartbeat batch can
// move several of one user's sessions at once).
const requestedIn = new WeakMap<object, Set<string>>();

/**
 * Ask for a refresh from a status write. It reads the phone row and never
 * writes it, so status transactions never conflict with one another over it;
 * the write happens in requestRefresh, which runs only when a refresh would
 * actually be scheduled. Nearly every request found none needed (no phone, or
 * a sooner refresh already pending: 3,922 of 3,922 in an hour, 2026-10-23).
 */
export async function scheduleLiveActivityRefresh(
  ctx: { db: any; scheduler: any },
  userId: Id<"users">,
  opts: { urgent?: boolean; delayMs?: number } = {},
): Promise<void> {
  if (refreshDueAt(await liveActivityRow(ctx, userId), opts, Date.now()) === null) return;
  const requested = requestedIn.get(ctx.db) ?? new Set<string>();
  if (requested.has(String(userId))) return;
  requestedIn.set(ctx.db, requested.add(String(userId)));
  await ctx.scheduler.runAfter(0, internal.liveActivity.requestRefresh, { user_id: userId, ...opts });
}

export async function coalesceLiveActivityRefresh(
  ctx: { db: any; scheduler: any },
  userId: Id<"users">,
  opts: { urgent?: boolean; delayMs?: number } = {},
): Promise<boolean> {
  const row = await liveActivityRow(ctx, userId);
  const now = Date.now();
  const due = refreshDueAt(row, opts, now);
  if (due === null) return false;
  await ctx.db.patch(row._id, { refresh_due_at: due });
  await ctx.scheduler.runAfter(due - now, internal.liveActivity.refresh, { user_id: userId, due });
  return true;
}

function liveActivityRow(ctx: { db: any }, userId: Id<"users">) {
  return ctx.db
    .query("live_activities")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .first();
}

/** When a new refresh should fire, or null when none is needed. */
function refreshDueAt(row: any, opts: { urgent?: boolean; delayMs?: number }, now: number): number | null {
  // No phone has ever registered: nothing to address, and nothing to schedule.
  if (!row) return null;
  if (!row.push_to_start_token && !row.activity_id) return null;
  const due = now + (opts.urgent ? 0 : Math.max(0, opts.delayMs ?? LIVE_ACTIVITY_PUSH_INTERVAL_MS));
  const pending = row.refresh_due_at;
  if (pending !== undefined && pending <= due) return null;
  return due;
}
