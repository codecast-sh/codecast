import { action, internalAction, internalMutation, internalQuery, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { isConversationTeamVisible } from "./privacy";

type OutcomeType = "shipped" | "progress" | "blocked" | "unknown";
type InsightGenStatus = {
  status: "ok" | "error" | "skipped" | "unknown";
  reason?: string;
  insight_id?: Id<"session_insights">;
};
type ConversationInsightContext = {
  conversation: {
    _id: Id<"conversations">;
    team_id?: Id<"teams">;
    actor_user_id: Id<"users">;
    title?: string;
    subtitle?: string;
    idle_summary?: string;
    project_path?: string;
    git_branch?: string;
    status: "active" | "completed";
    started_at: number;
    updated_at: number;
  };
  messages: Array<{ role: string; content: string; timestamp: number }>;
  tool_names: string[];
  commits: Array<{
    sha: string;
    message: string;
    files_changed: number;
    insertions: number;
    deletions: number;
    timestamp: number;
  }>;
  prs: Array<{
    number: number;
    title: string;
    state: "open" | "closed" | "merged";
    repository: string;
    updated_at: number;
  }>;
};

const internalApi = internal as any;

function uniqCompact(values: string[] | undefined, maxItems = 8, maxLen = 64): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const val = (raw || "").trim();
    if (!val) continue;
    const normalized = val.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(val.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

function clampConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function safeOutcomeType(value: unknown): OutcomeType {
  if (value === "shipped" || value === "progress" || value === "blocked") return value;
  return "unknown";
}

function normalizeWord(token: string): string {
  return token
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function summarySignature(summary: string): string {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "into",
    "from",
    "that",
    "this",
    "was",
    "were",
    "is",
    "are",
    "to",
    "of",
    "in",
    "on",
    "by",
    "a",
    "an",
  ]);
  const tokens = summary
    .split(/\s+/)
    .map(normalizeWord)
    .filter((t) => t && !stop.has(t))
    .slice(0, 4);
  return tokens.join("-");
}

export const getConversationContextForInsight = internalQuery({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("desc")
      .take(80);

    const chronological = messages.reverse();
    const conversationMessages = chronological
      .filter((m) => (m.role === "user" || m.role === "assistant") && !!m.content)
      .map((m) => ({
        role: m.role,
        content: (m.content || "").slice(0, 500),
        timestamp: m.timestamp,
      }));

    const toolNames = uniqCompact(
      chronological
        .flatMap((m) => (m.tool_calls || []).map((tc) => tc.name))
        .filter(Boolean),
      16,
      80
    );

    const commits = await ctx.db
      .query("commits")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .order("desc")
      .take(20);

    let linkedPrs: Array<{ number: number; title: string; state: "open" | "closed" | "merged"; repository: string; updated_at: number }> = [];
    if (conversation.team_id) {
      const teamPrs = await ctx.db
        .query("pull_requests")
        .withIndex("by_team_id", (q) => q.eq("team_id", conversation.team_id!))
        .collect();

      linkedPrs = teamPrs
        .filter((pr) => pr.linked_session_ids.some((id) => id.toString() === args.conversation_id.toString()))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, 10)
        .map((pr) => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          repository: pr.repository,
          updated_at: pr.updated_at,
        }));
    }

    return {
      conversation: {
        _id: conversation._id,
        team_id: conversation.team_id,
        actor_user_id: conversation.user_id,
        title: conversation.title,
        subtitle: conversation.subtitle,
        idle_summary: conversation.idle_summary,
        project_path: conversation.project_path,
        git_branch: conversation.git_branch,
        status: conversation.status,
        started_at: conversation.started_at,
        updated_at: conversation.updated_at,
      },
      messages: conversationMessages,
      tool_names: toolNames,
      commits: commits.map((c) => ({
        sha: c.sha,
        message: c.message,
        files_changed: c.files_changed,
        insertions: c.insertions,
        deletions: c.deletions,
        timestamp: c.timestamp,
      })),
      prs: linkedPrs,
    };
  },
});

export const getExistingInsight = internalQuery({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("session_insights")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .first();
  },
});

// Lazy per-card enrichment for the unified activity feed. The feed lists every
// team-visible session straight from listConversations; a card calls this only
// when it is expanded, to pull its AI summary if one already exists. Read-only:
// returns null when the session was never summarized, in which case the card
// stays plain (or the client triggers regenerateSessionInsight on demand).
export const getSessionInsight = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const insight = await ctx.db
      .query("session_insights")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .first();
    if (!insight) return null;
    return {
      conversation_id: insight.conversation_id,
      summary: insight.summary,
      headline: insight.headline,
      key_changes: insight.key_changes,
      timeline: insight.timeline,
      turns: insight.turns,
      outcome_type: insight.outcome_type,
      blockers: insight.blockers,
      next_action: insight.next_action,
      themes: insight.themes,
      generated_at: insight.generated_at,
      metadata: insight.metadata,
    };
  },
});

export const getBackfillCandidates = internalQuery({
  args: {
    team_id: v.id("teams"),
    since: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
      .collect();

    if (memberships.length === 0) return [];

    const perMemberFetch = Math.max(
      8,
      Math.ceil((args.limit * 4) / Math.max(memberships.length, 1))
    );
    const recentByMember = await Promise.all(
      memberships.map((m) =>
        ctx.db
          .query("conversations")
          .withIndex("by_team_user_updated", (q) =>
            q.eq("team_id", args.team_id).eq("user_id", m.user_id)
          )
          .order("desc")
          .take(perMemberFetch)
      )
    );

    const seenConversationIds = new Set<string>();
    const conversations = recentByMember
      .flat()
      .filter((c) => {
        const key = c._id.toString();
        if (seenConversationIds.has(key)) return false;
        seenConversationIds.add(key);
        return true;
      });

    const visible = conversations
      .filter((c) => c.updated_at >= args.since && c.message_count > 0)
      .sort((a, b) => b.updated_at - a.updated_at);

    const candidates: Array<{
      conversation_id: Id<"conversations">;
      updated_at: number;
      title?: string;
      reason: "missing" | "stale";
    }> = [];

    for (const conversation of visible) {
      if (!(await isConversationTeamVisible(ctx, conversation))) continue;
      const existing = await ctx.db
        .query("session_insights")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation._id))
        .first();
      if (!existing) {
        candidates.push({
          conversation_id: conversation._id,
          updated_at: conversation.updated_at,
          title: conversation.title || conversation.subtitle || undefined,
          reason: "missing",
        });
      } else if (existing.generated_at + 60 * 1000 < conversation.updated_at) {
        candidates.push({
          conversation_id: conversation._id,
          updated_at: conversation.updated_at,
          title: conversation.title || conversation.subtitle || undefined,
          reason: "stale",
        });
      }

      if (candidates.length >= args.limit) break;
    }

    return candidates;
  },
});

export const upsertSessionInsight = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    team_id: v.optional(v.id("teams")),
    actor_user_id: v.id("users"),
    source: v.union(
      v.literal("idle"),
      v.literal("commit"),
      v.literal("manual"),
      v.literal("periodic")
    ),
    generated_at: v.number(),
    summary: v.string(),
    headline: v.optional(v.string()),
    key_changes: v.optional(v.array(v.string())),
    timeline: v.optional(v.array(v.object({
      t: v.string(),
      event: v.string(),
      type: v.string(),
      session_title: v.optional(v.string()),
    }))),
    turns: v.optional(v.array(v.object({
      ask: v.string(),
      did: v.array(v.string()),
    }))),
    goal: v.optional(v.string()),
    what_changed: v.optional(v.string()),
    outcome_type: v.union(
      v.literal("shipped"),
      v.literal("progress"),
      v.literal("blocked"),
      v.literal("unknown")
    ),
    blockers: v.optional(v.array(v.string())),
    next_action: v.optional(v.string()),
    themes: v.array(v.string()),
    confidence: v.optional(v.number()),
    metadata: v.optional(v.object({
      commit_shas: v.optional(v.array(v.string())),
      pr_numbers: v.optional(v.array(v.number())),
      files_touched: v.optional(v.array(v.string())),
    })),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("session_insights")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .first();

    let insightId;
    if (existing) {
      await ctx.db.patch(existing._id, {
        team_id: args.team_id,
        actor_user_id: args.actor_user_id,
        source: args.source,
        generated_at: args.generated_at,
        summary: args.summary,
        headline: args.headline,
        key_changes: args.key_changes,
        timeline: args.timeline,
        turns: args.turns,
        goal: args.goal,
        what_changed: args.what_changed,
        outcome_type: args.outcome_type,
        blockers: args.blockers,
        next_action: args.next_action,
        themes: args.themes,
        confidence: args.confidence,
        metadata: args.metadata,
      });
      insightId = existing._id;
    } else {
      insightId = await ctx.db.insert("session_insights", {
        conversation_id: args.conversation_id,
        team_id: args.team_id,
        actor_user_id: args.actor_user_id,
        source: args.source,
        generated_at: args.generated_at,
        summary: args.summary,
        headline: args.headline,
        key_changes: args.key_changes,
        timeline: args.timeline,
        turns: args.turns,
        goal: args.goal,
        what_changed: args.what_changed,
        outcome_type: args.outcome_type,
        blockers: args.blockers,
        next_action: args.next_action,
        themes: args.themes,
        confidence: args.confidence,
        metadata: args.metadata,
      });
    }

    return insightId;
  },
});

export const generateSessionInsight = internalAction({
  args: {
    conversation_id: v.id("conversations"),
    reason: v.optional(v.union(
      v.literal("idle"),
      v.literal("commit"),
      v.literal("manual"),
      v.literal("periodic")
    )),
  },
  handler: async (ctx, args): Promise<InsightGenStatus> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { status: "skipped", reason: "missing_api_key" };

    const context = (await ctx.runQuery(internal.sessionInsights.getConversationContextForInsight, {
      conversation_id: args.conversation_id,
    })) as ConversationInsightContext | null;
    if (!context) return { status: "skipped", reason: "missing_context" };

    const now = Date.now();
    const source = args.reason || "periodic";
    const existing = await ctx.runQuery(internal.sessionInsights.getExistingInsight, {
      conversation_id: args.conversation_id,
    });

    if (existing && source !== "manual" && now - existing.generated_at < 5 * 60 * 1000) {
      return { status: "skipped", reason: "rate_limited" };
    }

    const firstSlice = context.messages.slice(0, 8);
    const lastSlice = context.messages.length > 18 ? context.messages.slice(-10) : context.messages.slice(8);
    const formatMsgTime = (ts: number | undefined) => {
      if (!ts) return "";
      const d = new Date(ts);
      return `[${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}]`;
    };
    const sampledMessages = [...firstSlice, ...lastSlice]
      .map((m) => `${formatMsgTime(m.timestamp)} ${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
      .join("\n\n");

    const commitsText = context.commits.length
      ? context.commits
          .slice(0, 8)
          .map((c) => `- ${c.sha.slice(0, 7)} ${c.message.split("\n")[0]} (+${c.insertions}/-${c.deletions}, ${c.files_changed} files)`)
          .join("\n")
      : "- none";

    const prsText = context.prs.length
      ? context.prs
          .slice(0, 6)
          .map((pr) => `- #${pr.number} [${pr.state}] ${pr.title} (${pr.repository})`)
          .join("\n")
      : "- none";

    const prompt = `You are writing a session narrative for a developer activity feed.

Return ONLY valid JSON with this exact shape:
{
  "headline": "string (one sentence, max 80 chars, what was accomplished)",
  "turns": [
    { "ask": "what the user asked/directed (their actual words, paraphrased concisely)", "did": ["what was done in response (2-4 bullet points, specific)"] }
  ],
  "summary": "string (2-3 sentences, narrative context)",
  "outcome_type": "shipped|progress|blocked|unknown",
  "themes": ["string"],
  "confidence": number (0..1)
}

Rules:
- turns: THE MOST IMPORTANT FIELD. This captures the back-and-forth of the session. Each turn is one user request and what the agent did about it. The "ask" field should quote or closely paraphrase what the user actually said -- their intent, their words. The "did" array lists specific concrete things that were done in response (files changed, bugs found, features built). 3-8 turns per session.
  Good: { "ask": "Fix the OOM crash in renderMedia", "did": ["Found root cause: renderMedia() spawning unlimited Chromium processes", "Capped concurrency to os.cpus().length * 0.5 in index.ts", "Deployed fix, confirmed memory stable"] }
  Good: { "ask": "Map the React Native architecture across the monorepo", "did": ["Documented Router file-base routing in app/, layout.tsx", "Identified Tamagui config and component library structure", "Wrote comprehensive report covering all three backend layers"] }
  Bad: { "ask": "Worked on stuff", "did": ["Made changes"] }
- headline: Lead with the verb. Max 80 characters.
- summary: Brief narrative context, 2-3 sentences.
- outcome_type: shipped = deployed/merged/complete. progress = still working. blocked = stuck.
- themes: 2-4 short tags, lowercase.
- No markdown, no commentary, just JSON.

Session metadata:
- title: ${context.conversation.title || ""}
- subtitle: ${context.conversation.subtitle || ""}
- idle_summary: ${context.conversation.idle_summary || ""}
- project_path: ${context.conversation.project_path || ""}
- git_branch: ${context.conversation.git_branch || ""}
- status: ${context.conversation.status}
- started_at: ${context.conversation.started_at ? new Date(context.conversation.started_at).toISOString() : "unknown"}
- updated_at: ${context.conversation.updated_at ? new Date(context.conversation.updated_at).toISOString() : "unknown"}
- source: ${source}

Tool names seen:
${context.tool_names.join(", ") || "none"}

Commits:
${commitsText}

Linked PRs:
${prsText}

Conversation excerpt:
${sampledMessages}`;

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1200,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        return { status: "error", reason: `provider_${response.status}` };
      }

      const data = await response.json();
      const raw = data.content?.[0]?.text?.trim();
      if (!raw) return { status: "error", reason: "empty_response" };

      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      let parsed: any;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        return { status: "error", reason: "invalid_json" };
      }

      const summary = (parsed.summary || context.conversation.idle_summary || context.conversation.subtitle || "Updated session activity")
        .toString()
        .trim()
        .slice(0, 600);

      const headline = parsed.headline ? String(parsed.headline).trim().slice(0, 120) : undefined;
      const keyChanges = uniqCompact(Array.isArray(parsed.key_changes) ? parsed.key_changes.map((c: any) => String(c)) : [], 6, 120);
      const timeline = Array.isArray(parsed.timeline)
        ? parsed.timeline
            .filter((e: any) => e && typeof e.event === "string" && typeof e.t === "string")
            .slice(0, 12)
            .map((e: any) => ({
              t: String(e.t).slice(0, 10),
              event: String(e.event).trim().slice(0, 200),
              type: String(e.type || "change").slice(0, 20),
            }))
        : undefined;
      const turns = Array.isArray(parsed.turns)
        ? parsed.turns
            .filter((t: any) => t && typeof t.ask === "string" && Array.isArray(t.did))
            .slice(0, 10)
            .map((t: any) => ({
              ask: String(t.ask).trim().slice(0, 200),
              did: t.did.filter((d: any) => typeof d === "string").slice(0, 6).map((d: any) => String(d).trim().slice(0, 200)),
            }))
        : undefined;
      const goal = parsed.goal ? String(parsed.goal).trim().slice(0, 220) : undefined;
      const whatChanged = parsed.what_changed ? String(parsed.what_changed).trim().slice(0, 320) : undefined;
      const outcomeType = safeOutcomeType(parsed.outcome_type);
      const blockers = uniqCompact(Array.isArray(parsed.blockers) ? parsed.blockers.map((b: any) => String(b)) : [], 5, 200);
      const nextAction = parsed.next_action ? String(parsed.next_action).trim().slice(0, 220) : undefined;
      const themes = uniqCompact(Array.isArray(parsed.themes) ? parsed.themes.map((t: any) => String(t)) : [], 6, 48);
      const confidence = clampConfidence(parsed.confidence);

      const filesTouched = uniqCompact(
        context.commits
          .slice(0, 6)
          .map((c) => c.message.split("\n")[0]),
        6,
        120
      );

      const insightId = (await ctx.runMutation(internal.sessionInsights.upsertSessionInsight, {
        conversation_id: context.conversation._id,
        team_id: context.conversation.team_id,
        actor_user_id: context.conversation.actor_user_id,
        source,
        generated_at: now,
        summary,
        headline,
        key_changes: keyChanges.length ? keyChanges : undefined,
        timeline: timeline?.length ? timeline : undefined,
        turns: turns?.length ? turns : undefined,
        goal,
        what_changed: whatChanged,
        outcome_type: outcomeType,
        blockers: blockers.length ? blockers : undefined,
        next_action: nextAction,
        themes: themes.length ? themes : ["general"],
        confidence,
        metadata: {
          commit_shas: context.commits.slice(0, 8).map((c) => c.sha),
          pr_numbers: context.prs.slice(0, 8).map((pr) => pr.number),
          files_touched: filesTouched.length ? filesTouched : undefined,
        },
      })) as Id<"session_insights">;

      // Keep the inbox's short summary fresh by reusing the insight headline.
      // Runs every turn (5-min throttled), so any active session has a one-liner --
      // unlike the idle-notification path, which fires at most once per idle transition.
      if (headline) {
        await ctx.runMutation(internal.idleSummary.setIdleSummary, {
          conversation_id: context.conversation._id,
          idle_summary: headline,
        });
      }

      // Auto-mine tasks and docs from this conversation after insight is saved
      if (context.conversation.actor_user_id) {
        await ctx.scheduler.runAfter(0, internal.taskMining.mineConversationAfterInsight, {
          user_id: context.conversation.actor_user_id,
          team_id: context.conversation.team_id,
          insight_id: insightId,
          conversation_id: context.conversation._id,
        });
      }

      return { status: "ok", insight_id: insightId };
    } catch (error) {
      console.error("generateSessionInsight failed", error);
      return { status: "error", reason: "exception" };
    }
  },
});

export const regenerateSessionInsight = action({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args): Promise<InsightGenStatus> => {
    const currentUser = await ctx.runQuery(api.users.getCurrentUser, {} as any);
    if (!currentUser) throw new Error("Not authenticated");

    const conversation = await ctx.runQuery(api.conversations.getConversation, {
      conversation_id: args.conversation_id,
    });

    if (!conversation) throw new Error("Conversation not found");

    return await ctx.runAction(internal.sessionInsights.generateSessionInsight, {
      conversation_id: args.conversation_id,
      reason: "manual",
    });
  },
});

export const backfillTeamInsights = action({
  args: {
    team_id: v.id("teams"),
    window_hours: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const user = await ctx.runQuery(api.users.getCurrentUser, {} as any);
    if (!user) throw new Error("Not authenticated");

    const userTeams = await ctx.runQuery(api.teams.getUserTeams, {});
    const isMember = (userTeams || []).some((t: any) => t?._id?.toString() === args.team_id.toString());
    if (!isMember) {
      throw new Error("Not a member of this team");
    }

    const windowHours = Math.max(1, Math.min(args.window_hours ?? 24 * 14, 24 * 30));
    const limit = Math.max(1, Math.min(args.limit ?? 25, 100));
    const since = Date.now() - windowHours * 60 * 60 * 1000;

    const candidates = await ctx.runQuery(internal.sessionInsights.getBackfillCandidates, {
      team_id: args.team_id,
      since,
      limit,
    });

    const results: Array<{
      conversation_id: Id<"conversations">;
      reason: "missing" | "stale";
      status: string;
      detail?: string;
    }> = [];

    let success = 0;
    for (const candidate of candidates) {
      const res = await ctx.runAction(internal.sessionInsights.generateSessionInsight, {
        conversation_id: candidate.conversation_id,
        reason: "periodic",
      });
      const status = (res as any)?.status || "unknown";
      const detail = (res as any)?.reason ? String((res as any).reason) : undefined;
      if (status === "ok") success += 1;
      results.push({
        conversation_id: candidate.conversation_id,
        reason: candidate.reason,
        status,
        detail,
      });
    }

    return {
      window_hours: windowHours,
      requested: limit,
      candidates: candidates.length,
      generated: success,
      skipped_or_failed: candidates.length - success,
      results,
    };
  },
});

export const backfillTeamInsightsInternal = internalAction({
  args: {
    team_id: v.id("teams"),
    window_hours: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const windowHours = Math.max(1, Math.min(args.window_hours ?? 24 * 14, 24 * 30));
    const limit = Math.max(1, Math.min(args.limit ?? 25, 100));
    const since = Date.now() - windowHours * 60 * 60 * 1000;

    const candidates = await ctx.runQuery(internal.sessionInsights.getBackfillCandidates, {
      team_id: args.team_id,
      since,
      limit,
    });

    let success = 0;
    for (const candidate of candidates) {
      const res = await ctx.runAction(internal.sessionInsights.generateSessionInsight, {
        conversation_id: candidate.conversation_id,
        reason: "periodic",
      });
      if ((res as any)?.status === "ok") success += 1;
    }

    return { candidates: candidates.length, generated: success };
  },
});

export const getInsightsNeedingTimeline = internalQuery({
  args: {
    user_id: v.id("users"),
    since: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const insights = await ctx.db
      .query("session_insights")
      .withIndex("by_actor_generated_at", (q) =>
        q.eq("actor_user_id", args.user_id).gte("generated_at", args.since)
      )
      .order("desc")
      .take(args.limit * 2);

    return insights
      .filter((i) => !i.timeline || i.timeline.length === 0 || !i.turns || i.turns.length === 0)
      .slice(0, args.limit)
      .map((i) => i.conversation_id);
  },
});

export const backfillTimelines = action({
  args: {
    window_hours: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const user = await ctx.runQuery(api.users.getCurrentUser, {} as any);
    if (!user) throw new Error("Not authenticated");

    const windowHours = Math.max(1, Math.min(args.window_hours ?? 168, 24 * 30));
    const limit = Math.max(1, Math.min(args.limit ?? 25, 100));
    const since = Date.now() - windowHours * 60 * 60 * 1000;

    const conversationIds = await ctx.runQuery(
      internal.sessionInsights.getInsightsNeedingTimeline,
      { user_id: user._id, since, limit }
    );

    let success = 0;
    for (const cid of conversationIds) {
      const res = await ctx.runAction(internal.sessionInsights.generateSessionInsight, {
        conversation_id: cid,
        reason: "manual",
      });
      if ((res as any)?.status === "ok") success += 1;
    }

    return { candidates: conversationIds.length, generated: success };
  },
});

