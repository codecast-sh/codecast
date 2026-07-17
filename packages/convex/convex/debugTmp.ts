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

// Set a user's alternate_emails (assignee-resolution aliases) by primary email.
export const setAlternateEmails = internalMutation({
  args: { email: v.string(), alternate_emails: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q: any) => q.eq("email", args.email))
      .first();
    if (!user) return { error: "no user" };
    await ctx.db.patch(user._id, { alternate_emails: args.alternate_emails });
    return { user_id: user._id, name: user.name, alternate_emails: args.alternate_emails };
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

// TEMPORARY: sample conversation doc weight — how many docs carry the orphaned
// title_embedding (1024 float64s) and what the average doc size is, newest or
// oldest first. Sizes the strip-migration payoff. Safe to delete.
export const sampleConversationWeight = internalQuery({
  args: { take: v.optional(v.number()), oldest: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const n = Math.min(args.take ?? 200, 400);
    const rows = await ctx.db
      .query("conversations")
      .order(args.oldest ? "asc" : "desc")
      .take(n);
    let withEmb = 0;
    let bytes = 0;
    let embBytes = 0;
    for (const c of rows) {
      bytes += JSON.stringify(c).length;
      const emb = (c as any).title_embedding;
      if (emb) {
        withEmb++;
        embBytes += JSON.stringify(emb).length;
      }
    }
    return {
      sampled: rows.length,
      with_embedding: withEmb,
      avg_doc_bytes: rows.length ? Math.round(bytes / rows.length) : 0,
      embedding_bytes_total: embBytes,
      newest_first: !args.oldest,
    };
  },
});

// TEMPORARY: sample docs of any table by creation-time seek — how many carry an
// orphaned embedding field (writers removed 2026-06-28, data never stripped) and
// average doc size. after = ms epoch to seek to. Safe to delete.
export const sampleEmbeddingEra = internalQuery({
  args: {
    table: v.union(v.literal("messages"), v.literal("conversations"), v.literal("docs")),
    after: v.number(),
    take: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const n = Math.min(args.take ?? 300, 400);
    const rows = await (ctx.db.query(args.table as any) as any)
      .withIndex("by_creation_time", (q: any) => q.gt("_creationTime", args.after))
      .take(n);
    const field = args.table === "conversations" ? "title_embedding" : "embedding";
    let withEmb = 0;
    let bytes = 0;
    let embBytes = 0;
    for (const r of rows) {
      bytes += JSON.stringify(r).length;
      const emb = r[field];
      if (emb) {
        withEmb++;
        embBytes += JSON.stringify(emb).length;
      }
    }
    return {
      table: args.table,
      sampled: rows.length,
      with_embedding: withEmb,
      avg_doc_bytes: rows.length ? Math.round(bytes / rows.length) : 0,
      avg_emb_bytes: withEmb ? Math.round(embBytes / withEmb) : 0,
      first_at: rows.length ? new Date(rows[0]._creationTime).toISOString() : null,
    };
  },
});

// TEMPORARY: time the managed_sessions per-user scan two ways — the unbounded
// by_user_id collect (suspected SystemTimeoutError source in listConversations)
// vs a by_user_heartbeat window seek. Safe to delete.
export const timeManagedScan = internalQuery({
  args: {
    who: v.string(), // email, username, or github_username
    mode: v.union(v.literal("full"), v.literal("window")),
    windowMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user =
      (await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", args.who))
        .first()) ??
      (await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", args.who))
        .first()) ??
      (await ctx.db
        .query("users")
        .withIndex("by_github_username", (q) => q.eq("github_username", args.who))
        .first());
    if (!user) return { error: "no user" };
    const now = Date.now();
    const t0 = Date.now();
    const rows =
      args.mode === "full"
        ? await ctx.db
            .query("managed_sessions")
            .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
            .collect()
        : await ctx.db
            .query("managed_sessions")
            .withIndex("by_user_heartbeat", (q) =>
              q.eq("user_id", user._id).gte("last_heartbeat", now - (args.windowMs ?? 90 * 1000))
            )
            .collect();
    const ages = rows.map((s) => Math.round((now - s.last_heartbeat) / 1000)).sort((a, b) => a - b);
    return {
      mode: args.mode,
      user_id: user._id,
      user_email: (user as any).email ?? null,
      scan_ms: Date.now() - t0,
      rows: rows.length,
      live_90s: rows.filter((s) => now - s.last_heartbeat < 90 * 1000).length,
      heartbeat_ages_s: ages.slice(0, 5).concat(ages.length > 10 ? [-1] : [], ages.slice(-5)),
    };
  },
});

// TEMPORARY: list users that have a role set (find the admin account). Safe to delete.
export const listRoleUsers = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users
      .filter((u) => u.role)
      .map((u) => ({ id: u._id, email: u.email, role: u.role }));
  },
});
