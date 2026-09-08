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
import {
  INPUT_ACTIVE_MS,
  PRESENCE_FRESH_MS,
  isDesktopActivePresence,
  isMachineActivePresence,
  type MachineDevice,
  type PresenceRow,
} from "./presencePolicy";
import { workspaceGrantsAccess, workspaceKey } from "./lib/access";

// Client heartbeats every ~30s while visible; background browser tabs get
// throttled to ~1/min, so "fresh" tolerates two missed beats. Sleeping the
// machine stops the heartbeat entirely — presence goes stale on its own.
export { PRESENCE_FRESH_MS } from "./presencePolicy";
// "Active" additionally requires input (keys/pointer, or low system idle on
// Electron) this recently. A focused-but-abandoned window is NOT active.
export { INPUT_ACTIVE_MS } from "./presencePolicy";
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

export { isDesktopActivePresence, isMachineActivePresence } from "./presencePolicy";
export type { MachineDevice, PresenceRow } from "./presencePolicy";

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
  daemon_overloaded: ["overloaded daemon", "overloaded daemons"],
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

// ── Catch-up ring (ct-49553) ──
// The outbox deletes a row the moment it ships, so a phone that was asleep or
// out of signal recovered nothing: the only thing it could reconstruct was the
// single notification it was last tapped from. Every routed push is now also
// recorded here with a monotonic per-user `seq` and the `epoch` that counter
// belongs to, and the phone asks notifications.getMissedSince for the rest.

// Why 256: it matches the phone's own cap on remembered notification keys, and
// it is far more than any background window a replay can still usefully cover.
// Past the cap we evict oldest-first — a phone away that long is a cold open,
// and the live stream resumes from current.
export const PUSH_RING_CAPACITY = 256;

// system_config key holding the counter lifetime. One row, global. Unlike
// Orca's in-memory buffer the counter here is durable — it is the ring's own
// head — so the epoch does NOT change per deploy; it changes when the router is
// deliberately RESET (rotatePushEpoch). Rotating on every deploy would make
// every phone replay its whole ring for nothing.
export const PUSH_EPOCH_KEY = "push_router_epoch";

// Reads the current epoch, minting it on first run. A phone's watermark means
// nothing under a different epoch, which is what lets getMissedSince tell "you
// missed nothing" from "your seq came from a counter that no longer exists".
export async function currentPushEpoch(ctx: any): Promise<string> {
  const row = await ctx.db
    .query("system_config")
    .withIndex("by_key", (q: any) => q.eq("key", PUSH_EPOCH_KEY))
    .first();
  if (row?.value) return row.value;
  const epoch = crypto.randomUUID();
  await ctx.db.insert("system_config", {
    key: PUSH_EPOCH_KEY,
    value: epoch,
    updated_at: Date.now(),
  });
  return epoch;
}

/** The id both the live push payload and its replayed copy carry. */
export function pushRingKey(epoch: string, seq: number): string {
  return `${epoch}.${seq}`;
}

export type RoutedPushContent = {
  type?: string;
  title: string;
  subtitle?: string;
  body: string;
  data?: any;
  channel_id?: string;
  interruption_level?: string;
};

// Records one routed push and returns the stamp that rides its payload. The
// ring IS the counter — the next seq is one past the head of what this user
// still holds — so there is no state row to keep in step with it, and no write
// to the user doc (whose every change re-renders the phone's whole tree through
// the auth provider's getCurrentUser subscription). Eviction preserves the
// head, so the counter only ever climbs; rows from a rotated epoch are dropped
// outright, because a mismatched reply must be able to say "here is everything
// I still hold" and rows from a dead counter are not that.
export async function recordRoutedPush(
  ctx: any,
  user: { _id: any },
  push: RoutedPushContent,
): Promise<{ seq: number; epoch: string; key: string }> {
  const epoch = await currentPushEpoch(ctx);
  const all = await ctx.db
    .query("push_ring")
    .withIndex("by_user_seq", (q: any) => q.eq("user_id", user._id))
    .collect();
  const rows: any[] = [];
  for (const row of all) {
    if (row.epoch === epoch) rows.push(row);
    else await ctx.db.delete(row._id);
  }
  const seq = ringHead(rows) + 1;
  const key = pushRingKey(epoch, seq);
  await ctx.db.insert("push_ring", {
    user_id: user._id,
    // Write-time ACCESS key: a routed push is private to its recipient, even
    // when the notification behind it came off a team surface.
    workspace: workspaceKey({ type: "personal", userId: user._id }),
    epoch,
    seq,
    key,
    type: push.type,
    title: push.title,
    subtitle: push.subtitle,
    body: push.body,
    data: push.data,
    channel_id: push.channel_id,
    interruption_level: push.interruption_level,
    created_at: Date.now(),
  });
  if (rows.length >= PUSH_RING_CAPACITY) {
    const ordered = [...rows].sort((a: any, b: any) => a.seq - b.seq);
    for (const row of ordered.slice(0, rows.length - PUSH_RING_CAPACITY + 1)) {
      await ctx.db.delete(row._id);
    }
  }
  return { seq, epoch, key };
}

/** Highest seq the ring still holds; 0 when it holds nothing. */
function ringHead(rows: Array<{ seq: number }>): number {
  return rows.reduce((head, row) => (row.seq > head ? row.seq : head), 0);
}

export type MissedPush = RoutedPushContent & {
  key: string;
  seq: number;
  epoch: string;
  created_at: number;
};

// The cut, pure so both epoch cases are testable without a db. A matching epoch
// returns strictly newer entries — the same watermark always yields the same
// set, so asking twice can never re-deliver. A mismatch returns the whole ring:
// a seq from a dead counter indexes nothing here, and every retained entry
// postdates that counter, so none of them can already have reached this phone.
//
// A watermark PAST the head is the same situation wearing a matching epoch: the
// counter is the ring's head, so a caller claiming a seq this counter never
// issued did not get it here (a ring emptied out from under a live epoch is the
// way that happens). Cutting against it would silently kill catch-up until the
// counter climbed back past it, so it reads as a mismatch too.
export function selectMissedSince(
  rows: MissedPush[],
  args: { seq: number; epoch?: string },
): MissedPush[] {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  if (ordered.length === 0) return ordered;
  const head = ordered[ordered.length - 1];
  if (args.epoch !== undefined && args.epoch !== head.epoch) return ordered;
  if (args.seq > head.seq) return ordered;
  return ordered.filter((row) => row.seq > args.seq);
}

// Wipes the epoch, so every phone's stored watermark names a counter nobody
// has. The lever for a router reset: after it the next getMissedSince replays
// what is retained instead of silently cutting it against a restarted counter.
export const rotatePushEpoch = internalMutation({
  args: {},
  handler: async (ctx) => {
    const epoch = crypto.randomUUID();
    const row = await ctx.db
      .query("system_config")
      .withIndex("by_key", (q: any) => q.eq("key", PUSH_EPOCH_KEY))
      .first();
    if (row) await ctx.db.patch(row._id, { value: epoch, updated_at: Date.now() });
    else await ctx.db.insert("system_config", { key: PUSH_EPOCH_KEY, value: epoch, updated_at: Date.now() });
    return { epoch };
  },
});

// Read side of the ring, called by notifications.getMissedSince (where the
// phone reaches it). Access is the stored workspace key evaluated through the
// one predicate — never team_id, and never "the index is keyed by my user id".
export async function readMissedSince(
  ctx: any,
  userId: any,
  args: { seq: number; epoch?: string },
): Promise<{ epoch: string | null; entries: MissedPush[] }> {
  const rows = await ctx.db
    .query("push_ring")
    .withIndex("by_user_seq", (q: any) => q.eq("user_id", userId))
    .collect();
  const mine: any[] = [];
  for (const row of rows) {
    if (await workspaceGrantsAccess(ctx, userId, row.workspace)) mine.push(row);
  }
  mine.sort((a, b) => a.seq - b.seq);
  const entries = selectMissedSince(mine as MissedPush[], args).map((row) => ({
    key: row.key,
    seq: row.seq,
    epoch: row.epoch,
    type: row.type,
    title: row.title,
    subtitle: row.subtitle,
    body: row.body,
    data: row.data,
    channel_id: row.channel_id,
    interruption_level: row.interruption_level,
    created_at: row.created_at,
  }));
  return { epoch: mine.length > 0 ? mine[mine.length - 1].epoch : null, entries };
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
  const channelId = isChat ? "chat" : undefined;
  const interruptionLevel = addressed ? "time-sensitive" : undefined;
  // Stamp and retain BEFORE the send: the ring is what a phone that misses this
  // push reads back, and the same {seq, epoch, key} rides the payload so a live
  // arrival and its replayed copy are recognisably one notification.
  const stamp = await recordRoutedPush(ctx, user!, {
    type: sendable.length === 1 ? sendable[0].type : "aggregate",
    title,
    subtitle,
    body,
    data,
    channel_id: channelId,
    interruption_level: interruptionLevel,
  });
  await ctx.scheduler.runAfter(0, internal.notifications.sendPushNotification, {
    push_token: user!.push_token!,
    title,
    subtitle,
    body,
    data: {
      ...(data ?? {}),
      notificationSeq: stamp.seq,
      notificationEpoch: stamp.epoch,
      notificationKey: stamp.key,
    },
    channel_id: channelId,
    interruption_level: interruptionLevel,
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
