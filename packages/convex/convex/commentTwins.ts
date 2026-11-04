// The conversation comment read that web clients from Oct 24 to Nov 3 2026
// subscribe to (their `comments_from_review` preference). Conversation
// comments live in review_comments now (commentStore), and this answers
// exactly what comments.getConversationCommentSummary answers.

import { v } from "convex/values";
import { query } from "./functions";
import { getConversationCommentSummaryRows } from "./comments";

export const conversationComments = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => await getConversationCommentSummaryRows(ctx, args.conversation_id),
});
