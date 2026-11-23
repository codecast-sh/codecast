import { v } from "convex/values";
import { mutation } from "./functions";
import { getAuthenticatedUserId, bounceFromEndedSession } from "./pendingMessages";
import { checkRateLimit } from "./rateLimit";
import { isDeletedSession } from "./lib/deletedSessions";
import { buildShareUpdate } from "./privacy";
import { patchConversationVisibility } from "./lib/conversationVisibility";

const deliveryTarget = v.union(
  v.object({ kind: v.literal("herdr"), socket: v.string(), pane: v.string() }),
  v.object({ kind: v.literal("paseo"), agent_id: v.string() }),
);

const UNDELIVERED = ["pending", "held", "injected", "failed", "undeliverable"] as const;

function titleOf(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || cwd;
}

async function requireUser(ctx: { db: any }, apiToken?: string) {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) throw new Error("Authentication failed: invalid token or session");
  return userId;
}

export const registerSession = mutation({
  args: {
    api_token: v.optional(v.string()),
    session_id: v.string(),
    cwd: v.string(),
    device_id: v.string(),
    delivery_target: deliveryTarget,
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx, args.api_token);
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
      await ctx.db.patch(existing._id, {
        delivery_target: args.delivery_target,
        owner_device_id: args.device_id,
        project_path: args.cwd,
        ended_at: undefined,
      });
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
    });
    const shortId = id.toString().slice(0, 7);
    await ctx.db.patch(id, { short_id: shortId });
    const conv = (await ctx.db.get(id))!;
    await patchConversationVisibility(ctx, conv, await buildShareUpdate(ctx, conv, userId), userId);
    return { conversation_id: id, short_id: shortId };
  },
});

export const markEnded = mutation({
  args: {
    api_token: v.optional(v.string()),
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx, args.api_token);
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), userId))
      .first();
    if (!conv || !conv.register_only) throw new Error("No registered session found for that session id");
    if (conv.ended_at) return;
    await ctx.db.patch(conv._id, { ended_at: Date.now() });
    for (const status of UNDELIVERED) {
      const rows = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q) => q.eq("conversation_id", conv._id).eq("status", status))
        .collect();
      for (const row of rows) await bounceFromEndedSession(ctx, row);
    }
  },
});
