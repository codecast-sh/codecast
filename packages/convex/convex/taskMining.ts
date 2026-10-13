import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction, query } from "./functions";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id, Doc } from "./_generated/dataModel";
import { attachCommentSessionInfo } from "./lib/commentSessionInfo";
import { canAccessConversation, canAccessDoc, canAccessPlan, canAccessTask } from "./lib/access";
import { inboxVisibilityFields } from "./inboxProjection";
import { liveConversationIdSet } from "./lib/liveSessions";
import { docRelatesToTask } from "@codecast/shared/tasks";
import { graphNeighbors } from "./lib/taskGraph";

function normalizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

export function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeTitle(a));
  const wordsB = new Set(normalizeTitle(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}


const internalApi = internal as any;

// Get all users (for cron backfill)
export const getAllUsers = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("users").collect();
  },
});

export const getStalePlansWithSessions = internalQuery({
  args: { user_id: v.id("users"), stale_before: v.number() },
  handler: async (ctx, args) => {
    const plans = await ctx.db
      .query("plans")
      .withIndex("by_user_status", (q) => q.eq("user_id", args.user_id).eq("status", "active"))
      .collect();
    // Return plans with session links — the caller checks if insight is newer than plan
    return plans.filter((p: any) => p.session_ids?.length > 0);
  },
});

export const getLatestInsightForConversation = internalQuery({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("session_insights")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .order("desc")
      .first();
  },
});

export const refreshPlanTimestamp = internalMutation({
  args: { plan_id: v.id("plans"), updated_at: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.plan_id, { updated_at: args.updated_at });
  },
});

export const webGetDocDetail = query({
  // Raw string, not v.id("docs"): the docs detail route (/docs/<id>) can be reached
  // with a non-doc id when a malformed link (e.g. a conversation id) is clicked.
  // v.id("docs") would throw ArgumentValidationError and crash the whole dashboard
  // shell; normalizeId returns null for any id outside the docs table so we render a
  // graceful "not found" instead.
  args: {
    id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const docId = ctx.db.normalizeId("docs", args.id);
    if (!docId) return null;
    const doc = await ctx.db.get(docId);
    if (!doc) return null;

    // Owner or effective-team member. The hand-rolled raw-tag check leaked a doc
    // linked to a private conversation to the team; canAccessDoc resolves the
    // effective team instead.
    if (!(await canAccessDoc(ctx, userId, doc))) return null;

    let conversation = null;
    if (doc.conversation_id) {
      const conv = await ctx.db.get(doc.conversation_id);
      if (conv) {
        conversation = {
          _id: conv._id,
          title: conv.title || conv.subtitle,
          project_path: conv.project_path,
          session_id: conv.session_id,
          message_count: conv.message_count,
          started_at: conv.started_at,
          updated_at: conv.updated_at,
        };
      }
    }

    // Tasks the same session filed for this doc: the reverse of the task
    // page's related docs, so the two views agree (docRelatesToTask).
    let relatedTasks: any[] = [];
    if (doc.conversation_id) {
      const allTasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_id", (q) => q.eq("user_id", doc.user_id))
        .collect();
      relatedTasks = allTasks.filter(
        (t) => t.created_from_conversation === doc.conversation_id && docRelatesToTask(doc, t)
      );
    }

    // Find other sessions that reference the same themes, scoped to the doc's
    // own team. A teamless (personal) doc has no cross-session neighbourhood.
    let relatedSessions: any[] = [];
    if (doc.labels?.length && doc.conversation_id && doc.team_id) {
      const insights = await ctx.db
        .query("session_insights")
        .withIndex("by_team_generated_at", (q) =>
          q.eq("team_id", doc.team_id as Id<"teams">)
        )
        .order("desc")
        .take(100);

      relatedSessions = insights
        .filter(i =>
          i.conversation_id !== doc.conversation_id &&
          i.themes.some((t: string) => doc.labels?.includes(t))
        )
        .slice(0, 5)
        .map(i => ({
          _id: i._id,
          conversation_id: i.conversation_id,
          summary: i.summary,
          outcome_type: i.outcome_type,
          themes: i.themes,
          generated_at: i.generated_at,
        }));
    }

    // Load author profile
    const author = await ctx.db.get(doc.user_id);
    const authorInfo = author
      ? { author_name: author.name, author_image: author.image || (author as any).github_avatar_url }
      : {};

    const result: any = {
      ...doc,
      ...authorInfo,
      conversation,
      related_tasks: relatedTasks,
      related_sessions: relatedSessions,
    };

    // Extract plan title from content
    if (doc.source === "plan_mode" && doc.content) {
      const titleMatch = doc.content.match(/^#\s+(.+)/m);
      if (titleMatch) {
        result.display_title = titleMatch[1].trim();
        result.plan_name = doc.title;
      }
    }

    // Load related conversations
    const convIds = doc.related_conversation_ids || (doc.conversation_id ? [doc.conversation_id] : []);
    if (convIds.length > 0) {
      const convs = [];
      for (const cid of convIds) {
        const conv = await ctx.db.get(cid);
        if (conv) {
          const entry: any = {
            _id: conv._id,
            session_id: conv.session_id,
            title: conv.title,
            headline: (conv as any).headline,
            project_path: conv.project_path,
            started_at: (conv as any).started_at || conv._creationTime,
            updated_at: conv.updated_at,
            message_count: conv.message_count,
            is_active: (conv as any).is_active,
            agent_type: conv.agent_type,
            outcome_type: (conv as any).outcome_type,
            git_branch: (conv as any).git_branch,
            short_id: conv.short_id,
            // Triage/visibility stamps: the client seeds these snapshots into its
            // sessions cache (useOpenLinkedSession), so a stashed/dismissed session
            // must not seed as an active row (ct-42666).
            ...inboxVisibilityFields(conv),
          };
          const insight = await ctx.db
            .query("session_insights")
            .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
            .first();
          if (insight) {
            entry.key_changes = insight.key_changes;
            entry.turns = insight.turns;
            entry.timeline = insight.timeline;
            entry.blockers = insight.blockers;
            entry.next_action = insight.next_action;
            if (!entry.headline) entry.headline = insight.headline;
            if (!entry.outcome_type) entry.outcome_type = insight.outcome_type;
          }
          convs.push(entry);
        }
      }
      result.related_conversations = convs;
    }

    return result;
  },
});

/** A task's direct children the viewer may read, oldest first, capped: a
 *  checklist, never a crawl. */
async function directSubtasks(ctx: any, userId: Id<"users">, taskId: Id<"tasks">): Promise<Doc<"tasks">[]> {
  const rows: Doc<"tasks">[] = await ctx.db
    .query("tasks")
    .withIndex("by_parent_id", (q: any) => q.eq("parent_id", taskId))
    .take(100);
  const out: Doc<"tasks">[] = [];
  for (const r of rows) if (await canAccessTask(ctx, userId, r)) out.push(r);
  return out.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
}

export const webGetTaskDetail = query({
  args: {
    id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    let task: Doc<"tasks"> | null = null;
    if (args.id.startsWith("ct-") || args.id.startsWith("pl-")) {
      task = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.id))
        .first();
    } else {
      try {
        // db.get is table-blind: a conversation / doc / plan id resolves to *that*
        // document, not a task. Only accept it if it's genuinely a task (tasks always
        // carry a `ct-` short_id), otherwise a `/tasks/<conversationId>` link would
        // render the conversation as a fake task (no created_at -> "Invalid Date").
        const doc = await ctx.db.get(args.id as Id<"tasks">);
        task = doc && typeof doc.short_id === "string" && doc.short_id.startsWith("ct-") ? doc : null;
      } catch {
        task = await ctx.db
          .query("tasks")
          .withIndex("by_short_id", (q) => q.eq("short_id", args.id))
          .first();
      }
    }
    if (!task || !await canAccessTask(ctx, userId, task)) return null;

    const comments = await ctx.db
      .query("task_comments")
      .withIndex("by_task_id", (q) => q.eq("task_id", task._id))
      .collect();

    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    const liveConvIds = await liveConversationIdSet(ctx, task.user_id, { now });

    const linkedConversations: any[] = [];
    const seenConvIds = new Set<string>();
    const pushLinked = async (conv: any) => {
      seenConvIds.add(conv._id.toString());
      const isActive = conv.status === "active" && (conv.updated_at > fiveMinutesAgo || liveConvIds.has(conv._id.toString()));
      const entry: any = {
        _id: conv._id,
        session_id: conv.session_id,
        title: conv.title || conv.subtitle,
        headline: (conv as any).headline,
        project_path: conv.project_path,
        message_count: conv.message_count || 0,
        is_active: isActive,
        started_at: (conv as any).started_at || conv._creationTime,
        updated_at: conv.updated_at,
        agent_type: conv.agent_type,
        outcome_type: (conv as any).outcome_type,
        git_branch: (conv as any).git_branch,
        git_remote_url: conv.git_remote_url,
        // Triage/visibility stamps: the client seeds these snapshots into its
        // sessions cache (useOpenLinkedSession), so a stashed/dismissed session
        // must not seed as an active row (ct-42666).
        ...inboxVisibilityFields(conv),
      };
      if (String(conv.active_task_id ?? "") === String(task._id) && String(conv.review_of_task_id ?? "") !== String(task._id)) {
        entry.bound = true;
      }
      if (isActive) {
        const recentMsgs = await ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conv._id))
          .order("desc")
          .take(5);
        entry.recent_messages = recentMsgs.reverse().map((m: any) => ({
          _id: m._id,
          role: m.role,
          content: typeof m.content === "string" ? m.content.slice(0, 300) : "",
          timestamp: m.timestamp,
        }));
      }
      linkedConversations.push(entry);
    };
    for (const convId of task.conversation_ids ?? []) {
      if (seenConvIds.has(convId.toString())) continue;
      const conv = await ctx.db.get(convId);
      if (conv && await canAccessConversation(ctx, userId, conv)) await pushLinked(conv);
    }
    const allConvs = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q: any) => q.eq("user_id", task.user_id))
      .order("desc")
      .take(100)
      .then((convs: any[]) => convs.filter((c: any) => c.active_task_id === task._id));
    for (const conv of allConvs) {
      if (seenConvIds.has(conv._id.toString()) || !await canAccessConversation(ctx, userId, conv)) continue;
      await pushLinked(conv);
    }
    // The task's one owning session (lib/taskOwner.ts): the newest bound one,
    // which is the only one once every binding goes through claimTaskOwnership.
    const owner = linkedConversations.filter((lc) => lc.bound).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
    for (const lc of linkedConversations) delete lc.bound;
    if (owner) owner.is_owner = true;

    for (const lc of linkedConversations) {
      const insight = await ctx.db
        .query("session_insights")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", lc._id))
        .first();
      if (insight) {
        lc.key_changes = insight.key_changes;
        lc.turns = insight.turns;
        lc.timeline = insight.timeline;
        lc.blockers = insight.blockers;
        lc.next_action = insight.next_action;
        if (!lc.headline) lc.headline = insight.headline;
        if (!lc.outcome_type) lc.outcome_type = insight.outcome_type;
      }
    }

    // The origin session's docs, narrowed to the ones it wrote for this task
    // (docRelatesToTask): a long-lived session's whole journal is not related.
    let relatedDocs: any[] = [];
    if (task.created_from_conversation) {
      const convDocs = await ctx.db
        .query("docs")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", task.created_from_conversation))
        .collect();
      for (const d of convDocs) {
        if (d.archived_at || !docRelatesToTask(d, task) || !await canAccessDoc(ctx, userId, d)) continue;
        relatedDocs.push({
          _id: d._id,
          title: d.title,
          doc_type: d.doc_type,
          source: d.source,
          created_at: d.created_at,
        });
      }
    }

    let insight = null;
    if (task.created_from_insight) {
      const candidate = await ctx.db.get(task.created_from_insight);
      const conversation = candidate?.conversation_id ? await ctx.db.get(candidate.conversation_id) : null;
      if (candidate && conversation && await canAccessConversation(ctx, userId, conversation)) insight = candidate;
    }

    // Get creator info
    const taskUser = await ctx.db.get(task.user_id);
    const creator = taskUser ? {
      _id: taskUser._id,
      name: taskUser.name || taskUser.email || "Unknown",
      image: taskUser.image || taskUser.github_avatar_url,
      github_username: taskUser.github_username,
    } : null;

    // Get assignee info
    // A role assignee is resolved by the client from the org tree slice, never
    // read here: a role row is patched on every message its sessions sync, and
    // reading it would re-run this detail query each time (see tasks.ts
    // enrichTasks; org-roles-run-work.md R5).
    let assignee_info = null;
    if (task.assignee && !ctx.db.normalizeId("org_roles", task.assignee)) {
      try {
        const assigneeUser = await ctx.db.get(task.assignee as any);
        if (assigneeUser) assignee_info = { name: (assigneeUser as any).name || (assigneeUser as any).email || "Unknown", image: (assigneeUser as any).image || (assigneeUser as any).github_avatar_url, github_username: (assigneeUser as any).github_username };
      } catch {
        assignee_info = { name: task.assignee as string };
      }
    }

    // Get audit history
    const history = await ctx.db
      .query("task_history")
      .withIndex("by_task_id", (q) => q.eq("task_id", task._id))
      .collect();

    // Resolve user names/images for history entries
    const historyUserIds = [...new Set(history.filter(h => h.user_id).map(h => h.user_id!))];
    const historyUsers = new Map<string, { name: string; image?: string; github_username?: string }>();
    for (const uid of historyUserIds) {
      const u = await ctx.db.get(uid);
      if (u) historyUsers.set(uid.toString(), { name: u.name || u.email || "Unknown", image: u.image || u.github_avatar_url, github_username: u.github_username });
    }

    const assigneeIds = [...new Set(
      history.filter(h => h.field === "assignee")
        .flatMap(h => [h.old_value, h.new_value].filter(Boolean))
    )];
    const assigneeNames = new Map<string, { name: string; image?: string; github_username?: string }>();
    for (const aid of assigneeIds) {
      if (!aid) continue;
      try {
        const u = await ctx.db.get(aid as any);
        if (u) assigneeNames.set(aid, { name: (u as any).name || (u as any).email || "Unknown", image: (u as any).image || (u as any).github_avatar_url, github_username: (u as any).github_username });
      } catch {}
    }

    const enrichedHistory = history.map(h => ({
      ...h,
      actor: h.user_id ? historyUsers.get(h.user_id.toString()) : null,
      ...(h.field === "assignee" ? {
        old_value_resolved: h.old_value ? assigneeNames.get(h.old_value) : null,
        new_value_resolved: h.new_value ? assigneeNames.get(h.new_value) : null,
      } : {}),
    }));

    const nameToImage = new Map<string, string>();
    for (const u of historyUsers.values()) {
      if (u.image) nameToImage.set(u.name, u.image);
    }
    if (creator?.image) nameToImage.set(creator.name, creator.image);
    const enrichedComments = (await attachCommentSessionInfo(ctx, comments, userId)).map(c => ({
      ...c,
      author_image: nameToImage.get(c.author) || null,
    }));

    let plan = null;
    if (task.plan_id) {
      const p = await ctx.db.get(task.plan_id);
      if (p && await canAccessPlan(ctx, userId, p)) plan = { _id: p._id, short_id: p.short_id, title: p.title, status: p.status };
    }

    const graph = await graphNeighbors(ctx, task);
    // graphNeighbors keeps rows in the task's workspace; a viewer may read the
    // task through a grant alone, so only rows they may read ship whole.
    const graphTasks: Doc<"tasks">[] = [];
    for (const t of graph.tasks) if (await canAccessTask(ctx, userId, t)) graphTasks.push(t);

    return {
      ...task,
      assignee_info,
      comments: enrichedComments,
      linked_conversations: linkedConversations,
      // The task's direct children, so a surface that never mounted the task
      // list (a session's task chip) draws the same subtask checklist and
      // progress. The client files each into the one tasks collection.
      subtasks: await directSubtasks(ctx, userId, task._id),
      // The tasks its graph names (blockers, blocks, links), filed the same
      // way, so Blocked by shows a finished blocker's state, not "unknown",
      // and the refs that name no task, which it shows as not found.
      graph_tasks: graphTasks,
      graph_missing: graph.missing,
      related_docs: relatedDocs,
      source_insight: insight,
      creator,
      history: enrichedHistory,
      plan,
    };
  },
});

export const backfillMinedTimestamps = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tasks = await ctx.db.query("tasks").collect();
    let patched = 0;
    for (const task of tasks) {
      if (task.source !== "insight" || !task.created_from_insight) continue;
      const insight = await ctx.db.get(task.created_from_insight);
      if (!insight?.generated_at) continue;
      if (Math.abs(task.created_at - insight.generated_at) < 60000) continue;
      await ctx.db.patch(task._id, {
        created_at: insight.generated_at,
        updated_at: insight.generated_at,
        ...(task.closed_at ? { closed_at: insight.generated_at } : {}),
      });
      patched++;
    }

    const docs = await ctx.db.query("docs").collect();
    let docsPatched = 0;
    for (const doc of docs) {
      if (doc.source !== "agent" || !doc.conversation_id) continue;
      const conv = await ctx.db.get(doc.conversation_id);
      if (!conv?.started_at) continue;
      if (Math.abs(doc.created_at - conv.started_at) < 60000) continue;
      await ctx.db.patch(doc._id, {
        created_at: conv.started_at,
        updated_at: conv.started_at,
      });
      docsPatched++;
    }

    return { tasks_patched: patched, docs_patched: docsPatched };
  },
});

// Cron: a plan whose linked sessions moved since its last update takes the
// newest insight's time as its own, so plans with sessions but no task links
// still sort by activity.
export const refreshPlanTimestamps = internalAction({
  args: {},
  handler: async (ctx) => {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let plansUpdated = 0;
    const allUsers: any[] = await ctx.runQuery(internalApi.taskMining.getAllUsers);
    for (const user of allUsers) {
      const stalePlans: any[] = await ctx.runQuery(internalApi.taskMining.getStalePlansWithSessions, {
        user_id: user._id,
        stale_before: since,
      });
      for (const plan of stalePlans) {
        if (!plan.session_ids?.length) continue;
        for (const convId of plan.session_ids) {
          const insight: any = await ctx.runQuery(internalApi.taskMining.getLatestInsightForConversation, {
            conversation_id: convId,
          });
          if (insight && insight.generated_at > plan.updated_at) {
            await ctx.runMutation(internalApi.taskMining.refreshPlanTimestamp, {
              plan_id: plan._id,
              updated_at: insight.generated_at,
            });
            plansUpdated++;
            break;
          }
        }
      }
    }
    return { plans_updated: plansUpdated };
  },
});

export const backfillTaskProjectPaths = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const result = await ctx.db.query("tasks").paginate({ numItems: 200, cursor: args.cursor as any || null });
    let patched = 0;
    for (const task of result.page) {
      if ((task as any).project_path) continue;
      const convId = (task as any).created_from_conversation;
      if (!convId) continue;
      const conv = await ctx.db.get(convId as any) as any;
      const projectPath = conv?.project_path || (conv as any)?.git_root;
      if (projectPath) {
        await ctx.db.patch(task._id, { project_path: projectPath } as any);
        patched++;
      }
    }
    return { patched, pageSize: result.page.length, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});
