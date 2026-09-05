import { internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { redactSecrets } from "./redact";
import { normalizeRepository } from "./lib/gitRefs";

// One-time backfill: stamp conversations.model from each conversation's newest
// assistant message carrying a real model id ("<synthetic>" = error banner, not
// a model). addMessages/addMessage roll the field forward on every new batch;
// this covers rows written before that rollup existed. Only conversations
// updated after `since` are stamped — older ones pick it up organically if they
// wake. Pass auto:true to self-drain page by page via the scheduler.
//   npx convex run migrations:backfillConversationModels '{"dryRun":false,"auto":true}'
export const backfillConversationModels = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    since: v.optional(v.number()),
    auto: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = args.numItems ?? 50;
    // Stable across continuations — computed once on the first page.
    const since = args.since ?? Date.now() - 60 * 24 * 60 * 60 * 1000;
    const page = await ctx.db
      .query("conversations")
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems });

    let stamped = 0;
    for (const conv of page.page) {
      if (conv.model || conv.updated_at < since) continue;
      const recent = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
        .order("desc")
        .take(12);
      const src = recent.find((m) => m.role === "assistant" && m.model && m.model !== "<synthetic>");
      if (!src?.model) continue;
      if (!dryRun) await ctx.db.patch(conv._id, { model: src.model });
      stamped++;
    }

    if (args.auto && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillConversationModels, {
        dryRun,
        cursor: page.continueCursor,
        numItems,
        since,
        auto: true,
      });
    }
    return { dryRun, stamped, scanned: page.page.length, done: page.isDone, cursor: page.continueCursor };
  },
});

function looksLikeUserMessage(content: string | undefined): boolean {
  if (!content) return false;
  const c = content.trim().toLowerCase();

  // Assistant message patterns - if it starts with these, it's NOT a user message
  const assistantPatterns = [
    "i'll ", "i will ", "let me ", "i can ", "i'm going to ", "i am going to ",
    "here's ", "here is ", "i've ", "i have ", "i would ", "i'd ",
    "based on ", "looking at ", "after ", "now ", "the ", "this ",
    "first, ", "to ", "yes, ", "sure, ", "great, ", "okay, ",
    "i understand", "i see", "i notice", "i found", "i analyzed",
    "```", "done.", "completed.", "finished.", "fixed.",
  ];

  for (const pattern of assistantPatterns) {
    if (c.startsWith(pattern)) return false;
  }

  // Very long messages are likely assistant messages
  if (content.length > 500) return false;

  // User message patterns - questions, commands, short messages
  const userPatterns = [
    "?", // questions
    "can you ", "could you ", "please ", "help ", "what ", "how ", "why ",
    "where ", "when ", "which ", "who ", "do ", "does ", "is ", "are ",
    "tell me ", "show me ", "explain ", "describe ", "list ", "find ",
    "create ", "make ", "add ", "remove ", "delete ", "update ", "change ",
    "fix ", "run ", "test ", "check ", "verify ", "debug ",
    "yes", "no", "ok", "okay", "sure", "thanks", "continue", "go ahead",
    "so what ", "we will ", "we need ", "we want ", "i want ", "i need ",
    "lets ", "let's ", "@", // file references in cursor/claude
  ];

  for (const pattern of userPatterns) {
    if (c.includes(pattern)) return true;
  }

  // Short messages are more likely user messages
  if (content.length < 100) return true;

  return false;
}

// Backfill messages.from_user_id from the delivered pending_messages rows that
// produced them. addMessage/addMessages now stamp the sender when the daemon
// echoes a send back into the transcript, but rows written before that stamp
// existed render as the conversation owner. Joins messages.client_id ->
// pending_messages.client_id within one conversation and patches the missing
// sender; bumps transcript_revision so open clients pull the changed rows.
//   npx convex run migrations:backfillMessageSenders '{"conversation_id":"...","dryRun":false}'
export const backfillMessageSenders = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return { error: "conversation not found" };
    const pending = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .collect();
    let revision = conversation.transcript_revision ?? 0;
    let matched = 0;
    let patched = 0;
    const details: Array<Record<string, unknown>> = [];
    for (const pm of pending) {
      const detail: Record<string, unknown> = {
        status: pm.status,
        hasClientId: !!pm.client_id,
        from: pm.from_user_id,
        preview: (pm.content || "").slice(0, 60),
      };
      details.push(detail);
      if (!pm.from_user_id) continue;
      // Primary join: the echo stamped the pending row's client_id onto the
      // stored message. Fallback for rows consumed by the content-dedup path
      // (which historically dropped client_id): exact-content match among the
      // conversation's user messages near the delivery time.
      let msg = null;
      if (pm.client_id) {
        const clientId = pm.client_id;
        msg = await ctx.db
          .query("messages")
          .withIndex("by_conversation_client_id", (q) =>
            q.eq("conversation_id", args.conversation_id).eq("client_id", clientId))
          .first();
      }
      if (!msg) {
        const around = pm.delivered_at ?? pm.created_at;
        const candidates = await ctx.db
          .query("messages")
          .withIndex("by_conversation_role_timestamp", (q) =>
            q.eq("conversation_id", args.conversation_id).eq("role", "user")
              .gte("timestamp", around - 15 * 60 * 1000))
          .take(200);
        // Same fuzz as findEchoedPendingMessage: image refs stripped, secrets
        // redacted, whitespace flattened.
        const norm = (s: string) =>
          s.replace(/\[Image[:\s][^\]]*\]/gi, "").replace(/\[image\]/gi, "").replace(/\s+/g, " ").trim();
        const want = norm(redactSecrets(pm.content || ""));
        if (!want) continue;
        let textMatches = candidates.filter((m) => norm(m.content || "") === want);
        // Queued sends can be injected as one combined turn — fall back to
        // containment when exact match finds nothing.
        if (textMatches.length === 0 && want.length >= 20) {
          textMatches = candidates.filter((m) => norm(m.content || "").includes(want));
        }
        // Ambiguity guard: identical content sent twice can't be attributed safely.
        if (textMatches.length === 1) msg = textMatches[0];
        else detail.ambiguous = textMatches.length;
      }
      if (!msg) continue;
      matched++;
      detail.matched = true;
      if (msg.from_user_id) continue;
      if (!dryRun) {
        await ctx.db.patch(msg._id, { from_user_id: pm.from_user_id, transcript_revision: ++revision });
      }
      patched++;
    }
    if (!dryRun && revision !== (conversation.transcript_revision ?? 0)) {
      await ctx.db.patch(args.conversation_id, { transcript_revision: revision });
    }
    return { dryRun, pendingRows: pending.length, matched, patched, details: dryRun ? details : undefined };
  },
});

export const setAdminRole = internalMutation({
  args: {
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const users = await ctx.db.query("users").collect();
    const user = users.find((u) => u.email === args.email);
    if (!user) {
      return { success: false, error: `User with email ${args.email} not found` };
    }
    await ctx.db.patch(user._id, { role: "admin" });
    return { success: true, userId: user._id, email: user.email };
  },
});

export const fixCorruptedMessageRoles = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;

    const allConversations = await ctx.db
      .query("conversations")
      .order("desc")
      .take(limit + offset);

    const conversations = allConversations.slice(offset);

    let fixedCount = 0;
    let checkedConversations = 0;
    const fixes: Array<{ conversationId: string; messageId: string; oldRole: string; newRole: string; preview: string }> = [];

    for (const conv of conversations) {
      checkedConversations++;

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
        .take(20);

      if (messages.length === 0) continue;

      messages.sort((a, b) => a.timestamp - b.timestamp);

      const firstMsg = messages[0];
      if (firstMsg.role === "assistant" && !firstMsg.tool_calls?.length && !firstMsg.thinking && looksLikeUserMessage(firstMsg.content)) {
        fixes.push({
          conversationId: conv._id,
          messageId: firstMsg._id,
          oldRole: firstMsg.role,
          newRole: "user",
          preview: (firstMsg.content || "").slice(0, 80),
        });

        if (!dryRun) {
          await ctx.db.patch(firstMsg._id, { role: "user" });
        }
        fixedCount++;
      }

      for (let i = 1; i < messages.length && i < 15; i++) {
        const msg = messages[i];
        const prevMsg = messages[i - 1];

        if (
          msg.role === "assistant" &&
          prevMsg.role === "assistant" &&
          !msg.tool_calls?.length &&
          !msg.thinking &&
          !msg.tool_results?.length &&
          looksLikeUserMessage(msg.content)
        ) {
          fixes.push({
            conversationId: conv._id,
            messageId: msg._id,
            oldRole: msg.role,
            newRole: "user",
            preview: (msg.content || "").slice(0, 80),
          });

          if (!dryRun) {
            await ctx.db.patch(msg._id, { role: "user" });
          }
          fixedCount++;
        }
      }
    }

    return {
      dryRun,
      checkedConversations,
      fixedCount,
      fixes: fixes.slice(0, 50),
    };
  },
});

export const fixTaskSourceFromAgent = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;

    const tasks = await ctx.db.query("tasks").collect();
    const convCache = new Map<string, string | null>();

    let checked = 0;
    let fixed = 0;
    const fixes: Array<{ taskId: string; title: string; agentType: string }> = [];

    for (const task of tasks) {
      checked++;
      if (task.source !== "human" || !task.created_from_conversation) continue;

      const convIdStr = task.created_from_conversation.toString();
      let agentType: string | null;
      if (convCache.has(convIdStr)) {
        agentType = convCache.get(convIdStr)!;
      } else {
        try {
          const conv = await ctx.db.get(task.created_from_conversation);
          agentType = conv?.agent_type || null;
        } catch {
          agentType = null;
        }
        convCache.set(convIdStr, agentType);
      }

      if (agentType) {
        fixes.push({
          taskId: task._id,
          title: task.title,
          agentType,
        });
        if (!dryRun) {
          await ctx.db.patch(task._id, { source: "agent" as any });
        }
        fixed++;
      }
    }

    return { dryRun, checked, fixed, fixCount: fixes.length };
  },
});

// internalQuery, not query: this samples the most recent conversations across
// EVERY user and returns titles plus a preview of each first message, and it
// walks `messages` (millions of rows) with no index. As a public function it
// was both a cross-tenant leak and a denial-of-service handed to anyone with
// the deployment URL. It has no callers; kept as internal for one-off use.
export const analyzeMessageRoles = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 20, 50);

    const conversations = await ctx.db
      .query("conversations")
      .order("desc")
      .take(limit);

    const stats = {
      totalConversations: conversations.length,
      conversationsChecked: 0,
      conversationsWithMessages: 0,
      conversationsWithIssues: 0,
      firstMessageNotUser: 0,
      consecutiveAssistant: 0,
      examples: [] as Array<{
        conversationId: string;
        title: string | undefined;
        firstMessageRole: string;
        firstMessagePreview: string;
        messageCount: number;
      }>,
    };

    for (const conv of conversations) {
      stats.conversationsChecked++;

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
        .take(10);

      if (messages.length === 0) continue;
      stats.conversationsWithMessages++;

      messages.sort((a, b) => a.timestamp - b.timestamp);

      const firstMsg = messages[0];
      if (firstMsg.role !== "user") {
        stats.firstMessageNotUser++;
        stats.conversationsWithIssues++;

        if (stats.examples.length < 10) {
          stats.examples.push({
            conversationId: conv._id,
            title: conv.title,
            firstMessageRole: firstMsg.role,
            firstMessagePreview: (firstMsg.content || "").slice(0, 100),
            messageCount: conv.message_count,
          });
        }
      }

      for (let i = 1; i < messages.length; i++) {
        if (messages[i].role === "assistant" && messages[i - 1].role === "assistant") {
          if (!messages[i].tool_calls?.length && !messages[i].thinking) {
            stats.consecutiveAssistant++;
            break;
          }
        }
      }
    }

    return stats;
  },
});

// One-time backfill: rewrite every indexed repository name to its canonical
// spelling (`normalizeRepository`: lower case). Every writer now stores that
// form and every reader searches for it, so a row stored with capitals before
// this rule existed can never be found by index. The installation table is in
// the list because every repository lookup splits the owner out and searches
// `by_account_login`. Idempotent: a row already canonical is skipped, so a
// re-run is a no-op. Pass auto:true to drain each table and continue with the
// next one via the scheduler.
//   npx convex run migrations:canonicalizeRepositoryNames '{"dryRun":false,"auto":true}'
export const REPOSITORY_NAME_TABLES = [
  "pull_requests",
  "commits",
  "review_comments",
  "external_events",
  "github_check_suites",
  "github_app_installations",
] as const;
type RepositoryNameTable = (typeof REPOSITORY_NAME_TABLES)[number];

/** The field that carries the repository name (or, for installations, the owner login). */
function repositoryNameField(table: RepositoryNameTable): "repository" | "account_login" {
  return table === "github_app_installations" ? "account_login" : "repository";
}

export const canonicalizeRepositoryNames = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    table: v.optional(v.union(...REPOSITORY_NAME_TABLES.map((t) => v.literal(t)))),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    auto: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = args.numItems ?? 200;
    const table: RepositoryNameTable = args.table ?? REPOSITORY_NAME_TABLES[0];
    const field = repositoryNameField(table);
    const page = await ctx.db
      .query(table)
      .paginate({ cursor: args.cursor ?? null, numItems });

    let rewritten = 0;
    for (const row of page.page as Array<Record<string, any>>) {
      const stored = row[field];
      const canonical = normalizeRepository(stored);
      if (typeof stored !== "string" || stored === canonical) continue;
      if (!dryRun) await ctx.db.patch(row._id, { [field]: canonical });
      rewritten++;
    }

    const nextTable = page.isDone
      ? REPOSITORY_NAME_TABLES[REPOSITORY_NAME_TABLES.indexOf(table) + 1]
      : table;
    if (args.auto && nextTable) {
      await ctx.scheduler.runAfter(0, internal.migrations.canonicalizeRepositoryNames, {
        dryRun,
        table: nextTable,
        cursor: page.isDone ? undefined : page.continueCursor,
        numItems,
        auto: true,
      });
    }
    return { dryRun, table, rewritten, scanned: page.page.length, done: page.isDone, cursor: page.continueCursor };
  },
});
