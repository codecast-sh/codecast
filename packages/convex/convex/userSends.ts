import { v } from "convex/values";
import { internalMutation } from "./functions";
import { recordSendFor } from "./lib/userSend";

export const record = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    words: v.number(),
    by_person: v.boolean(),
    timestamp: v.number(),
  },
  handler: async (ctx, { conversation_id, by_person, timestamp, ...send }): Promise<void> => {
    const conversation = await ctx.db.get(conversation_id);
    if (conversation) await recordSendFor(ctx, conversation, send, by_person, timestamp);
  },
});
