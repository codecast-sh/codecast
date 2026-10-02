import { internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { redactSecrets } from "./redact";
import { normalizeRepository } from "./lib/gitRefs";
import { commitRecordedBy } from "./githubWebhooks";
import { repositoryOfCheckout } from "./users";
import { standingReportsToFields } from "./lib/standingSeat";
import { listSessionOwnerIds, stampSeatOwners } from "./sessionOwners";
import { EXECUTIVE_ASSISTANT_NAME, HEAD_OF_PEOPLE_HANDLE, HEAD_OF_PEOPLE_NAME, LEGACY_HEAD_OF_PEOPLE_HANDLE, LEGACY_HEAD_OF_PEOPLE_NAME, isHeadOfPeopleRole } from "@codecast/shared/contracts/orgLead";
import { defaultAssistantHandle, executiveAssistantCharter, ensureRoleRoutine, headOfPeopleCharter, roleRoutineOf, standingConversationOf } from "./orgRoles";
import { isScopeless } from "./lib/orgScope";
import { personName } from "./sessionOwnership";
import { seatTitlePatch } from "./anchors";
import { findRoleRoutineInAnyStatus, isLiveTrigger, liveRoutinesOf } from "./lib/orgRoutine";
import { applyCancel, applyReactivate } from "./agentTasks";

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

// One-time backfill: give every legacy task→conversation link an association
// row (entity_conversations), so the reverse lookup is exact.
//
// tasks.conversation_ids is an array field, and an array field cannot be
// indexed for containment. The association rail is the reverse index, but every
// path only started dual-writing it on 2026-08-01, so links older than that
// exist solely in the array. tasks.webListByConversation reads the rail plus
// two narrower indexes and is correct without this backfill for the common
// shapes (the task a session filed, the task it is working); this closes the
// remaining case — a task linked to a SECOND session before the rail existed.
//
//   packages/convex/run.sh migrations:backfillTaskConversationLinks '{"dryRun":false,"auto":true}'
export const backfillTaskConversationLinks = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    auto: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = args.numItems ?? 100;
    const page = await ctx.db.query("tasks").paginate({
      cursor: args.cursor ?? null,
      numItems,
    });

    let linked = 0;
    let scanned = 0;
    for (const task of page.page) {
      const convIds = task.conversation_ids ?? [];
      if (convIds.length === 0) continue;
      scanned++;
      const entityId = String(task._id);
      const existing = await ctx.db
        .query("entity_conversations")
        .withIndex("by_entity", (q) => q.eq("entity_type", "task").eq("entity_id", entityId))
        .collect();
      const have = new Set(existing.map((row) => String(row.conversation_id)));
      for (const convId of convIds) {
        if (have.has(String(convId))) continue;
        // The conversation may be gone (a deleted session leaves the id behind
        // in the array); a dangling rail row would only be filtered on read, so
        // skip it here instead.
        if (!(await ctx.db.get(convId))) continue;
        linked++;
        if (dryRun) continue;
        await ctx.db.insert("entity_conversations", {
          user_id: task.user_id,
          team_id: task.team_id,
          entity_type: "task" as const,
          entity_id: entityId,
          conversation_id: convId,
          // The legacy array records no relationship; "work" is what every
          // linking path (dispatch, task start) writes.
          relationship: "work" as const,
          created_at: task.created_at ?? Date.now(),
        });
        have.add(String(convId));
      }
    }

    if (args.auto && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillTaskConversationLinks, {
        ...args,
        cursor: page.continueCursor,
      });
    }
    return { dryRun, scanned_linked_tasks: scanned, rows_written: linked, isDone: page.isDone, cursor: page.continueCursor };
  },
});

// One-time repair: unlink commits a merge handed to the wrong session.
//
// Until 2026-09-22 a push that merged main into a branch linked every main
// commit it carried to the one session sitting on that branch (the branch
// fallback in conversationForCommit ignored GitHub's `distinct` flag), so a
// session's timeline filled with its team's unrelated main history. A row is
// unlinked only when all three hold: no edit row from that session names the
// sha; the row was first stored on another branch than the session's; and the
// GitHub commit event, written when the commit was first seen, names another
// session or none, so the link was added afterwards.
//   packages/convex/run.sh migrations:unlinkMergedCommits '{"dryRun":false,"auto":true}'
export const unlinkMergedCommits = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    auto: v.optional(v.boolean()),
    scanned: v.optional(v.number()),
    unlinked: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = args.numItems ?? 200;
    const page = await ctx.db.query("commits").paginate({ cursor: args.cursor ?? null, numItems });

    let scanned = args.scanned ?? 0;
    let unlinked = args.unlinked ?? 0;
    const samples: string[] = [];
    for (const row of page.page) {
      scanned++;
      if (!row.conversation_id) continue;
      const conversation = await ctx.db.get(row.conversation_id);
      if (!conversation?.git_branch || !row.branch || row.branch === conversation.git_branch) continue;
      if ((await commitRecordedBy(ctx, row.sha)) === row.conversation_id) continue;
      const event = await ctx.db
        .query("external_events")
        .withIndex("by_dedupe_key", (q) => q.eq("dedupe_key", `commit:${row.sha}`))
        .first();
      if (!event || event.conversation_id === row.conversation_id) continue;
      unlinked++;
      if (samples.length < 5) samples.push(`${row.sha.slice(0, 7)} ${row.branch} -> ${row.conversation_id} (${conversation.git_branch})`);
      if (!dryRun) await ctx.db.patch(row._id, { conversation_id: undefined });
    }

    if (args.auto && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.unlinkMergedCommits, {
        ...args,
        cursor: page.continueCursor,
        scanned,
        unlinked,
      });
    } else if (args.auto) {
      console.log(`[unlinkMergedCommits] done dryRun=${dryRun} scanned=${scanned} unlinked=${unlinked}`);
    }
    return { dryRun, scanned, unlinked, samples, isDone: page.isDone, cursor: page.continueCursor };
  },
});

// One-time: stamp directory_team_mappings.repository from the sessions
// recorded under each mapped checkout, so a rule written before the field
// existed reaches the owner's other clones and worktrees. Idempotent: rows
// that carry the key, or whose folder has no session with a remote, are
// skipped. Small table; one pass.
//   packages/convex/run.sh migrations:stampMappingRepositories '{"dryRun":false}'
export const stampMappingRepositories = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const rows = await ctx.db.query("directory_team_mappings").collect();
    const stamped: Array<{ path_prefix: string; repository: string }> = [];
    let skipped = 0;
    for (const row of rows) {
      if (row.repository) { skipped++; continue; }
      const repository = await repositoryOfCheckout(ctx, row.user_id, row.path_prefix);
      if (!repository) { skipped++; continue; }
      if (!dryRun) await ctx.db.patch(row._id, { repository });
      stamped.push({ path_prefix: row.path_prefix, repository });
    }
    return { dryRun, scanned: rows.length, stamped, skipped };
  },
});

// One-time cleanup (org-staffing.md S28): `cast escalate` is gone, and with it
// the `escalated_by_role` stamp it wrote on a role's session. Nothing reads
// the field any more; this clears it from every row that still carries it, so
// the schema can drop the field afterwards (Convex refuses a schema the rows
// do not fit). Dry by default.
//   npx convex run migrations:clearEscalationStamps '{"dryRun":false}'
export const clearEscalationStamps = internalMutation({
  args: { dryRun: v.optional(v.boolean()), cursor: v.optional(v.string()), numItems: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const page = await ctx.db.query("conversations").paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 200 });
    const stamped = page.page.filter((c: any) => c.escalated_by_role !== undefined);
    if (!dryRun) for (const c of stamped) await ctx.db.patch(c._id, { escalated_by_role: undefined });
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.clearEscalationStamps, { dryRun, cursor: page.continueCursor, numItems: args.numItems });
    }
    return { dryRun, scanned: page.page.length, cleared: stamped.length, done: page.isDone };
  },
});

// One-time backfill (org-staffing.md S28): a role's standing session carries
// its parent role in `org_role_id` so it rides the parent lead's card. Roles
// seated before the rule have it unset; roles that report to a person must
// have it clear. Dry by default.
//   npx convex run migrations:stampStandingSeats '{"dryRun":false}'
export const stampStandingSeats = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const roles = (await ctx.db.query("org_roles").collect()).filter((r: any) => r.status !== "retired");
    const out: Array<{ role: string; standing: string; from: string | null; to: string | null }> = [];
    for (const role of roles as any[]) {
      const anchor: any = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
      const standing: any = anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
      if (!standing) continue;
      const { org_role_id } = standingReportsToFields(role);
      // The seat's owner is the person the role reports to (sessionOwners.stampSeatOwners).
      const boss = role.reports_to?.kind === "user" ? String(role.reports_to.user_id) : null;
      const owners = (await listSessionOwnerIds(ctx, standing._id)).map(String);
      const ownersRight = boss ? owners.length === 1 && owners[0] === boss : owners.length === 0;
      if (String(standing.org_role_id ?? "") === String(org_role_id ?? "") && ownersRight) continue;
      out.push({ role: role.handle, standing: standing.short_id ?? String(standing._id), from: `${standing.org_role_id ? String(standing.org_role_id) : "person"} owners=${owners.join(",") || "none"}`, to: `${org_role_id ? String(org_role_id) : "person"} owner=${boss ?? "none"}` });
      if (!dryRun) {
        await ctx.db.patch(standing._id, { org_role_id });
        // Written as the boss's own row, so the backfill hands nobody a ping.
        await stampSeatOwners(ctx, standing._id, role.reports_to, role.reports_to?.kind === "user" ? role.reports_to.user_id : role.host_user_id);
      }
    }
    return { dryRun, roles: roles.length, stamped: out.length, changes: out };
  },
});

// The Head of People rename (org-staffing.md S30). Every role that still
// answers to `chief-of-staff` and is not an Executive Assistant is the Head of
// People under its old name: a team's gets the new handle, the birth name
// where it kept the default, the Head of People's charter, its seat retitled
// and its review routine refreshed. The personal workspace's root is the
// agent the person already talks to, so with `personal_root: "convert"` it
// becomes their global Executive Assistant instead: the handle, name and
// charter become the assistant's (the old handle always names the Head of
// People), the Company review is cancelled and the assistant's daily check
// armed; a person who already has a global assistant is skipped. The charter
// doc (what the agent reads) follows the row: its heading names the new role,
// and its charter paragraph is replaced only while it is still the old
// default text; a charter a person wrote stays and is reported. A row the run
// already renamed gets the doc pass alone, so the run is idempotent. Every
// row records what changed in `renamed_from`, and `reverse: true` puts it
// back. Dry by default.
//   npx convex run migrations:renameHeadOfPeople '{"dryRun":false,"personal_root":"convert"}'
//   npx convex run migrations:renameHeadOfPeople '{"dryRun":false,"only":["or-19","or-35"]}'   (team roots only)
//   npx convex run migrations:renameHeadOfPeople '{"dryRun":false,"scope":"team"}'
export type RenameHeadPlanRow = {
  role: string; workspace: string; action: "rename" | "convert" | "doc" | "reverse" | "skip";
  from: { handle: string; name: string }; to: { handle: string; name: string };
  seat: string | null; retitle: boolean; charter: boolean;
  /** What happens to the charter doc: rewritten (heading and the default
   *  charter), heading (a person's charter stays), current (already names
   *  the role), custom (not the template; untouched), null (no doc). */
  charter_doc?: CharterDocOutcome | null;
  /** Convert only: the review trigger cancelled, and whether the personal
   *  workspace has other roles and so still needs a Head of People. */
  review_cancelled?: string | null; needs_head_of_people?: boolean;
  reason?: string;
};

export type RenameHeadArgs = {
  dryRun?: boolean;
  personal_root?: "head_of_people" | "convert";
  reverse?: boolean;
  /** Only these roles (short ids like "or-19"), so a run can take the team
   *  roots now and leave other people's personal agents for later. */
  only?: string[];
  /** Only team roots, or only personal roots. */
  scope?: "team" | "user";
};

// The charter was the opening's job paragraph (the right hand's); a charter
// a person wrote is theirs and stays.
const OLD_DEFAULT_CHARTER_RE = /right hand|keep .* goals in view/i;
const isOldDefaultCharter = (text?: string | null) => !text || OLD_DEFAULT_CHARTER_RE.test(text);

export type CharterDocOutcome = "rewritten" | "heading" | "current" | "custom";
const charterHeading = (r: { name: string; handle: string }) => `# Charter: ${r.name} (@${r.handle})`;

/** The charter doc as the run leaves it: the heading names the role as it
 *  is now, and the charter paragraph (what sits before the first section) is
 *  replaced only while it is the old default. Null when nothing changes. */
export function rewriteCharterDoc(content: string, was: { name: string; handle: string }, to: { name: string; handle: string }, charter: string): { content: string; outcome: CharterDocOutcome } | null {
  const [heading, ...rest] = content.split("\n");
  const named = heading === charterHeading(was) ? "old" : heading === charterHeading(to) ? "new" : null;
  if (!named) return null;
  const body = rest.join("\n");
  const at = body.search(/^## /m);
  const paragraph = (at < 0 ? body : body.slice(0, at)).trim();
  const isDefault = isOldDefaultCharter(paragraph);
  if (named === "new" && !isDefault) return null;
  const next = [charterHeading(to), "", isDefault ? charter : paragraph, ...(at < 0 ? [] : ["", body.slice(at).trimStart()])].join("\n");
  return next === content ? null : { content: next, outcome: isDefault ? "rewritten" : "heading" };
}

/** The outcome a doc reports when it is not rewritten. */
const charterDocOutcomeOf = (content: string, to: { name: string; handle: string }): CharterDocOutcome => (content.split("\n")[0] === charterHeading(to) ? "current" : "custom");

export async function performRenameHeadOfPeople(
  ctx: any,
  args: RenameHeadArgs,
): Promise<{ dryRun: boolean; reverse: boolean; rows: RenameHeadPlanRow[] }> {
  const dryRun = args.dryRun ?? true;
  const reverse = !!args.reverse;
  const convertPersonal = (args.personal_root ?? "head_of_people") === "convert";
  const only = args.only?.length ? new Set(args.only.map((s) => s.trim())) : null;
  const all: any[] = await ctx.db.query("org_roles").collect();
  const roles = all.filter((r) => (!only || only.has(r.short_id) || only.has(String(r._id))) && (!args.scope || r.scope_type === args.scope));
  const rows: RenameHeadPlanRow[] = [];
  const now = Date.now();
  for (const role of roles) {
    const workspace = role.team_id ? ((await ctx.db.get(role.team_id))?.name ?? "a team") : `${personName(await ctx.db.get(role.scope_user_id ?? role.host_user_id))}'s personal workspace`;
    const standing = await standingConversationOf(ctx, role);
    const seat = standing?.short_id ?? null;
    if (reverse) {
      const was = role.renamed_from;
      if (!was) continue;
      const retitle = !!standing && standing.title === role.name;
      rows.push({ role: role.short_id, workspace, action: "reverse", from: { handle: role.handle, name: role.name }, to: { handle: was.handle, name: was.name }, seat, retitle, charter: was.charter !== undefined, charter_doc: was.charter_doc !== undefined ? "rewritten" : null, review_cancelled: was.review_trigger_id ? String(was.review_trigger_id) : null });
      if (dryRun) continue;
      await ctx.db.patch(role._id, { handle: was.handle, name: was.name, charter: was.charter, assistant: undefined, renamed_from: undefined, updated_at: now });
      if (was.charter_doc !== undefined && role.charter_doc_id) await ctx.db.patch(role.charter_doc_id, { content: was.charter_doc, updated_at: now });
      if (retitle) await ctx.db.patch(standing._id, { ...seatTitlePatch(standing, was.name), updated_at: now });
      if (was.routine_trigger_id) { const t = await ctx.db.get(was.routine_trigger_id); if (t && isLiveTrigger(t)) await applyCancel(ctx, t); }
      if (was.review_trigger_id) { const t = await ctx.db.get(was.review_trigger_id); if (t) await applyReactivate(ctx, t); }
      continue;
    }
    const doc = role.charter_doc_id ? await ctx.db.get(role.charter_doc_id) : null;
    const person = personName(await ctx.db.get(role.reports_to?.kind === "user" ? role.reports_to.user_id : role.host_user_id));
    // The charter doc follows the row: rewritten here for a row renamed on
    // this run, and alone for a row an earlier run renamed before the doc
    // was part of it. The content before is kept so reverse restores it.
    const docPatch = async (was: { name: string; handle: string }, charter: string): Promise<CharterDocOutcome | null> => {
      if (!doc) return null;
      const fresh = await ctx.db.get(role._id);
      const next = rewriteCharterDoc(doc.content ?? "", was, fresh, charter);
      if (!next) return charterDocOutcomeOf(doc.content ?? "", fresh);
      if (!dryRun) {
        await ctx.db.patch(doc._id, { content: next.content, updated_at: now });
        await ctx.db.patch(role._id, { renamed_from: { ...fresh.renamed_from, charter_doc: doc.content ?? "" } });
      }
      return next.outcome;
    };
    if (role.renamed_from && !role.assistant && role.status !== "retired" && role.renamed_from.charter_doc === undefined && doc) {
      const next = rewriteCharterDoc(doc.content ?? "", role.renamed_from, role, role.charter ?? headOfPeopleCharter(person));
      if (!next) continue;
      rows.push({ role: role.short_id, workspace, action: "doc", from: { handle: role.handle, name: role.name }, to: { handle: role.handle, name: role.name }, seat, retitle: false, charter: false, charter_doc: next.outcome, reason: "renamed by an earlier run; the charter doc alone" });
      await docPatch(role.renamed_from, role.charter ?? headOfPeopleCharter(person));
      continue;
    }
    if (role.handle !== LEGACY_HEAD_OF_PEOPLE_HANDLE || role.assistant || role.renamed_from) continue;
    if (role.status === "retired") {
      // A retired seat keeps its name in history; only its handle moves, so
      // a later hire does not meet a dead row under the live handle.
      rows.push({ role: role.short_id, workspace, action: "rename", from: { handle: role.handle, name: role.name }, to: { handle: HEAD_OF_PEOPLE_HANDLE, name: role.name }, seat, retitle: false, charter: false, reason: "retired" });
      if (!dryRun) await ctx.db.patch(role._id, { handle: HEAD_OF_PEOPLE_HANDLE, renamed_from: { handle: role.handle, name: role.name, at: now }, updated_at: now });
      continue;
    }
    const defaultName = role.name === LEGACY_HEAD_OF_PEOPLE_NAME;
    const was = { handle: role.handle, name: role.name };
    if (role.scope_type === "user" && convertPersonal) {
      const others = all.filter((r) => r._id !== role._id && String(r.scope_user_id ?? "") === String(role.scope_user_id) && r.status !== "retired");
      const has = others.find(isGlobalAssistant);
      if (has) { rows.push({ role: role.short_id, workspace, action: "skip", from: { handle: role.handle, name: role.name }, to: { handle: role.handle, name: role.name }, seat, retitle: false, charter: false, reason: `${has.short_id} is already their global Executive Assistant` }); continue; }
      const review = standing ? await findRoleRoutineInAnyStatus(ctx, role, standing) : null;
      const handle = defaultAssistantHandle({ reach: "global" }, true, null, (h) => others.some((r) => r.handle === h));
      const retitle = !!standing && standing.title === role.name;
      const row: RenameHeadPlanRow = { role: role.short_id, workspace, action: "convert", from: was, to: { handle, name: EXECUTIVE_ASSISTANT_NAME }, seat, retitle, charter: true, review_cancelled: review && isLiveTrigger(review) ? (review.short_id ?? String(review._id)) : null, needs_head_of_people: others.length > 0 };
      rows.push(row);
      if (!dryRun) {
        const renamed_from: any = { handle: role.handle, name: role.name, charter: role.charter, converted: true, at: now, ...(review ? { review_trigger_id: review._id } : {}) };
        await ctx.db.patch(role._id, { assistant: { reach: "global" }, handle, name: EXECUTIVE_ASSISTANT_NAME, charter: executiveAssistantCharter(person), renamed_from, updated_at: now });
      }
      row.charter_doc = doc ? (dryRun ? (rewriteCharterDoc(doc.content ?? "", was, { handle, name: EXECUTIVE_ASSISTANT_NAME }, executiveAssistantCharter(person))?.outcome ?? charterDocOutcomeOf(doc.content ?? "", { handle, name: EXECUTIVE_ASSISTANT_NAME })) : await docPatch(was, executiveAssistantCharter(person))) : null;
      if (dryRun) continue;
      if (review && isLiveTrigger(review)) await applyCancel(ctx, review);
      if (standing) {
        if (retitle) await ctx.db.patch(standing._id, { ...seatTitlePatch(standing, EXECUTIVE_ASSISTANT_NAME), updated_at: now });
        const routine = await ensureRoleRoutine(ctx, await ctx.db.get(role._id), standing);
        await ctx.db.patch(role._id, { renamed_from: { ...(await ctx.db.get(role._id)).renamed_from, routine_trigger_id: routine.id } });
      }
      continue;
    }
    const name = defaultName ? HEAD_OF_PEOPLE_NAME : role.name;
    const retitle = !!standing && standing.title === role.name && defaultName;
    const charter = isOldDefaultCharter(role.charter);
    const to = { handle: HEAD_OF_PEOPLE_HANDLE, name };
    const nextCharter = charter ? headOfPeopleCharter(person) : role.charter;
    const row: RenameHeadPlanRow = { role: role.short_id, workspace, action: "rename", from: was, to, seat, retitle, charter };
    rows.push(row);
    if (!dryRun) await ctx.db.patch(role._id, { handle: HEAD_OF_PEOPLE_HANDLE, name, ...(charter ? { charter: nextCharter } : {}), renamed_from: { handle: role.handle, name: role.name, ...(charter ? { charter: role.charter } : {}), at: now }, updated_at: now });
    row.charter_doc = doc ? (dryRun ? (rewriteCharterDoc(doc.content ?? "", was, to, nextCharter)?.outcome ?? charterDocOutcomeOf(doc.content ?? "", to)) : await docPatch(was, nextCharter)) : null;
    if (dryRun) continue;
    if (retitle) await ctx.db.patch(standing._id, { ...seatTitlePatch(standing, name), updated_at: now });
    // The routine's prompt names the role; refresh brings it up to date.
    if (standing) await roleRoutineOf(ctx, await ctx.db.get(role._id), standing);
  }
  return { dryRun, reverse, rows };
}

export const renameHeadOfPeople = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    personal_root: v.optional(v.union(v.literal("head_of_people"), v.literal("convert"))),
    reverse: v.optional(v.boolean()),
    only: v.optional(v.array(v.string())),
    scope: v.optional(v.union(v.literal("team"), v.literal("user"))),
  },
  handler: async (ctx, args) => performRenameHeadOfPeople(ctx, args),
});

const isGlobalAssistant = (r: any) => r.assistant?.reach === "global" && r.status !== "retired";

// A personal role a person already works with becomes their global Executive
// Assistant (org-staffing.md S30). The row gains `assistant` and nothing else
// moves: its name, handle, brief, standing session and triggers are as they
// were. Its charter keeps its words too, except that a charter written before
// the rename calls the structure role by its old name, and that one phrase is
// brought up to date on the row and in the charter doc. Only the roles named
// by short id are touched, and `reverse: true` puts both back. Dry by default.
//   npx convex run migrations:seatExecutiveAssistant '{"only":["or-44"]}'
//   npx convex run migrations:seatExecutiveAssistant '{"dryRun":false,"only":["or-44"]}'
export type SeatAssistantPlanRow = {
  role: string; workspace: string; action: "seat" | "reverse" | "skip";
  name: string; handle: string; reports_to: string | null;
  /** What stays: the standing session, the brief and the live triggers. */
  seat: string | null; brief: boolean; triggers: string[];
  /** Where the charter's phrase is reworded ("role", "doc"), and to what. */
  charter: { in: string[]; from: string; to: string } | null;
  reason?: string;
};

const CHARTER_PHRASE = [`the ${LEGACY_HEAD_OF_PEOPLE_NAME}'s job`, `the ${HEAD_OF_PEOPLE_NAME}'s job`] as const;

export async function performSeatExecutiveAssistant(
  ctx: any,
  args: { dryRun?: boolean; only: string[]; reverse?: boolean },
): Promise<{ dryRun: boolean; reverse: boolean; rows: SeatAssistantPlanRow[] }> {
  const dryRun = args.dryRun ?? true;
  const reverse = !!args.reverse;
  const only = new Set(args.only.map((s) => s.trim()));
  const all: any[] = await ctx.db.query("org_roles").collect();
  const rows: SeatAssistantPlanRow[] = [];
  for (const role of all.filter((r) => only.has(r.short_id))) {
    const standing = await standingConversationOf(ctx, role);
    const boss = role.reports_to?.kind === "user" ? personName(await ctx.db.get(role.reports_to.user_id)) : null;
    const [from, to] = reverse ? [CHARTER_PHRASE[1], CHARTER_PHRASE[0]] : CHARTER_PHRASE;
    const reword = (text?: string) => (text?.includes(from) ? text.split(from).join(to) : undefined);
    const charterDoc = role.charter_doc_id ? await ctx.db.get(role.charter_doc_id) : null;
    const charter = reword(role.charter);
    const charterDocContent = reword(charterDoc?.content);
    const reworded = [...(charter !== undefined ? ["role"] : []), ...(charterDocContent !== undefined ? ["doc"] : [])];
    const twin = all.find((r) => r._id !== role._id && String(r.scope_user_id ?? "") === String(role.scope_user_id ?? "") && isGlobalAssistant(r));
    const reason = role.status === "retired" ? "retired"
      : role.scope_type !== "user" ? "a global Executive Assistant lives in a person's own workspace"
      : !boss ? "it reports to a role, not to a person"
      : !isScopeless(role.scope) ? "it names an area; an Executive Assistant owns none"
      : isHeadOfPeopleRole(role) ? "it is the Head of People"
      : reverse ? (isGlobalAssistant(role) ? undefined : "not a global Executive Assistant")
      : role.assistant ? "already an Executive Assistant"
      : twin ? `${twin.short_id} is already their global Executive Assistant`
      : undefined;
    rows.push({
      role: role.short_id,
      workspace: `${personName(await ctx.db.get(role.scope_user_id ?? role.host_user_id))}'s personal workspace`,
      action: reason ? "skip" : reverse ? "reverse" : "seat",
      name: role.name, handle: role.handle, reports_to: boss,
      seat: standing?.short_id ?? null, brief: !!role.brief_doc_id,
      triggers: standing ? (await liveRoutinesOf(ctx, standing)).map((t: any) => `${t.short_id ?? String(t._id)} ${t.title}`) : [],
      charter: reworded.length && !reason ? { in: reworded, from, to } : null,
      ...(reason ? { reason } : {}),
    });
    if (dryRun || reason) continue;
    const now = Date.now();
    await ctx.db.patch(role._id, { assistant: reverse ? undefined : { reach: "global" }, ...(charter !== undefined ? { charter } : {}), updated_at: now });
    if (charterDocContent !== undefined) await ctx.db.patch(charterDoc._id, { content: charterDocContent, updated_at: now });
  }
  return { dryRun, reverse, rows };
}

export const seatExecutiveAssistant = internalMutation({
  args: { dryRun: v.optional(v.boolean()), only: v.array(v.string()), reverse: v.optional(v.boolean()) },
  handler: async (ctx, args) => performSeatExecutiveAssistant(ctx, args),
});
