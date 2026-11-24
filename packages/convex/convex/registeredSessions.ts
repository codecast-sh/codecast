import { v } from "convex/values";
import { mutation, query } from "./functions";
import { getAuthenticatedUserId, bounceFromEndedSession, NON_TERMINAL_PENDING_STATUSES } from "./pendingMessages";
import { checkRateLimit } from "./rateLimit";
import { isDeletedSession } from "./lib/deletedSessions";
import { buildShareUpdate, conversationRepository, matchDirectoryMapping, type DirectoryMapping } from "./privacy";
import { patchConversationVisibility } from "./lib/conversationVisibility";
import { deliveryTargetValidator, sameDeliveryTarget } from "./lib/registerOnly";
import { deviceTokenCaller } from "./devices";

async function endRegisteredRow(ctx: { db: any }, conv: any): Promise<void> {
  await ctx.db.patch(conv._id, { ended_at: Date.now(), status: "completed" });
  for (const status of NON_TERMINAL_PENDING_STATUSES) {
    const rows = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conv._id).eq("status", status))
      .collect();
    for (const row of rows) await bounceFromEndedSession(ctx, row);
  }
}

async function endSupersededRows(ctx: { db: any }, keep: any): Promise<void> {
  const rows = await ctx.db
    .query("conversations")
    .withIndex("by_owner_device_register_only", (q: any) => q.eq("user_id", keep.user_id).eq("owner_device_id", keep.owner_device_id).eq("register_only", true))
    .collect();
  for (const row of rows) {
    if (row._id !== keep._id && !row.ended_at && sameDeliveryTarget(row.delivery_target, keep.delivery_target)) await endRegisteredRow(ctx, row);
  }
}

function titleOf(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || cwd;
}

export const registerSession = mutation({
  args: {
    api_token: v.optional(v.string()),
    session_id: v.string(),
    cwd: v.string(),
    device_id: v.string(),
    delivery_target: deliveryTargetValidator,
    git_remote_url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    await checkRateLimit(ctx, userId, "createConversation");
    if (await isDeletedSession(ctx, userId, args.session_id)) {
      throw new Error("Session deleted by its owner");
    }
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), userId))
      .first();
    if (existing) {
      if (!existing.register_only) {
        throw new Error("Session is already synced by the daemon; messaging-only registration cannot take it over");
      }
      if (existing.owner_device_id && existing.owner_device_id !== args.device_id && !existing.ended_at) {
        throw new Error("Session is registered from another device");
      }
      await ctx.db.patch(existing._id, {
        delivery_target: args.delivery_target,
        owner_device_id: args.device_id,
        project_path: args.cwd,
        ended_at: undefined,
        status: "active",
      });
      await endSupersededRows(ctx, (await ctx.db.get(existing._id))!);
      return {
        conversation_id: existing._id,
        short_id: existing.short_id ?? existing._id.toString().slice(0, 7),
      };
    }
    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      user_id: userId,
      agent_type: "claude_code",
      session_id: args.session_id,
      title: titleOf(args.cwd),
      project_path: args.cwd,
      owner_device_id: args.device_id,
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: true,
      status: "active",
      register_only: true,
      delivery_target: args.delivery_target,
      git_remote_url: args.git_remote_url,
    });
    const shortId = id.toString().slice(0, 7);
    await ctx.db.patch(id, { short_id: shortId });
    const conv = (await ctx.db.get(id))!;
    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    if (!matchDirectoryMapping(mappings as DirectoryMapping[], args.cwd, conversationRepository(conv))?.private) {
      const share = await buildShareUpdate(ctx, conv, userId);
      if (share.team_id) {
        await patchConversationVisibility(ctx, conv, { ...share, auto_shared: true }, userId);
      }
    }
    await endSupersededRows(ctx, (await ctx.db.get(id))!);
    return { conversation_id: id, short_id: shortId };
  },
});

export const markEnded = mutation({
  args: {
    api_token: v.optional(v.string()),
    session_id: v.string(),
    delivery_target: v.optional(deliveryTargetValidator),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), userId))
      .first();
    if (!conv || !conv.register_only) throw new Error("No registered session found for that session id");
    if (conv.ended_at) return;
    if (args.delivery_target && !sameDeliveryTarget(conv.delivery_target, args.delivery_target)) return;
    await endRegisteredRow(ctx, conv);
  },
});

export const relayHeartbeat = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
  },
  handler: async (ctx, args) => {
    const caller = await deviceTokenCaller(ctx, args.api_token);
    if (!caller) throw new Error("Authentication failed: invalid token or session");
    if (caller.boundDeviceId && caller.boundDeviceId !== args.device_id) throw new Error("This token is bound to a different machine");
    const userId = caller.userId;
    const existing = await ctx.db
      .query("relay_heartbeats")
      .withIndex("by_user_device", (q) => q.eq("user_id", userId).eq("device_id", args.device_id))
      .first();
    if (existing) await ctx.db.patch(existing._id, { last_seen: Date.now() });
    else await ctx.db.insert("relay_heartbeats", { user_id: userId, device_id: args.device_id, last_seen: Date.now() });
  },
});

export const registeredForDevice = query({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_owner_device_register_only", (q) => q.eq("user_id", userId).eq("owner_device_id", args.device_id).eq("register_only", true))
      .collect();
    return rows
      .filter((c) => !c.ended_at && c.delivery_target && c.session_id)
      .map((c) => ({ session_id: c.session_id!, delivery_target: c.delivery_target!, short_id: c.short_id ?? c._id.toString().slice(0, 7) }));
  },
});
