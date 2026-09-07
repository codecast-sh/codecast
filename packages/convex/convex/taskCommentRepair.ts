import { v } from "convex/values";
import { internalMutation } from "./functions";
import { canAccessTask } from "./lib/access";

export const restoreSessionAuthor = internalMutation({
  args: {
    comment_id: v.id("task_comments"),
    conversation_id: v.id("conversations"),
    expected_text: v.string(),
    dry_run: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get(args.comment_id);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!comment || !conversation) throw new Error("Comment or session not found");
    if (comment.text !== args.expected_text || comment.author_user_id) throw new Error("Comment does not match the agent evidence");
    if (comment.conversation_id && comment.conversation_id !== conversation._id) throw new Error("Comment already has a different author session");
    const task = await ctx.db.get(comment.task_id);
    if (!task || !await canAccessTask(ctx, conversation.user_id, task)) throw new Error("Session owner cannot access the task");
    const result = { comment_id: comment._id, conversation_id: conversation._id, title: conversation.title, agent_type: conversation.agent_type };
    if (args.dry_run !== false || comment.conversation_id === conversation._id) return result;
    await ctx.db.patch(comment._id, { conversation_id: conversation._id });
    const now = Date.now();
    await ctx.db.patch(task._id, { updated_at: now, last_comment_at: now });
    return result;
  },
});
