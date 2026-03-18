import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction, action, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { createDataContext } from "./data";

// Called after generateSessionInsight saves a new insight — mines tasks + docs for that conversation
export const mineConversationAfterInsight = internalAction({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    insight_id: v.id("session_insights"),
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const internalApi = internal as any;

    // Mine tasks from this single insight
    const insight = await ctx.runQuery(internalApi.taskMining.getInsightById, { insight_id: args.insight_id });
    if (insight) {
      await ctx.runMutation(internalApi.taskMining.mineTasksFromInsights, {
        user_id: args.user_id,
        team_id: args.team_id,
        insights: [insight],
      });
    }

    // Mine session-summary doc from insight (if conversation has enough messages)
    if (insight) {
      const conv: any = await ctx.runQuery(internalApi.taskMining.getConversationById, { conversation_id: args.conversation_id });
      if (conv && (conv.message_count || 0) >= 10 && insight.outcome_type !== "unknown" && insight.summary?.length >= 50) {
        await ctx.runMutation(internalApi.taskMining.mineDocsFromSessions, {
          user_id: args.user_id,
          team_id: args.team_id,
          sessions: [{
            conversation_id: args.conversation_id,
            title: conv.title || insight.goal || "Untitled",
            message_count: conv.message_count || 0,
            project_path: conv.project_path,
            started_at: conv.started_at,
            is_private: conv.is_private,
            team_visibility: conv.team_visibility,
            insight: {
              summary: insight.summary,
              goal: insight.goal,
              what_changed: insight.what_changed,
              blockers: insight.blockers,
              outcome_type: insight.outcome_type,
              themes: insight.themes || [],
            },
          }],
        });
      }
    }

    // Mine raw markdown docs from this conversation's messages
    let afterCreation: number | undefined;
    for (let page = 0; page < 20; page++) {
      const batch: any = await ctx.runQuery(internalApi.taskMining.findMarkdownWrites, {
        conversation_id: args.conversation_id,
        after_creation: afterCreation,
      });
      if (batch.writes.length > 0) {
        await ctx.runMutation(internalApi.taskMining.insertExtractedDocs, {
          user_id: args.user_id,
          team_id: args.team_id,
          conversation_id: args.conversation_id,
          docs: batch.writes,
        });
      }
      if (!batch.hasMore) break;
      afterCreation = batch.lastCreation;
    }
  },
});

// Retrieve a single conversation by ID
export const getConversationById = internalQuery({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.conversation_id);
  },
});

// Retrieve a single insight by ID for targeted mining
export const getInsightById = internalQuery({
  args: { insight_id: v.id("session_insights") },
  handler: async (ctx, args) => {
    const insight = await ctx.db.get(args.insight_id);
    if (!insight) return null;
    const conv = await ctx.db.get(insight.conversation_id);
    return {
      _id: insight._id,
      conversation_id: insight.conversation_id,
      generated_at: insight.generated_at,
      summary: insight.summary,
      goal: insight.goal,
      what_changed: insight.what_changed,
      outcome_type: insight.outcome_type,
      blockers: insight.blockers,
      next_action: insight.next_action,
      themes: insight.themes || [],
      confidence: insight.confidence,
      is_private: conv?.is_private,
      team_visibility: conv?.team_visibility,
    };
  },
});

function generateShortId(prefix = "ct-"): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = prefix;
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function normalizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function titleSimilarity(a: string, b: string): number {
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

const DEDUP_SIMILARITY_THRESHOLD = 0.5;

// Every insight should produce at least one task. We extract:
// 1. The goal itself (shipped = done feature, progress = in_progress task, blocked = blocked bug)
// 2. Each blocker as a separate high-priority bug
// 3. next_action as a follow-up task
export const mineTasksFromInsights = internalMutation({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    insights: v.array(
      v.object({
        _id: v.id("session_insights"),
        conversation_id: v.id("conversations"),
        generated_at: v.optional(v.number()),
        actor_name: v.optional(v.string()),
        summary: v.string(),
        goal: v.optional(v.string()),
        what_changed: v.optional(v.string()),
        outcome_type: v.string(),
        blockers: v.optional(v.array(v.string())),
        next_action: v.optional(v.string()),
        themes: v.array(v.string()),
        confidence: v.optional(v.number()),
        is_private: v.optional(v.boolean()),
        team_visibility: v.optional(v.union(v.literal("summary"), v.literal("full"), v.literal("private"))),
      })
    ),
  },
  handler: async (ctx, args) => {
    let tasksCreated = 0;
    let tasksDeduped = 0;
    let plansCreated = 0;

    const existingTasks = await ctx.db
      .query("tasks")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .filter((q) =>
        q.or(
          q.eq(q.field("status"), "open"),
          q.eq(q.field("status"), "in_progress"),
          q.eq(q.field("status"), "done"),
        )
      )
      .collect();

    const existingPlans = args.team_id
      ? await ctx.db
          .query("plans")
          .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
          .filter((q) =>
            q.or(
              q.eq(q.field("status"), "draft"),
              q.eq(q.field("status"), "active"),
            )
          )
          .collect()
      : [];

    function findSimilarTask(title: string) {
      let bestMatch: (typeof existingTasks)[0] | null = null;
      let bestScore = 0;
      for (const task of existingTasks) {
        const score = titleSimilarity(title, task.title);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = task;
        }
      }
      return bestScore >= DEDUP_SIMILARITY_THRESHOLD ? bestMatch : null;
    }

    function findSimilarPlan(title: string) {
      for (const plan of existingPlans) {
        if (titleSimilarity(title, plan.title) >= DEDUP_SIMILARITY_THRESHOLD) return plan;
        if (plan.goal && titleSimilarity(title, plan.goal) >= DEDUP_SIMILARITY_THRESHOLD) return plan;
      }
      return null;
    }

    const newTaskIds: Id<"tasks">[] = [];
    const newTaskThemes: string[][] = [];

    for (const insight of args.insights) {
      const ts = insight.generated_at || Date.now();
      const labels = insight.themes.length ? insight.themes : undefined;
      const base = {
        user_id: args.user_id,
        team_id: args.team_id,
        labels,
        conversation_ids: [insight.conversation_id],
        created_from_conversation: insight.conversation_id,
        created_from_insight: insight._id,
        source: "insight" as const,
        confidence: insight.confidence,
        is_private: insight.is_private,
        team_visibility: insight.team_visibility,
      };

      const alreadyMined = await ctx.db
        .query("tasks")
        .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
        .filter((q) => q.eq(q.field("created_from_insight"), insight._id))
        .first();
      if (alreadyMined) continue;

      // 1. Primary task from the goal/summary
      if (insight.goal || insight.summary) {
        const title = insight.goal || insight.summary.slice(0, 200);

        const similarTask = findSimilarTask(title);
        const similarPlan = findSimilarPlan(title);

        if (similarTask) {
          await ctx.db.insert("task_comments", {
            task_id: similarTask._id,
            author: "mining",
            text: `Related session insight: ${insight.summary.slice(0, 300)}`,
            conversation_id: insight.conversation_id,
            comment_type: "note" as any,
            created_at: ts,
          });
          tasksDeduped++;
          continue;
        }

        if (similarPlan) {
          tasksDeduped++;
          continue;
        }

        let status: "done" | "in_progress" | "open" = "open";
        let taskType: "feature" | "bug" | "task" = "task";
        let priority: "high" | "medium" | "low" = "medium";

        if (insight.outcome_type === "shipped") {
          status = "done";
          taskType = "feature";
        } else if (insight.outcome_type === "progress") {
          status = "in_progress";
          taskType = "task";
        } else if (insight.outcome_type === "blocked") {
          status = "open";
          taskType = "bug";
          priority = "high";
        }

        const taskId = await ctx.db.insert("tasks", {
          ...base,
          short_id: generateShortId(),
          title,
          description: insight.what_changed || insight.summary,
          task_type: taskType,
          status,
          priority,
          attempt_count: status === "in_progress" ? 1 : 0,
          last_attempted_at: status === "in_progress" ? ts : undefined,
          closed_at: status === "done" ? ts : undefined,
          created_at: ts,
          updated_at: ts,
        });
        existingTasks.push({ ...base, _id: taskId, title, status, task_type: taskType, priority, short_id: "", description: "", attempt_count: 0, created_at: ts, updated_at: ts } as any);
        newTaskIds.push(taskId);
        newTaskThemes.push(insight.themes);
        tasksCreated++;
      }

      // 2. Each blocker as a separate high-priority bug (dedup against existing)
      if (insight.blockers?.length) {
        for (const blocker of insight.blockers) {
          if (findSimilarTask(blocker)) {
            tasksDeduped++;
            continue;
          }
          const taskId = await ctx.db.insert("tasks", {
            ...base,
            short_id: generateShortId(),
            title: blocker,
            description: `Blocker from: ${insight.goal || insight.summary}`,
            task_type: "bug",
            status: "open",
            priority: "high",
            attempt_count: 0,
            created_at: ts,
            updated_at: ts,
          });
          existingTasks.push({ ...base, _id: taskId, title: blocker, status: "open", task_type: "bug", priority: "high", short_id: "", description: "", attempt_count: 0, created_at: ts, updated_at: ts } as any);
          tasksCreated++;
        }
      }

      // 3. next_action as a follow-up task (dedup against existing)
      if (insight.next_action && insight.next_action !== insight.goal) {
        if (!findSimilarTask(insight.next_action)) {
          const taskId = await ctx.db.insert("tasks", {
            ...base,
            short_id: generateShortId(),
            title: insight.next_action,
            description: insight.goal ? `Follow-up from: ${insight.goal}` : undefined,
            task_type: "task",
            status: "open",
            priority: "medium",
            attempt_count: 0,
            created_at: ts,
            updated_at: ts,
          });
          existingTasks.push({ ...base, _id: taskId, title: insight.next_action, status: "open", task_type: "task", priority: "medium", short_id: "", description: "", attempt_count: 0, created_at: ts, updated_at: ts } as any);
          tasksCreated++;
        } else {
          tasksDeduped++;
        }
      }
    }

    // Group related new tasks into a draft plan if 3+ share overlapping themes
    if (newTaskIds.length >= 3 && args.team_id) {
      const themeCounts = new Map<string, number[]>();
      for (let i = 0; i < newTaskThemes.length; i++) {
        for (const theme of newTaskThemes[i]) {
          if (!themeCounts.has(theme)) themeCounts.set(theme, []);
          themeCounts.get(theme)!.push(i);
        }
      }

      const grouped = new Set<number>();
      let dominantTheme: string | null = null;
      for (const [theme, indices] of themeCounts) {
        if (indices.length >= 3 && indices.length > grouped.size) {
          dominantTheme = theme;
          grouped.clear();
          for (const idx of indices) grouped.add(idx);
        }
      }

      if (dominantTheme && grouped.size >= 3) {
        const groupedTaskIds = [...grouped].map((i) => newTaskIds[i]);
        const now = Date.now();
        const planId = await ctx.db.insert("plans", {
          user_id: args.user_id,
          team_id: args.team_id,
          short_id: generateShortId("pl-"),
          title: `${dominantTheme.charAt(0).toUpperCase() + dominantTheme.slice(1)} tasks`,
          goal: `Auto-grouped ${groupedTaskIds.length} related tasks around "${dominantTheme}"`,
          status: "draft",
          source: "insight",
          owner_id: args.user_id,
          task_ids: groupedTaskIds,
          progress: { total: groupedTaskIds.length, done: 0, in_progress: 0, open: groupedTaskIds.length },
          progress_log: [],
          decision_log: [],
          discoveries: [],
          context_pointers: [],
          session_ids: [],
          created_at: now,
          updated_at: now,
        });
        for (const taskId of groupedTaskIds) {
          await ctx.db.patch(taskId, { plan_id: planId });
        }
        plansCreated++;
      }
    }

    return { tasks_created: tasksCreated, tasks_deduped: tasksDeduped, plans_created: plansCreated };
  },
});

// Create a doc for every session that has an insight (not just >100 messages)
export const mineDocsFromSessions = internalMutation({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    sessions: v.array(
      v.object({
        conversation_id: v.id("conversations"),
        title: v.optional(v.string()),
        message_count: v.number(),
        project_path: v.optional(v.string()),
        started_at: v.optional(v.number()),
        actor_name: v.optional(v.string()),
        is_private: v.optional(v.boolean()),
        team_visibility: v.optional(v.union(v.literal("summary"), v.literal("full"), v.literal("private"))),
        insight: v.optional(
          v.object({
            summary: v.string(),
            goal: v.optional(v.string()),
            what_changed: v.optional(v.string()),
            blockers: v.optional(v.array(v.string())),
            outcome_type: v.string(),
            themes: v.optional(v.array(v.string())),
          })
        ),
      })
    ),
  },
  handler: async (ctx, args) => {
    let docsCreated = 0;

    for (const session of args.sessions) {
      if (!session.insight) continue;
      const ts = session.started_at || Date.now();

      const existingDocs = await ctx.db
        .query("docs")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", session.conversation_id))
        .first();
      if (existingDocs) continue;

      const docType =
        session.insight.outcome_type === "blocked"
          ? "investigation"
          : session.insight.outcome_type === "shipped"
            ? "handoff"
            : session.insight.outcome_type === "progress"
              ? "note"
              : "note";

      const contentParts: string[] = [];
      if (session.insight.goal)
        contentParts.push(`## Goal\n${session.insight.goal}`);
      contentParts.push(`## Summary\n${session.insight.summary}`);
      if (session.insight.what_changed)
        contentParts.push(`## What Changed\n${session.insight.what_changed}`);
      if (session.insight.blockers?.length)
        contentParts.push(
          `## Blockers\n${session.insight.blockers.map((b: string) => `- ${b}`).join("\n")}`
        );
      if (session.actor_name)
        contentParts.push(`## Author\n${session.actor_name}`);
      if (session.project_path)
        contentParts.push(`## Project\n\`${session.project_path}\``);

      const conv = await ctx.db.get(session.conversation_id);
      const convTeamId = conv && (!conv.is_private || conv.auto_shared) ? conv.team_id : args.team_id;

      await ctx.db.insert("docs", {
        user_id: args.user_id,
        team_id: convTeamId,
        title: session.title || session.insight.goal || "Untitled Session",
        content: contentParts.join("\n\n"),
        doc_type: docType as any,
        source: "agent",
        conversation_id: session.conversation_id,
        project_path: session.project_path,
        labels: session.insight.themes,
        is_private: session.is_private,
        team_visibility: session.team_visibility,
        created_at: ts,
        updated_at: ts,
      });
      docsCreated++;
    }

    return { docs_created: docsCreated };
  },
});

const internalApi = internal as any;

export const getUserTeamId = internalQuery({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.user_id);
    if (!user) return null;
    return user.active_team_id || null;
  },
});

// Get all teams (for cron backfill)
export const getAllTeams = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("teams").collect();
  },
});

// Get all team members for a team
export const getTeamMembers = internalQuery({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
      .collect();
    const members = [];
    for (const m of memberships) {
      const user = await ctx.db.get(m.user_id);
      if (user) members.push(user);
    }
    return members;
  },
});

// Mine tasks and docs for ALL team members, not just current user
export const webMineAll = action({
  args: {},
  handler: async (ctx, _args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const team_id = await ctx.runQuery(internalApi.taskMining.getUserTeamId, {
      user_id: userId,
    }) as Id<"teams"> | null;

    if (!team_id) return { tasks_created: 0, docs_created: 0, insights_processed: 0, members_processed: 0 };

    const members: any[] = await ctx.runQuery(internalApi.taskMining.getTeamMembers, { team_id });
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

    let totalTasksCreated = 0;
    let totalDocsCreated = 0;
    let totalInsights = 0;

    for (const member of members) {
      const insights: any[] = await ctx.runQuery(
        internalApi.taskMining.getTeamInsights,
        { team_id, since: ninetyDaysAgo }
      );

      const memberInsights = insights.filter((i: any) => i.actor_user_id === member._id);
      if (memberInsights.length === 0) continue;
      totalInsights += memberInsights.length;

      const conversationIds = [...new Set(memberInsights.map((i: any) => i.conversation_id))];
      const conversations: any[] = await ctx.runQuery(
        internalApi.taskMining.getConversationsByIds,
        { conversation_ids: conversationIds }
      );

      const BATCH_SIZE = 25;

      // Mine tasks
      for (let i = 0; i < memberInsights.length; i += BATCH_SIZE) {
        const batch = memberInsights.slice(i, i + BATCH_SIZE);
        const result: any = await ctx.runMutation(
          internalApi.taskMining.mineTasksFromInsights,
          {
            user_id: member._id,
            team_id,
            insights: batch.map((ins: any) => {
              const conv = conversations.find((c: any) => c._id === ins.conversation_id);
              return {
                _id: ins._id,
                conversation_id: ins.conversation_id,
                generated_at: ins.generated_at,
                actor_name: ins.actor_name,
                summary: ins.summary,
                goal: ins.goal,
                what_changed: ins.what_changed,
                outcome_type: ins.outcome_type,
                blockers: ins.blockers,
                next_action: ins.next_action,
                themes: ins.themes || [],
                confidence: ins.confidence,
                is_private: conv?.is_private,
                team_visibility: conv?.team_visibility,
              };
            }),
          }
        );
        totalTasksCreated += result.tasks_created;
      }

      // Mine docs from sessions with substantial insights
      const sessionsForDocs: any[] = [];
      for (const ins of memberInsights) {
        if (ins.outcome_type === "unknown") continue;
        if (!ins.summary || ins.summary.length < 50) continue;
        const conv = conversations.find((c: any) => c._id === ins.conversation_id);
        if (!conv || (conv.message_count || 0) < 10) continue;
        sessionsForDocs.push({
          conversation_id: ins.conversation_id,
          title: conv.title || ins.goal || "Untitled",
          message_count: conv.message_count || 0,
          project_path: conv.project_path,
          started_at: conv.started_at,
          actor_name: ins.actor_name,
          is_private: conv.is_private,
          team_visibility: conv.team_visibility,
          insight: {
            summary: ins.summary,
            goal: ins.goal,
            what_changed: ins.what_changed,
            blockers: ins.blockers,
            outcome_type: ins.outcome_type,
            themes: ins.themes || [],
          },
        });
      }
      for (let i = 0; i < sessionsForDocs.length; i += BATCH_SIZE) {
        const batch = sessionsForDocs.slice(i, i + BATCH_SIZE);
        const result: any = await ctx.runMutation(
          internalApi.taskMining.mineDocsFromSessions,
          { user_id: member._id, team_id, sessions: batch }
        );
        totalDocsCreated += result.docs_created;
      }
    }

    return {
      tasks_created: totalTasksCreated,
      docs_created: totalDocsCreated,
      insights_processed: totalInsights,
      members_processed: members.length,
    };
  },
});

export const mineAllForUser = internalAction({
  args: { user_id: v.id("users"), since_days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const internalApi = internal as any;
    const team_id = await ctx.runQuery(internalApi.taskMining.getUserTeamId, {
      user_id: args.user_id,
    }) as Id<"teams"> | null;
    if (!team_id) return { tasks_created: 0, docs_created: 0 };

    const members: any[] = await ctx.runQuery(internalApi.taskMining.getTeamMembers, { team_id });
    const ninetyDaysAgo = Date.now() - (args.since_days || 90) * 24 * 60 * 60 * 1000;
    let totalDocsCreated = 0;

    for (const member of members) {
      const insights: any[] = await ctx.runQuery(
        internalApi.taskMining.getTeamInsights,
        { team_id, since: ninetyDaysAgo }
      );
      const memberInsights = insights.filter((i: any) => i.actor_user_id === member._id);
      if (memberInsights.length === 0) continue;

      const conversationIds = [...new Set(memberInsights.map((i: any) => i.conversation_id))];
      const conversations: any[] = await ctx.runQuery(
        internalApi.taskMining.getConversationsByIds,
        { conversation_ids: conversationIds }
      );

      const sessionsForDocs: any[] = [];
      for (const ins of memberInsights) {
        if (ins.outcome_type === "unknown") continue;
        if (!ins.summary || ins.summary.length < 50) continue;
        const conv = conversations.find((c: any) => c._id === ins.conversation_id);
        if (!conv || (conv.message_count || 0) < 10) continue;
        sessionsForDocs.push({
          conversation_id: ins.conversation_id,
          title: conv.title || ins.goal || "Untitled",
          message_count: conv.message_count || 0,
          project_path: conv.project_path,
          started_at: conv.started_at,
          actor_name: ins.actor_name,
          is_private: conv.is_private,
          team_visibility: conv.team_visibility,
          insight: {
            summary: ins.summary,
            goal: ins.goal,
            what_changed: ins.what_changed,
            blockers: ins.blockers,
            outcome_type: ins.outcome_type,
            themes: ins.themes || [],
          },
        });
      }
      const BATCH_SIZE = 25;
      for (let i = 0; i < sessionsForDocs.length; i += BATCH_SIZE) {
        const batch = sessionsForDocs.slice(i, i + BATCH_SIZE);
        const result: any = await ctx.runMutation(
          internalApi.taskMining.mineDocsFromSessions,
          { user_id: member._id, team_id, sessions: batch }
        );
        totalDocsCreated += result.docs_created;
      }
    }
    return { docs_created: totalDocsCreated, members_processed: members.length };
  },
});

// Find Write tool calls to .md files in a batch of messages
function classifyDocContent(content: string): string {
  const lower = content.toLowerCase();
  const first2k = lower.slice(0, 2000);
  if (/implementation\s+plan|## phases?\b|## milestones?\b|## timeline/i.test(first2k)) return "plan";
  if (/design\s+doc|architecture|## design|## approach|system\s+design/i.test(first2k)) return "design";
  if (/## spec|specification|## requirements|## api\b|## endpoints/i.test(first2k)) return "spec";
  if (/investigation|root\s+cause|## findings|## analysis|debugging|what.s happening/i.test(first2k)) return "investigation";
  if (/handoff|## status|## context|## next\s+steps|picking\s+up/i.test(first2k)) return "handoff";
  return "note";
}

function extractTitleFromContent(content: string): string {
  const h1 = content.match(/^#\s+(.+)/m);
  if (h1) return h1[1].slice(0, 200);
  const h2 = content.match(/^##\s+(.+)/m);
  if (h2) return h2[1].slice(0, 200);
  const firstLine = content.split("\n").find((l) => l.trim().length > 10);
  if (firstLine) return firstLine.replace(/^[#*\->\s]+/, "").slice(0, 200);
  return "Untitled Document";
}

export const findMarkdownWrites = internalQuery({
  args: {
    conversation_id: v.id("conversations"),
    after_creation: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const results: Array<{ file_path: string; content: string; timestamp: number }> = [];
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q: any) => {
        const q2 = q.eq("conversation_id", args.conversation_id);
        return args.after_creation ? q2.gt("_creationTime", args.after_creation) : q2;
      })
      .take(100);

    let lastCreation = 0;
    for (const msg of msgs) {
      lastCreation = msg._creationTime;

      // Extract large structured markdown from assistant text content
      if (msg.role === "assistant" && msg.content && msg.content.length > 5000) {
        const text = msg.content;
        const headingCount = (text.match(/^#{1,3}\s/gm) || []).length;
        if (headingCount >= 3) {
          const syntheticPath = `inline://${args.conversation_id}/${msg._id}`;
          results.push({ file_path: syntheticPath, content: text, timestamp: msg.timestamp });
        }
      }

      // Extract Write tool calls to .md files
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.name !== "Write") continue;
          let input: any;
          try { input = JSON.parse(tc.input); } catch { continue; }
          const filePath: string = input.file_path || "";
          if (!filePath.endsWith(".md")) continue;
          const content: string = input.content || "";
          if (content.length < 200) continue;
          results.push({ file_path: filePath, content, timestamp: msg.timestamp });
        }
      }
    }
    return { writes: results, lastCreation, hasMore: msgs.length === 100 };
  },
});

// Insert extracted docs for a conversation
export const insertExtractedDocs = internalMutation({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    conversation_id: v.id("conversations"),
    docs: v.array(v.object({
      file_path: v.string(),
      content: v.string(),
      timestamp: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return { docs_created: 0 };

    const existing = await ctx.db
      .query("docs")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .filter((q) => q.eq(q.field("conversation_id"), args.conversation_id))
      .collect();
    const existingFiles = new Set(existing.map((d) => d.source_file).filter(Boolean));

    let docsCreated = 0;
    for (const doc of args.docs) {
      if (existingFiles.has(doc.file_path)) continue;
      existingFiles.add(doc.file_path);

      const isInline = doc.file_path.startsWith("inline://");
      const fileName = isInline ? "" : (doc.file_path.split("/").pop() || doc.file_path);

      let docType: string;
      if (isInline) {
        docType = classifyDocContent(doc.content);
      } else {
        docType = fileName.toLowerCase().includes("plan") ? "plan"
          : fileName.toLowerCase().includes("design") ? "design"
          : fileName.toLowerCase().includes("spec") ? "spec"
          : classifyDocContent(doc.content);
      }

      const title = extractTitleFromContent(doc.content);
      const source = isInline ? "inline_extract" as const : "file_sync" as const;

      await ctx.db.insert("docs", {
        user_id: args.user_id,
        team_id: args.team_id,
        title,
        content: doc.content,
        doc_type: docType as any,
        source: source as any,
        source_file: doc.file_path,
        conversation_id: args.conversation_id,
        project_path: conv.project_path,
        is_private: conv.is_private,
        team_visibility: conv.team_visibility,
        created_at: doc.timestamp,
        updated_at: doc.timestamp,
      });
      docsCreated++;
    }
    return { docs_created: docsCreated };
  },
});

// Scan all conversations for a user and extract markdown docs
export const backfillDocsFromMessages = internalAction({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    const internalApi = internal as any;
    const team_id = await ctx.runQuery(internalApi.taskMining.getUserTeamId, {
      user_id: args.user_id,
    }) as Id<"teams"> | null;

    const members: any[] = team_id
      ? await ctx.runQuery(internalApi.taskMining.getTeamMembers, { team_id })
      : [{ _id: args.user_id }];

    let totalDocs = 0;
    const since = Date.now() - 90 * 24 * 60 * 60 * 1000;
    for (const member of members) {
      let convCursor: number | undefined;
      for (let convPage = 0; convPage < 20; convPage++) {
        const convResult: any = await ctx.runQuery(
          internalApi.taskMining.getRecentConversations,
          { user_id: member._id, since, cursor: convCursor }
        );
        for (const conv of convResult.conversations) {
          let afterCreation: number | undefined;
          for (let page = 0; page < 50; page++) {
            const batch: any = await ctx.runQuery(
              internalApi.taskMining.findMarkdownWrites,
              { conversation_id: conv._id, after_creation: afterCreation }
            );
            if (batch.writes.length > 0) {
              const result: any = await ctx.runMutation(
                internalApi.taskMining.insertExtractedDocs,
                { user_id: member._id, team_id: team_id || undefined, conversation_id: conv._id, docs: batch.writes }
              );
              totalDocs += result.docs_created;
            }
            if (!batch.hasMore) break;
            afterCreation = batch.lastCreation;
          }
        }
        if (!convResult.hasMore) break;
        convCursor = convResult.lastTs;
      }
    }
    return { docs_created: totalDocs, members_processed: members.length };
  },
});

export const getRecentConversations = internalQuery({
  args: { user_id: v.id("users"), since: v.number(), cursor: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const since = args.cursor || args.since;
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q: any) =>
        q.eq("user_id", args.user_id).gt("updated_at", since)
      )
      .take(50);
    const lastTs = convs.length > 0 ? convs[convs.length - 1].updated_at : undefined;
    return { conversations: convs.map((c: any) => ({ _id: c._id })), lastTs, hasMore: convs.length === 50 };
  },
});

// Get ALL team insights (not filtered by user)
export const getTeamInsights = internalQuery({
  args: {
    team_id: v.id("teams"),
    since: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("session_insights")
      .withIndex("by_team_generated_at", (q) =>
        q.eq("team_id", args.team_id).gt("generated_at", args.since)
      )
      .order("desc")
      .take(1000);
  },
});

// Keep for backward compat
export const getRecentInsights = internalQuery({
  args: {
    user_id: v.id("users"),
    team_id: v.id("teams"),
    since: v.number(),
  },
  handler: async (ctx, args) => {
    const insights = await ctx.db
      .query("session_insights")
      .withIndex("by_team_generated_at", (q) =>
        q.eq("team_id", args.team_id).gt("generated_at", args.since)
      )
      .order("desc")
      .take(500);
    return insights.filter((i) => i.actor_user_id === args.user_id);
  },
});

export const getConversationsByIds = internalQuery({
  args: {
    conversation_ids: v.array(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const results = [];
    for (const id of args.conversation_ids) {
      const conv = await ctx.db.get(id);
      if (conv) results.push(conv);
    }
    return results;
  },
});

// Team-wide roadmap: sessions, tasks, docs for ALL team members
export const webGetRoadmap = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const user = await ctx.db.get(userId);
    const team_id = user?.active_team_id;

    const items: Array<{
      type: "session" | "task" | "doc";
      timestamp: number;
      data: any;
    }> = [];

    if (!team_id) return [];

    // Get ALL team insights (all members)
    const recentInsights = await ctx.db
      .query("session_insights")
      .withIndex("by_team_generated_at", (q) =>
        q.eq("team_id", team_id as Id<"teams">)
      )
      .order("desc")
      .take(200);

    // Batch-load users for actor names
    const userIds = [...new Set(recentInsights.map(i => i.actor_user_id))];
    const userMap = new Map<string, string>();
    for (const uid of userIds) {
      const u = await ctx.db.get(uid);
      if (u) userMap.set(uid, u.name || u.email || "Unknown");
    }

    // Batch-load all conversation IDs referenced by insights
    const insightConvIds = [...new Set(recentInsights.map(i => i.conversation_id))];
    const convMap = new Map<string, any>();
    for (const cid of insightConvIds) {
      const conv = await ctx.db.get(cid);
      if (conv) convMap.set(cid, conv);
    }

    for (const insight of recentInsights) {
      const conv = convMap.get(insight.conversation_id);
      items.push({
        type: "session",
        timestamp: insight.generated_at,
        data: {
          _id: insight._id,
          conversation_id: insight.conversation_id,
          summary: insight.summary,
          goal: insight.goal,
          what_changed: insight.what_changed,
          outcome_type: insight.outcome_type,
          blockers: insight.blockers,
          next_action: insight.next_action,
          themes: insight.themes,
          confidence: insight.confidence,
          conversation_title: conv?.title || conv?.subtitle,
          project_path: conv?.project_path,
          git_branch: conv?.git_branch,
          message_count: conv?.message_count,
          actor_user_id: insight.actor_user_id,
          actor_name: userMap.get(insight.actor_user_id) || (insight as any).actor_name,
        },
      });
    }

    // Get ALL team tasks (from all members)
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", team_id as Id<"teams">))
      .collect();
    const memberIds = new Set(memberships.map(m => m.user_id));
    memberIds.add(userId);

    const CONFIG_DOC_NAMES = new Set(["README", "AGENTS", "CLAUDE", "CLAUDE.md", "AGENTS.md", "README.md"]);
    const isNoiseDoc = (d: any) => {
      if (/^[a-z]+ [a-z]+ [a-z]+$/.test(d.title)) return true;
      if (CONFIG_DOC_NAMES.has(d.title)) return true;
      return false;
    };

    // Collect all tasks and docs first, then batch-load conversations
    const allTasks: any[] = [];
    const allDocs: any[] = [];

    for (const memberId of memberIds) {
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_id", (q) => q.eq("user_id", memberId))
        .order("desc")
        .take(100);
      allTasks.push(...tasks);

      const docs = await ctx.db
        .query("docs")
        .withIndex("by_user_id", (q) => q.eq("user_id", memberId))
        .order("desc")
        .take(100);
      allDocs.push(...docs.filter((d: any) => !d.archived_at && !isNoiseDoc(d)));
    }

    // Batch-load conversation titles for tasks and docs
    const taskDocConvIds = new Set<string>();
    for (const t of allTasks) {
      if (t.created_from_conversation) taskDocConvIds.add(t.created_from_conversation);
    }
    for (const d of allDocs) {
      if (d.conversation_id) taskDocConvIds.add(d.conversation_id);
    }
    for (const cid of taskDocConvIds) {
      if (!convMap.has(cid)) {
        const conv = await ctx.db.get(cid as Id<"conversations">);
        if (conv) convMap.set(cid, conv);
      }
    }

    for (const task of allTasks) {
      const conv = task.created_from_conversation ? convMap.get(task.created_from_conversation) : undefined;
      items.push({
        type: "task",
        timestamp: task.created_at,
        data: {
          ...task,
          conversation_title: conv?.title || conv?.subtitle,
          actor_name: userMap.get(task.user_id) || undefined,
        },
      });
    }

    for (const doc of allDocs) {
      const conv = doc.conversation_id ? convMap.get(doc.conversation_id) : undefined;
      items.push({
        type: "doc",
        timestamp: doc.created_at,
        data: {
          _id: doc._id,
          title: doc.title,
          doc_type: doc.doc_type,
          source: doc.source,
          labels: doc.labels,
          project_path: doc.project_path,
          conversation_id: doc.conversation_id,
          conversation_title: conv?.title || conv?.subtitle,
          created_at: doc.created_at,
          updated_at: doc.updated_at,
          actor_name: userMap.get(doc.user_id) || undefined,
        },
      });
    }

    items.sort((a, b) => b.timestamp - a.timestamp);
    return items.slice(0, 300);
  },
});

export const webGetDocDetail = query({
  args: {
    id: v.id("docs"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const doc = await ctx.db.get(args.id);
    if (!doc) return null;

    const user = await ctx.db.get(userId);
    const team_id = user?.active_team_id;
    if (doc.user_id !== userId && doc.team_id !== team_id) return null;

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

    // Find tasks linked to same conversation
    let relatedTasks: any[] = [];
    if (doc.conversation_id) {
      const allTasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_id", (q) => q.eq("user_id", doc.user_id))
        .collect();
      relatedTasks = allTasks.filter(
        (t) => t.created_from_conversation === doc.conversation_id
      );
    }

    // Find other sessions that reference the same themes
    let relatedSessions: any[] = [];
    if (doc.labels?.length && doc.conversation_id) {
      const insights = await ctx.db
        .query("session_insights")
        .withIndex("by_team_generated_at", (q) =>
          q.eq("team_id", (doc.team_id || team_id) as Id<"teams">)
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
        if (conv) convs.push({
          _id: conv._id,
          session_id: conv.session_id,
          title: conv.title,
          project_path: conv.project_path,
          started_at: conv.started_at,
          updated_at: conv.updated_at,
          message_count: conv.message_count,
          short_id: conv.short_id,
        });
      }
      result.related_conversations = convs;
    }

    return result;
  },
});

export const webGetTaskDetail = query({
  args: {
    id: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const task = await ctx.db.get(args.id);
    if (!task) return null;

    const user = await ctx.db.get(userId);
    const team_id = user?.active_team_id;
    if (task.user_id !== userId && task.team_id !== team_id) return null;

    const comments = await ctx.db
      .query("task_comments")
      .withIndex("by_task_id", (q) => q.eq("task_id", task._id))
      .collect();

    const linkedConversations: any[] = [];
    const seenConvIds = new Set<string>();
    if (task.conversation_ids) {
      for (const convId of task.conversation_ids) {
        const conv = await ctx.db.get(convId);
        if (conv) {
          seenConvIds.add(conv._id.toString());
          const entry: any = {
            _id: conv._id,
            session_id: conv.session_id,
            title: conv.title || conv.subtitle,
            headline: (conv as any).headline,
            project_path: conv.project_path,
            message_count: conv.message_count || 0,
            is_active: (conv as any).is_active,
            started_at: (conv as any).started_at || conv._creationTime,
            updated_at: conv.updated_at,
            agent_type: conv.agent_type,
            outcome_type: (conv as any).outcome_type,
            git_branch: (conv as any).git_branch,
          };
          if ((conv as any).is_active) {
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
        }
      }
    }
    const allConvs = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q: any) => q.eq("user_id", task.user_id))
      .order("desc")
      .take(100)
      .then((convs: any[]) => convs.filter((c: any) => c.active_task_id === task._id));
    for (const conv of allConvs) {
      if (seenConvIds.has(conv._id.toString())) continue;
      seenConvIds.add(conv._id.toString());
      const entry: any = {
        _id: conv._id,
        session_id: conv.session_id,
        title: conv.title || conv.subtitle,
        headline: (conv as any).headline,
        project_path: conv.project_path,
        message_count: conv.message_count || 0,
        is_active: (conv as any).is_active,
        started_at: (conv as any).started_at || conv._creationTime,
        updated_at: conv.updated_at,
        agent_type: conv.agent_type,
        outcome_type: (conv as any).outcome_type,
        git_branch: (conv as any).git_branch,
      };
      if ((conv as any).is_active) {
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
    }

    let relatedDocs: any[] = [];
    if (task.created_from_conversation) {
      const convDocs = await ctx.db
        .query("docs")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", task.created_from_conversation))
        .collect();
      relatedDocs = convDocs
        .filter((d) => !d.archived_at)
        .map((d) => ({
          _id: d._id,
          title: d.title,
          doc_type: d.doc_type,
          source: d.source,
          created_at: d.created_at,
        }));
    }

    let insight = null;
    if (task.created_from_insight) {
      insight = await ctx.db.get(task.created_from_insight);
    }

    // Get creator info
    const taskUser = await ctx.db.get(task.user_id);
    const creator = taskUser ? {
      _id: taskUser._id,
      name: taskUser.name || taskUser.email || "Unknown",
      image: taskUser.image || taskUser.github_avatar_url,
    } : null;

    // Get audit history
    const history = await ctx.db
      .query("task_history")
      .withIndex("by_task_id", (q) => q.eq("task_id", task._id))
      .collect();

    // Resolve user names/images for history entries
    const historyUserIds = [...new Set(history.filter(h => h.user_id).map(h => h.user_id!))];
    const historyUsers = new Map<string, { name: string; image?: string }>();
    for (const uid of historyUserIds) {
      const u = await ctx.db.get(uid);
      if (u) historyUsers.set(uid.toString(), { name: u.name || u.email || "Unknown", image: u.image || u.github_avatar_url });
    }

    const enrichedHistory = history.map(h => ({
      ...h,
      actor: h.user_id ? historyUsers.get(h.user_id.toString()) : null,
    }));

    let plan = null;
    if (task.plan_id) {
      const p = await ctx.db.get(task.plan_id);
      if (p) plan = { _id: p._id, short_id: p.short_id, title: p.title, status: p.status };
    }

    return {
      ...task,
      comments,
      linked_conversations: linkedConversations,
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

// Utility to get data counts for the roadmap header
export const webGetTeamStats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const user = await ctx.db.get(userId);
    const team_id = user?.active_team_id;
    if (!team_id) return null;

    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", team_id as Id<"teams">))
      .collect();

    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const insights = await ctx.db
      .query("session_insights")
      .withIndex("by_team_generated_at", (q) =>
        q.eq("team_id", team_id as Id<"teams">).gt("generated_at", ninetyDaysAgo)
      )
      .collect();

    let taskCount = 0;
    let docCount = 0;
    const statusCounts: Record<string, number> = {};
    const memberIds = new Set(memberships.map(m => m.user_id));
    memberIds.add(userId);

    for (const memberId of memberIds) {
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_id", (q) => q.eq("user_id", memberId))
        .collect();
      taskCount += tasks.length;
      for (const t of tasks) {
        statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
      }

      const docs = await ctx.db
        .query("docs")
        .withIndex("by_user_id", (q) => q.eq("user_id", memberId))
        .collect();
      docCount += docs.filter(d => !d.archived_at).length;
    }

    return {
      members: memberships.length,
      sessions: insights.length,
      tasks: taskCount,
      docs: docCount,
      tasksByStatus: statusCounts,
    };
  },
});

// Cron-callable: backfill docs and tasks for all teams from the last 7 days
export const backfillAllTeams = internalAction({
  args: {},
  handler: async (ctx, _args) => {
    const internalApi = internal as any;
    const teams: any[] = await ctx.runQuery(internalApi.taskMining.getAllTeams);
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let totalDocs = 0;
    let totalTasks = 0;

    for (const team of teams) {
      const members: any[] = await ctx.runQuery(internalApi.taskMining.getTeamMembers, { team_id: team._id });
      for (const member of members) {
        // Mine tasks from recent insights
        const insights: any[] = await ctx.runQuery(internalApi.taskMining.getTeamInsights, {
          team_id: team._id,
          since,
        });
        const memberInsights = insights.filter((i: any) => i.actor_user_id === member._id);
        const conversationIds = [...new Set(memberInsights.map((i: any) => i.conversation_id))];
        const conversations: any[] = memberInsights.length > 0
          ? await ctx.runQuery(internalApi.taskMining.getConversationsByIds, { conversation_ids: conversationIds })
          : [];
        if (memberInsights.length > 0) {
          const BATCH_SIZE = 25;
          for (let i = 0; i < memberInsights.length; i += BATCH_SIZE) {
            const batch = memberInsights.slice(i, i + BATCH_SIZE).map((ins: any) => {
              const conv = conversations.find((c: any) => c._id === ins.conversation_id);
              return {
                _id: ins._id,
                conversation_id: ins.conversation_id,
                generated_at: ins.generated_at,
                summary: ins.summary,
                goal: ins.goal,
                what_changed: ins.what_changed,
                outcome_type: ins.outcome_type,
                blockers: ins.blockers,
                next_action: ins.next_action,
                themes: ins.themes || [],
                confidence: ins.confidence,
                is_private: conv?.is_private,
                team_visibility: conv?.team_visibility,
              };
            });
            const result: any = await ctx.runMutation(internalApi.taskMining.mineTasksFromInsights, {
              user_id: member._id,
              team_id: team._id,
              insights: batch,
            });
            totalTasks += result.tasks_created;
          }
        }

        // Mine session-summary docs from insights
        if (memberInsights.length > 0) {
          const sessionsForDocs: any[] = [];
          for (const ins of memberInsights) {
            if (ins.outcome_type === "unknown" || !ins.summary || ins.summary.length < 50) continue;
            const conv = conversations.find((c: any) => c._id === ins.conversation_id);
            if (!conv || (conv.message_count || 0) < 10) continue;
            sessionsForDocs.push({
              conversation_id: ins.conversation_id,
              title: conv.title || ins.goal || "Untitled",
              message_count: conv.message_count || 0,
              project_path: conv.project_path,
              started_at: conv.started_at,
              is_private: conv.is_private,
              team_visibility: conv.team_visibility,
              insight: {
                summary: ins.summary,
                goal: ins.goal,
                what_changed: ins.what_changed,
                blockers: ins.blockers,
                outcome_type: ins.outcome_type,
                themes: ins.themes || [],
              },
            });
          }
          const BATCH_SIZE = 25;
          for (let i = 0; i < sessionsForDocs.length; i += BATCH_SIZE) {
            const result: any = await ctx.runMutation(internalApi.taskMining.mineDocsFromSessions, {
              user_id: member._id,
              team_id: team._id,
              sessions: sessionsForDocs.slice(i, i + BATCH_SIZE),
            });
            totalDocs += result.docs_created;
          }
        }

        // Mine raw markdown docs from recent conversation messages
        const convResult: any = await ctx.runQuery(internalApi.taskMining.getRecentConversations, {
          user_id: member._id,
          since,
        });
        for (const conv of convResult.conversations) {
          let afterCreation: number | undefined;
          for (let page = 0; page < 20; page++) {
            const batch: any = await ctx.runQuery(internalApi.taskMining.findMarkdownWrites, {
              conversation_id: conv._id,
              after_creation: afterCreation,
            });
            if (batch.writes.length > 0) {
              const result: any = await ctx.runMutation(internalApi.taskMining.insertExtractedDocs, {
                user_id: member._id,
                team_id: team._id,
                conversation_id: conv._id,
                docs: batch.writes,
              });
              totalDocs += result.docs_created;
            }
            if (!batch.hasMore) break;
            afterCreation = batch.lastCreation;
          }
        }
      }
    }
    return { docs_created: totalDocs, tasks_created: totalTasks, teams_processed: teams.length };
  },
});
