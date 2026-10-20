import { v } from "convex/values";
import { query } from "./functions";
import { conversationPagesOf } from "./messages";

/** The pages a conversation published, the feed of the header gallery (messages.conversationPagesOf). */
export const list = query({
  args: { conversation_id: v.id("conversations"), share_token: v.optional(v.string()) },
  handler: (ctx, args) => conversationPagesOf(ctx, args),
});
