import { internalMutation, mutation } from "./functions";
import { v } from "convex/values";
import { hasRecentPendingDaemonCommand } from "./daemonCommandUtils";

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

// Remove daemon-minted synthetic prompt cards (message_uuid "interactive-prompt-*")
// from a conversation — the recovery tool for pane-scrape misparses that shipped a
// fake AskUserQuestion poll (a prose answer with numbered sections used to qualify;
// see menuFooterBelowOptions in the CLI daemon). Only synthetic rows are eligible no
// matter what prefix is passed, so real JSONL-synced messages can never be touched.
export const deleteSyntheticPromptMessages = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    uuid_prefix: v.optional(v.string()),
    dry_run: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const prefix = args.uuid_prefix ?? "interactive-prompt-";
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_conversation_uuid", (q) =>
        q.eq("conversation_id", args.conversation_id).gte("message_uuid", prefix).lt("message_uuid", prefix + "￿"),
      )
      .take(50);
    const synthetic = rows.filter((m) => m.message_uuid?.startsWith("interactive-prompt-"));
    if (!args.dry_run) {
      for (const m of synthetic) await ctx.db.delete(m._id);
    }
    return {
      matched: synthetic.map((m) => ({ uuid: m.message_uuid, role: m.role, ts: m.timestamp })),
      deleted: args.dry_run ? 0 : synthetic.length,
    };
  },
});
// Purge synced "[Codecast import] …" truncation notices — synthetic context-only
// user messages minted by the CLI's jsonlGenerator on truncated imports. New CLIs
// mark them isMeta in the JSONL (never synced) and skip them at parse time; this
// drains the rows older daemons already synced. Uses the content search index, so
// it's a global sweep with no table scan — run repeatedly until matched is 0.
//
// Deliberately does NOT decrement conversation.message_count: reconciliation
// repairs only when backend < local (repairDiscrepancies), so leaving the counter
// alone keeps backend >= local for old AND new CLIs — no position-reset/re-sync
// loop. The +1 display skew on a handful of imported conversations is harmless.
// Run with: npx convex run cleanup:deleteImportNoticeMessages '{"dry_run":true}'
export const deleteImportNoticeMessages = internalMutation({
  args: { dry_run: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const PREFIX = "[Codecast import]";
    const candidates = await ctx.db
      .query("messages")
      .withSearchIndex("search_content_v2", (q) => q.search("content", "Codecast import session truncated"))
      .take(64);
    const notices = candidates.filter(
      (m) => m.role === "user" && m.content?.trimStart().startsWith(PREFIX),
    );
    if (!args.dry_run) {
      for (const m of notices) await ctx.db.delete(m._id);
    }
    return {
      scanned: candidates.length,
      matched: notices.length,
      deleted: args.dry_run ? 0 : notices.length,
      conversations: [...new Set(notices.map((m) => m.conversation_id.toString()))],
    };
  },
});

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

// Authoritative "nothing worth keeping" check for ONE conversation — the
// denormalized flags isGcableEmptyConversation reads can lag, so confirm against
// the source tables (messages / pending_messages) and the per-user draft. Used at
// dismiss time (single conv); the batched GC sweep inlines the equivalent checks
// with a per-batch draft cache. Read-only.
export async function conversationHasNoWork(
  ctx: { db: any },
  conv: any,
): Promise<boolean> {
  if (!isGcableEmptyConversation(conv)) return false;
  const hasMsg = await ctx.db
    .query("messages")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
    .first();
  if (hasMsg) return false;
  const hasPending = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conv._id))
    .first();
  if (hasPending) return false;
  const cs = await ctx.db
    .query("client_state")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", conv.user_id))
    .first();
  const drafts = cs?.drafts && typeof cs.drafts === "object" ? (cs.drafts as Record<string, unknown>) : null;
  if (drafts && hasLiveDraft(drafts[conv._id.toString()])) return false;
  return true;
}

// Reap-vs-protect decision for a GC-eligible empty conversation, given whether a
// managed session is still heartbeating. A live heartbeat (terminal / pre-warmed
// agent) protects the row ONLY while it's still active in the inbox; a DISMISSED
// (or stashed — an empty blank has nothing worth keeping alive) empty pre-warm's
// idle agent is cruft and gets reaped (its tmux torn down via the kill_session
// reapEmptyConversation enqueues). Pure, so it's unit-testable.
export function shouldReapEmpty(
  conv: { inbox_dismissed_at?: number; inbox_stashed_at?: number },
  hasLiveHeartbeat: boolean,
): boolean {
  return !(hasLiveHeartbeat && !conv.inbox_dismissed_at && !conv.inbox_stashed_at);
}

// Reap a contentless pre-warm. Two-phase, because the live agent must die BEFORE
// the conversation does:
//
//  • If an agent is still heartbeating, enqueue a kill_session command for the
//    owning daemon and STOP — do NOT delete the conversation or its
//    managed_sessions row. The daemon resolves conversation_id -> tmux from those
//    records (its startedSessionTmux map / local conversation cache), so deleting
//    them first orphans the tmux process — the exact leak that left idle `claude`
//    agents running for weeks. The daemon unregisters the managed_session when it
//    kills; the next reap pass (now seeing no live agent) deletes the row. Deduped
//    against an already-queued kill so repeated sweeps don't pile up commands.
//    (Broadcast like switchProject's kill_session: whichever daemon owns it acts.)
//
//  • Once no agent is live, delete the conversation + any stale managed rows + the
//    creation-time git-diff blob.
//
// Caller must have confirmed the conversation has no work (conversationHasNoWork,
// or the GC sweep's inline checks).
// Enqueue a broadcast kill_session for the conversation's agent, deduped against
// a still-pending kill so repeated sweeps/dismissals don't pile up commands.
// Returns true if a command was inserted (false = one is already queued).
export async function enqueueKillSessionCommand(
  ctx: { db: any },
  conv: { _id: any; user_id: any; session_id?: string },
  now: number = Date.now(),
): Promise<boolean> {
  const pending = await ctx.db
    .query("daemon_commands")
    .withIndex("by_user_pending", (q: any) => q.eq("user_id", conv.user_id).eq("executed_at", undefined))
    .collect();
  const alreadyQueued = hasRecentPendingDaemonCommand(pending, {
    conversationId: conv._id.toString(),
    command: "kill_session",
    now,
    dedupeWindowMs: 60 * 60 * 1000,
  });
  if (alreadyQueued) return false;
  await ctx.db.insert("daemon_commands", {
    user_id: conv.user_id,
    command: "kill_session" as const,
    // session_id rides along (mirrors conversations.killSession) so the daemon
    // can still tear the backend down when its conversation mapping is gone.
    args: JSON.stringify({ conversation_id: conv._id, session_id: conv.session_id }),
    created_at: now,
  });
  return true;
}

export async function reapEmptyConversation(
  ctx: { db: any },
  conv: { _id: any; user_id: any },
  managed?: any[],
): Promise<"kill_enqueued" | "deleted"> {
  const now = Date.now();
  const sessions = managed ?? await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
    .collect();
  const hasLiveAgent = sessions.some((m: any) => (m.last_heartbeat ?? 0) > now - LIVE_HEARTBEAT_MS);

  if (hasLiveAgent) {
    await enqueueKillSessionCommand(ctx, conv, now);
    return "kill_enqueued";
  }

  for (const m of sessions) await ctx.db.delete(m._id);
  const diffs = await ctx.db
    .query("conversation_git_diffs")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
    .collect();
  for (const d of diffs) await ctx.db.delete(d._id);
  await ctx.db.delete(conv._id);
  return "deleted";
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
    let killed = 0;

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
      // A live heartbeat means a process (terminal / pre-warmed agent) is still
      // attached. Keep protecting it WHILE the conversation is still active in the
      // inbox — but once the user has DISMISSED an empty pre-warm, that idle agent
      // is cruft, not a worker: reap it. reapEmptyConversation enqueues the
      // kill_session that tears the tmux down (deleting the managed row alone would
      // orphan it). Undismissed live empties (a fresh pre-warm, an open terminal)
      // stay protected.
      const live = managed.some((m) => m.last_heartbeat > now - LIVE_HEARTBEAT_MS);
      if (!shouldReapEmpty(c, live)) continue;

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

      // A live agent → enqueue kill_session and defer deletion to a later pass
      // (deleting now would orphan its tmux). No live agent → delete the
      // conversation + managed rows + the creation-time git-diff blob now.
      const outcome = await reapEmptyConversation(ctx, c, managed);
      if (outcome === "deleted") deleted++; else killed++;
    }

    if (deleted > 0 || killed > 0) {
      console.log(`gcEmptyConversations: deleted ${deleted}, killed ${killed} of ${rows.length} scanned (window ${new Date(since).toISOString()} → ${new Date(until).toISOString()})`);
    }
    return {
      scanned: rows.length,
      deleted,
      killed,
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

// Destructive admin/migration op — run from the dashboard/CLI with the admin key,
// never reachable as a public mutation (it took an arbitrary user_id with no auth).
export const clearUserConversations = internalMutation({
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

export const clearUserMessages = internalMutation({
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
export const forceDeleteConversations = internalMutation({
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
export const deleteConversationsByType = internalMutation({
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

export async function deleteConversationBySessionIdCore(
  ctx: { db: any },
  args: { session_id: string; conversation_id?: string },
) {
  const matches = await ctx.db
    .query("conversations")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
    .collect();
  const conv = args.conversation_id
    ? matches.find((m: any) => m._id === args.conversation_id)
    : matches.length === 1
      ? matches[0]
      : null;
  if (!conv && matches.length > 1) {
    return {
      found: true,
      ambiguous: true,
      candidates: matches.map((m: any) => ({
        id: m._id,
        title: m.title,
        message_count: m.message_count,
        created_at: m._creationTime,
        updated_at: m.updated_at,
      })),
      deleted: 0,
      done: true,
    };
  }
  if (!conv) return { found: false, deleted: 0, done: true };
  const msgs = await ctx.db
    .query("messages")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
    .take(500);
  for (const m of msgs) await ctx.db.delete(m._id);
  // Drop the conversation only once its messages are drained, so a caller
  // can loop until done without orphaning rows past the per-call batch.
  const done = msgs.length < 500;
  if (done) await ctx.db.delete(conv._id);
  return { found: true, deleted: msgs.length, done };
}

export const deleteConversationBySessionId = internalMutation({
  args: {
    session_id: v.string(),
    // Required when more than one conversation is bound to the session_id.
    // A session with twins is exactly the doppelgänger state — .first() there
    // resolves by creation time and once deleted a LIVE original instead of
    // the stray mint (ct-36973). Refuse to guess; the caller must pick.
    conversation_id: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => deleteConversationBySessionIdCore(ctx, args),
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
