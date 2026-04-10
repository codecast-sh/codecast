import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { isConversationTeamVisible, isTeamMember, createTeamFeedFilter } from "./privacy";

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

    // Auto-create/update doc from insight
    if (args.outcome_type !== "unknown" && args.summary.length >= 50) {
      const conv = await ctx.db.get(args.conversation_id);
      if (conv && (conv.message_count || 0) >= 10) {
        const docType =
          args.outcome_type === "blocked" ? "investigation"
          : args.outcome_type === "shipped" ? "handoff"
          : "note";

        const contentParts: string[] = [];
        if (args.goal) contentParts.push(`## Goal\n${args.goal}`);
        contentParts.push(`## Summary\n${args.summary}`);
        if (args.what_changed) contentParts.push(`## What Changed\n${args.what_changed}`);
        if (args.blockers?.length) contentParts.push(`## Blockers\n${args.blockers.map((b) => `- ${b}`).join("\n")}`);
        if (conv.project_path) contentParts.push(`## Project\n\`${conv.project_path}\``);

        const convTeamId = conv && (!conv.is_private || conv.auto_shared
          || (conv.team_visibility && conv.team_visibility !== "private")) ? conv.team_id : args.team_id;
        const existingDoc = await ctx.db
          .query("docs")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
          .first();

        if (existingDoc) {
          await ctx.db.patch(existingDoc._id, {
            title: conv.title || args.goal || "Untitled Session",
            content: contentParts.join("\n\n"),
            doc_type: docType as any,
            updated_at: Date.now(),
          });
        } else {
          await ctx.db.insert("docs", {
            user_id: args.actor_user_id,
            team_id: convTeamId,
            title: conv.title || args.goal || "Untitled Session",
            content: contentParts.join("\n\n"),
            doc_type: docType as any,
            source: "agent" as any,
            conversation_id: args.conversation_id,
            project_path: conv.project_path,
            labels: args.themes,
            is_private: conv.is_private,
            team_visibility: conv.team_visibility,
            created_at: conv.started_at || Date.now(),
            updated_at: Date.now(),
          });
        }
      }
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
  handler: async (ctx, args) => {
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
  handler: async (ctx, args) => {
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
  handler: async (ctx, args) => {
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

export const getTeamDigest = query({
  args: {
    team_id: v.id("teams"),
    window_hours: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }

    if (!(await isTeamMember(ctx, authUserId, args.team_id))) {
      throw new Error("Not a member of this team");
    }

    const windowHours = Math.max(1, Math.min(args.window_hours ?? 24, 24 * 30));
    const since = Date.now() - windowHours * 60 * 60 * 1000;

    const recent = await ctx.db
      .query("session_insights")
      .withIndex("by_team_generated_at", (q) => q.eq("team_id", args.team_id).gt("generated_at", since))
      .order("desc")
      .take(300);

    const deduped: typeof recent = [];
    const seenConversationIds = new Set<string>();
    for (const insight of recent) {
      const key = insight.conversation_id.toString();
      if (seenConversationIds.has(key)) continue;
      seenConversationIds.add(key);
      deduped.push(insight);
    }

    const actorIds = [...new Set(deduped.map((i) => i.actor_user_id.toString()))] as string[];
    const actorDocs = await Promise.all(
      actorIds.map((id) => ctx.db.get(id as Id<"users">))
    );
    const actorMap = new Map(
      actorDocs
        .filter((u): u is NonNullable<typeof u> => u !== null)
        .map((u) => [u._id.toString(), u])
    );

    const conversations = await Promise.all(
      deduped.map((i) => ctx.db.get(i.conversation_id))
    );
    const conversationMap = new Map(
      conversations
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => [c._id.toString(), c])
    );

    const insightFeedFilter = await createTeamFeedFilter(ctx, args.team_id);

    const filteredDeduped = deduped.filter((insight) => {
      const conv = conversationMap.get(insight.conversation_id.toString());
      if (!conv) return false;
      return insightFeedFilter.isVisible(conv);
    });

    const outcomes = { shipped: 0, progress: 0, blocked: 0, unknown: 0 };
    const themeCounts = new Map<string, number>();
    const peopleMap = new Map<string, {
      actor_user_id: Id<"users">;
      sessions: number;
      shipped: number;
      progress: number;
      blocked: number;
      unknown: number;
      latest_summary: string;
      latest_at: number;
      latest_conversation_id: Id<"conversations">;
      theme_counts: Map<string, number>;
    }>();

    for (const insight of filteredDeduped) {
      outcomes[insight.outcome_type] += 1;

      for (const theme of insight.themes || []) {
        const key = theme.toLowerCase();
        themeCounts.set(key, (themeCounts.get(key) || 0) + 1);
      }

      const actorKey = insight.actor_user_id.toString();
      let person = peopleMap.get(actorKey);
      if (!person) {
        person = {
          actor_user_id: insight.actor_user_id,
          sessions: 0,
          shipped: 0,
          progress: 0,
          blocked: 0,
          unknown: 0,
          latest_summary: insight.summary,
          latest_at: insight.generated_at,
          latest_conversation_id: insight.conversation_id,
          theme_counts: new Map<string, number>(),
        };
        peopleMap.set(actorKey, person);
      }

      person.sessions += 1;
      person[insight.outcome_type] += 1;

      if (insight.generated_at > person.latest_at) {
        person.latest_at = insight.generated_at;
        person.latest_summary = insight.summary;
        person.latest_conversation_id = insight.conversation_id;
      }

      for (const theme of insight.themes || []) {
        const key = theme.toLowerCase();
        person.theme_counts.set(key, (person.theme_counts.get(key) || 0) + 1);
      }
    }

    const topThemes = [...themeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([theme, count]) => ({ theme, count }));

    const CLUSTER_WINDOW_MS = 6 * 60 * 60 * 1000;
    const sorted = [...filteredDeduped].sort((a, b) => b.generated_at - a.generated_at);
    const clusters: Array<{
      key: string;
      outcome_type: OutcomeType;
      primary_theme: string;
      signature: string;
      latest_at: number;
      actor_ids: Set<string>;
      items: typeof deduped;
    }> = [];

    for (const insight of sorted) {
      const primaryTheme = (insight.themes?.[0] || "general").toLowerCase();
      const signature = summarySignature(insight.summary || "");
      const actorKey = insight.actor_user_id.toString();

      const existingCluster = clusters.find((cluster) => {
        if (cluster.outcome_type !== insight.outcome_type) return false;
        if (cluster.latest_at - insight.generated_at > CLUSTER_WINDOW_MS) return false;
        const sameTheme = cluster.primary_theme === primaryTheme;
        const sameActor = cluster.actor_ids.has(actorKey);
        const sameSignature = cluster.signature && signature && cluster.signature === signature;
        return sameSignature || (sameTheme && sameActor);
      });

      if (existingCluster) {
        existingCluster.items.push(insight);
        existingCluster.actor_ids.add(actorKey);
        existingCluster.latest_at = Math.max(existingCluster.latest_at, insight.generated_at);
        continue;
      }

      clusters.push({
        key: `${insight.outcome_type}:${primaryTheme}:${signature || actorKey}:${insight.generated_at}`,
        outcome_type: insight.outcome_type,
        primary_theme: primaryTheme,
        signature,
        latest_at: insight.generated_at,
        actor_ids: new Set([actorKey]),
        items: [insight],
      });
    }

    clusters.sort((a, b) => b.latest_at - a.latest_at);
    const highlights = clusters.slice(0, 10).map((cluster) => {
      const representative = cluster.items[0];
      const actor = actorMap.get(representative.actor_user_id.toString());
      const conv = conversationMap.get(representative.conversation_id.toString());
      const actorNames = [...cluster.actor_ids]
        .map((id) => {
          const user = actorMap.get(id);
          return user?.name || user?.email || "Unknown";
        })
        .slice(0, 4);
      const rollupCount = cluster.items.length;

      const rollupSummary = rollupCount > 1
        ? `${rollupCount} sessions${actorNames.length ? ` by ${actorNames.join(", ")}` : ""} · ${cluster.items
            .slice(0, 2)
            .map((i) => i.summary)
            .join(" · ")}`
        : representative.summary;

      return {
        conversation_id: representative.conversation_id,
        conversation_ids: cluster.items.map((i) => i.conversation_id),
        title: rollupCount > 1
          ? `${(cluster.primary_theme && cluster.primary_theme !== "general") ? cluster.primary_theme : "Related work"} (${rollupCount} sessions)`
          : (conv?.title || conv?.subtitle || "Session"),
        summary: rollupSummary.slice(0, 340),
        outcome_type: representative.outcome_type,
        generated_at: representative.generated_at,
        themes: representative.themes,
        goal: representative.goal,
        what_changed: representative.what_changed,
        blockers: representative.blockers,
        next_action: representative.next_action,
        confidence: representative.confidence,
        rollup_count: rollupCount,
        rolled_up: rollupCount > 1,
        actor_names: actorNames,
        actor: {
          _id: representative.actor_user_id,
          name: actor?.name || actor?.email || "Unknown",
          image: actor?.image || actor?.github_avatar_url,
        },
        project_path: conv?.project_path,
        git_branch: conv?.git_branch,
      };
    });

    const feedUnsorted = sorted.slice(0, 50).map((insight) => {
      const actor = actorMap.get(insight.actor_user_id.toString());
      const conv = conversationMap.get(insight.conversation_id.toString());
      return {
        conversation_id: insight.conversation_id,
        title: conv?.title || conv?.subtitle || "Session",
        summary: insight.summary,
        headline: insight.headline,
        key_changes: insight.key_changes,
        timeline: insight.timeline,
        turns: insight.turns,
        goal: insight.goal,
        what_changed: insight.what_changed,
        outcome_type: insight.outcome_type,
        blockers: insight.blockers,
        next_action: insight.next_action,
        themes: insight.themes,
        confidence: insight.confidence,
        generated_at: insight.generated_at,
        metadata: insight.metadata,
        actor: {
          _id: insight.actor_user_id,
          name: actor?.name || actor?.email || "Unknown",
          image: actor?.image || actor?.github_avatar_url,
        },
        project_path: conv?.project_path,
        git_branch: conv?.git_branch,
        message_count: conv?.message_count,
        status: conv?.status,
        started_at: conv?.started_at,
        updated_at: conv?.updated_at,
      };
    });
    const feed = feedUnsorted.sort((a, b) =>
      (b.updated_at || b.started_at || b.generated_at) - (a.updated_at || a.started_at || a.generated_at)
    );

    const people = [...peopleMap.values()]
      .map((p) => {
        const actor = actorMap.get(p.actor_user_id.toString());
        const topPersonThemes = [...p.theme_counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([theme]) => theme);

        return {
          actor: {
            _id: p.actor_user_id,
            name: actor?.name || actor?.email || "Unknown",
          image: actor?.image || actor?.github_avatar_url,
          },
          sessions: p.sessions,
          outcomes: {
            shipped: p.shipped,
            progress: p.progress,
            blocked: p.blocked,
            unknown: p.unknown,
          },
          top_themes: topPersonThemes,
          latest_summary: p.latest_summary,
          latest_at: p.latest_at,
          latest_conversation_id: p.latest_conversation_id,
        };
      })
      .sort((a, b) => b.sessions - a.sessions);

    return {
      window_hours: windowHours,
      generated_at: Date.now(),
      sessions_analyzed: filteredDeduped.length,
      outcomes,
      top_themes: topThemes,
      highlights,
      feed,
      people,
    };
  },
});

export const getPersonDigest = query({
  args: {
    team_id: v.id("teams"),
    actor_user_id: v.id("users"),
    window_hours: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }

    if (!(await isTeamMember(ctx, authUserId, args.team_id))) {
      throw new Error("Not a member of this team");
    }

    const windowHours = Math.max(1, Math.min(args.window_hours ?? 24, 24 * 30));
    const since = Date.now() - windowHours * 60 * 60 * 1000;

    const actorInsights = await ctx.db
      .query("session_insights")
      .withIndex("by_actor_generated_at", (q) => q.eq("actor_user_id", args.actor_user_id).gt("generated_at", since))
      .order("desc")
      .take(200);

    const filtered = actorInsights.filter((i) => i.team_id && i.team_id.toString() === args.team_id.toString());

    const deduped: typeof filtered = [];
    const seenConversations = new Set<string>();
    for (const insight of filtered) {
      const key = insight.conversation_id.toString();
      if (seenConversations.has(key)) continue;
      seenConversations.add(key);
      deduped.push(insight);
    }

    const actor = await ctx.db.get(args.actor_user_id);

    const outcomes = { shipped: 0, progress: 0, blocked: 0, unknown: 0 };
    const themeCounts = new Map<string, number>();
    const blockerCounts = new Map<string, number>();
    const nextActions: string[] = [];

    for (const insight of deduped) {
      outcomes[insight.outcome_type] += 1;
      for (const theme of insight.themes || []) {
        const key = theme.toLowerCase();
        themeCounts.set(key, (themeCounts.get(key) || 0) + 1);
      }
      for (const blocker of insight.blockers || []) {
        const key = blocker.trim();
        if (!key) continue;
        blockerCounts.set(key, (blockerCounts.get(key) || 0) + 1);
      }
      if (insight.next_action && nextActions.length < 8) {
        nextActions.push(insight.next_action);
      }
    }

    const conversations = await Promise.all(deduped.slice(0, 12).map((i) => ctx.db.get(i.conversation_id)));
    const conversationMap = new Map(
      conversations
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => [c._id.toString(), c])
    );

    const highlights = deduped.slice(0, 12).map((insight) => {
      const conv = conversationMap.get(insight.conversation_id.toString());
      return {
        conversation_id: insight.conversation_id,
        title: conv?.title || conv?.subtitle || "Session",
        summary: insight.summary,
        outcome_type: insight.outcome_type,
        generated_at: insight.generated_at,
        themes: insight.themes,
        blockers: insight.blockers,
        next_action: insight.next_action,
      };
    });

    return {
      actor: {
        _id: args.actor_user_id,
        name: actor?.name || actor?.email || "Unknown",
      },
      window_hours: windowHours,
      sessions_analyzed: deduped.length,
      outcomes,
      top_themes: [...themeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([theme, count]) => ({ theme, count })),
      blockers: [...blockerCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([blocker, count]) => ({ blocker, count })),
      next_actions: uniqCompact(nextActions, 8, 180),
      highlights,
    };
  },
});

export const getActivityDigest = query({
  args: {
    mode: v.union(v.literal("personal"), v.literal("team")),
    team_id: v.optional(v.id("teams")),
    window_hours: v.optional(v.number()),
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) throw new Error("Not authenticated");

    if (args.mode === "team") {
      if (!args.team_id) throw new Error("team_id required for team mode");
      if (!(await isTeamMember(ctx, authUserId, args.team_id))) {
        throw new Error("Not a member of this team");
      }
    }

    const windowHours = Math.max(1, Math.min(args.window_hours ?? 24, 24 * 30));
    const since = Date.now() - windowHours * 60 * 60 * 1000;
    const tz = args.timezone || "UTC";

    let recent;
    if (args.mode === "personal") {
      recent = await ctx.db
        .query("session_insights")
        .withIndex("by_actor_generated_at", (q) =>
          q.eq("actor_user_id", authUserId).gt("generated_at", since)
        )
        .order("desc")
        .take(300);
    } else {
      recent = await ctx.db
        .query("session_insights")
        .withIndex("by_team_generated_at", (q) =>
          q.eq("team_id", args.team_id!).gt("generated_at", since)
        )
        .order("desc")
        .take(300);
    }

    const deduped: typeof recent = [];
    const seenConversationIds = new Set<string>();
    for (const insight of recent) {
      const key = insight.conversation_id.toString();
      if (seenConversationIds.has(key)) continue;
      seenConversationIds.add(key);
      deduped.push(insight);
    }

    const actorIds = [...new Set(deduped.map((i) => i.actor_user_id.toString()))];
    const actorDocs = await Promise.all(
      actorIds.map((id) => ctx.db.get(id as Id<"users">))
    );
    const actorMap = new Map(
      actorDocs
        .filter((u): u is NonNullable<typeof u> => u !== null)
        .map((u) => [u._id.toString(), u])
    );

    const conversations = await Promise.all(
      deduped.map((i) => ctx.db.get(i.conversation_id))
    );
    const conversationMap = new Map(
      conversations
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => [c._id.toString(), c])
    );

    let filteredDeduped = deduped;
    if (args.mode === "team") {
      const insightFeedFilter = await createTeamFeedFilter(ctx, args.team_id!);
      filteredDeduped = deduped.filter((insight) => {
        const conv = conversationMap.get(insight.conversation_id.toString());
        if (!conv) return false;
        return insightFeedFilter.isVisible(conv);
      });
    }

    const outcomes = { shipped: 0, progress: 0, blocked: 0, unknown: 0 };
    const themeCounts = new Map<string, number>();
    const peopleMap = new Map<string, {
      actor_user_id: Id<"users">;
      sessions: number;
      shipped: number;
      progress: number;
      blocked: number;
      unknown: number;
      latest_summary: string;
      latest_at: number;
      latest_conversation_id: Id<"conversations">;
      theme_counts: Map<string, number>;
    }>();

    for (const insight of filteredDeduped) {
      outcomes[insight.outcome_type] += 1;
      for (const theme of insight.themes || []) {
        const key = theme.toLowerCase();
        themeCounts.set(key, (themeCounts.get(key) || 0) + 1);
      }

      const actorKey = insight.actor_user_id.toString();
      let person = peopleMap.get(actorKey);
      if (!person) {
        person = {
          actor_user_id: insight.actor_user_id,
          sessions: 0, shipped: 0, progress: 0, blocked: 0, unknown: 0,
          latest_summary: insight.summary,
          latest_at: insight.generated_at,
          latest_conversation_id: insight.conversation_id,
          theme_counts: new Map<string, number>(),
        };
        peopleMap.set(actorKey, person);
      }
      person.sessions += 1;
      person[insight.outcome_type] += 1;
      if (insight.generated_at > person.latest_at) {
        person.latest_at = insight.generated_at;
        person.latest_summary = insight.summary;
        person.latest_conversation_id = insight.conversation_id;
      }
      for (const theme of insight.themes || []) {
        const key = theme.toLowerCase();
        person.theme_counts.set(key, (person.theme_counts.get(key) || 0) + 1);
      }
    }

    const topThemes = [...themeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([theme, count]) => ({ theme, count }));

    const sorted = [...filteredDeduped].sort((a, b) => b.generated_at - a.generated_at);

    const feedUnsorted = sorted.slice(0, 50).map((insight) => {
      const actor = actorMap.get(insight.actor_user_id.toString());
      const conv = conversationMap.get(insight.conversation_id.toString());
      return {
        conversation_id: insight.conversation_id,
        title: conv?.title || conv?.subtitle || "Session",
        summary: insight.summary,
        headline: insight.headline,
        key_changes: insight.key_changes,
        timeline: insight.timeline,
        turns: insight.turns,
        goal: insight.goal,
        what_changed: insight.what_changed,
        outcome_type: insight.outcome_type,
        blockers: insight.blockers,
        next_action: insight.next_action,
        themes: insight.themes,
        confidence: insight.confidence,
        generated_at: insight.generated_at,
        metadata: insight.metadata,
        actor: {
          _id: insight.actor_user_id,
          name: actor?.name || actor?.email || "Unknown",
          image: actor?.image || actor?.github_avatar_url,
        },
        project_path: conv?.project_path,
        git_branch: conv?.git_branch,
        message_count: conv?.message_count,
        status: conv?.status,
        started_at: conv?.started_at,
        updated_at: conv?.updated_at,
      };
    });
    const feed = feedUnsorted.sort((a, b) =>
      (b.updated_at || b.started_at || b.generated_at) - (a.updated_at || a.started_at || a.generated_at)
    );

    const dayMap = new Map<string, typeof feed>();
    for (const item of feed) {
      const ts = item.updated_at || item.started_at || item.generated_at;
      const dateStr = new Date(ts).toLocaleDateString("en-CA", { timeZone: tz });
      if (!dayMap.has(dateStr)) dayMap.set(dateStr, []);
      dayMap.get(dateStr)!.push(item);
    }

    const daySummaries = [...dayMap.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, items]) => {
        const dayOutcomes = { shipped: 0, progress: 0, blocked: 0, unknown: 0 };
        const dayThemes = new Map<string, number>();
        const dayActors = new Set<string>();
        for (const item of items) {
          dayOutcomes[item.outcome_type as OutcomeType] += 1;
          dayActors.add(item.actor._id.toString());
          for (const theme of item.themes || []) {
            const key = theme.toLowerCase();
            dayThemes.set(key, (dayThemes.get(key) || 0) + 1);
          }
        }
        const sortedThemes = [...dayThemes.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([t]) => t);

        const highlights = items
          .filter((i) => i.outcome_type === "shipped" || i.outcome_type === "progress")
          .slice(0, 2)
          .map((i) => i.summary.slice(0, 120));

        return {
          date,
          session_count: items.length,
          outcomes: dayOutcomes,
          top_themes: sortedThemes,
          highlights,
          people_count: dayActors.size,
        };
      });

    const people = [...peopleMap.values()]
      .map((p) => {
        const actor = actorMap.get(p.actor_user_id.toString());
        const topPersonThemes = [...p.theme_counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([theme]) => theme);
        return {
          actor: {
            _id: p.actor_user_id,
            name: actor?.name || actor?.email || "Unknown",
          image: actor?.image || actor?.github_avatar_url,
          },
          sessions: p.sessions,
          outcomes: { shipped: p.shipped, progress: p.progress, blocked: p.blocked, unknown: p.unknown },
          top_themes: topPersonThemes,
          latest_summary: p.latest_summary,
          latest_at: p.latest_at,
          latest_conversation_id: p.latest_conversation_id,
        };
      })
      .sort((a, b) => b.sessions - a.sessions);

    return {
      window_hours: windowHours,
      generated_at: Date.now(),
      sessions_analyzed: filteredDeduped.length,
      outcomes,
      top_themes: topThemes,
      day_summaries: daySummaries,
      feed,
      people,
      day_narratives: await getDigests(ctx, authUserId, "day", daySummaries.map((d) => d.date), args.team_id),
    };
  },
});

async function getDigests(
  ctx: any,
  userId: Id<"users">,
  scope: "day" | "week" | "month",
  dateKeys: string[],
  teamId?: Id<"teams">,
): Promise<Record<string, { narrative: string; events: any[]; generated_at: number; session_count?: number }>> {
  const result: Record<string, { narrative: string; events: any[]; generated_at: number; session_count?: number }> = {};
  for (const date of dateKeys) {
    if (teamId) {
      const teamDigest = await ctx.db
        .query("digests")
        .withIndex("by_team_scope_date", (q: any) => q.eq("team_id", teamId).eq("scope", scope).eq("date", date))
        .order("desc")
        .first();
      if (teamDigest?.narrative) {
        result[date] = {
          narrative: teamDigest.narrative,
          events: teamDigest.events || [],
          generated_at: teamDigest.generated_at,
          session_count: teamDigest.session_count,
        };
      }
    } else {
      const candidates = await ctx.db
        .query("digests")
        .withIndex("by_user_scope_date", (q: any) => q.eq("user_id", userId).eq("scope", scope).eq("date", date))
        .collect();
      const existing = candidates.find((d: any) => !d.team_id);
      if (existing?.narrative) {
        result[date] = {
          narrative: existing.narrative,
          events: existing.events || [],
          generated_at: existing.generated_at,
          session_count: existing.session_count,
        };
        continue;
      }
      if (scope === "day") {
        const legacy = await ctx.db
          .query("day_timelines")
          .withIndex("by_user_date", (q: any) => q.eq("user_id", userId).eq("date", date))
          .first();
        if (legacy?.narrative) {
          result[date] = {
            narrative: legacy.narrative,
            events: legacy.events || [],
            generated_at: legacy.generated_at,
          };
        }
      }
    }
  }
  return result;
}

export const getDayInsightsForNarrative = internalQuery({
  args: {
    user_id: v.id("users"),
    date: v.string(),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const dateStart = new Date(args.date + "T00:00:00Z").getTime();
    const dateEnd = dateStart + 24 * 60 * 60 * 1000;

    const insights = await ctx.db
      .query("session_insights")
      .withIndex("by_actor_generated_at", (q) =>
        q.eq("actor_user_id", args.user_id).gt("generated_at", dateStart - 12 * 60 * 60 * 1000)
      )
      .order("asc")
      .take(100);

    const dayInsights = insights.filter((i) => {
      if (i.generated_at < dateStart || i.generated_at >= dateEnd) return false;
      if (args.team_id) return i.team_id?.toString() === args.team_id.toString();
      return !i.team_id;
    });

    const conversations = await Promise.all(
      dayInsights.map((i) => ctx.db.get(i.conversation_id))
    );
    const convMap = new Map(
      conversations.filter((c): c is NonNullable<typeof c> => c !== null).map((c) => [c._id.toString(), c])
    );

    const actorIds = [...new Set(dayInsights.map((i) => i.actor_user_id.toString()))];
    const actorDocs = await Promise.all(actorIds.map((id) => ctx.db.get(id as Id<"users">)));
    const actorMap = new Map(
      actorDocs.filter((u): u is NonNullable<typeof u> => u !== null).map((u) => [u._id.toString(), u])
    );

    return dayInsights.map((i) => {
      const conv = convMap.get(i.conversation_id.toString());
      const actor = actorMap.get(i.actor_user_id.toString());
      return {
        conversation_id: i.conversation_id,
        actor_user_id: i.actor_user_id,
        actor_name: actor?.name || actor?.email?.split("@")[0] || "unknown",
        actor_image: actor?.image || (actor as any)?.github_avatar_url || null,
        title: conv?.title || "Session",
        project_path: conv?.project_path,
        timeline: i.timeline || [],
        headline: i.headline,
        key_changes: i.key_changes,
        outcome_type: i.outcome_type,
        summary: i.summary,
        turns: i.turns || [],
        blockers: i.blockers || [],
        next_action: i.next_action,
        themes: i.themes || [],
        metadata: i.metadata,
        started_at: conv?.started_at,
        updated_at: conv?.updated_at,
      };
    });
  },
});

export const getTeamDayInsights = internalQuery({
  args: {
    team_id: v.id("teams"),
    date: v.string(),
  },
  handler: async (ctx, args) => {
    const dateStart = new Date(args.date + "T00:00:00Z").getTime();
    const dateEnd = dateStart + 24 * 60 * 60 * 1000;

    const insights = await ctx.db
      .query("session_insights")
      .withIndex("by_team_generated_at", (q) =>
        q.eq("team_id", args.team_id).gt("generated_at", dateStart - 12 * 60 * 60 * 1000)
      )
      .order("asc")
      .take(200);

    const dayInsights = insights.filter((i) =>
      i.generated_at >= dateStart && i.generated_at < dateEnd
    );

    const conversations = await Promise.all(
      dayInsights.map((i) => ctx.db.get(i.conversation_id))
    );
    const convMap = new Map(
      conversations.filter((c): c is NonNullable<typeof c> => c !== null).map((c) => [c._id.toString(), c])
    );

    const actorIds = [...new Set(dayInsights.map((i) => i.actor_user_id.toString()))];
    const actorDocs = await Promise.all(actorIds.map((id) => ctx.db.get(id as Id<"users">)));
    const actorMap = new Map(
      actorDocs.filter((u): u is NonNullable<typeof u> => u !== null).map((u) => [u._id.toString(), u])
    );

    return dayInsights.map((i) => {
      const conv = convMap.get(i.conversation_id.toString());
      const actor = actorMap.get(i.actor_user_id.toString());
      return {
        conversation_id: i.conversation_id,
        actor_user_id: i.actor_user_id,
        actor_name: actor?.name || actor?.email?.split("@")[0] || "unknown",
        actor_image: actor?.image || (actor as any)?.github_avatar_url || null,
        title: conv?.title || "Session",
        project_path: conv?.project_path,
        timeline: i.timeline || [],
        headline: i.headline,
        key_changes: i.key_changes,
        outcome_type: i.outcome_type,
        summary: i.summary,
        turns: i.turns || [],
        blockers: i.blockers || [],
        next_action: i.next_action,
        themes: i.themes || [],
        metadata: i.metadata,
        started_at: conv?.started_at,
        updated_at: conv?.updated_at,
      };
    });
  },
});

// --- Date helpers for ISO week/month key computation ---

function getISOWeekKey(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const dayOfWeek = d.getUTCDay() || 7;
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((thursday.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function getWeekDateRange(weekKey: string): { monday: string; sunday: string } {
  const [yearStr, weekStr] = weekKey.split("-W");
  const year = parseInt(yearStr);
  const week = parseInt(weekStr);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { monday: fmt(monday), sunday: fmt(sunday) };
}

function getWeeksInMonth(monthKey: string): string[] {
  const [year, month] = monthKey.split("-").map(Number);
  const weeks = new Set<string>();
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    weeks.add(getISOWeekKey(dateStr));
  }
  return [...weeks].sort();
}

// --- Render a session insight as a markdown block for the synthesizer prompt ---

function renderInsightBlock(insight: any): string {
  const project = insight.project_path?.split("/").filter(Boolean).pop() || "unknown";
  const cid = insight.conversation_id;
  const actor = insight.actor_name || "unknown";
  const actorId = insight.actor_user_id;
  const parts: string[] = [];

  parts.push(`### [${insight.title}](/conversation/${cid})`);
  parts.push(`[@${actor}](/team/${actorId}) in **${project}** | ${insight.outcome_type}`);

  if (insight.headline) parts.push(insight.headline);
  if (insight.summary) parts.push(insight.summary);

  if (insight.turns?.length) {
    for (const turn of insight.turns) {
      parts.push(`- ${turn.ask} → ${turn.did.join("; ")}`);
    }
  }

  if (insight.key_changes?.length) parts.push(`**Changes:** ${insight.key_changes.join(", ")}`);
  if (insight.blockers?.length) parts.push(`**Blocked:** ${insight.blockers.join(", ")}`);
  if (insight.metadata?.pr_numbers?.length) parts.push(`**PRs:** ${insight.metadata.pr_numbers.map((n: number) => `#${n}`).join(", ")}`);

  return parts.join("\n");
}

// --- The single synthesizer prompt used at every level ---

const DIGEST_PROMPT = `Synthesize these activity records into a tight markdown digest.

CRITICAL: Preserve ALL links from the input exactly as-is. Every session MUST keep its [Title](/conversation/id) link. Every person MUST keep their [@Name](/team/id) link. Format each session as:
- [Session Title](/conversation/id) ([@Author](/team/id)): one-line summary with \`code\` and **bold**

Group sessions under ## headings by project or theme.

10 sessions = ~150 words. 3 sessions = ~50 words. Brief but preserve all links and authors.
No title, no preamble. Start with first ## heading.`;

const DIGEST_MODEL: Record<string, { model: string; maxTokens: number }> = {
  day: { model: "claude-haiku-4-5-20251001", maxTokens: 800 },
  week: { model: "claude-sonnet-4-20250514", maxTokens: 2500 },
  month: { model: "claude-sonnet-4-20250514", maxTokens: 2500 },
};

// --- Digest mutations and queries ---

export const upsertDigest = internalMutation({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    scope: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
    date: v.string(),
    narrative: v.string(),
    events: v.array(v.object({
      time: v.number(),
      t: v.string(),
      event: v.string(),
      type: v.string(),
      session_id: v.optional(v.id("conversations")),
      session_title: v.optional(v.string()),
      project: v.optional(v.string()),
    })),
    session_count: v.optional(v.number()),
    generated_at: v.number(),
  },
  handler: async (ctx, args) => {
    const candidates = await ctx.db
      .query("digests")
      .withIndex("by_user_scope_date", (q) =>
        q.eq("user_id", args.user_id).eq("scope", args.scope).eq("date", args.date)
      )
      .collect();
    const existing = candidates.find((d) =>
      args.team_id ? d.team_id?.toString() === args.team_id.toString() : !d.team_id
    );

    if (existing) {
      await ctx.db.patch(existing._id, {
        narrative: args.narrative,
        events: args.events,
        session_count: args.session_count,
        generated_at: args.generated_at,
      });
      return existing._id;
    }

    return await ctx.db.insert("digests", {
      user_id: args.user_id,
      team_id: args.team_id,
      scope: args.scope,
      date: args.date,
      narrative: args.narrative,
      events: args.events,
      session_count: args.session_count,
      generated_at: args.generated_at,
    });
  },
});

export const getDigestsInRange = internalQuery({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    scope: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
    start_date: v.string(),
    end_date: v.string(),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("digests")
      .withIndex("by_user_scope_date", (q) =>
        q.eq("user_id", args.user_id).eq("scope", args.scope).gte("date", args.start_date)
      )
      .take(100);
    return all.filter((d) => {
      if (d.date > args.end_date) return false;
      if (args.team_id) return d.team_id?.toString() === args.team_id.toString();
      return !d.team_id;
    });
  },
});

export const getDigestsByScope = query({
  args: {
    scope: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
    team_id: v.optional(v.id("teams")),
    window_months: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const months = args.window_months ?? 1;
    const now = new Date();
    const startDate = new Date(now);
    startDate.setMonth(startDate.getMonth() - months);

    let startKey: string;
    let endKey: string;
    if (args.scope === "day") {
      startKey = startDate.toISOString().slice(0, 10);
      endKey = now.toISOString().slice(0, 10);
    } else if (args.scope === "week") {
      startKey = "2020-W01";
      endKey = "2099-W53";
    } else {
      startKey = startDate.toISOString().slice(0, 7);
      endKey = now.toISOString().slice(0, 7);
    }

    let digests;
    if (args.team_id) {
      digests = await ctx.db
        .query("digests")
        .withIndex("by_team_scope_date", (q) =>
          q.eq("team_id", args.team_id!).eq("scope", args.scope).gte("date", startKey)
        )
        .take(200);
    } else {
      digests = await ctx.db
        .query("digests")
        .withIndex("by_user_scope_date", (q) =>
          q.eq("user_id", userId).eq("scope", args.scope).gte("date", startKey)
        )
        .take(100);
    }

    const filtered = digests.filter((d) => {
      if (d.date > endKey) return false;
      if (!args.team_id) return !d.team_id;
      return true;
    });

    if (args.team_id) {
      const seen = new Set<string>();
      const deduped = filtered.filter((d) => {
        if (seen.has(d.date)) return false;
        seen.add(d.date);
        return true;
      });
      return deduped
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((d) => ({
          date: d.date,
          narrative: d.narrative,
          session_count: d.session_count,
          generated_at: d.generated_at,
        }));
    }

    return filtered
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((d) => ({
        date: d.date,
        narrative: d.narrative,
        session_count: d.session_count,
        generated_at: d.generated_at,
      }));
  },
});

// --- The main digest generator ---

export const generateDigest = internalAction({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    scope: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
    date: v.string(),
  },
  handler: async (ctx, args): Promise<InsightGenStatus> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { status: "skipped", reason: "missing_api_key" };

    let activityText: string;
    let events: Array<{
      time: number; t: string; event: string; type: string;
      session_id?: Id<"conversations">; session_title?: string; project?: string;
    }> = [];
    let sessionCount = 0;

    if (args.scope === "day") {
      const dayInsights = args.team_id
        ? await ctx.runQuery(internal.sessionInsights.getTeamDayInsights, { team_id: args.team_id, date: args.date })
        : await ctx.runQuery(internal.sessionInsights.getDayInsightsForNarrative, { user_id: args.user_id, date: args.date });
      if (!dayInsights.length) return { status: "skipped", reason: "no_insights" };

      sessionCount = dayInsights.length;
      activityText = dayInsights.map(renderInsightBlock).join("\n\n---\n\n");

      for (const insight of dayInsights) {
        const project = insight.project_path?.split("/").filter(Boolean).pop() || undefined;
        for (const te of insight.timeline || []) {
          const timeParts = te.t.match(/^(\d{1,2}):(\d{2})/);
          const timeMinutes = timeParts ? Number(timeParts[1]) * 60 + Number(timeParts[2]) : 0;
          events.push({
            time: timeMinutes, t: te.t, event: te.event, type: te.type,
            session_id: insight.conversation_id, session_title: insight.title, project,
          });
        }
      }
      events.sort((a, b) => a.time - b.time);
      events = events.slice(0, 40);

    } else if (args.scope === "week") {
      const { monday, sunday } = getWeekDateRange(args.date);
      const dayDigests = await ctx.runQuery(internal.sessionInsights.getDigestsInRange, {
        user_id: args.user_id, team_id: args.team_id, scope: "day", start_date: monday, end_date: sunday,
      });
      if (!dayDigests.length) return { status: "skipped", reason: "no_child_digests" };

      sessionCount = dayDigests.reduce((sum: number, d: any) => sum + (d.session_count || 0), 0);
      activityText = [...dayDigests]
        .sort((a: any, b: any) => a.date.localeCompare(b.date))
        .map((d: any) => `## ${d.date}\n\n${d.narrative}`)
        .join("\n\n---\n\n");

    } else {
      const weekKeys = getWeeksInMonth(args.date);
      const weekDigests = await ctx.runQuery(internal.sessionInsights.getDigestsInRange, {
        user_id: args.user_id, team_id: args.team_id, scope: "week",
        start_date: weekKeys[0], end_date: weekKeys[weekKeys.length - 1],
      });
      if (!weekDigests.length) return { status: "skipped", reason: "no_child_digests" };

      sessionCount = weekDigests.reduce((sum: number, d: any) => sum + (d.session_count || 0), 0);
      activityText = [...weekDigests]
        .sort((a: any, b: any) => a.date.localeCompare(b.date))
        .map((d: any) => `## ${d.date}\n\n${d.narrative}`)
        .join("\n\n---\n\n");
    }

    const { model, maxTokens } = DIGEST_MODEL[args.scope];
    const fullPrompt = `${DIGEST_PROMPT}\n\n---\n\n${activityText}`;

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: fullPrompt }],
        }),
      });

      if (!response.ok) return { status: "error", reason: `provider_${response.status}` };

      const data = await response.json();
      const narrative = data.content?.[0]?.text?.trim();
      if (!narrative) return { status: "error", reason: "empty_response" };

      await ctx.runMutation(internal.sessionInsights.upsertDigest, {
        user_id: args.user_id,
        team_id: args.team_id,
        scope: args.scope,
        date: args.date,
        narrative,
        events: events.map((e) => ({ ...e, session_id: e.session_id || undefined })),
        session_count: sessionCount,
        generated_at: Date.now(),
      });

      return { status: "ok" };
    } catch (error) {
      console.error(`Failed to generate ${args.scope} digest:`, error);
      return { status: "error", reason: "fetch_failed" };
    }
  },
});

// --- Backfill: cascading digest generation across scopes ---

export const backfillDigests = action({
  args: {
    scope: v.optional(v.union(v.literal("day"), v.literal("week"), v.literal("month"))),
    window_hours: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(api.users.getCurrentUser, {} as any);
    if (!user) throw new Error("Not authenticated");

    const scope = args.scope ?? "day";
    const windowHours = Math.max(1, Math.min(args.window_hours ?? 168, 24 * 30));
    const since = Date.now() - windowHours * 60 * 60 * 1000;
    const tz = "America/Los_Angeles";

    if (scope === "day") {
      const insights = await ctx.runQuery(internal.sessionInsights.getRecentInsightsForUser, {
        user_id: user._id, since,
      });
      const dayDates = new Set<string>();
      for (const i of insights) {
        dayDates.add(new Date(i.generated_at).toLocaleDateString("en-CA", { timeZone: tz }));
      }
      let generated = 0;
      for (const date of dayDates) {
        const result = await ctx.runAction(internal.sessionInsights.generateDigest, {
          user_id: user._id, team_id: user.active_team_id || undefined, scope: "day", date,
        });
        if ((result as any)?.status === "ok") generated++;
      }
      return { scope, dates: dayDates.size, generated };
    }

    if (scope === "week") {
      const insights = await ctx.runQuery(internal.sessionInsights.getRecentInsightsForUser, {
        user_id: user._id, since,
      });
      const weekKeys = new Set<string>();
      for (const i of insights) {
        const dateStr = new Date(i.generated_at).toLocaleDateString("en-CA", { timeZone: tz });
        weekKeys.add(getISOWeekKey(dateStr));
      }
      let generated = 0;
      for (const weekKey of weekKeys) {
        const result = await ctx.runAction(internal.sessionInsights.generateDigest, {
          user_id: user._id, team_id: user.active_team_id || undefined, scope: "week", date: weekKey,
        });
        if ((result as any)?.status === "ok") generated++;
      }
      return { scope, dates: weekKeys.size, generated };
    }

    // month
    const insights = await ctx.runQuery(internal.sessionInsights.getRecentInsightsForUser, {
      user_id: user._id, since,
    });
    const monthKeys = new Set<string>();
    for (const i of insights) {
      const dateStr = new Date(i.generated_at).toLocaleDateString("en-CA", { timeZone: tz });
      monthKeys.add(dateStr.slice(0, 7));
    }
    let generated = 0;
    for (const monthKey of monthKeys) {
      const result = await ctx.runAction(internal.sessionInsights.generateDigest, {
        user_id: user._id, team_id: user.active_team_id || undefined, scope: "month", date: monthKey,
      });
      if ((result as any)?.status === "ok") generated++;
    }
    return { scope, dates: monthKeys.size, generated };
  },
});

export const getRecentInsightsForUser = internalQuery({
  args: {
    user_id: v.id("users"),
    since: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("session_insights")
      .withIndex("by_actor_generated_at", (q) =>
        q.eq("actor_user_id", args.user_id).gt("generated_at", args.since)
      )
      .order("desc")
      .take(300);
  },
});