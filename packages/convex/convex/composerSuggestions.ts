import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
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
    phrases: v.optional(v.array(v.object({ text: v.string(), count: v.number() }))),
    patterns: v.optional(v.array(v.object({
      pattern: v.string(),
      example: v.string(),
      count: v.number(),
    }))),
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
        phrases: args.phrases,
        patterns: args.patterns,
        recent: args.recent,
        generated_at: args.generated_at,
      });
    } else {
      await ctx.db.insert("suggestion_profiles", args);
    }
  },
});

// Client-reported fate of a shown pill. Owner-gated; append-only. A dismissal
// covers the whole row, so the client sends one event per pill it hid.
export const recordSuggestionOutcome = mutation({
  args: {
    conversation_id: v.id("conversations"),
    anchor_message_uuid: v.string(),
    suggestion: v.string(),
    outcome: v.union(v.literal("sent"), v.literal("edited"), v.literal("dismissed")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return;
    await ctx.db.insert("suggestion_outcomes", {
      user_id: userId,
      conversation_id: args.conversation_id,
      anchor_message_uuid: args.anchor_message_uuid,
      suggestion: args.suggestion.slice(0, 300),
      outcome: args.outcome,
      created_at: Date.now(),
    });
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

// Boundary trim for mined n-grams: leading/trailing glue words carry no
// meaning, so "add a regression test to" and "a regression test" collapse
// toward the same core phrase before counting.
const PHRASE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "at", "by", "is", "are", "was", "were", "be", "it", "this", "that", "i",
  "we", "you", "me", "my", "your", "our", "as", "so", "do", "does", "did",
  "can", "could", "should", "would", "will", "have", "has", "had", "not",
  "its", "if", "then", "than", "also", "just", "like",
]);

// Recurring multi-word fragments across the user's inputs — the "things I say
// to models" ("add a regression test", "work hard on this", "make it
// beautiful"). Exact-equal whole-input matching misses these: the phrase
// recurs, the sentence around it never does. Each phrase counts once per
// input so one rambling message can't inflate it; when a longer phrase has
// support close to a contained shorter one, the longer (more specific) wins.
export function minePhrases(inputs: string[]): Array<{ text: string; count: number }> {
  const counts = new Map<string, number>();
  for (const input of inputs) {
    const words = input
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/\[image[^\]]*\]/g, " ")
      .replace(/[^a-z0-9' -]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const seen = new Set<string>();
    for (let n = 3; n <= 7; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n);
        let lo = 0;
        let hi = gram.length;
        while (lo < hi && PHRASE_STOPWORDS.has(gram[lo])) lo++;
        while (hi > lo && PHRASE_STOPWORDS.has(gram[hi - 1])) hi--;
        const core = gram.slice(lo, hi);
        if (core.length < 3) continue;
        const text = core.join(" ");
        if (text.length >= 10) seen.add(text);
      }
    }
    for (const p of seen) counts.set(p, (counts.get(p) || 0) + 1);
  }
  const candidates = [...counts.entries()]
    .filter(([, c]) => c >= 3)
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.text.length - a.text.length);
  const kept: Array<{ text: string; count: number }> = [];
  for (const cand of candidates) {
    const container = kept.find((k) => k.text.includes(cand.text));
    if (container && container.count >= cand.count * 0.8) continue;
    kept.push(cand);
  }
  return kept
    .sort((a, b) => b.count - a.count || b.text.length - a.text.length)
    .slice(0, 25);
}

// Rank raw inputs into the profile: mined recurring phrases, repeated whole
// multi-word inputs (with a recency boost), and the newest distinct inputs in
// order (style evidence even when nothing repeats). One- and two-word inputs
// ("continue", "go", "do it") are deliberately excluded from `frequent` —
// they dominate any frequency count but carry nothing worth suggesting.
export function rankInputs(rows: Array<{ text: string; ts: number }>, now: number): {
  frequent: Array<{ text: string; count: number }>;
  phrases: Array<{ text: string; count: number }>;
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
    .filter((e) => e.count >= 2 && e.text.trim().split(/\s+/).length >= 3)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 15)
    .map((e) => ({ text: e.text, count: e.count }));

  const phrases = minePhrases(rows.map((r) => r.text));

  const seen = new Set<string>();
  const recent: string[] = [];
  for (const r of [...rows].sort((a, b) => b.ts - a.ts)) {
    const key = r.text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push(r.text);
    if (recent.length >= 12) break;
  }
  return { frequent, phrases, recent };
}

// Bare continuation nudges are never worth a pill: the user types them in one
// keystroke, so a suggestion earns its place only by carrying content. The
// prompt forbids them too; this is the backstop.
const GENERIC_NUDGES = new Set([
  "continue", "go", "proceed", "go ahead", "keep going", "do it", "yes", "ok",
  "okay", "sure", "yes please", "sounds good", "looks good", "lgtm", "done",
  "next", "fix it", "try again", "ship it",
]);

// Normalization used to compare a suggestion against historical messages.
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.!?…]+$/, "").trim();
}

// Output guards: press-send-ready strings only. Refusal/meta prose from the
// model must never render as a pill. Selectivity lives here too: candidates
// carry a model-reported confidence, anything under 0.7 is dropped, and the
// row shows at most TWO pills — a third only when the model is near-certain
// (an explicit multi-choice moment). Legacy bare strings score 0.75.
// `bannedVerbatim` holds the user's own historical messages and mined
// examples (normalized): a suggestion equal to one is a replayed quote, the
// exact failure the pattern mining exists to prevent — drop it.
export function sanitizeSuggestions(
  parsed: unknown,
  lastUserText: string | null,
  bannedVerbatim?: Set<string>,
): string[] {
  const rawList: unknown[] = Array.isArray(parsed) ? parsed : [];
  const seen = new Set<string>();
  const lastKey = lastUserText ? normalizeForMatch(lastUserText) : null;
  const scored: Array<{ text: string; conf: number }> = [];
  for (const item of rawList) {
    const text = (typeof item === "string" ? item : (item as any)?.text)
      ?.toString()
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "");
    if (!text || text.length > 120) continue;
    if (/^(i cannot|i can't|i'm sorry|sorry|as an ai|i don't have)/i.test(text)) continue;
    const key = normalizeForMatch(text);
    if (GENERIC_NUDGES.has(key)) continue;
    if (seen.has(key) || key === lastKey) continue;
    if (bannedVerbatim?.has(key)) continue;
    seen.add(key);
    const rawConf = (item as any)?.confidence;
    const conf = typeof rawConf === "number" && rawConf >= 0 && rawConf <= 1 ? rawConf : 0.75;
    scored.push({ text, conf });
  }
  const kept = scored.filter((s) => s.conf >= 0.7).sort((a, b) => b.conf - a.conf);
  const out = kept.slice(0, 2).map((s) => s.text);
  if (kept.length > 2 && kept[2].conf >= 0.85 && out.length < MAX_SUGGESTIONS) {
    out.push(kept[2].text);
  }
  return out;
}

// LLM pass over the mined corpus: learn the user's recurring BEHAVIOR
// PATTERNS — what they habitually demand, abstracted from topic — each with
// one real quote as voice evidence. The suggester then APPLIES a pattern to
// the current conversation's specifics; it never replays the old message
// (that was the verbatim-quote failure mode). Runs once per profile refresh
// (12h TTL), so its cost is a rounding error. Returns null on any failure so
// the caller can fall back to the n-gram phrases.
export async function minePatternsWithLLM(
  inputs: string[],
): Promise<{
  patterns: Array<{ pattern: string; example: string; count: number }>;
  usage?: unknown;
} | null> {
  // Bare nudges dominate any raw corpus (a "go" for every agent turn) and
  // would surface as the top "habit" — noise that biases the suggester
  // toward exactly what it must never output. Mine only substantive inputs.
  const corpus = inputs
    .filter((t) => t.trim().split(/\s+/).length >= 3)
    .slice(0, 250)
    .map((t) => t.replace(/\s+/g, " ").slice(0, 200))
    .join("\n");
  const prompt = `You are analyzing one developer's messages to their coding agents, collected across many sessions. Learn their recurring BEHAVIOR PATTERNS — what they habitually ask for, demand, or decide — so another model can apply those habits to a brand-new conversation.

Return ONLY a JSON array: [{"pattern": string, "example": string, "count": number}]

- "pattern": a short, generalized description of the habit, freed from any specific topic, written so it could guide a reply in ANY conversation. Good: "after seeing a finished feature, asks for several concrete ways to make it better", "demands thorough end-to-end testing with visual proof before accepting work", "tells the agent to proceed autonomously and patch everything it found rather than asking". Bad (too topic-bound): "asks about screenshots rendering inline".
- "example": ONE real quote from the messages that best shows the habit and the developer's voice.
- "count": how many distinct messages express this habit.

Rules:
- A pattern must be expressed in at least 2 distinct messages; cluster different wordings of the same intent.
- Generalize the INTENT and drop the topic: the topic belongs to old conversations, the habit transfers.
- Exclude one-off requests, greetings, filler, and bare nudges ("continue", "go", "do it").
- Sort by count descending. At most 15 entries. No markdown, no commentary.

Messages (one per line):
${corpus}`;

  const completion = await llmComplete({ provider: "anthropic", prompt, maxTokens: 1200 });
  if (!completion) return null;
  {
    const parsed = parseJsonBlock(completion.text);
    if (!Array.isArray(parsed)) return null;
    const out = parsed
      .filter(
        (p: any) =>
          p &&
          typeof p.pattern === "string" &&
          typeof p.example === "string" &&
          typeof p.count === "number" &&
          p.count >= 2,
      )
      .map((p: any) => ({
        pattern: String(p.pattern).trim().slice(0, 200),
        example: String(p.example).trim().slice(0, 160),
        count: Math.round(p.count),
      }))
      // A habit whose best example is itself a bare nudge is the nudge habit
      // in disguise — the one pattern the suggester must not learn.
      .filter((p: { example: string }) => !GENERIC_NUDGES.has(normalizeForMatch(p.example)))
      .slice(0, 15);
    return out.length ? { patterns: out, usage: completion.usage } : null;
  }
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
  profile: {
    frequent: Array<{ text: string; count: number }>;
    phrases: Array<{ text: string; count: number }>;
    patterns: Array<{ pattern: string; example: string; count: number }>;
    recent: string[];
  },
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

  // Patterns are the primary habit evidence. The n-gram phrases only appear
  // when the LLM miner produced nothing (fallback), so the model is never
  // handed a list of literal quotes when generalized habits are available.
  const habitsText = profile.patterns.length
    ? profile.patterns
        .map((p) => `- (×${p.count}) ${p.pattern}\n    e.g. "${p.example}"`)
        .join("\n")
    : profile.phrases.length
      ? profile.phrases.map((f) => `- (×${f.count}) says things like: "${f.text}"`).join("\n")
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

  return `You predict what a developer will type next into their coding-agent session. You see the session so far, plus a profile of this developer's HABITS — the things they recurrently ask for, learned across their history. Your job is to apply those habits to THIS conversation's specifics and produce the exact next message they would send — or nothing.

Return ONLY a JSON array: [{"text": string, "confidence": number}] — 0 to 2 entries (a third only for an explicit multi-choice moment where each option is near-certain). "confidence" is your probability (0..1) that the developer would actually send this text or a trivial variant of it; omit anything below 0.7. No wrapper object, no markdown, no commentary. [] is the expected answer for most moments.

Read the moment first — the agent's final message decides everything:
- The agent asked a question or offered options → suggest the most likely answers, phrased the way this developer would phrase them.
- The agent proposed a plan or showed a diff → suggest this developer's likely verdict: approval in their usual words, or a pushback they would plausibly raise from the session itself.
- The agent finished work → suggest the natural next directive, grounded in what this session shows is still undone (verify, test, commit, deploy, fix the thing it flagged).
- The agent is mid-task, or the reply needs knowledge only the developer has (their opinion, product intent, something outside the session) → return [].

How to use the habits: each habit is a generalized tendency with one example quote for voice. Apply the TENDENCY to what is on the table right now, filling in this session's actual subject — the feature, file, bug, or decision in front of them. The example shows HOW they talk, not WHAT to say: a suggestion that repeats an example, or any past message, is wrong by definition, because it is about some other conversation.

Voice: copy the developer's register from the examples and recent messages — casing, punctuation, brevity, bluntness. If they write terse lowercase commands, so do you. Every suggestion must read like THEY typed it, about THIS conversation, and be sendable exactly as written; each will be sent with one click.

Hard rules:
- Quality over count. One suggestion the developer actually sends is the win; two mediocre ones teach them to ignore the feature. When you're not confident, return [].
- Never suggest a bare continuation nudge — "continue", "go", "proceed", "do it", "yes", or anything the developer could type in one keystroke. A suggestion earns its place by carrying content: a concrete directive, answer, or decision specific to this moment.
- Never output a past message or an example quote verbatim or near-verbatim. Only its habit transfers.
- Suggestions must differ in intent, not phrasing.
- Keep each under 60 characters unless the moment clearly requires a longer reply.
- Never repeat what has already been said, asked, or done in the session; never contradict the developer's last instruction.
- Never invent file paths, commands, names, or ids that do not appear in the session.

Session:
${meta || "- (no metadata)"}

This developer's recurring habits (×N = seen in N separate messages across their history):
${habitsText}

Their most recent messages, for voice only (newest first):
${recentText}

Conversation:
${excerpt}`;
}

// One completion call, either provider. The suggester picks its provider from
// the SUGGESTIONS_PROVIDER env var ("openai" → GPT-5.6 Luna, anything else →
// Haiku 4.5), so an A/B flip is an env change, not a deploy. Luna quirks:
// temperature is rejected (fixed at 1) and the token cap is
// max_completion_tokens, which also feeds its hidden reasoning tokens — cap
// generously or long prompts return empty content with the budget consumed.
export async function llmComplete(opts: {
  provider: "anthropic" | "openai";
  prompt: string;
  maxTokens: number;
}): Promise<{ text: string; usage?: unknown } | null> {
  try {
    if (opts.provider === "openai") {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return null;
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          max_completion_tokens: opts.maxTokens,
          messages: [{ role: "user", content: opts.prompt }],
        }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      const text = data.choices?.[0]?.message?.content?.trim() ?? "";
      return text ? { text, usage: data.usage } : null;
    }
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: opts.maxTokens,
        temperature: 0.3,
        messages: [{ role: "user", content: opts.prompt }],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data.content?.[0]?.text?.trim() ?? "";
    return text ? { text, usage: data.usage } : null;
  } catch {
    return null;
  }
}

export function parseJsonBlock(raw: string): unknown | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// Side-by-side provider comparison over real conversations — the evidence
// behind the SUGGESTIONS_PROVIDER choice. Internal-only; run via
// `npx convex run` with a user id and conversation ids. Makes no writes.
export const bakeoffSuggestions = internalAction({
  args: {
    user_id: v.id("users"),
    conversation_ids: v.array(v.id("conversations")),
  },
  handler: async (ctx, args): Promise<any> => {
    const profile = await ctx.runQuery(internal.composerSuggestions.getSuggestionProfile, {
      user_id: args.user_id,
    });
    if (!profile) return { error: "no profile" };
    const tok = (u: any) => ({
      in: u?.input_tokens ?? u?.prompt_tokens,
      out: u?.output_tokens ?? u?.completion_tokens,
      reasoning: u?.completion_tokens_details?.reasoning_tokens,
    });
    const results: any[] = [];
    for (const cid of args.conversation_ids) {
      const context = await ctx.runQuery(internal.composerSuggestions.getSuggestionContext, {
        conversation_id: cid,
      });
      if (!context || context.tail_role !== "assistant") {
        results.push({ cid, skipped: "no assistant tail" });
        continue;
      }
      const prompt = buildPrompt(context, {
        frequent: profile.frequent,
        phrases: profile.phrases ?? [],
        patterns: profile.patterns ?? [],
        recent: profile.recent,
      });
      const t0 = Date.now();
      const haiku = await llmComplete({ provider: "anthropic", prompt, maxTokens: 600 });
      const t1 = Date.now();
      const luna = await llmComplete({ provider: "openai", prompt, maxTokens: 600 });
      const t2 = Date.now();
      const tailMsg = [...context.turns].reverse().find((t) => t.role === "assistant");
      results.push({
        cid,
        title: context.conversation.title,
        tail: (tailMsg?.content ?? "").slice(-180),
        haiku: { ms: t1 - t0, text: haiku?.text ?? null, tokens: tok(haiku?.usage) },
        luna: { ms: t2 - t1, text: luna?.text ?? null, tokens: tok(luna?.usage) },
      });
    }
    return results;
  },
});

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
      // Generalized habits beat literal quotes; the n-gram phrases are the
      // fallback when the miner call fails, so a bad LLM day degrades, never
      // blanks.
      const mined = await minePatternsWithLLM(inputs.map((r) => r.text));
      await ctx.runMutation(internal.composerSuggestions.storeSuggestionProfile, {
        user_id: user._id,
        frequent: ranked.frequent,
        phrases: ranked.phrases,
        patterns: mined?.patterns,
        recent: ranked.recent,
        generated_at: now,
      });
      profile = { ...ranked, patterns: mined?.patterns, generated_at: now } as any;
    }

    const prompt = buildPrompt(context, {
      frequent: profile!.frequent,
      phrases: profile!.phrases ?? [],
      patterns: profile!.patterns ?? [],
      recent: profile!.recent,
    });
    // Anything the user has literally said before — recent messages, mined
    // examples, repeated whole inputs — may not come back as a pill.
    const bannedVerbatim = new Set<string>([
      ...profile!.recent.map(normalizeForMatch),
      ...profile!.frequent.map((f) => normalizeForMatch(f.text)),
      ...(profile!.patterns ?? []).map((p) => normalizeForMatch(p.example)),
      ...context.turns.filter((t) => t.role === "user").map((t) => normalizeForMatch(t.content)),
    ]);

    try {
      const provider = process.env.SUGGESTIONS_PROVIDER === "openai" ? "openai" : "anthropic";
      const completion = await llmComplete({ provider, prompt, maxTokens: 600 });
      if (!completion) return { status: "error", reason: "provider_failed" };
      const parsed = parseJsonBlock(completion.text);
      if (parsed === null) return { status: "error", reason: "invalid_json" };

      const lastUser = [...context.turns].reverse().find((t) => t.role === "user");
      const suggestions = sanitizeSuggestions(parsed, lastUser?.content ?? null, bannedVerbatim);

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
