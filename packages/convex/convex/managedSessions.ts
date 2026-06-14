import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { findConversationBySessionReference } from "./conversationSessionLookup";
import { AGENT_STATUSES } from "@codecast/shared/contracts";

async function getAuthenticatedUserId(
  ctx: { db: any },
  apiToken?: string
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) {
    return sessionUserId;
  }

  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) {
      return result.userId;
    }
  }

  return null;
}

export const registerManagedSession = mutation({
  args: {
    session_id: v.string(),
    pid: v.number(),
    tmux_session: v.optional(v.string()),
    conversation_id: v.optional(v.id("conversations")),
    api_token: v.optional(v.string()),
    // Device claiming this session. When set, we stamp the conversation's
    // owner_device_id (single-owner invariant). If the conversation is already
    // owned by a DIFFERENT device that is still online, we refuse the claim
    // and return { notOwner: true } so the calling daemon backs off.
    device_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    // Single-owner guard: refuse to manage a session owned by another live
    // device. "Live" = that device heartbeated within the online window.
    //
    // Exception — a REMOTE owner never blocks a local registration. A remote box
    // only legitimately owns a session that was explicitly moved to it, and a move
    // kills the local process. So a LOCAL device presenting a live process here has
    // the real checkout and is the rightful owner: it reclaims (this is exactly the
    // self-heal for a session the remote auto-claimed and can't serve, and it also
    // implements "bring back from remote"). Only a live LOCAL peer blocks.
    if (args.device_id && args.conversation_id) {
      const conv = await ctx.db.get(args.conversation_id);
      const owner = (conv as any)?.owner_device_id as string | undefined;
      if (owner && owner !== args.device_id) {
        const ownerDevice = await ctx.db
          .query("devices")
          .withIndex("by_user_device", (q: any) =>
            q.eq("user_id", authUserId).eq("device_id", owner),
          )
          .first();
        const ownerOnline =
          ownerDevice &&
          !ownerDevice.is_remote &&
          Date.now() - ownerDevice.last_seen < 2 * 60 * 1000;
        if (ownerOnline) {
          return { notOwner: true as const, owner } as any;
        }
        // Owner offline, or owner is a remote box → fall through and reclaim (stamp below).
      }
    }

    const existing = await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .first();

    const now = Date.now();

    if (existing) {
      // Reclaim ownership if the existing row belongs to a different user.
      // session_ids are UUIDv4 (effectively unique), but the same session can
      // resurface under a different local user (e.g. after a logout/login),
      // and the daemon making this call has the legitimate live process.
      // Without this, the next heartbeat throws Unauthorized in a loop.
      if (existing.user_id.toString() !== authUserId.toString()) {
        console.warn(
          `[registerManagedSession] reclaiming session ${args.session_id} from ${existing.user_id} -> ${authUserId}`,
        );
        await ctx.db.delete(existing._id);
      } else {
        await ctx.db.patch(existing._id, {
          pid: args.pid,
          last_heartbeat: now,
          ...(args.tmux_session !== undefined ? { tmux_session: args.tmux_session } : {}),
          ...(args.conversation_id !== undefined ? { conversation_id: args.conversation_id } : {}),
        });
        if (args.device_id && args.conversation_id) {
          // Registering a live local process for this conversation disproves any
          // "couldn't start / no local checkout - clone it first" banner stamped
          // before the session came up. Piggyback the clear on the ownership patch
          // we already write (no extra read/write). setSessionError handles the
          // reverse: refusing to WRITE such a banner while the session is live.
          await ctx.db.patch(args.conversation_id, { owner_device_id: args.device_id, session_error: undefined });
        }
        return existing._id;
      }
    }

    // Remove stale sessions for same conversation, but carry forward a known
    // tmux_session if this re-registration didn't supply one. Daemon paths
    // sometimes re-register without a pane handle (e.g. after a transient
    // findTmuxPaneForTty failure); we must not silently erase the live attach
    // target the UI shows.
    let inheritedTmuxSession: string | undefined;
    if (args.conversation_id) {
      const old = await ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id))
        .collect();
      for (const o of old) {
        if (args.tmux_session === undefined && o.tmux_session && !inheritedTmuxSession) {
          inheritedTmuxSession = o.tmux_session;
        }
        await ctx.db.delete(o._id);
      }
    }

    const id = await ctx.db.insert("managed_sessions", {
      session_id: args.session_id,
      user_id: authUserId,
      pid: args.pid,
      tmux_session: args.tmux_session ?? inheritedTmuxSession,
      conversation_id: args.conversation_id,
      started_at: now,
      last_heartbeat: now,
    });

    // Claim ownership: stamp this device as the conversation's owner. Also clear
    // any stale "no local checkout" banner — a fresh local process disproves it
    // (see the matching patch on the re-registration path above).
    if (args.device_id && args.conversation_id) {
      await ctx.db.patch(args.conversation_id, { owner_device_id: args.device_id, session_error: undefined });
    }

    return id;
  },
});

export const updateSessionConversation = mutation({
  args: {
    session_id: v.string(),
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .first();

    if (!session) {
      throw new Error("Managed session not found");
    }

    if (session.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized");
    }

    // Remove old sessions linked to this conversation to prevent duplicates
    const oldSessions = await ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id))
      .collect();

    for (const oldSession of oldSessions) {
      if (oldSession._id !== session._id) {
        await ctx.db.delete(oldSession._id);
      }
    }

    await ctx.db.patch(session._id, {
      conversation_id: args.conversation_id,
    });

    const conversation = await ctx.db.get(args.conversation_id);
    if (conversation && conversation.user_id.toString() === authUserId.toString() && conversation.session_id !== session.session_id) {
      await ctx.db.patch(args.conversation_id, {
        session_id: session.session_id,
      });
    }
  },
});

export const updateManagedSessionId = mutation({
  args: {
    old_session_id: v.string(),
    new_session_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.old_session_id))
      .first();

    if (!session) {
      return { found: false };
    }

    if (session.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(session._id, {
      session_id: args.new_session_id,
    });

    if (session.conversation_id) {
      const conversation = await ctx.db.get(session.conversation_id);
      if (conversation && conversation.user_id.toString() === authUserId.toString() && conversation.session_id !== args.new_session_id) {
        await ctx.db.patch(session.conversation_id, {
          session_id: args.new_session_id,
        });
      }
    }

    return { found: true, updated: true };
  },
});

// Derived from the single source of truth in @codecast/shared/contracts so the
// CLI daemon, the browser store, and this validator can never drift. Accepts
// exactly AGENT_STATUSES — same set as before, just no longer hand-maintained.
const agentStatusValidator = v.union(
  ...AGENT_STATUSES.map((s) => v.literal(s)),
);

// Shared by heartbeat + heartbeatBatch: compute one session's heartbeat patch.
// last_heartbeat always advances. The heartbeat carries the daemon's current
// agent_status so the server self-heals a dropped transition — but only
// overwrites when the incoming client_ts isn't older than the stored change
// time, and only advances agent_status_updated_at on an ACTUAL status change
// (the heartbeat re-sends the current status, so bumping it unconditionally
// would track "last heard" instead of "entered this status", which idle
// detection depends on).
// Refresh last_heartbeat at most this often. Every managed_sessions write
// invalidates listInboxSessions (it .collect()s the whole table), so an
// unconditional last_heartbeat=now on every 30s beat — ×N sessions ×N
// heartbeat sources — was a needless invalidation/OCC firehose. The liveness
// window is 90s everywhere (HEARTBEAT_ALIVE_MS), so throttling the timestamp
// write to 45s keeps the row at most ~60s stale: always live with a full beat
// of margin. A status change always writes through immediately.
const HEARTBEAT_REFRESH_MS = 45 * 1000;

// Returns null when there is nothing worth writing (status unchanged AND the
// heartbeat timestamp is still fresh) so callers can skip the patch entirely.
function buildHeartbeatPatch(
  session: { agent_status?: string; agent_status_updated_at?: number; last_heartbeat?: number },
  agentStatus: string | undefined,
  clientTs: number | undefined,
  now: number,
): Record<string, any> | null {
  const patch: Record<string, any> = {};
  let statusChanged = false;
  if (agentStatus) {
    const tsStale = clientTs && session.agent_status_updated_at && clientTs < session.agent_status_updated_at;
    // Only write agent_status when it actually changes — re-writing the same
    // value is a no-op mutation that still invalidates every reader.
    if (!tsStale && agentStatus !== session.agent_status) {
      patch.agent_status = agentStatus;
      patch.agent_status_updated_at = clientTs || now;
      statusChanged = true;
    }
  }
  const heartbeatStale = !session.last_heartbeat || now - session.last_heartbeat > HEARTBEAT_REFRESH_MS;
  if (statusChanged || heartbeatStale) {
    patch.last_heartbeat = now;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export const heartbeat = mutation({
  args: {
    session_id: v.string(),
    api_token: v.optional(v.string()),
    agent_status: v.optional(agentStatusValidator),
    client_ts: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .first();

    if (!session) {
      return { found: false };
    }

    if (session.user_id.toString() !== authUserId.toString()) {
      // Don't throw — daemon's heartbeat loop swallows the error anyway,
      // but throwing pollutes Convex logs every 30s. Returning found:false
      // tells the daemon to re-register, which will reclaim ownership via
      // the updated registerManagedSession path above.
      console.warn(
        `[heartbeat] cross-user heartbeat ignored: auth=${authUserId} session=${args.session_id} owner=${session.user_id} conv=${session.conversation_id ?? "?"}`,
      );
      return { found: false };
    }

    const now = Date.now();
    const patch = buildHeartbeatPatch(session, args.agent_status, args.client_ts, now);
    if (patch) await ctx.db.patch(session._id, patch);

    let dismissed = false;
    if (session.conversation_id) {
      const conv = await ctx.db.get(session.conversation_id);
      if (conv && conv.inbox_dismissed_at && !conv.is_subagent) {
        dismissed = true;
      }
    }

    return { found: true, dismissed };
  },
});

// Batched liveness heartbeat for many sessions in ONE transaction.
//
// Per-session heartbeats are individually cheap, but each is a separate
// transaction, and EVERY commit that touches a managed_sessions row invalidates
// the queries that .collect() them (listInboxSessions, plans, tasks, …). With a
// large fleet that's ~N invalidations every 30s → the app's most expensive
// query recomputes dozens of times/sec for no visible change. Folding all of a
// daemon's heartbeats into one transaction collapses those N invalidations into
// 1: the inbox recomputes once per flush instead of once per session. The daemon
// caps batch size so a write conflict only retries a bounded slice, not the
// whole fleet. (No dismissed-read here — the daemon ignores the response.)
export const heartbeatBatch = mutation({
  args: {
    api_token: v.optional(v.string()),
    sessions: v.array(v.object({
      session_id: v.string(),
      agent_status: v.optional(agentStatusValidator),
      client_ts: v.optional(v.number()),
    })),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const now = Date.now();
    let updated = 0;
    for (const entry of args.sessions) {
      const session = await ctx.db
        .query("managed_sessions")
        .withIndex("by_session_id", (q: any) => q.eq("session_id", entry.session_id))
        .first();
      // Silently skip unknown / cross-user rows (a stale daemon can carry either);
      // throwing would abort the whole batch and pollute logs every 30s.
      if (!session || session.user_id.toString() !== authUserId.toString()) continue;
      const patch = buildHeartbeatPatch(session, entry.agent_status, entry.client_ts, now);
      if (!patch) continue;
      await ctx.db.patch(session._id, patch);
      updated++;
    }
    return { updated };
  },
});

export const unregisterManagedSession = mutation({
  args: {
    session_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .first();

    if (!session) {
      return { found: false };
    }

    if (session.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized");
    }

    await ctx.db.delete(session._id);
    return { found: true };
  },
});

// Daemon-authed catalog of this user's managed sessions, for the liveness
// reconciler. Returns just the fields needed to re-verify a process is alive
// (session_id, tmux_session, agent_pid) without the per-conversation joins
// listActiveSessions does. Keep this lean — it's polled on a timer.
export const listManagedSessionsForDaemon = query({
  args: {
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const rows = await ctx.db
      .query("managed_sessions")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", authUserId))
      .collect();

    return rows.map((s) => ({
      session_id: s.session_id,
      conversation_id: s.conversation_id,
      tmux_session: s.tmux_session,
      agent_pid: s.agent_pid,
      last_metrics_at: s.last_metrics_at,
    }));
  },
});

export const isSessionManaged = query({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id))
      .first();

    const STALE_THRESHOLD = 60 * 1000;
    const now = Date.now();

    if (!session) {
      return { managed: false };
    }

    const isStale = now - session.last_heartbeat > STALE_THRESHOLD;

    // Check if any child sessions (subagents) are still active
    let has_active_children = false;
    if (isStale) {
      const children = await ctx.db
        .query("conversations")
        .withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", args.conversation_id))
        .collect();
      for (const child of children) {
        const childSession = await ctx.db
          .query("managed_sessions")
          .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", child._id))
          .first();
        if (childSession && now - childSession.last_heartbeat < STALE_THRESHOLD) {
          has_active_children = true;
          break;
        }
      }
    }

    return {
      managed: !isStale || has_active_children,
      has_active_children,
      session_id: session.session_id,
      pid: session.pid,
      last_heartbeat: session.last_heartbeat,
      tmux_session: session.tmux_session,
      agent_status: session.agent_status,
      agent_status_updated_at: session.agent_status_updated_at,
      permission_mode: session.permission_mode,
    };
  },
});

export const getPendingMessagesForSession = query({
  args: {
    session_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .first();

    if (!session || !session.conversation_id) {
      return [];
    }

    if (session.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized");
    }

    const messages = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", session.conversation_id))
      .filter((q: any) => q.eq(q.field("status"), "pending"))
      .collect();

    return messages;
  },
});

export const markMessageDelivered = mutation({
  args: {
    message_id: v.id("pending_messages"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const message = await ctx.db.get(args.message_id);
    if (!message) {
      throw new Error("Message not found");
    }

    await ctx.db.patch(args.message_id, {
      status: "delivered" as const,
      delivered_at: Date.now(),
    });

    const remaining = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", message.conversation_id).eq("status", "pending")
      )
      .first();
    if (!remaining) {
      await ctx.db.patch(message.conversation_id, { has_pending_messages: false });
    }

    return { success: true };
  },
});

export const updateAgentStatus = mutation({
  args: {
    conversation_id: v.id("conversations"),
    agent_status: agentStatusValidator,
    client_ts: v.optional(v.number()),
    api_token: v.optional(v.string()),
    permission_mode: v.optional(v.union(v.literal("default"), v.literal("plan"), v.literal("acceptEdits"), v.literal("bypassPermissions"), v.literal("dontAsk"), v.literal("auto"))),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id))
      .first();

    if (!session) return;
    if (session.user_id.toString() !== authUserId.toString()) return;

    const patch: Record<string, any> = {};

    if (args.permission_mode !== undefined) {
      patch.permission_mode = args.permission_mode;
    }

    const tsStale = args.client_ts && session.agent_status_updated_at && args.client_ts < session.agent_status_updated_at;
    if (!tsStale) {
      patch.agent_status = args.agent_status;
      // Advance the change-time only on an actual change so the field stays a
      // "when did the agent enter this status" signal (idle detection relies on
      // it). Redundant same-status updates — e.g. PreToolUse re-firing "working"
      // each tool call — must not reset it.
      if (args.agent_status !== session.agent_status) {
        patch.agent_status_updated_at = args.client_ts || Date.now();
      }
    }

    // Active status updates prove the daemon is alive — refresh heartbeat too.
    // This prevents stale-heartbeat inference from overriding a valid status update
    // (e.g. after daemon restart before the heartbeat interval kicks in).
    const ACTIVE_STATUSES = new Set(["working", "compacting", "thinking", "connected", "starting", "resuming"]);
    if (ACTIVE_STATUSES.has(args.agent_status)) {
      patch.last_heartbeat = Date.now();
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(session._id, patch);
    }

    // Active processing states prove the message reached the session — ack injected messages
    if (args.agent_status === "working" || args.agent_status === "thinking" || args.agent_status === "compacting" || args.agent_status === "permission_blocked") {
      const injected = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q: any) =>
          q.eq("conversation_id", args.conversation_id).eq("status", "injected")
        )
        .collect();
      const now = Date.now();
      for (const msg of injected) {
        await ctx.db.patch(msg._id, { status: "delivered" as const, delivered_at: now });
      }
      if (injected.length > 0) {
        const remainingPending = await ctx.db
          .query("pending_messages")
          .withIndex("by_conversation_status", (q: any) =>
            q.eq("conversation_id", args.conversation_id).eq("status", "pending")
          )
          .first();
        if (!remainingPending) {
          await ctx.db.patch(args.conversation_id, { has_pending_messages: false });
        }
      }
    }
  },
});

export const reportMetrics = mutation({
  args: {
    session_id: v.string(),
    cpu: v.number(),
    memory: v.number(),
    pid_count: v.number(),
    agent_pid: v.optional(v.number()),
    awake_idle_ms: v.optional(v.number()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .first();

    if (!session) return;
    if (session.user_id.toString() !== authUserId.toString()) return;

    const now = Date.now();
    // The managed_sessions doc is in the read set of listInboxSessions' whole-table
    // collect, so patching it every 30s × N sessions invalidates that subscription
    // continuously (→ re-collect + isolate memory thrash). The live metric values
    // live in session_metrics (inserted below) for the graphs; the copies on the
    // registry doc only feed the metrics views and tolerate staleness. So throttle
    // the hot-doc patch to ~5min/session (or when agent_pid changes), instead of
    // hammering it on every report.
    const SNAPSHOT_THROTTLE_MS = 5 * 60 * 1000;
    const snapshotStale = !session.last_metrics_at || now - session.last_metrics_at > SNAPSHOT_THROTTLE_MS;
    const agentPidChanged = args.agent_pid !== undefined && args.agent_pid !== session.agent_pid;
    if (snapshotStale || agentPidChanged) {
      await ctx.db.patch(session._id, {
        current_cpu: args.cpu,
        current_memory: args.memory,
        current_pid_count: args.pid_count,
        last_metrics_at: now,
        ...(args.agent_pid !== undefined ? { agent_pid: args.agent_pid } : {}),
        ...(args.awake_idle_ms !== undefined ? { awake_idle_ms: args.awake_idle_ms } : {}),
      });

      // Prune the time series on the throttled snapshot cadence (~5min/session),
      // not on every insert. The per-insert range-scan was N scans/30s of pure
      // overhead competing with message-sync mutations for the worker pool; a few
      // extra minutes of rows past the 2h cutoff before pruning is harmless.
      const cutoff = now - 2 * 60 * 60 * 1000;
      const old = await ctx.db
        .query("session_metrics")
        .withIndex("by_session_collected", (q: any) =>
          q.eq("session_id", args.session_id).lt("collected_at", cutoff)
        )
        .collect();
      for (const row of old) {
        await ctx.db.delete(row._id);
      }
    }

    await ctx.db.insert("session_metrics", {
      session_id: args.session_id,
      user_id: authUserId,
      cpu: args.cpu,
      memory: args.memory,
      pid_count: args.pid_count,
      collected_at: now,
    });
  },
});

export const listActiveSessions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx as any);
    if (!userId) throw new Error("Not authenticated");

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const sessions = await ctx.db
      .query("managed_sessions")
      .withIndex("by_user_heartbeat", (q: any) =>
        q.eq("user_id", userId).gte("last_heartbeat", cutoff)
      )
      .collect();

    const results = [];
    for (const session of sessions) {
      let conversationTitle: string | undefined;
      let projectPath: string | undefined;
      let agentType: string | undefined;
      let messageCount: number | undefined;
      let conversationStatus: string | undefined;
      let model: string | undefined;
      let gitBranch: string | undefined;
      let worktreeName: string | undefined;
      let headline: string | undefined;
      let isSubagent: boolean | undefined;
      let conversationUpdatedAt: number | undefined;
      let lastMessagePreview: string | undefined;
      let lastMessageRole: string | undefined;

      if (session.conversation_id) {
        const conv = await ctx.db.get(session.conversation_id);
        if (conv) {
          if (conv.inbox_killed_at) continue;
          conversationTitle = conv.title;
          projectPath = conv.project_path;
          agentType = conv.agent_type;
          messageCount = conv.message_count;
          conversationStatus = conv.status;
          model = conv.model;
          gitBranch = conv.git_branch;
          worktreeName = conv.worktree_name;
          isSubagent = conv.is_subagent;
          // updated_at moves on real conversation activity (messages, status) but
          // NOT on idle heartbeats or metrics writes — the honest "last active"
          // signal. The preview/role give every row something identifiable even
          // when no insight headline exists (common for short/dead sessions).
          conversationUpdatedAt = conv.updated_at;
          lastMessagePreview = conv.last_message_preview;
          lastMessageRole = conv.last_message_role;

          const insight = await ctx.db
            .query("session_insights")
            .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", session.conversation_id))
            .order("desc")
            .first();
          if (insight) {
            headline = insight.headline || insight.summary?.slice(0, 120);
          }
        }
      }

      // The current_* copies on the registry doc are throttled to a ~5min write
      // (SNAPSHOT_THROTTLE_MS in reportMetrics) to keep listInboxSessions' read
      // set stable. That staleness is fine for the inbox but wrong for this
      // monitoring view, which sorts and sums these numbers. Read the freshest
      // time-series sample instead (≤30s old for active sessions, ≤3min for
      // idle) and prefer it. This page is the ONLY consumer of
      // listActiveSessions, so the extra per-session read never touches the hot
      // inbox subscription the throttle exists to protect.
      const latestMetric = await ctx.db
        .query("session_metrics")
        .withIndex("by_session_collected", (q: any) => q.eq("session_id", session.session_id))
        .order("desc")
        .first();

      results.push({
        _id: session._id,
        session_id: session.session_id,
        conversation_id: session.conversation_id,
        pid: session.pid,
        tmux_session: session.tmux_session,
        started_at: session.started_at,
        last_heartbeat: session.last_heartbeat,
        agent_status: session.agent_status,
        agent_status_updated_at: session.agent_status_updated_at,
        permission_mode: session.permission_mode,
        // Prefer the freshest sample; fall back to the throttled snapshot only
        // when no time-series row survives the 2h retention (e.g. long-idle).
        current_cpu: latestMetric?.cpu ?? session.current_cpu,
        current_memory: latestMetric?.memory ?? session.current_memory,
        current_pid_count: latestMetric?.pid_count ?? session.current_pid_count,
        agent_pid: session.agent_pid,
        awake_idle_ms: session.awake_idle_ms,
        // Honest "as of" for the displayed metrics: the sample time, not the
        // throttled snapshot time.
        last_metrics_at: latestMetric?.collected_at ?? session.last_metrics_at,
        conversation_title: conversationTitle,
        project_path: projectPath,
        agent_type: agentType,
        message_count: messageCount,
        conversation_status: conversationStatus,
        model,
        git_branch: gitBranch,
        worktree_name: worktreeName,
        headline,
        is_subagent: isSubagent,
        conversation_updated_at: conversationUpdatedAt,
        last_message_preview: lastMessagePreview,
        last_message_role: lastMessageRole,
      });
    }

    return results;
  },
});

export const getSessionMetrics = query({
  args: {
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx as any);
    if (!userId) throw new Error("Not authenticated");

    return await ctx.db
      .query("session_metrics")
      .withIndex("by_session_collected", (q: any) =>
        q.eq("session_id", args.session_id)
      )
      .collect();
  },
});

export const getAggregateMetrics = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx as any);
    if (!userId) throw new Error("Not authenticated");

    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("session_metrics")
      .withIndex("by_user_collected", (q: any) =>
        q.eq("user_id", userId).gte("collected_at", cutoff)
      )
      .collect();

    // Bucket by 30-second windows and aggregate across sessions
    const buckets = new Map<number, { cpu: number; memory: number; pid_count: number; count: number }>();
    for (const row of rows) {
      const bucket = Math.round(row.collected_at / 30000) * 30000;
      const existing = buckets.get(bucket);
      if (existing) {
        existing.cpu += row.cpu;
        existing.memory += row.memory;
        existing.pid_count += row.pid_count;
        existing.count++;
      } else {
        buckets.set(bucket, { cpu: row.cpu, memory: row.memory, pid_count: row.pid_count, count: 1 });
      }
    }

    return Array.from(buckets.entries())
      .map(([t, v]) => ({ collected_at: t, cpu: v.cpu, memory: v.memory, pid_count: v.pid_count }))
      .sort((a, b) => a.collected_at - b.collected_at);
  },
});

export const getConversationBySessionId = query({
  args: {
    claude_session_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const conversation = await findConversationBySessionReference(
      ctx as any,
      args.claude_session_id,
      authUserId
    );

    if (!conversation) {
      return null;
    }

    return {
      conversation_id: conversation._id,
      session_id: conversation.session_id,
    };
  },
});

// Reap dead managed_sessions — rows whose daemon stopped heartbeating (a crash, a
// kill, or a forked tmux that was never cleanly unregistered). This is pure
// housekeeping, NOT correctness: clean shutdowns delete their own row, and every
// reader already ignores stale rows by filtering on heartbeat age
// (HEARTBEAT_ALIVE_MS), so a dead row never shows up as "live". The reaper just
// stops the registry growing without bound — Convex won't drop the row on its own
// (a dead session's final row is its newest version, not a superseded one).
//
// The one non-obvious bit: `last_heartbeat` is indexed and rewritten every ~45s per
// live session, and Convex keeps ~10 days of old index versions, so the OLD end of
// `by_heartbeat` is a multi-million-row tombstone graveyard. An unbounded
// `lt(cutoff)` scan timed out fetching even one row. The fix is the LOWER bound:
// gte(cutoff - WINDOW) lets the index seek straight to the recent sliver and skip
// the graveyard. That range is also disjoint from live heartbeats (which land at
// > cutoff), so the deletes never collide with heartbeat writes. Everything in range
// is dead by definition. WINDOW only needs to exceed the gap between cron runs so a
// death is always caught before it ages out — 6h gives the 10-min cron wide margin.
const REAP_WINDOW_MS = 6 * 60 * 60 * 1000;
export const reapStaleManagedSessions = internalMutation({
  args: { cutoffMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - (args.cutoffMs ?? 60 * 60 * 1000); // dead = no beat in 1h
    const readStart = Date.now();
    const dead = await ctx.db
      .query("managed_sessions")
      .withIndex("by_heartbeat", (q: any) =>
        q.gte("last_heartbeat", cutoff - REAP_WINDOW_MS).lt("last_heartbeat", cutoff)
      )
      .collect();
    const readMs = Date.now() - readStart;

    for (const s of dead) await ctx.db.delete(s._id);

    if (dead.length > 0) {
      console.log(
        `reapStaleManagedSessions: deleted ${dead.length} dead session(s) (scan ${readMs}ms)`
      );
    }
    return { deleted: dead.length };
  },
});
