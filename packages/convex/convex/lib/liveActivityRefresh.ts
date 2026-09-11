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

export async function scheduleLiveActivityRefresh(
  ctx: { db: any; scheduler: any },
  userId: Id<"users">,
  opts: { urgent?: boolean; delayMs?: number } = {},
): Promise<boolean> {
  const row = await ctx.db
    .query("live_activities")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .first();
  // No phone has ever registered: nothing to address, and nothing to schedule.
  if (!row) return false;
  if (!row.push_to_start_token && !row.activity_id) return false;
  const now = Date.now();
  const delay = opts.urgent ? 0 : Math.max(0, opts.delayMs ?? LIVE_ACTIVITY_PUSH_INTERVAL_MS);
  const due = now + delay;
  const pending = row.refresh_due_at;
  if (pending !== undefined && pending >= now && pending <= due) return false;
  await ctx.db.patch(row._id, { refresh_due_at: due });
  await ctx.scheduler.runAfter(delay, internal.liveActivity.refresh, { user_id: userId, due });
  return true;
}
