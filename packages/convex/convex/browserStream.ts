// Relay for watching a session's browser tab on another machine.
//
// The watch stream's normal transport is a loopback WebSocket to the daemon
// (packages/cli/src/browser/watchServer.ts): only a viewer on the agent's own
// machine reaches it. This is the second transport, the terminal relay's lease
// protocol (terminalStream.ts) carrying browser frames. The contract and its
// numbers are in packages/shared/contracts/browserStream.ts.
//
// OWNERSHIP is the terminal relay's rule (resolveQueueUser): your own devices,
// and an agent box running a session you own. Never a teammate's machine.
//
// COST. One row per watched (device, session), single writer. Nothing is
// written unless a viewer holds a lease, and then at most two frames a second
// plus a heartbeat.

import { v } from "convex/values";
import { query, mutation, internalMutation } from "./functions";
import { requireUserOrToken } from "./lib/auth";
import { resolveQueueUser } from "./terminalStream";
import {
  BROWSER_RELAY_COMMAND_DEBOUNCE_MS,
  BROWSER_RELAY_INTERACTIVE_TTL_MS,
  BROWSER_RELAY_LEASE_MS,
  BROWSER_RELAY_MAX_FRAME_CHARS,
  BROWSER_RELAY_MAX_PENDING_INPUT,
  BROWSER_RELAY_STREAMER_STALE_MS,
  isValidBrowserStreamKey,
  type StreamBrowserArgs,
} from "@codecast/shared/contracts";

async function findRow(ctx: any, userId: any, device_id: string, key: string) {
  return await ctx.db
    .query("browser_frames")
    .withIndex("by_user_device_key", (q: any) =>
      q.eq("user_id", userId).eq("device_id", device_id).eq("key", key),
    )
    .first();
}

function parseJsonArray(raw: string | undefined): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Take or renew a viewer's lease, queueing the stream command when nothing is
 * streaming. Called on a timer while the viewer is looking.
 */
export const watchBrowser = mutation({
  args: {
    device_id: v.string(),
    key: v.string(),
    session_uuid: v.optional(v.string()),
    tmux_session: v.optional(v.string()),
    /** The viewer is driving: the daemon should collect input promptly. */
    interactive: v.optional(v.boolean()),
    conversation_id: v.optional(v.id("conversations")),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const viewerId = await requireUserOrToken(ctx, args.api_token);
    if (!isValidBrowserStreamKey(args.key)) throw new Error("Invalid session key");
    if (args.session_uuid !== undefined && !isValidBrowserStreamKey(args.session_uuid)) throw new Error("Invalid session");
    if (args.tmux_session !== undefined && !isValidBrowserStreamKey(args.tmux_session)) throw new Error("Invalid session");

    const userId = await resolveQueueUser(ctx, viewerId, args);
    if (!userId) return { ok: false as const, reason: "unknown-device" as const };

    const now = Date.now();
    const row = await findRow(ctx, userId, args.device_id, args.key);
    const watch_until = now + BROWSER_RELAY_LEASE_MS;
    const streamerCold = !row || now - (row.streamer_seen_at ?? 0) > BROWSER_RELAY_STREAMER_STALE_MS;
    const commandCold = !row || now - (row.requested_at ?? 0) > BROWSER_RELAY_COMMAND_DEBOUNCE_MS;
    const dispatch = streamerCold && commandCold;

    if (dispatch) {
      const cmd: StreamBrowserArgs = {
        key: args.key,
        ...(args.session_uuid ? { session_uuid: args.session_uuid } : {}),
        ...(args.tmux_session ? { tmux_session: args.tmux_session } : {}),
      };
      await ctx.db.insert("daemon_commands", {
        user_id: userId,
        command: "stream_browser" as const,
        args: JSON.stringify(cmd),
        created_at: now,
        target_device_id: args.device_id,
      });
    }

    // Only pushed forward, so two viewers cannot switch each other's fast
    // poll off.
    const interactive_until = args.interactive
      ? Math.max(row?.interactive_until ?? 0, now + BROWSER_RELAY_INTERACTIVE_TTL_MS)
      : row?.interactive_until;

    if (row) {
      await ctx.db.patch(row._id, {
        watch_until,
        interactive_until,
        updated_at: now,
        // A new stream starts clean: the previous stream's ending, picture,
        // tab and input must not reach this viewer as if they were current.
        ...(dispatch
          ? {
              requested_at: now,
              end: undefined,
              pending_input: undefined,
              frame: undefined,
              tab_id: undefined,
              tab_title: undefined,
              tab_url: undefined,
              control: undefined,
              actions: undefined,
            }
          : {}),
      });
    } else {
      await ctx.db.insert("browser_frames", {
        user_id: userId,
        device_id: args.device_id,
        key: args.key,
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

/** The current picture, as the viewer subscribes to it. */
export const getBrowser = query({
  args: {
    device_id: v.string(),
    key: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const viewerId = await requireUserOrToken(ctx, args.api_token);
    const userId = await resolveQueueUser(ctx, viewerId, args);
    if (!userId) return null;
    const row = await findRow(ctx, userId, args.device_id, args.key);
    if (!row) return null;
    return {
      frame: row.frame ?? null,
      frame_w: row.frame_w ?? 0,
      frame_h: row.frame_h ?? 0,
      seq: row.seq,
      tab: row.tab_id ? { id: row.tab_id, title: row.tab_title ?? "", url: row.tab_url ?? "" } : null,
      control: row.control === true,
      actions: parseJsonArray(row.actions),
      end: row.end ? (JSON.parse(row.end) as { kind: "error" | "exit"; code: string; message?: string }) : null,
      streamer_seen_at: row.streamer_seen_at ?? null,
      requested_at: row.requested_at ?? null,
    };
  },
});

/**
 * Daemon push. Every field is optional: absent means unchanged, and a push
 * with none is a heartbeat. The reply carries the lease and any input the
 * viewer queued, cleared in the same transaction.
 */
export const cliPushBrowserFrame = mutation({
  args: {
    api_token: v.string(),
    device_id: v.string(),
    key: v.string(),
    frame: v.optional(v.string()),
    frame_w: v.optional(v.number()),
    frame_h: v.optional(v.number()),
    tab: v.optional(v.object({ id: v.string(), title: v.string(), url: v.string() })),
    control: v.optional(v.boolean()),
    /** The daemon's recent actions for the tab, JSON array, newest last. */
    actions: v.optional(v.string()),
    /** BrowserRelayEnd as JSON: the stream is over. */
    end: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    if (!isValidBrowserStreamKey(args.key)) throw new Error("Invalid session key");
    const now = Date.now();
    const row = await findRow(ctx, userId, args.device_id, args.key);
    if (!row) return { stop: true, fast: false };

    const patch: Record<string, unknown> = { streamer_seen_at: now, updated_at: now };
    if (args.frame !== undefined && args.frame.length <= BROWSER_RELAY_MAX_FRAME_CHARS) {
      patch.frame = args.frame;
      patch.frame_w = args.frame_w;
      patch.frame_h = args.frame_h;
      patch.seq = row.seq + 1;
    }
    if (args.tab) {
      patch.tab_id = args.tab.id;
      patch.tab_title = args.tab.title.slice(0, 500);
      patch.tab_url = args.tab.url.slice(0, 4000);
    }
    if (args.control !== undefined) patch.control = args.control;
    if (args.actions !== undefined && args.actions.length <= 8_000) patch.actions = args.actions;
    if (args.end !== undefined) {
      patch.end = args.end.slice(0, 2_000);
      // The streamer is gone: the next renewal (a retry, a resume) must queue
      // a new command at once rather than wait out the stale window.
      patch.streamer_seen_at = undefined;
      patch.requested_at = undefined;
    }
    const input = parseJsonArray(row.pending_input);
    if (input.length) patch.pending_input = undefined;
    await ctx.db.patch(row._id, patch);

    return {
      stop: row.watch_until < now,
      input: input.length ? input : undefined,
      fast: input.length > 0 || now < (row.interactive_until ?? 0),
    };
  },
});

/**
 * Viewer input (control mode), toward the agent's tab. Queued here, delivered
 * on the daemon's next push. Refused when nothing is collecting it.
 */
export const sendBrowserInput = mutation({
  args: {
    device_id: v.string(),
    key: v.string(),
    events: v.array(v.any()),
    conversation_id: v.optional(v.id("conversations")),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const viewerId = await requireUserOrToken(ctx, args.api_token);
    if (args.events.length === 0 || args.events.length > 64) throw new Error("Invalid input batch");
    const userId = await resolveQueueUser(ctx, viewerId, args);
    if (!userId) return { ok: false as const, reason: "not-watching" as const };
    const row = await findRow(ctx, userId, args.device_id, args.key);
    if (!row) return { ok: false as const, reason: "not-watching" as const };
    const now = Date.now();
    if (now - (row.streamer_seen_at ?? 0) > BROWSER_RELAY_STREAMER_STALE_MS) {
      return { ok: false as const, reason: "no-streamer" as const };
    }
    const pending = [...parseJsonArray(row.pending_input), ...args.events];
    if (pending.length > BROWSER_RELAY_MAX_PENDING_INPUT) {
      return { ok: false as const, reason: "backlog" as const };
    }
    await ctx.db.patch(row._id, {
      pending_input: JSON.stringify(pending),
      watch_until: Math.max(row.watch_until, now + BROWSER_RELAY_LEASE_MS),
      updated_at: now,
    });
    return { ok: true as const };
  },
});

/** Drop rows nobody has watched for a day (crons.ts); a stored frame is a
 *  picture of someone's page and has no use once the lease is gone. */
export const pruneStaleFrames = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rows = await ctx.db.query("browser_frames").take(500);
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
