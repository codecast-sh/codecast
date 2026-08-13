import { action, internalMutation, internalQuery, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { isLowSignalPrompt } from "./titleGeneration";

// Suggested replies for the composer ("suggestion pills"). Fourth member of
// the Haiku family (titleGeneration, idleSummary, sessionInsights): an
// internal query slices context, a public action calls the API, output guards
// reject junk before storage. What sets this one apart is the second input:
// alongside the session, the model sees a mined, ranked corpus of the user's
// own past composer inputs — the suggestions should sound like the user, not
// like a model.

const PROFILE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SUGGESTIONS = 3;

// A message row that carries a real human-readable turn (mirrors
// idleSummary.isSummarizableMessage without the low-signal filter, which we
// apply only to USER rows — an assistant tail is context however it's phrased).
function isConversationTurn(m: {
  role?: string;
  content?: string | null;
  tool_results?: unknown[] | null;
}): boolean {
  return (
    (m.role === "user" || m.role === "assistant") &&
    !!m.content?.trim() &&
    !m.tool_results?.length
  );
}

// The anchor identifies the tail turn suggestions were generated against.
// The client computes the same value from its store window (message_uuid ??
// _id of the last real turn), so a matching anchor means "still current".
function anchorOf(m: { message_uuid?: string | null; _id: Id<"messages"> }): string {
  return m.message_uuid || m._id.toString();
}

export const getComposerSuggestions = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row = await ctx.db
      .query("composer_suggestions")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .first();
    // Owner-only: suggestions are predictions of the OWNER's next message,
    // mined partly from their private input history.
    if (!row || row.user_id !== userId) return null;
    return {
      suggestions: row.suggestions,
      anchor_message_uuid: row.anchor_message_uuid,
      generated_at: row.generated_at,
    };
  },
});

export const getSuggestionContext = internalQuery({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;

    const raw = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("desc")
      .take(60);

    const turns = raw.filter(isConversationTurn).reverse();
    const tail = turns[turns.length - 1];

    return {
      conversation: {
        user_id: conversation.user_id,
        title: conversation.title,
        subtitle: conversation.subtitle,
        idle_summary: conversation.idle_summary,
        thread_state: conversation.thread_state,
        project_path: conversation.project_path,
        git_branch: conversation.git_branch,
        status: conversation.status,
      },
      turns: turns.map((m) => ({
        role: m.role,
        content: m.content || "",
        timestamp: m.timestamp,
      })),
      tail_role: tail?.role ?? null,
      anchor: tail ? anchorOf(tail) : null,
    };
  },
});

// The user's recent composer inputs across their latest sessions. Uses the
// role-scoped index so only user rows are read. The recency-ordered
// conversation walk goes DEEP (up to 120 sessions) with an early stop: for a
// user whose freshest sessions are machine-driven (triggers, spawned runs —
// their "user" turns are markup carriers, filtered below), the typed inputs
// live further back, and a shallow walk mines almost nothing. Run only when
// the cached profile has expired.
export const getRecentUserInputs = internalQuery({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) => q.eq("user_id", args.user_id))
      .order("desc")
      .take(120);

    const out: Array<{ text: string; ts: number }> = [];
    for (const conv of conversations) {
      if (out.length >= 400) break;
      // Filter BEFORE take: most user-role rows are tool-result carriers (the
      // agent's tool outputs come back as role "user"), and an unfiltered
      // take(25) window fills up with them, crowding out every typed prompt.
      // Same idiom as titleGeneration's userPrompts.
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_conversation_role_timestamp", (q) =>
          q.eq("conversation_id", conv._id).eq("role", "user")
        )
        .order("desc")
        .filter((q) =>
          q.and(
            q.eq(q.field("tool_results"), undefined),
            q.neq(q.field("content"), undefined)
          )
        )
        .take(25);
      for (const m of rows) {
        const text = (m.content || "").trim();
        if (!text || m.tool_results?.length || m.is_encrypted) continue;
        if (text.length > 300 || isLowSignalPrompt(text)) continue;
        // Machine-carrier turns (session messages, scheduled-task briefings,
        // pasted transcripts) start with markup — not something the user typed.
        if (text.startsWith("<")) continue;
        out.push({ text, ts: m.timestamp });
      }
    }
    return out;
  },
});

export const getSuggestionProfile = internalQuery({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("suggestion_profiles")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .first();
  },
});

export const storeSuggestionProfile = internalMutation({
  args: {
    user_id: v.id("users"),
    frequent: v.array(v.object({ text: v.string(), count: v.number() })),
    recent: v.array(v.string()),
    generated_at: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("suggestion_profiles")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        frequent: args.frequent,
        recent: args.recent,
        generated_at: args.generated_at,
      });
    } else {
      await ctx.db.insert("suggestion_profiles", args);
    }
  },
});

export const storeSuggestions = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    anchor_message_uuid: v.string(),
    suggestions: v.array(v.string()),
    generated_at: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("composer_suggestions")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        anchor_message_uuid: args.anchor_message_uuid,
        suggestions: args.suggestions,
        generated_at: args.generated_at,
      });
    } else {
      await ctx.db.insert("composer_suggestions", args);
    }
  },
});

// Rank raw inputs into the profile: exact-normalized frequency counting with
// a recency boost, plus the newest distinct inputs in order (style evidence
// even when nothing repeats).
export function rankInputs(rows: Array<{ text: string; ts: number }>, now: number): {
  frequent: Array<{ text: string; count: number }>;
  recent: string[];
} {
  const byKey = new Map<string, { text: string; count: number; lastTs: number }>();
  for (const r of rows) {
    const key = r.text.toLowerCase().replace(/\s+/g, " ");
    const e = byKey.get(key);
    if (e) {
      e.count++;
      if (r.ts > e.lastTs) {
        e.lastTs = r.ts;
        e.text = r.text;
      }
    } else {
      byKey.set(key, { text: r.text, count: 1, lastTs: r.ts });
    }
  }
  const day = 24 * 60 * 60 * 1000;
  const score = (e: { count: number; lastTs: number }) =>
    e.count + (now - e.lastTs < 7 * day ? 1.5 : 0) + (now - e.lastTs < day ? 1 : 0);
  const frequent = [...byKey.values()]
    .filter((e) => e.count >= 2)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 30)
    .map((e) => ({ text: e.text, count: e.count }));

  const seen = new Set<string>();
  const recent: string[] = [];
  for (const r of [...rows].sort((a, b) => b.ts - a.ts)) {
    const key = r.text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push(r.text);
    if (recent.length >= 12) break;
  }
  return { frequent, recent };
}

// Output guards: press-send-ready strings only. Refusal/meta prose from the
// model must never render as a pill.
export function sanitizeSuggestions(parsed: unknown, lastUserText: string | null): string[] {
  const rawList: unknown[] = Array.isArray(parsed) ? parsed : [];
  const out: string[] = [];
  const seen = new Set<string>();
  const lastKey = lastUserText?.trim().toLowerCase() ?? null;
  for (const item of rawList) {
    const text = (typeof item === "string" ? item : (item as any)?.text)
      ?.toString()
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "");
    if (!text || text.length > 120) continue;
    if (/^(i cannot|i can't|i'm sorry|sorry|as an ai|i don't have)/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key) || key === lastKey) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

function buildPrompt(
  context: {
    conversation: {
      title?: string;
      subtitle?: string;
      idle_summary?: string;
      thread_state?: string;
      project_path?: string;
      git_branch?: string;
    };
    turns: Array<{ role: string; content: string }>;
  },
  profile: { frequent: Array<{ text: string; count: number }>; recent: string[] },
): string {
  const turns = context.turns;
  // Opening turns set the goal; the tail is the moment being replied to. The
  // final assistant message gets the most room — suggestions respond to it.
  const head = turns.length > 14 ? turns.slice(0, 4) : [];
  const tail = turns.length > 14 ? turns.slice(-10) : turns;
  const renderTurn = (m: { role: string; content: string }, isLast: boolean) => {
    const cap = isLast && m.role === "assistant" ? 2400 : 400;
    const text = m.content.length > cap ? m.content.slice(0, cap) + " […]" : m.content;
    return `${m.role === "assistant" ? "Agent" : "Developer"}: ${text}`;
  };
  const excerpt = [
    ...head.map((m) => renderTurn(m, false)),
    ...(head.length ? ["[… earlier conversation omitted …]"] : []),
    ...tail.map((m, i) => renderTurn(m, i === tail.length - 1)),
  ].join("\n\n");

  const frequentText = profile.frequent.length
    ? profile.frequent.map((f) => `- (×${f.count}) ${f.text}`).join("\n")
    : "- none mined yet";
  const recentText = profile.recent.length
    ? profile.recent.map((t) => `- ${t}`).join("\n")
    : "- none";

  const c = context.conversation;
  const meta = [
    c.title && `- session: ${c.title}`,
    c.project_path && `- project: ${c.project_path}`,
    c.git_branch && `- branch: ${c.git_branch}`,
    c.idle_summary && `- last status: ${c.idle_summary}`,
    c.thread_state && `- pinned thread state:\n${c.thread_state.slice(0, 500)}`,
  ]
    .filter(Boolean)
    .join("\n");

  return `You predict what a developer will type next into their coding-agent session. You see the session so far and evidence of how this developer actually writes. Suggest the exact next message they would send — or nothing.

Return ONLY a JSON array of 0 to 3 strings. No wrapper object, no markdown, no commentary.

Read the moment first — the agent's final message decides everything:
- The agent asked a question or offered options → suggest the most likely answers, phrased the way this developer would phrase them.
- The agent proposed a plan or showed a diff → suggest this developer's likely verdict: approval in their usual words, or a pushback they would plausibly raise from the session itself.
- The agent finished work → suggest the natural next directive, grounded in what this session shows is still undone (verify, test, commit, deploy, fix the thing it flagged).
- The agent is mid-task, or the reply needs knowledge only the developer has (their opinion, product intent, something outside the session) → return [].

Voice: copy the developer's register from their past inputs below — casing, punctuation, brevity, bluntness. If they write terse lowercase commands, so do you. Every suggestion must read like THEY typed it and be sendable exactly as written.

Hard rules:
- Quality over count. One confident suggestion beats three guesses; [] is a good answer when the moment isn't predictable.
- Suggestions must differ in intent, not phrasing.
- Keep each under 60 characters unless the moment clearly requires a longer reply.
- Never repeat what has already been said, asked, or done in the session; never contradict the developer's last instruction.
- Never invent file paths, commands, names, or ids that do not appear in the session.
- The frequent inputs are habit evidence, not a menu — reuse one only when it fits this exact moment.

Session:
${meta || "- (no metadata)"}

How this developer writes — their most frequent composer inputs across recent sessions:
${frequentText}

Their most recent inputs (newest first):
${recentText}

Conversation:
${excerpt}`;
}

export const generateComposerSuggestions = action({
  args: { conversation_id: v.id("conversations") },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: "ok" | "skipped" | "error"; reason?: string }> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { status: "skipped", reason: "missing_api_key" };

    const user = await ctx.runQuery(api.users.getCurrentUser, {} as any);
    if (!user) throw new Error("Not authenticated");

    const context = await ctx.runQuery(internal.composerSuggestions.getSuggestionContext, {
      conversation_id: args.conversation_id,
    });
    if (!context) return { status: "skipped", reason: "missing_conversation" };
    if (context.conversation.user_id !== user._id) {
      throw new Error("Only the session owner can generate suggestions");
    }
    // Suggestions predict a reply to the AGENT; if the developer spoke last,
    // there is nothing to reply to yet.
    if (!context.anchor || context.tail_role !== "assistant") {
      return { status: "skipped", reason: "no_assistant_tail" };
    }

    const now = Date.now();
    const existing = await ctx.runQuery(api.composerSuggestions.getComposerSuggestions, {
      conversation_id: args.conversation_id,
    });
    // Anchor match is the throttle: the tail hasn't changed, so neither would
    // the prediction. Covers cross-device double-fires too.
    if (existing && existing.anchor_message_uuid === context.anchor) {
      return { status: "skipped", reason: "already_generated" };
    }

    let profile = await ctx.runQuery(internal.composerSuggestions.getSuggestionProfile, {
      user_id: user._id,
    });
    if (!profile || now - profile.generated_at > PROFILE_TTL_MS) {
      const inputs = await ctx.runQuery(internal.composerSuggestions.getRecentUserInputs, {
        user_id: user._id,
      });
      const ranked = rankInputs(inputs, now);
      await ctx.runMutation(internal.composerSuggestions.storeSuggestionProfile, {
        user_id: user._id,
        frequent: ranked.frequent,
        recent: ranked.recent,
        generated_at: now,
      });
      profile = { ...ranked, generated_at: now } as any;
    }

    const prompt = buildPrompt(context, {
      frequent: profile!.frequent,
      recent: profile!.recent,
    });

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
          max_tokens: 300,
          temperature: 0.3,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) return { status: "error", reason: `provider_${response.status}` };

      const data = await response.json();
      const raw = data.content?.[0]?.text?.trim() ?? "";
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      let parsed: unknown = [];
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        return { status: "error", reason: "invalid_json" };
      }

      const lastUser = [...context.turns].reverse().find((t) => t.role === "user");
      const suggestions = sanitizeSuggestions(parsed, lastUser?.content ?? null);

      // Store even an empty result: it records "this anchor was evaluated",
      // which is what stops clients from re-asking every render.
      await ctx.runMutation(internal.composerSuggestions.storeSuggestions, {
        conversation_id: args.conversation_id,
        user_id: user._id,
        anchor_message_uuid: context.anchor,
        suggestions,
        generated_at: now,
      });
      return { status: "ok" };
    } catch (error) {
      console.error("generateComposerSuggestions failed", error);
      return { status: "error", reason: "exception" };
    }
  },
});
