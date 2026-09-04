import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { enqueueHibernateSession, requireSessionCommandTarget, extractDaemonCommandConversationId, findSessionCommandByRequest, validateSessionCommandRequestId } from "./daemonCommandUtils";

export const hibernate = mutation({
  args: { conversation_id: v.id("conversations"), session_id: v.string(), owner_device_id: v.string(), request_id: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthUserId(ctx);
    if (!user) throw new Error("Not authenticated");
    validateSessionCommandRequestId(args.request_id);
    const conv = await requireSessionCommandTarget(ctx, user, args.conversation_id);
    if (conv.user_id !== user) throw new Error("Only your own idle sessions can be parked in bulk");
    if (conv.session_id !== args.session_id || conv.owner_device_id !== args.owner_device_id) throw new Error("Session identity or owning device changed");
    return enqueueHibernateSession(ctx, conv, args.request_id);
  },
});

export const results = query({
  args: { request_ids: v.optional(v.array(v.string())), command_ids: v.optional(v.array(v.id("daemon_commands"))), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await getAuthUserId(ctx) ?? (args.api_token ? (await verifyApiToken(ctx, args.api_token))?.userId : null);
    if (!user) return [];
    if ((args.request_ids?.length ?? 0) + (args.command_ids?.length ?? 0) > 100) throw new Error("At most 100 command results at once");
    const byRequest = await Promise.all((args.request_ids ?? []).map(id => findSessionCommandByRequest(ctx, user, id)));
    const byId = await Promise.all((args.command_ids ?? []).map(id => ctx.db.get(id)));
    const rows = [];
    for (const command of [...byRequest, ...byId]) {
      if (!command || (command.command !== "hibernate_session" && command.command !== "resume_session")) continue;
      const conversationId = extractDaemonCommandConversationId(command.args);
      if (command.user_id !== user) {
        const id = conversationId && ctx.db.normalizeId("conversations", conversationId);
        const conv = id ? await ctx.db.get(id) : null;
        if (!conv || conv.owner_user_id !== user) continue;
      }
      if (command.request_id !== undefined && byId.includes(command)) {
        await findSessionCommandByRequest(ctx, command.user_id, command.request_id);
      }
      rows.push({
        _id: command.request_id ?? command._id,
        command_id: command._id,
        conversation_id: conversationId,
        command: command.command,
        requested_at: command.created_at,
        executed_at: command.executed_at ?? null,
        result: command.result ?? null,
        error: command.error ?? null,
      });
    }
    return rows;
  },
});
