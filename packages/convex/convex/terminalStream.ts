// Relay for watching a tmux pane that lives on another machine.
//
// The integrated terminal is a loopback PTY: the browser opens a WebSocket to
// 127.0.0.1 and only the machine it runs on ever answers. That is the right
// transport for a terminal you type into, and the wrong one for the common
// case of "the agent runs on my Mac mini and I'm on the laptop" — there is no
// path at all today. This module is the second transport for exactly that case:
// screens instead of bytes, on the rails that already carry daemon traffic.
//
// THE PROTOCOL, END TO END
//   1. The viewer calls watchPane every few seconds. Each call extends a short
//      lease on one row, and queues a `stream_pane` daemon command only when no
//      streamer has been heard from lately.
//   2. The daemon captures the pane, and pushes a frame whenever the screen
//      changes (plus a heartbeat while it doesn't). pushFrame answers with the
//      lease deadline, so the capture loop learns it is unwatched from the very
//      request it was already making.
//   3. The viewer subscribes to getPane and repaints on `seq`.
//   4. Keystrokes go back the other way on that same answer: sendPaneInput
//      appends bytes to the row, and the next push carries them out and clears
//      them in one transaction — so input is exactly-once and free of extra
//      round-trips, and it cannot outlive the lease that authorized it.
//
// Nobody sends a stop. The lease lapsing IS the stop, which is what makes a
// closed tab, a crashed browser and a dropped network behave identically.
//
// COST. One row per watched pane, reused forever, with a single writer — so
// the hot-document contention that rules byte streams out of Convex doesn't
// arise. An unwatched pane costs nothing; an idle watched pane costs one small
// write every few seconds; a pane printing continuously costs a couple of
// small writes a second, and only while a human is looking at it. A FOCUSED
// pane costs a few small writes a second even when quiet, because that is the
// price of a keystroke not waiting on a heartbeat — see PANE_INPUT_POLL_MS.
//
// OWNERSHIP. You may watch panes on YOUR OWN devices, and on an AGENT BOX — a
// machine whose daemon signs in as a bot account on your team — for a session
// you own there (resolveReachableRunnerDevice in devices.ts, the same rule the
// attach pill uses). A teammate's machine is out of scope on purpose: relaying
// it would mean writing commands into a person's daemon queue, which is a
// bigger decision than a terminal view. A bot has no person behind it.

import { v } from "convex/values";
import { query, mutation, internalMutation } from "./functions";
import { requireUserOrToken } from "./lib/auth";
import { resolveReachableRunnerDevice } from "./devices";
import {
  PANE_COMMAND_DEBOUNCE_MS,
  PANE_LEASE_MS,
  PANE_MAX_FRAME_BYTES,
  PANE_INTERACTIVE_TTL_MS,
  PANE_MAX_PENDING_INPUT_BYTES,
  PANE_STREAMER_STALE_MS,
  hexToBytes,
  isValidPaneTarget,
} from "@codecast/shared/contracts";

/**
 * Whose daemon queue and frame rows a pane lives under. Your own device: you.
 * A device the viewer reaches through a conversation — an agent box whose bot
 * daemon runs a session they own (resolveReachableRunnerDevice) — the runner
 * account, because that is the daemon that will answer the stream command and
 * push the frames. Null is the "unknown-device" answer: not yours, not
 * reachable through that conversation, or a conversation/device mismatch.
 */
async function resolveQueueUser(
  ctx: any,
  userId: any,
  args: { device_id: string; conversation_id?: any },
): Promise<any | null> {
  if (args.conversation_id) {
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return null;
    const reach = await resolveReachableRunnerDevice(ctx, userId, conv);
    if (!reach || reach.device.device_id !== args.device_id) return null;
    return reach.runnerUserId;
  }
  const device = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q: any) =>
      q.eq("user_id", userId).eq("device_id", args.device_id),
    )
    .first();
  return device ? userId : null;
}

async function findRow(ctx: any, userId: any, device_id: string, target: string) {
  return await ctx.db
    .query("terminal_frames")
    .withIndex("by_user_device_target", (q: any) =>
      q.eq("user_id", userId).eq("device_id", device_id).eq("target", target),
    )
    .first();
}

/**
 * Take or renew a viewer's lease on a pane, queueing the capture command when
 * nothing is currently streaming.
 *
 * Called on a timer for as long as the split is open, so it is written to be
 * boring: at most one row patch, and a command insert only when the stream is
 * actually cold.
 */
export const watchPane = mutation({
  // Session auth OR an api token, the same pair every other function here
  // resolves. The browser is the normal caller; a token lets the CLI hold a
  // lease too (`cast watch`, and the relay's end-to-end test).
  args: {
    device_id: v.string(),
    target: v.string(),
    /** The viewer has this pane focused, so keystrokes are imminent and the far
     *  loop should poll fast enough that the first one isn't swallowed. */
    interactive: v.optional(v.boolean()),
    /** The conversation this pane belongs to. Lets a session owner watch a
     *  pane on an agent box (a bot account's daemon); without it the relay
     *  is own-device only. */
    conversation_id: v.optional(v.id("conversations")),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const viewerId = await requireUserOrToken(ctx, args.api_token);
    if (!isValidPaneTarget(args.target)) throw new Error("Invalid pane target");

    // Your device, or an agent box reached through a session you own. This is
    // also what makes the command insert safe: it lands in a daemon queue the
    // viewer is entitled to — their own, or the bot's that runs their session.
    const userId = await resolveQueueUser(ctx, viewerId, args);
    if (!userId) return { ok: false as const, reason: "unknown-device" as const };

    const now = Date.now();
    const row = await findRow(ctx, userId, args.device_id, args.target);
    const watch_until = now + PANE_LEASE_MS;

    const streamerCold = !row || now - (row.streamer_seen_at ?? 0) > PANE_STREAMER_STALE_MS;
    const commandCold = !row || now - (row.requested_at ?? 0) > PANE_COMMAND_DEBOUNCE_MS;
    const dispatch = streamerCold && commandCold;

    if (dispatch) {
      await ctx.db.insert("daemon_commands", {
        user_id: userId,
        command: "stream_pane" as const,
        args: JSON.stringify({ target: args.target }),
        created_at: now,
        target_device_id: args.device_id,
      });
    }

    // Only ever pushed forward. A blurred viewer lets it expire rather than
    // clearing it, so two tabs on the same pane can't switch each other's
    // keyboard off.
    const interactive_until = args.interactive
      ? Math.max(row?.interactive_until ?? 0, now + PANE_INTERACTIVE_TTL_MS)
      : row?.interactive_until;

    if (row) {
      await ctx.db.patch(row._id, {
        watch_until,
        interactive_until,
        updated_at: now,
        ...(dispatch ? { requested_at: now } : {}),
      });
    } else {
      await ctx.db.insert("terminal_frames", {
        user_id: userId,
        device_id: args.device_id,
        target: args.target,
        seq: 0,
        watch_until,
        interactive_until,
        updated_at: now,
        ...(dispatch ? { requested_at: now } : {}),
      });
    }

    return { ok: true as const, dispatched: dispatch };
  },
});

/** The current screen, as the viewer subscribes to it. */
export const getPane = query({
  args: {
    device_id: v.string(),
    target: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const viewerId = await requireUserOrToken(ctx, args.api_token);
    const userId = await resolveQueueUser(ctx, viewerId, args);
    if (!userId) return null;
    const row = await findRow(ctx, userId, args.device_id, args.target);
    if (!row) return null;
    return {
      frame: row.frame ?? null,
      cols: row.cols ?? null,
      rows: row.rows ?? null,
      cursor_x: row.cursor_x ?? null,
      cursor_y: row.cursor_y ?? null,
      seq: row.seq,
      error: row.error ?? null,
      streamer_seen_at: row.streamer_seen_at ?? null,
      updated_at: row.updated_at,
    };
  },
});

/**
 * Daemon push. `frame` absent means "nothing changed" — a heartbeat that keeps
 * the viewer's connected indicator honest without rewriting the screen.
 *
 * The reply is how the capture loop learns whether to keep going: it already
 * makes this request, so the lease costs no extra round-trip.
 */
export const cliPushFrame = mutation({
  args: {
    api_token: v.string(),
    device_id: v.string(),
    target: v.string(),
    frame: v.optional(v.string()),
    cols: v.optional(v.number()),
    rows: v.optional(v.number()),
    cursor_x: v.optional(v.number()),
    cursor_y: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    if (!isValidPaneTarget(args.target)) throw new Error("Invalid pane target");

    const now = Date.now();
    const row = await findRow(ctx, userId, args.device_id, args.target);
    // No row means nobody ever asked for this pane — a stale command from a
    // previous boot, say. Telling the daemon to stop is the whole answer.
    if (!row) return { watch_until: 0, stop: true, fast: false };

    const patch: Record<string, unknown> = { streamer_seen_at: now, updated_at: now };
    if (args.frame !== undefined) {
      patch.frame = args.frame.length > PANE_MAX_FRAME_BYTES
        ? args.frame.slice(0, PANE_MAX_FRAME_BYTES)
        : args.frame;
      patch.seq = row.seq + 1;
      patch.cols = args.cols;
      patch.rows = args.rows;
      patch.cursor_x = args.cursor_x;
      patch.cursor_y = args.cursor_y;
      // A good frame clears whatever went wrong before it.
      patch.error = undefined;
    }
    if (args.error !== undefined) {
      patch.error = args.error;
      patch.seq = row.seq + 1;
    }
    // Hand back whatever the viewer typed and clear it in the SAME transaction.
    // That is what makes delivery exactly-once: a push that never reaches the
    // daemon also never cleared the buffer, so the next one carries the same
    // keystrokes rather than losing them.
    const input = row.pending_input ?? "";
    if (input) patch.pending_input = undefined;

    await ctx.db.patch(row._id, patch);

    return {
      watch_until: row.watch_until,
      stop: row.watch_until < now,
      input: input || undefined,
      // "Someone is at the keyboard" — poll fast enough that their next
      // keystroke doesn't wait on a heartbeat. Input in hand says the same
      // thing even if the focus stamp hasn't landed yet.
      fast: !!input || now < (row.interactive_until ?? 0),
    };
  },
});

/**
 * Keystrokes, from the viewer toward the pane.
 *
 * This only queues them. Delivery happens on the capture loop's next push,
 * which is already in flight — so typing adds one small write per burst and no
 * polling at all.
 *
 * Refusing is better than buffering here. Input that piles up because the far
 * machine stopped collecting would eventually arrive as a paragraph typed into
 * an agent's prompt long after the person who wrote it walked away, so a dead
 * streamer and a full buffer both say no and let the UI show it.
 */
export const sendPaneInput = mutation({
  args: {
    device_id: v.string(),
    target: v.string(),
    /** Lowercase hex, exactly as xterm produced the bytes. */
    data: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const viewerId = await requireUserOrToken(ctx, args.api_token);
    if (!isValidPaneTarget(args.target)) throw new Error("Invalid pane target");
    if (hexToBytes(args.data) === null) throw new Error("Invalid input encoding");

    const userId = await resolveQueueUser(ctx, viewerId, args);
    if (!userId) return { ok: false as const, reason: "not-watching" as const };
    const row = await findRow(ctx, userId, args.device_id, args.target);
    if (!row) return { ok: false as const, reason: "not-watching" as const };

    const now = Date.now();
    if (now - (row.streamer_seen_at ?? 0) > PANE_STREAMER_STALE_MS) {
      return { ok: false as const, reason: "no-streamer" as const };
    }

    const pending = (row.pending_input ?? "") + args.data;
    // Hex is two characters a byte.
    if (pending.length > PANE_MAX_PENDING_INPUT_BYTES * 2) {
      return { ok: false as const, reason: "backlog" as const };
    }

    // Typing is also proof someone is watching, so it extends the lease. Without
    // this, a long silent think between keystrokes could let the lease lapse
    // under an active typist.
    await ctx.db.patch(row._id, {
      pending_input: pending,
      watch_until: Math.max(row.watch_until, now + PANE_LEASE_MS),
      updated_at: now,
    });
    return { ok: true as const };
  },
});

/**
 * Drop rows nobody has watched for a day (crons.ts).
 *
 * A row is only meaningful while a lease is live; afterwards it is a screen of
 * dead text pinned per pane, and panes are minted per session. Deleting is
 * safe because watchPane recreates the row on the next look.
 */
export const pruneStaleFrames = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rows = await ctx.db.query("terminal_frames").take(2000);
    let deleted = 0;
    for (const r of rows) {
      if (r.updated_at < cutoff) {
        await ctx.db.delete(r._id);
        deleted++;
      }
    }
    return { deleted };
  },
});
