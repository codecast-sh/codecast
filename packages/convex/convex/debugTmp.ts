// TEMPORARY debug query — safe to delete. Inspects why a conversation keeps
// reappearing after dismiss: dumps dismiss-relevant fields + recent activity.
import { internalQuery, internalMutation } from "./functions";
import { v } from "convex/values";

// TEMPORARY: insert a switch_account daemon command scoped to ONE conversation
// — exercises the daemon's swap+kill+continue handler end-to-end without
// selecting the whole blocked fleet the way requestAccountSwitch does.
export const insertSwitchAccountForOne = internalMutation({
  args: { conversation_id: v.id("conversations"), profile: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return { error: "not found" };
    const id = await ctx.db.insert("daemon_commands", {
      user_id: conv.user_id,
      command: "switch_account" as const,
      args: JSON.stringify({
        profile: args.profile,
        conversation_ids: [conv._id],
        session_ids: { [conv._id]: conv.session_id },
        continue_blocked: true,
      }),
      created_at: Date.now(),
      target_device_id: conv.owner_device_id,
    });
    return { command_id: id };
  },
});

export const inspectConversation = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    let conversation = null;
    const convId = ctx.db.normalizeId("conversations", args.id);
    if (convId) conversation = await ctx.db.get(convId);
    if (!conversation) {
      conversation = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.id))
        .first();
    }
    if (!conversation) return { error: "not found" };

    const recentMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation._id))
      .order("desc")
      .take(5);

    const pending = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation._id))
      .order("desc")
      .take(5);

    const managed = conversation.session_id
      ? await ctx.db
          .query("managed_sessions")
          .withIndex("by_session_id", (q) => q.eq("session_id", conversation.session_id!))
          .first()
      : null;

    return {
      conversation: {
        _id: conversation._id,
        title: conversation.title,
        session_id: conversation.session_id,
        user_id: conversation.user_id,
        status: conversation.status,
        inbox_dismissed_at: conversation.inbox_dismissed_at,
        inbox_pinned_at: (conversation as any).inbox_pinned_at,
        updated_at: conversation.updated_at,
        started_at: conversation.started_at,
        parent_conversation_id: (conversation as any).parent_conversation_id,
        is_subagent: (conversation as any).is_subagent,
        active_plan_id: (conversation as any).active_plan_id,
        owner_device_id: (conversation as any).owner_device_id,
        project_path: conversation.project_path,
      },
      now: Date.now(),
      recentMessages: recentMessages.map((m) => ({
        _id: m._id,
        role: m.role,
        timestamp: m.timestamp,
        _creationTime: m._creationTime,
        preview: (m.content ?? "").slice(0, 80),
      })),
      pendingMessages: pending.map((p) => ({
        _id: p._id,
        status: p.status,
        created_at: p.created_at,
        _creationTime: p._creationTime,
      })),
      managedSession: managed
        ? {
            agent_status: managed.agent_status,
            last_heartbeat: managed.last_heartbeat,
            last_metrics_at: managed.last_metrics_at,
          }
        : null,
    };
  },
});

// TEMPORARY: clear archived_at on a bucket stranded by the dropped-undefined
// dispatch bug (unarchive never reached the server). Safe to delete.
export const unarchiveBucket = internalMutation({
  args: { bucket_id: v.id("inbox_buckets") },
  handler: async (ctx, args) => {
    const bucket = await ctx.db.get(args.bucket_id);
    if (!bucket) return { error: "not found" };
    await ctx.db.patch(args.bucket_id, { archived_at: undefined, updated_at: Date.now() });
    return { name: bucket.name, was_archived_at: bucket.archived_at ?? null };
  },
});
