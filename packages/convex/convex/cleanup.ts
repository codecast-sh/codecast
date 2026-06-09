import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// Abandoned empty-conversation GC.
//
// Every quick-create entry point (Ctrl+N, the compose palette, mobile) creates
// the server conversation EAGERLY — before the first message — so the daemon
// can pre-warm the agent while the user types. Abandoning that UI (Escape,
// navigate away) used to strand a contentless "New Session" row forever: the
// inbox's New bucket has no age limit and nothing ever deleted them. The web
// now converges repeated summons onto one blank session per project
// (beginOptimisticSession reuse); this sweep deletes whatever still slips
// through once it's stale.
//
// The cron covers a rolling _creationTime band just past the grace cutoff
// (hourly tick, 2h band → every row is scanned twice; deletes are idempotent).
// The same mutation takes explicit {since, until} for manual backlog drains —
// scan_limit keeps a single run inside Convex read budgets (conversation rows
// carry title embeddings, so unbounded scans are heavy).
// ---------------------------------------------------------------------------

export const EMPTY_CONVERSATION_GRACE_MS = 24 * 60 * 60 * 1000;
const EMPTY_GC_BAND_MS = 2 * 60 * 60 * 1000;
// A managed session beating within this window means a real process (terminal,
// pre-warmed agent) is still attached — never sweep those.
const LIVE_HEARTBEAT_MS = 60 * 60 * 1000;

// Row-level qualification, pure so it's unit-testable. Anything that signals
// user intent or attached work disqualifies; the authoritative existence
// checks (messages, pending_messages, managed_sessions, client_state drafts)
// happen in the mutation.
export function isGcableEmptyConversation(c: {
  message_count?: number;
  has_pending_messages?: boolean;
  draft_message?: string;
  active_task_id?: unknown;
  active_plan_id?: unknown;
  plan_ids?: unknown[];
  is_subagent?: boolean;
  parent_conversation_id?: unknown;
  forked_from?: unknown;
  fork_status?: string;
  workflow_run_id?: unknown;
  is_workflow_sub?: boolean;
  is_workflow_primary?: boolean;
  inbox_pinned_at?: number;
  is_favorite?: boolean;
  share_token?: string;
  title_is_custom?: boolean;
}): boolean {
  if ((c.message_count ?? 0) !== 0) return false;
  if (c.has_pending_messages) return false;
  if (c.draft_message?.trim()) return false;
  if (c.active_task_id || c.active_plan_id || c.plan_ids?.length) return false;
  if (c.is_subagent || c.parent_conversation_id) return false;
  if (c.forked_from || c.fork_status) return false;
  if (c.workflow_run_id || c.is_workflow_sub || c.is_workflow_primary) return false;
  if (c.inbox_pinned_at || c.is_favorite) return false;
  if (c.share_token) return false;
  if (c.title_is_custom) return false;
  return true;
}

// A client_state drafts entry is live user content when it carries any
// non-empty text or attachments; cleared drafts are nulled, not removed.
export function hasLiveDraft(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  return Object.values(entry as Record<string, unknown>).some((v) =>
    typeof v === "string" ? v.trim().length > 0 : Array.isArray(v) ? v.length > 0 : false
  );
}

export const gcEmptyConversations = internalMutation({
  args: {
    since: v.optional(v.number()),
    until: v.optional(v.number()),
    scan_limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const until = Math.min(args.until ?? now - EMPTY_CONVERSATION_GRACE_MS, now - EMPTY_CONVERSATION_GRACE_MS);
    const since = args.since ?? until - EMPTY_GC_BAND_MS;
    const limit = Math.min(args.scan_limit ?? 600, 1000);

    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", since).lt("_creationTime", until))
      .take(limit);

    // Per-user client_state drafts, fetched once per user seen in this batch.
    const draftsByUser = new Map<string, Record<string, unknown> | null>();
    let deleted = 0;

    for (const c of rows) {
      if (!isGcableEmptyConversation(c)) continue;

      // Authoritative checks — the denormalized flags can lag reality.
      const hasMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", c._id))
        .first();
      if (hasMsg) continue;
      const hasPending = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q) => q.eq("conversation_id", c._id))
        .first();
      if (hasPending) continue;

      const managed = await ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", c._id))
        .collect();
      if (managed.some((m) => m.last_heartbeat > now - LIVE_HEARTBEAT_MS)) continue;

      const userKey = c.user_id.toString();
      let drafts = draftsByUser.get(userKey);
      if (drafts === undefined) {
        const cs = await ctx.db
          .query("client_state")
          .withIndex("by_user_id", (q) => q.eq("user_id", c.user_id))
          .first();
        drafts = (cs as any)?.drafts && typeof (cs as any).drafts === "object" ? ((cs as any).drafts as Record<string, unknown>) : null;
        draftsByUser.set(userKey, drafts);
      }
      if (drafts && hasLiveDraft(drafts[c._id.toString()])) continue;

      // Dead managed rows and the creation-time git-diff blob go with the row.
      for (const m of managed) await ctx.db.delete(m._id);
      const diffs = await ctx.db
        .query("conversation_git_diffs")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", c._id))
        .collect();
      for (const d of diffs) await ctx.db.delete(d._id);
      await ctx.db.delete(c._id);
      deleted++;
    }

    if (deleted > 0) {
      console.log(`gcEmptyConversations: deleted ${deleted}/${rows.length} scanned (window ${new Date(since).toISOString()} → ${new Date(until).toISOString()})`);
    }
    return {
      scanned: rows.length,
      deleted,
      exhausted: rows.length < limit,
      last_creation_time: rows.length ? rows[rows.length - 1]._creationTime : null,
    };
  },
});

export const clearRateLimits = internalMutation({
  args: {},
  handler: async (ctx) => {
    const limits = await ctx.db.query("rate_limits").collect();
    for (const limit of limits) {
      await ctx.db.delete(limit._id);
    }
    return `Cleared ${limits.length} rate limit records`;
  },
});

// One-time cleanup mutation to delete orphan tables
// Run with: npx convex run cleanup:deleteOrphanTables
export const deleteOrphanTables = internalMutation({
  args: {},
  handler: async (ctx) => {
    const orphanTables = [
      "activity",
      "activityChunk",
      "contacts",
      "credentials",
      "emailDrafts",
      "integrations",
      "jobs",
      "reminders",
      "tasks",
      "typingPresence",
      "userCalendarPrefs",
    ];

    for (const tableName of orphanTables) {
      try {
        // @ts-ignore - accessing tables not in schema
        const docs = await ctx.db.query(tableName).collect();
        for (const doc of docs) {
          // @ts-ignore
          await ctx.db.delete(doc._id);
        }
        console.log(`Deleted ${docs.length} documents from ${tableName}`);
      } catch (e) {
        console.log(`Table ${tableName} doesn't exist or error: ${e}`);
      }
    }

    return "Done";
  },
});

export const clearUserConversations = mutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    // Just get conversation IDs without loading full docs
    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .take(50);

    let deleted = 0;
    for (const conv of convos) {
      // Check if has messages (just get first, don't load content)
      const hasMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .first();

      if (!hasMsg) {
        await ctx.db.delete(conv._id);
        deleted++;
      }
    }

    const hasMore = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .first();

    return { deleted, hasMore: !!hasMore };
  },
});

export const clearUserMessages = mutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    // Get one conversation
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .first();

    if (!conv) return { deleted: 0, hasMore: false };

    // Get message IDs only (not full content) by using a projection-like query
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .take(100);

    for (const msg of msgs) {
      await ctx.db.delete(msg._id);
    }

    return { deleted: msgs.length, hasMore: msgs.length > 0 };
  },
});

// Force delete conversations without checking for messages - deletes 50 at a time
export const forceDeleteConversations = mutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .take(50);

    for (const conv of convos) {
      await ctx.db.delete(conv._id);
    }

    const hasMore = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .first();

    return { deleted: convos.length, hasMore: !!hasMore };
  },
});

// Delete conversations by agent type
export const deleteConversationsByType = mutation({
  args: {
    user_id: v.id("users"),
    agent_type: v.union(v.literal("claude_code"), v.literal("codex"), v.literal("cursor")),
  },
  handler: async (ctx, args) => {
    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .filter((q) => q.eq(q.field("agent_type"), args.agent_type))
      .take(100);

    for (const conv of convos) {
      await ctx.db.delete(conv._id);
    }

    return { deleted: convos.length };
  },
});

export const deleteConversationBySessionId = mutation({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .first();
    if (!conv) return { found: false, deleted: 0 };
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .take(500);
    for (const m of msgs) await ctx.db.delete(m._id);
    await ctx.db.delete(conv._id);
    return { found: true, deleted: msgs.length };
  },
});

// Delete all Cursor conversations and their messages (uses auth)
export const deleteCursorConversationsWithMessages = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", identity.email))
      .first();
    if (!user) throw new Error("User not found");

    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .filter((q) => q.eq(q.field("agent_type"), "cursor"))
      .take(100);

    let messagesDeleted = 0;
    for (const conv of convos) {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .take(1000);

      for (const msg of msgs) {
        await ctx.db.delete(msg._id);
        messagesDeleted++;
      }
      await ctx.db.delete(conv._id);
    }

    return { conversationsDeleted: convos.length, messagesDeleted };
  },
});
