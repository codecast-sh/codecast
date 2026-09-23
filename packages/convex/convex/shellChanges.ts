import { v } from "convex/values";
import { mutation } from "./functions";
import { getAuthenticatedUserId } from "./pendingMessages";
import { materializeFileChanges } from "./messages";
import { redactSecrets } from "./redact";

export const sync = mutation({
  args: {
    conversation_id: v.id("conversations"),
    message_uuid: v.string(),
    api_token: v.optional(v.string()),
    changes: v.array(v.object({
      tool_call_id: v.string(),
      seq: v.number(),
      file_path: v.string(),
      change_type: v.union(v.literal("write"), v.literal("edit"), v.literal("delete")),
      old_content: v.optional(v.string()),
      new_content: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    if (args.changes.length > 8 || new TextEncoder().encode(JSON.stringify(args.changes)).length > 800_000) {
      throw new Error("Shell diff exceeds batch budget");
    }
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!userId || !conversation || conversation.user_id !== userId) throw new Error("Unauthorized shell diff");
    const message = await ctx.db.query("messages")
      .withIndex("by_conversation_uuid", (q) => q.eq("conversation_id", conversation._id).eq("message_uuid", args.message_uuid))
      .first();
    if (!message) throw new Error("Message not synced yet; try again later");
    const toolIds = new Set(message.tool_results?.map((result) => result.tool_use_id));
    if (args.changes.some((change) => !toolIds.has(change.tool_call_id) || !Number.isSafeInteger(change.seq) || change.seq < 0)) {
      throw new Error("Shell diff does not match the message's tool results");
    }
    const changes = args.changes.map((change) => ({
      ...change,
      old_content: change.old_content === undefined ? undefined : redactSecrets(change.old_content),
      new_content: redactSecrets(change.new_content),
    }));
    await materializeFileChanges(ctx, conversation._id, message._id, message.timestamp, undefined, undefined, [], changes);
    return { synced: changes.length };
  },
});
