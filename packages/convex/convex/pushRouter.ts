// Presence-aware mobile push routing.
//
// Every mobile push used to fire the moment its notification row was written —
// so a user sitting at their desktop got the same push on their phone, and an
// account-wide event (logged out, usage limit) across 20 live sessions meant 20
// phone buzzes in a row. This module fixes both with one mechanism: pushes go
// through an OUTBOX with a per-user flush instead of straight to Expo.
//
// Routing policy (the phone is the "away" channel):
// - Desktop ACTIVE (fresh heartbeat + recent input): hold the push. If the
//   notification is still unread after the hold window — the user never opened
//   the bell — send it to the phone after all. Reading it cancels the push.
// - Desktop away/idle/asleep (heartbeat stale or input old): send after a short
//   debounce. The debounce is what lets a burst collapse: every row pending for
//   the user ships as ONE aggregated push ("12 sessions need attention"), not N.
//
// Desktop surfaces are untouched by this file: the in-app bell badge always
// bumps (it reads the notifications table), and the native desktop banner is
// already gated client-side on window focus (notifyNative in web/lib/desktop.ts).
// Suppressing the phone while the desktop is active is what removes the overlap.

import { mutation, internalMutation } from "./functions";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";

// Client heartbeats every ~30s while visible; background browser tabs get
// throttled to ~1/min, so "fresh" tolerates two missed beats. Sleeping the
// machine stops the heartbeat entirely — presence goes stale on its own.
export const PRESENCE_FRESH_MS = 150_000;
// "Active" additionally requires input (keys/pointer, or low system idle on
// Electron) this recently. A focused-but-abandoned window is NOT active.
export const INPUT_ACTIVE_MS = 3 * 60_000;
// How long a push is held while the desktop is active before escalating to
// the phone anyway ("I never opened the notifs").
export const HOLD_WHILE_ACTIVE_MS = 3 * 60_000;
// Away-path debounce: long enough to let a storm of same-cause notifications
// pile up, short enough that a lone push still feels immediate.
export const AWAY_DEBOUNCE_MS = 20_000;
// A flush ships everything due within this lookahead, so a burst spread over a
// few seconds rides the first flush instead of trickling out one per wakeup.
export const BATCH_SLACK_MS = 25_000;

export type PresenceRow = {
  last_seen: number;
  last_input_at: number;
};

// Pure policy: is a human actively using a desktop surface right now?
export function isDesktopActivePresence(
  presence: PresenceRow | null | undefined,
  now: number,
): boolean {
  if (!presence) return false;
  return (
    now - presence.last_seen < PRESENCE_FRESH_MS &&
    now - presence.last_input_at < INPUT_ACTIVE_MS
  );
}

async function isDesktopActive(ctx: any, userId: any, now: number): Promise<boolean> {
  const presence = await ctx.db
    .query("user_presence")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .first();
  return isDesktopActivePresence(presence, now);
}

// Aggregate body for a multi-row flush, grouped by notification type.
const TYPE_LABELS: Record<string, [string, string]> = {
  session_idle: ["session waiting for input", "sessions waiting for input"],
  permission_request: ["permission request", "permission requests"],
  session_error: ["session error", "session errors"],
  session_assigned: ["session assigned to you", "sessions assigned to you"],
  task_completed: ["task completed", "tasks completed"],
  task_failed: ["task failed", "tasks failed"],
  team_session_start: ["teammate session", "teammate sessions"],
};

export function summarizePushBatch(
  rows: Array<{ type?: string; title: string; body: string; data?: any }>,
): { title: string; body: string; data: any } {
  if (rows.length === 1) {
    const r = rows[0];
    return { title: r.title, body: r.body, data: r.data ?? {} };
  }
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.type && TYPE_LABELS[r.type] ? r.type : "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [key, n] of counts) {
    if (key === "other") continue;
    const [one, many] = TYPE_LABELS[key];
    parts.push(`${n} ${n === 1 ? one : many}`);
  }
  const otherCount = counts.get("other") ?? 0;
  if (otherCount > 0) {
    parts.push(`${otherCount} ${otherCount === 1 ? "update" : "updates"}`);
  }
  return {
    title: `${rows.length} notifications`,
    body: parts.join(" · "),
    // No conversationId on purpose: tapping an aggregate opens the app (and
    // its notification list), not one arbitrary session out of many.
    data: { type: "aggregate", count: rows.length },
  };
}

// Queue a mobile push for a user. Call from the same mutation that inserted the
// notification row; replaces the old direct scheduler.runAfter(0, sendPush…).
// `user` is the already-fetched recipient doc (every call site has it in hand).
export async function enqueuePush(
  ctx: any,
  opts: {
    user: { _id: any; push_token?: string; notifications_enabled?: boolean };
    notification_id?: any;
    type?: string;
    title: string;
    body: string;
    data?: any;
  },
): Promise<void> {
  if (!opts.user.push_token || !opts.user.notifications_enabled) return;
  const now = Date.now();
  const active = await isDesktopActive(ctx, opts.user._id, now);
  const dueAt = now + (active ? HOLD_WHILE_ACTIVE_MS : AWAY_DEBOUNCE_MS);
  await ctx.db.insert("push_outbox", {
    user_id: opts.user._id,
    notification_id: opts.notification_id,
    type: opts.type,
    title: opts.title,
    body: opts.body,
    data: opts.data,
    created_at: now,
    due_at: dueAt,
    // Held-while-active rows have already had their one deferral; away-path
    // rows get at most one more if the user sits down before the debounce.
    deferred: active,
  });
  await ctx.scheduler.runAfter(dueAt - now, internal.pushRouter.flush, {
    user_id: opts.user._id,
  });
}

export const flush = internalMutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("push_outbox")
      .withIndex("by_user", (q: any) => q.eq("user_id", args.user_id))
      .collect();
    const due = rows.filter((r: any) => r.due_at <= now + BATCH_SLACK_MS);
    if (due.length === 0) return;

    const user = await ctx.db.get(args.user_id);
    const canPush = !!user?.push_token && !!user.notifications_enabled;
    const active = canPush && (await isDesktopActive(ctx, args.user_id, now));

    const sendable: any[] = [];
    for (const row of due) {
      if (!canPush) {
        await ctx.db.delete(row._id);
        continue;
      }
      // The backing notification was read (bell opened marks all read) or
      // superseded (session-state rows replace per conversation): the user
      // already has — or no longer needs — this. Drop the push.
      if (row.notification_id) {
        const n = await ctx.db.get(row.notification_id);
        if (!n || n.read) {
          await ctx.db.delete(row._id);
          continue;
        }
      }
      // User came back to the desktop while this sat in the away debounce:
      // convert it to one held escalation instead of buzzing the phone.
      if (!row.deferred && active) {
        await ctx.db.patch(row._id, {
          deferred: true,
          due_at: now + HOLD_WHILE_ACTIVE_MS,
        });
        await ctx.scheduler.runAfter(HOLD_WHILE_ACTIVE_MS, internal.pushRouter.flush, {
          user_id: args.user_id,
        });
        continue;
      }
      sendable.push(row);
    }
    if (sendable.length === 0) return;

    const { title, body, data } = summarizePushBatch(sendable);
    for (const row of sendable) await ctx.db.delete(row._id);
    await ctx.scheduler.runAfter(0, internal.notifications.sendPushNotification, {
      push_token: user!.push_token!,
      title,
      body,
      data,
    });
  },
});

// Desktop/web clients report "a human is here" every ~30s while visible.
// idle_ms is a duration (time since last input on that machine), so client
// clock skew can't poison the signal. Multiple desktops collapse into one row
// via max(): any active machine makes the user active.
export const reportPresence = mutation({
  args: {
    focused: v.boolean(),
    idle_ms: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return;
    const now = Date.now();
    const lastInputAt = now - Math.max(0, Math.min(args.idle_ms, 7 * 24 * 3600_000));
    const existing = await ctx.db
      .query("user_presence")
      .withIndex("by_user", (q: any) => q.eq("user_id", userId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        last_seen: now,
        last_input_at: Math.max(existing.last_input_at, lastInputAt),
        focused: args.focused,
        updated_at: now,
      });
    } else {
      await ctx.db.insert("user_presence", {
        user_id: userId,
        surface: "desktop",
        last_seen: now,
        last_input_at: lastInputAt,
        focused: args.focused,
        updated_at: now,
      });
    }
  },
});
