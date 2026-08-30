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
// Ceiling on the machine-presence hold. Machine presence waits for you to leave
// rather than escalating on a timer, which needs a backstop: HIDIdleTime resets
// on SYNTHETIC input too (mouse jigglers, Screen Sharing, iPhone Mirroring, UI
// automation), so a machine can read "present" for days with nobody there. Once
// the oldest pending push has waited this long the whole batch escalates anyway
// — the hold is a wait, never a black hole.
export const MAX_MACHINE_HOLD_MS = 60 * 60_000;

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

export type MachineDevice = {
  last_seen: number;
  last_input_at?: number;
  is_remote?: boolean;
};

// Pure policy: is a human touching one of this user's own Macs right now —
// anywhere, not just in Codecast? On-by-default widening of the presence
// signal (users.machine_wide_presence, opt-out).
//
// A device only counts when it is (a) not a remote box — nose and the hosted
// agent Macs are servers, never where the user is sitting — (b) still
// heartbeating, and (c) reporting input recently. Devices that report no input
// at all (Linux/headless, or a daemon too old to send it) contribute nothing
// rather than counting as present, so every uncertain case degrades to "away",
// which keeps notifications flowing rather than silently swallowing them.
export function isMachineActivePresence(
  devices: MachineDevice[],
  now: number,
): boolean {
  return devices.some(
    (d) =>
      !d.is_remote &&
      d.last_input_at !== undefined &&
      now - d.last_seen < PRESENCE_FRESH_MS &&
      now - d.last_input_at < INPUT_ACTIVE_MS,
  );
}

// The two presence signals, kept separate because they hold pushes DIFFERENTLY.
// Client presence gets one hold window and then escalates ("you never opened the
// bell"). Machine presence keeps holding for as long as you're at the computer —
// escalating on a 3-minute timer would defeat the whole opt-in, since being
// heads-down in an editor for hours without touching Codecast is exactly the
// case it exists to cover.
//
// `user` is the recipient doc, already in hand at both call sites — passing it
// avoids a second get() just to read the opt-in flag.
async function readPresence(
  ctx: any,
  user: { _id: any; machine_wide_presence?: boolean },
  now: number,
): Promise<{ clientActive: boolean; machineActive: boolean; active: boolean }> {
  const presence = await ctx.db
    .query("user_presence")
    .withIndex("by_user", (q: any) => q.eq("user_id", user._id))
    .first();
  const clientActive = isDesktopActivePresence(presence, now);
  // Is any Codecast surface actually ALIVE to show this? Input may be stale (the
  // human is in their editor) but the app is still running, so its bell badge and
  // native banner still land. The daemon runs under launchd, wholly independent
  // of the app — without this check, an opted-in user with Codecast closed would
  // have every push held while no surface anywhere could display it.
  const clientAlive = !!presence && now - presence.last_seen < PRESENCE_FRESH_MS;
  let machineActive = false;
  // Opted out: client presence is the whole story, and we skip the devices
  // read entirely. On by default — an absent flag means opted in.
  if ((user.machine_wide_presence ?? true) && clientAlive) {
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .collect();
    machineActive = isMachineActivePresence(devices, now);
  }
  return { clientActive, machineActive, active: clientActive || machineActive };
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
  chat_mention: ["chat mention", "chat mentions"],
  chat_reply: ["thread reply", "thread replies"],
  chat_here: ["channel announcement", "channel announcements"],
  chat_dm: ["direct message", "direct messages"],
  chat_added: ["channel invite", "channel invites"],
  chat_post: ["channel message", "channel messages"],
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
    user: {
      _id: any;
      push_token?: string;
      notifications_enabled?: boolean;
      machine_wide_presence?: boolean;
    };
    notification_id?: any;
    type?: string;
    title: string;
    subtitle?: string;
    body: string;
    data?: any;
  },
): Promise<void> {
  if (!opts.user.push_token || !opts.user.notifications_enabled) return;
  const now = Date.now();
  const { active } = await readPresence(ctx, opts.user, now);
  const dueAt = now + (active ? HOLD_WHILE_ACTIVE_MS : AWAY_DEBOUNCE_MS);
  await ctx.db.insert("push_outbox", {
    user_id: opts.user._id,
    notification_id: opts.notification_id,
    type: opts.type,
    title: opts.title,
    subtitle: opts.subtitle,
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

// Exported plain for tests (same pattern as performNeedsInputCheck).
export async function performPushFlush(ctx: any, userId: any): Promise<void> {
  const now = Date.now();
  const rows = await ctx.db
    .query("push_outbox")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .collect();
  const due = rows.filter((r: any) => r.due_at <= now + BATCH_SLACK_MS);
  if (due.length === 0) return;

  const user = await ctx.db.get(userId);
  const canPush = !!user?.push_token && !!user.notifications_enabled;
  const { clientActive, machineActive } = canPush
    ? await readPresence(ctx, user!, now)
    : { clientActive: false, machineActive: false };

  // Machine holds stop once the oldest pending push hits the ceiling — and the
  // whole batch goes together, so walking into the ceiling costs ONE buzz rather
  // than dribbling rows out as each ages past it.
  const capReached =
    machineActive && due.some((r: any) => now - r.created_at >= MAX_MACHINE_HOLD_MS);
  const holdForMachine = machineActive && !capReached;

  const sendable: any[] = [];
  let heldAny = false;
  // Rows no longer in the table (or about to leave it), so the phase-collapse
  // pass below never patches a deleted row.
  const gone = new Set<string>();
  for (const row of due) {
    if (!canPush) {
      await ctx.db.delete(row._id);
      gone.add(row._id);
      continue;
    }
    // The backing notification was read (bell opened marks all read) or
    // superseded (session-state rows replace per conversation): the user
    // already has — or no longer needs — this. Drop the push.
    if (row.notification_id) {
      const n = await ctx.db.get(row.notification_id);
      if (!n || n.read) {
        await ctx.db.delete(row._id);
        gone.add(row._id);
        continue;
      }
    }
    // Hold this round if either: the user is at the computer with machine-wide
    // presence on (keeps re-deferring, so the push waits until they actually
    // walk away instead of escalating on a timer), or the user came back to the
    // desktop while this sat in the away debounce (one escalating hold — the
    // shipped behavior, unchanged for opted-out users).
    if (holdForMachine || (!row.deferred && clientActive)) {
      await ctx.db.patch(row._id, {
        deferred: true,
        due_at: now + HOLD_WHILE_ACTIVE_MS,
      });
      heldAny = true;
      continue;
    }
    sendable.push(row);
  }
  // ONE reschedule per flush, not one per row: a single flush already processes
  // every due row, so per-row scheduling just spawns N-1 no-op mutations — and
  // under a machine hold, which re-defers indefinitely, that becomes a permanent
  // background cost instead of a one-shot.
  if (heldAny) {
    const nextDue = now + HOLD_WHILE_ACTIVE_MS;
    // Collapse every pending row onto ONE deadline. due_at phases otherwise drift
    // apart (rows enqueued minutes apart never land in the same flush window), so
    // walking away would buzz the phone once per phase instead of once total.
    const sendableIds = new Set(sendable.map((r: any) => r._id));
    for (const row of rows) {
      if (gone.has(row._id) || sendableIds.has(row._id)) continue;
      if (row.due_at !== nextDue) await ctx.db.patch(row._id, { due_at: nextDue });
    }
    await ctx.scheduler.runAfter(HOLD_WHILE_ACTIVE_MS, internal.pushRouter.flush, {
      user_id: userId,
    });
  }
  if (sendable.length === 0) return;

  const { title, body, data } = summarizePushBatch(sendable);
  // A single row keeps its subtitle ("#team"); a batch has no one "where".
  const subtitle = sendable.length === 1 ? sendable[0].subtitle : undefined;
  // Chat banners ride their own Android channel and, when addressed to the
  // person (a mention, a DM line, @here), the time-sensitive interruption
  // level — a message TO you should raise a Focus-respecting banner, not sit
  // in the summary tray.
  const CHAT_TYPES = new Set(["chat_mention", "chat_reply", "chat_here", "chat_dm", "chat_added", "chat_post"]);
  const ADDRESSED = new Set(["chat_mention", "chat_dm", "chat_here"]);
  const isChat = sendable.some((r: any) => CHAT_TYPES.has(r.type));
  const addressed = sendable.some((r: any) => ADDRESSED.has(r.type));
  // The icon badge is the bell's own number, so the phone and the app agree.
  const unread = await ctx.db
    .query("notifications")
    .withIndex("by_recipient_read", (q: any) =>
      q.eq("recipient_user_id", userId).eq("read", false))
    .take(100);
  for (const row of sendable) await ctx.db.delete(row._id);
  await ctx.scheduler.runAfter(0, internal.notifications.sendPushNotification, {
    push_token: user!.push_token!,
    title,
    subtitle,
    body,
    data,
    channel_id: isChat ? "chat" : undefined,
    interruption_level: addressed ? "time-sensitive" : undefined,
    badge: Math.min(unread.length, 99),
    user_id: userId,
  });
}

export const flush = internalMutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    await performPushFlush(ctx, args.user_id);
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
