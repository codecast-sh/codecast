import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { canReadSessionCommand, enqueueHibernateSession, requireSessionCommandTarget, findSessionCommandByRequest, validateSessionCommandRequestId, sessionCommandRow, recentConversationCommands } from "./daemonCommandUtils";

// The commands a web store action can bind a request id to (hibernate, a
// restart's resume, a device move, an account switch), plus the kill that
// opens a restart.
const STORE_COMMANDS = new Set(["hibernate_session", "resume_session", "kill_session", "move_to_device", "switch_account"]);

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
      if (!command || !STORE_COMMANDS.has(command.command)) continue;
      if (!(await canReadSessionCommand(ctx, user, command))) continue;
      if (command.request_id !== undefined && byId.includes(command)) {
        await findSessionCommandByRequest(ctx, command.user_id, command.request_id);
      }
      rows.push(sessionCommandRow(command));
    }
    return rows;
  },
});

// One conversation's recent restart/move commands, in the same row shape as
// results: the second feed of the web's sessionCommands collection, mounted
// while a restart or move is in flight for the open conversation.
export const forConversation = query({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthUserId(ctx);
    if (!user) return [];
    return (await recentConversationCommands(ctx, user, args.conversation_id)).map(sessionCommandRow);
  },
});
