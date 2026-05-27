import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";

async function getAuthenticatedUserId(
  ctx: { db: any },
  apiToken?: string,
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) return sessionUserId;
  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) return result.userId;
  }
  return null;
}

/**
 * Upsert this machine's device row. Called by the daemon on heartbeat. Per-
 * device fields (local_project_roots) live here so multiple machines don't
 * clobber each other on the shared user doc.
 */
export const registerDevice = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    label: v.string(),
    platform: v.string(),
    is_remote: v.optional(v.boolean()),
    local_project_roots: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");

    const now = Date.now();
    const existing = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) =>
        q.eq("user_id", userId).eq("device_id", args.device_id),
      )
      .first();

    const patch = {
      label: args.label,
      platform: args.platform,
      last_seen: now,
      status: "online" as const,
      ...(args.is_remote !== undefined ? { is_remote: args.is_remote } : {}),
      ...(args.local_project_roots !== undefined
        ? { local_project_roots: args.local_project_roots }
        : {}),
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return { device_id: args.device_id, created: false };
    }
    await ctx.db.insert("devices", { user_id: userId, device_id: args.device_id, ...patch });
    return { device_id: args.device_id, created: true };
  },
});

/**
 * Owner device of a conversation. Used by daemons to enforce the single-owner
 * invariant on session-targeted commands (resume/kill/inject): a daemon skips
 * commands for conversations owned by another device.
 */
export const getConversationOwner = query({
  args: { api_token: v.optional(v.string()), conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) return null;
    return { owner_device_id: (conv as any).owner_device_id ?? null };
  },
});

/** Resolve a session_id to its conversation (api_token authed) for the move flow. */
export const resolveConversationBySession = query({
  args: { api_token: v.optional(v.string()), session_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .filter((q: any) => q.eq(q.field("user_id"), userId))
      .first();
    if (!conv) return null;
    return {
      _id: conv._id,
      short_id: conv.short_id ?? null,
      owner_device_id: (conv as any).owner_device_id ?? null,
      project_path: conv.project_path ?? null,
      status: conv.status,
      title: conv.title ?? null,
    };
  },
});

/**
 * Server side of `cast remote move`: flip a conversation's owner to the target
 * device, repoint its project_path to the remote worktree, and enqueue a
 * resume_session command (which only the owner device will execute, per the
 * daemon's single-owner guard). One mutation = atomic handoff of ownership.
 */
export const moveSessionToDevice = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
    owner_device_id: v.string(),
    project_path: v.string(),
    resume: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");

    await ctx.db.patch(args.conversation_id, {
      owner_device_id: args.owner_device_id,
      project_path: args.project_path,
      status: "active" as const,
      updated_at: Date.now(),
    });

    let commandId: string | undefined;
    if (args.resume !== false) {
      const agentType =
        conv.agent_type === "codex" ? "codex" : conv.agent_type === "gemini" ? "gemini" : "claude";
      const id = await ctx.db.insert("daemon_commands", {
        user_id: userId,
        command: "resume_session" as const,
        args: JSON.stringify({
          session_id: conv.session_id,
          agent_type: agentType,
          conversation_id: args.conversation_id,
          project_path: args.project_path,
        }),
        created_at: Date.now(),
      });
      commandId = id;
    }
    return { ok: true, command_id: commandId, owner_device_id: args.owner_device_id };
  },
});

/** List the user's devices (for the web UI + `cast remote hosts`). */
export const listDevices = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    const now = Date.now();
    const ONLINE_MS = 2 * 60 * 1000; // online if seen within 2 min
    const rows = await ctx.db
      .query("devices")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    return rows
      .map((d: any) => ({
        device_id: d.device_id,
        label: d.label,
        platform: d.platform,
        last_seen: d.last_seen,
        is_remote: d.is_remote ?? false,
        local_project_roots: d.local_project_roots ?? [],
        online: now - d.last_seen < ONLINE_MS,
      }))
      .sort((a: any, b: any) => b.last_seen - a.last_seen);
  },
});

/**
 * Claim a conversation for this device on a successful session start: stamp
 * owner_device_id and clear any stale session_error in one write. This is the
 * first real enforcement of the single-owner invariant — the device that can
 * actually run the session becomes its owner, which self-heals a "clone it
 * first" error written by a different device that lacked the checkout.
 */
export const claimConversation = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.string(),
    device_id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const convId = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!convId) return;
    const conv = await ctx.db.get(convId);
    if (!conv || conv.user_id.toString() !== userId.toString()) return;
    await ctx.db.patch(convId, {
      owner_device_id: args.device_id,
      session_error: undefined,
    });
    return { ok: true };
  },
});

/**
 * Set (or clear) which device owns a conversation. Used by the move flow to
 * flip ownership local <-> remote. Authorizes the caller owns the conversation.
 */
export const setConversationOwner = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
    owner_device_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) throw new Error("conversation not found");
    if (conv.user_id.toString() !== userId.toString()) throw new Error("not your conversation");
    await ctx.db.patch(args.conversation_id, { owner_device_id: args.owner_device_id });
    return { ok: true, owner_device_id: args.owner_device_id ?? null };
  },
});
