// TEMPORARY debug query — safe to delete. Inspects why a conversation keeps
// reappearing after dismiss: dumps dismiss-relevant fields + recent activity.
import { internalQuery, internalMutation } from "./functions";
import { v } from "convex/values";



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
    if (!conversation) {
      conversation = await ctx.db
        .query("conversations")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.id))
        .first();
    }
    if (!conversation) return { error: "not found" };

    const ownerRows = await ctx.db
      .query("session_owners")
      .withIndex("by_conversation", (q) => q.eq("conversation_id", conversation._id))
      .collect();

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
        nav_prompts_indexed_at: conversation.nav_prompts_indexed_at,
        nav_prompts_backfill_started_at: conversation.nav_prompts_backfill_started_at,
        session_id: conversation.session_id,
        user_id: conversation.user_id,
        status: conversation.status,
        inbox_dismissed_at: conversation.inbox_dismissed_at,
        inbox_stashed_at: (conversation as any).inbox_stashed_at,
        inbox_pinned_at: (conversation as any).inbox_pinned_at,
        owner_user_id: (conversation as any).owner_user_id,
        updated_at: conversation.updated_at,
        started_at: conversation.started_at,
        parent_conversation_id: (conversation as any).parent_conversation_id,
        is_subagent: (conversation as any).is_subagent,
        active_plan_id: (conversation as any).active_plan_id,
        owner_device_id: (conversation as any).owner_device_id,
        project_path: conversation.project_path,
        // The pin and the station report beside it: a run routes on the report.
        thread_state_status: conversation.thread_state_status,
        thread_state_at: conversation.thread_state_at,
        thread_state_result: conversation.thread_state_result?.slice(0, 300),
        thread_state_result_at: conversation.thread_state_result_at,
      },
      now: Date.now(),
      sessionOwners: ownerRows.map((r) => ({
        user_id: r.user_id,
        added_by: r.added_by,
        added_at: r.added_at,
      })),
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



// TEMPORARY: a bare `cast sync` (from a mistyped `cast sync ls`) re-uploaded
// old transcripts on 2026-10-07, and addMessage stamped each row's updated_at
// with the upload time, so weeks-old sessions sorted as minutes old. Resets
// updated_at to the newest message's own time for rows still carrying an
// upload-window stamp that no message explains.
export const repairReuploadedActivity = internalMutation({
  args: { user_id: v.id("users"), from: v.number(), to: v.number(), dryRun: v.boolean() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) => q.eq("user_id", args.user_id).gte("updated_at", args.from).lte("updated_at", args.to))
      .collect();
    const fixed: Array<{ id: string; title?: string; from: number; to: number }> = [];
    for (const conv of rows) {
      const newest = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
        .order("desc")
        .first();
      const to = Math.max(newest?.timestamp ?? 0, conv.started_at ?? 0);
      if (!to || to > conv.updated_at - 3600_000) continue;
      fixed.push({ id: conv._id, title: conv.title, from: conv.updated_at, to });
      if (!args.dryRun) await ctx.db.patch(conv._id, { updated_at: to });
    }
    return { scanned: rows.length, fixed: fixed.length, rows: fixed };
  },
});
