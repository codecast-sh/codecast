import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { isConversationTeamVisible, isTeamMember } from "./privacy";

type OutcomeType = "shipped" | "progress" | "blocked" | "unknown";
type InsightGenStatus = {
  status: "ok" | "error" | "skipped" | "unknown";
  reason?: string;
  insight_id?: Id<"session_insights">;
};
type ConversationInsightContext = {
  conversation: {
    _id: Id<"conversations">;
    team_id: Id<"teams">;
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
    if (!conversation || !conversation.team_id) return null;

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

    const teamPrs = await ctx.db
      .query("pull_requests")
      .withIndex("by_team_id", (q) => q.eq("team_id", conversation.team_id!))
      .collect();

    const linkedPrs = teamPrs
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
    team_id: v.id("teams"),
    actor_user_id: v.id("users"),
    source: v.union(
      v.literal("idle"),
      v.literal("commit"),
      v.literal("manual"),
      v.literal("periodic")
    ),
    generated_at: v.number(),
    summary: v.string(),
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

    if (existing) {
      await ctx.db.patch(existing._id, {
        team_id: args.team_id,
        actor_user_id: args.actor_user_id,
        source: args.source,
        generated_at: args.generated_at,
        summary: args.summary,
        goal: args.goal,
        what_changed: args.what_changed,
        outcome_type: args.outcome_type,
        blockers: args.blockers,
        next_action: args.next_action,
        themes: args.themes,
        confidence: args.confidence,
        metadata: args.metadata,
      });
      return existing._id;
    }

    return await ctx.db.insert("session_insights", {
      conversation_id: args.conversation_id,
      team_id: args.team_id,
      actor_user_id: args.actor_user_id,
      source: args.source,
      generated_at: args.generated_at,
      summary: args.summary,
      goal: args.goal,
      what_changed: args.what_changed,
      outcome_type: args.outcome_type,
      blockers: args.blockers,
      next_action: args.next_action,
      themes: args.themes,
      confidence: args.confidence,
      metadata: args.metadata,
    });
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

    const context = (await ctx.runQuery(internalApi.sessionInsights.getConversationContextForInsight, {
      conversation_id: args.conversation_id,
    })) as ConversationInsightContext | null;
    if (!context) return { status: "skipped", reason: "missing_context" };

    const now = Date.now();
    const source = args.reason || "periodic";
    const existing = await ctx.runQuery(internalApi.sessionInsights.getExistingInsight, {
      conversation_id: args.conversation_id,
    });

    if (existing && source !== "manual" && now - existing.generated_at < 5 * 60 * 1000) {
      return { status: "skipped", reason: "rate_limited" };
    }

    const firstSlice = context.messages.slice(0, 8);
    const lastSlice = context.messages.length > 18 ? context.messages.slice(-10) : context.messages.slice(8);
    const sampledMessages = [...firstSlice, ...lastSlice]
      .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
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

    const prompt = `You are writing a session digest for a team activity feed. Someone reading this should understand what happened without needing to open the session.

Return ONLY valid JSON with this exact shape:
{
  "summary": "string (2-4 sentences)",
  "outcome_type": "shipped|progress|blocked|unknown",
  "blockers": ["string"],
  "themes": ["string"],
  "confidence": number (0..1)
}

Rules for summary:
- Write a concise narrative paragraph (2-4 sentences) that covers what was done and why.
- Include specific technical details: file names, function names, config values, URLs, error messages, package names -- anything concrete that helps the reader understand without opening the session.
- Mention what changed and the outcome naturally within the narrative, don't use labels like "Goal:" or "Changed:".
- If there were commits or PRs, mention the key ones.

Other rules:
- outcome_type: shipped if clear completed work, progress if still ongoing, blocked if stuck.
- blockers: only real blockers, empty array if none.
- themes: 2-6 short tags.
- No markdown, no commentary, just JSON.

Session metadata:
- title: ${context.conversation.title || ""}
- subtitle: ${context.conversation.subtitle || ""}
- idle_summary: ${context.conversation.idle_summary || ""}
- project_path: ${context.conversation.project_path || ""}
- git_branch: ${context.conversation.git_branch || ""}
- status: ${context.conversation.status}
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
          max_tokens: 600,
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

      const insightId = (await ctx.runMutation(internalApi.sessionInsights.upsertSessionInsight, {
        conversation_id: context.conversation._id,
        team_id: context.conversation.team_id!,
        actor_user_id: context.conversation.actor_user_id,
        source,
        generated_at: now,
        summary,
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
    if (!conversation.team_id) throw new Error("Conversation is not in a team");

    return await ctx.runAction(internalApi.sessionInsights.generateSessionInsight, {
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

    const candidates = await ctx.runQuery(internalApi.sessionInsights.getBackfillCandidates, {
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
      const res = await ctx.runAction(internalApi.sessionInsights.generateSessionInsight, {
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
      deduped.slice(0, 50).map((i) => ctx.db.get(i.conversation_id))
    );
    const conversationMap = new Map(
      conversations
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => [c._id.toString(), c])
    );

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

    for (const insight of deduped) {
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
    const sorted = [...deduped].sort((a, b) => b.generated_at - a.generated_at);
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
      sessions_analyzed: deduped.length,
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

    const filtered = actorInsights.filter((i) => i.team_id.toString() === args.team_id.toString());

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
