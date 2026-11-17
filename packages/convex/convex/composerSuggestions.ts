import { action, internalMutation, internalQuery, mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { isLowSignalPrompt } from "./titleGeneration";
import { verifyApiToken } from "./apiTokens";
import { CHEAP_MODEL, parseJsonBlock, postMessages, replyText, type SurfaceRequest } from "./lib/anthropic";
import { openaiFetch } from "./lib/openai";
import { NO_TEAM_CONTENT_GATE, vendorAllowedFor, vendorRefusalFromDb, type VendorGate } from "./lib/vendorGuard";
import { MAX_SUGGESTIONS, MAX_SUGGESTION_CHARS, outcomeArgs, suggestionsProvider, writeSuggestionOutcome } from "./lib/suggestionOutcomeWrite";
import { rankInputs } from "./lib/suggestionInputRanking";
export { MAX_SUGGESTIONS, MAX_SUGGESTION_CHARS };

// Suggested replies for the composer ("suggestion pills"). Fourth member of
// the Haiku family (titleGeneration, idleSummary, sessionInsights): an
// internal query slices context, a public action calls the API, output guards
// reject junk before storage. What sets this one apart is the second input:
// alongside the session, the model sees a mined, ranked corpus of the user's
// own past composer inputs — the suggestions should sound like the user, not
// like a model.

const PROFILE_TTL_MS = 12 * 60 * 60 * 1000;
// One reply (MAX_SUGGESTIONS, lib/suggestionOutcomeWrite), drawn as ghost
// text in the empty composer. Alternatives behind a key were tried (Nov 2026)
// and matched what people typed in 0 of 180 eval replays, so the suggester
// makes its one prediction or none.
// The model's probability that the developer sends the reply. Below it the
// ghost stays empty: a wrong ghost costs a glance and teaches people to stop
// reading it, and silence is right when the session gives no basis.
const MIN_CONFIDENCE = 0.5;
// A pill may carry a full working prompt (a reusable multi-sentence
// directive), not just a verdict — so the cap is "not a pasted wall", not
// "fits on one line". The row truncates visually; the send carries it whole.

// A message row that carries a real human-readable turn (mirrors
// idleSummary.isSummarizableMessage without the low-signal filter, which we
// apply only to USER rows — an assistant tail is context however it's phrased).
export function isConversationTurn(m: {
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
function anchorOf(m: { message_uuid?: string | null; _id: string }): string {
  return m.message_uuid || m._id.toString();
}

// How many raw rows (newest first) the suggester reads before keeping only
// real turns.
const SUGGESTION_CONTEXT_ROWS = 60;

type SuggestionRow = {
  _id: string;
  message_uuid?: string | null;
  role?: string;
  content?: string | null;
  tool_results?: unknown[] | null;
  timestamp: number;
};

type SuggestionConversation = {
  user_id: Id<"users">;
  title?: string;
  subtitle?: string;
  idle_summary?: string;
  thread_state?: string;
  project_path?: string;
  git_branch?: string;
  status?: string;
};

// The suggester's context from a conversation's rows in time order, ending at
// the moment being predicted: the newest SUGGESTION_CONTEXT_ROWS rows, kept
// to real turns. getSuggestionContext feeds it the live tail; the evals feed
// it the rows up to a past moment, so both see the same window.
export function contextFromRows<C extends SuggestionConversation>(rows: SuggestionRow[], conversation: C) {
  const turns = rows.slice(-SUGGESTION_CONTEXT_ROWS).filter(isConversationTurn);
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
      role: m.role as string,
      content: m.content || "",
      timestamp: m.timestamp,
    })),
    tail_role: tail?.role ?? null,
    anchor: tail ? anchorOf(tail) : null,
  };
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

// The feeder for the client store (web store/clientSyncRegistry,
// `composerSuggestions`): this conversation's suggestion row, as a list of at
// most one, for its owner only. getComposerSuggestions above stays for clients
// built before the store read it.
export const forConversation = query({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const id = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!userId || !id) return [];
    const row = await ctx.db
      .query("composer_suggestions")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", id))
      .first();
    if (!row || row.user_id !== userId) return [];
    return [{ _id: row._id, conversation_id: row.conversation_id, anchor_message_uuid: row.anchor_message_uuid, suggestions: row.suggestions, generated_at: row.generated_at }];
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
      .take(SUGGESTION_CONTEXT_ROWS);

    return contextFromRows(raw.reverse(), conversation);
  },
});

// A session whose "user" turns were written by an agent, not the person:
// subagents, workflow workers, sessions spawned by another session, comment
// forks. Their briefings read like prompts and would be mined as the user's
// own habits.
export function isMachineDrivenConversation(conv: {
  is_subagent?: boolean;
  is_workflow_sub?: boolean;
  workflow_run_id?: unknown;
  parent_conversation_id?: unknown;
  spawned_by_conversation_id?: unknown;
  comment_fork_parent?: unknown;
}): boolean {
  return !!(
    conv.is_subagent ||
    conv.is_workflow_sub ||
    conv.workflow_run_id ||
    conv.parent_conversation_id ||
    conv.spawned_by_conversation_id ||
    conv.comment_fork_parent
  );
}

// A user-role row the person did not type: a peer session's message (the
// harness renders those as "Another Claude session sent a message: <teammate-
// message …>"), a session message or task notification carried as markup, a
// slash-command wrapper, or codecast's own notices ("[codecast] Now using
// Codex"). Everything the habit miner and the suggestion eval must ignore.
export function isMachineCarrierText(text: string): boolean {
  const head = text.trimStart().slice(0, 200);
  return (
    head.startsWith("<") ||
    head.startsWith("[codecast]") ||
    /<(teammate-message|session-message|task-notification|cast-decision|command-(?:message|name))\b/.test(head)
  );
}

// Bare continuation nudges are never worth a pill: the user types them in one
// keystroke, so a suggestion earns its place only by carrying content. The
// prompt forbids them too; this is the backstop.
const GENERIC_NUDGES = new Set([
  "continue", "go", "proceed", "go ahead", "keep going", "do it", "yes", "ok",
  "okay", "sure", "yes please", "sounds good", "looks good", "lgtm", "done",
  "next", "fix it", "try again", "ship it",
]);
export function isGenericNudge(text: string): boolean {
  return GENERIC_NUDGES.has(normalizeForMatch(text));
}

// Per conversation: the opening brief plus the newest inputs. Standing
// instructions ("polish this to perfection… do 10 more rounds") ride on the
// FIRST message of a session; in a long session that row is hundreds of
// turns behind the tail, so a newest-only window never sees it.
const OPENING_ROWS = 3;
const NEWEST_ROWS = 15;

// The user's recent composer inputs across their latest sessions. Uses the
// role-scoped index so only user rows are read. The recency-ordered
// conversation walk goes DEEP (up to 120 sessions) with an early stop: for a
// user whose freshest sessions are machine-driven, the typed inputs live
// further back, and a shallow walk mines almost nothing. Run only when the
// cached profile has expired.
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
      if (isMachineDrivenConversation(conv)) continue;
      // The miner sends this corpus to the suggester's vendor, so a regulated
      // team's conversation stays out of it while that vendor has no BAA.
      if (await vendorRefusalFromDb(ctx, { conversationId: conv._id }, suggestionsProvider())) continue;
      // Filter BEFORE take: most user-role rows are tool-result carriers (the
      // agent's tool outputs come back as role "user"), and an unfiltered
      // window fills up with them, crowding out every typed prompt. Same
      // idiom as titleGeneration's userPrompts.
      const typed = () =>
        ctx.db
          .query("messages")
          .withIndex("by_conversation_role_timestamp", (q) =>
            q.eq("conversation_id", conv._id).eq("role", "user")
          )
          .filter((q) =>
            q.and(
              q.eq(q.field("tool_results"), undefined),
              q.neq(q.field("content"), undefined)
            )
          );
      const opening = await typed().order("asc").take(OPENING_ROWS);
      const newest = await typed().order("desc").take(NEWEST_ROWS);
      const seen = new Set<string>();
      const rows = [...opening, ...newest]
        .filter((m) => (seen.has(m._id) ? false : (seen.add(m._id), true)))
        .sort((a, b) => a.timestamp - b.timestamp);
      // A slash command lands as two user rows: the `<command-message>`
      // wrapper, then the command's expanded .md body (nothing the user
      // typed, but no flag marks it). The wrapper is dropped as markup
      // below; the row that follows it is the expansion.
      let afterCommand = false;
      for (const m of rows) {
        const text = (m.content || "").trim();
        const isCommand = /^<command-(?:message|name)>/.test(text);
        const isExpansion = afterCommand;
        afterCommand = isCommand;
        if (isExpansion) continue;
        // A fork copies its parent's history with the original timestamps,
        // so rows older than the fork itself are the parent's — read once,
        // from the parent.
        if (conv.forked_from && m.timestamp < conv._creationTime) continue;
        if (!text || m.tool_results?.length || m.is_encrypted) continue;
        // The cap only excludes pasted walls (logs, transcripts). A long
        // typed directive — the multi-sentence "polish this to perfection"
        // prompt a developer reuses across sessions — is the richest input
        // the miner gets, so it must survive whole.
        if (text.length > 2000 || isLowSignalPrompt(text)) continue;
        // Machine-carrier turns (peer-session messages, scheduled-task
        // briefings, pasted transcripts) are not something the user typed.
        if (isMachineCarrierText(text)) continue;
        // A bare nudge ("continue") is a keystroke, not a habit; it would be
        // half the corpus and carries nothing for any consumer downstream.
        if (isGenericNudge(text)) continue;
        out.push({ text, ts: m.timestamp });
      }
    }
    return out;
  },
});

async function readSuggestionProfile(ctx: { db: any }, userId: Id<"users">) {
  return await ctx.db
    .query("suggestion_profiles")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .first();
}

export const getSuggestionProfile = internalQuery({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => readSuggestionProfile(ctx, args.user_id),
});

// The caller's own profile, for the suggest eval (POST /cli/suggestion-profile).
// The token is the only input: it names the user, so no one can read another
// person's mined history through it.
export const getOwnSuggestionProfile = internalQuery({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    return await readSuggestionProfile(ctx, auth.userId as Id<"users">);
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
    prompts: v.optional(v.array(v.object({ text: v.string(), count: v.number() }))),
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
        prompts: args.prompts,
        recent: args.recent,
        generated_at: args.generated_at,
      });
    } else {
      await ctx.db.insert("suggestion_profiles", args);
    }
  },
});

// The name phone builds released before Nov 2026 still call: the same write
// as suggestionOutcomes.record. It takes no words of the person's.
export const recordSuggestionOutcome = mutation({
  args: outcomeArgs,
  handler: async (ctx, args) => writeSuggestionOutcome(ctx, args),
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

// Normalization used to compare a suggestion against historical messages.
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.!?…]+$/, "").trim();
}

// Output guards: press-send-ready strings only. Refusal/meta prose from the
// model must never render as a suggestion. Selectivity lives here too:
// each candidate carries a model-reported probability, the likeliest shows
// only at MIN_CONFIDENCE or above, and at most MAX_SUGGESTIONS come back.
// Legacy bare strings score 0.6.
// `bannedVerbatim` holds the user's own historical messages, mined examples
// and what they typed after past suggestions (normalized): a suggestion that
// repeats one, word for word or nearly (nearlyRepeats), is a replayed quote,
// the exact failure the pattern mining exists to prevent — drop it. A
// suggestion that repeats one of `resendable` (the reusable prompts the user
// sends again on purpose) is exempt.
export function sanitizeSuggestions(
  parsed: unknown,
  lastUserText: string | null,
  bannedVerbatim?: Set<string>,
  resendable: string[] = [],
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
    if (!text || text.length > MAX_SUGGESTION_CHARS) continue;
    if (/^(i cannot|i can't|i'm sorry|sorry|as an ai|i don't have)/i.test(text)) continue;
    const key = normalizeForMatch(text);
    if (GENERIC_NUDGES.has(key)) continue;
    if (seen.has(key) || key === lastKey) continue;
    if (bannedVerbatim && nearlyRepeats(key, bannedVerbatim) && !nearlyRepeats(key, resendable)) continue;
    seen.add(key);
    const rawConf = (item as any)?.confidence;
    const conf = typeof rawConf === "number" && rawConf >= 0 && rawConf <= 1 ? rawConf : 0.6;
    scored.push({ text, conf });
  }
  return scored
    .filter((s) => s.conf >= MIN_CONFIDENCE)
    .sort((a, b) => b.conf - a.conf)
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => s.text);
}

// Whether normalized text `key` repeats one of `others`: the same, an
// unbroken run of REPEAT_RUN words in common, or (for texts of five words or
// more) REPEAT_OVERLAP of their distinct words shared. A replay with a word
// changed or a clause added still counts.
const REPEAT_RUN = 8;
const REPEAT_OVERLAP = 0.8;
export function nearlyRepeats(key: string, others: Iterable<string>): boolean {
  const words = key.split(" ").filter(Boolean);
  const runs = (w: string[]) => {
    const out = new Set<string>();
    for (let i = 0; i + REPEAT_RUN <= w.length; i++) out.add(w.slice(i, i + REPEAT_RUN).join(" "));
    return out;
  };
  const mine = runs(words);
  const set = new Set(words);
  for (const other of others) {
    if (other === key) return true;
    const theirs = other.split(" ").filter(Boolean);
    for (const r of runs(theirs)) if (mine.has(r)) return true;
    if (words.length >= 5 && theirs.length >= 5) {
      const otherSet = new Set(theirs);
      let shared = 0;
      for (const w of set) if (otherSet.has(w)) shared++;
      if (shared / (set.size + otherSet.size - shared) >= REPEAT_OVERLAP) return true;
    }
  }
  return false;
}

export type MinedProfile = {
  patterns: Array<{ pattern: string; example: string; count: number }>;
  prompts: Array<{ text: string; count: number }>;
};

// Shape-check and cap the miner's JSON. Two lists come back: generalized
// habits (one quote each, for voice) and reusable prompts (full text — the
// developer resends these, so the whole wording IS the value). A bare array
// is the pre-`prompts` shape and reads as patterns only.
export function parseMinedProfile(parsed: unknown): MinedProfile | null {
  const obj: any = Array.isArray(parsed) ? { patterns: parsed } : parsed;
  if (!obj || typeof obj !== "object") return null;
  const patterns = (Array.isArray(obj.patterns) ? obj.patterns : [])
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
      example: String(p.example).trim().slice(0, 300),
      count: Math.round(p.count),
    }))
    // A habit whose best example is itself a bare nudge is the nudge habit
    // in disguise — the one pattern the suggester must not learn.
    .filter((p: { example: string }) => !GENERIC_NUDGES.has(normalizeForMatch(p.example)))
    .slice(0, 15);
  const prompts = (Array.isArray(obj.prompts) ? obj.prompts : [])
    .filter(
      (p: any) =>
        p && typeof p.text === "string" && typeof p.count === "number" && p.count >= 2,
    )
    .map((p: any) => ({
      text: String(p.text).replace(/\s+/g, " ").trim().slice(0, MAX_SUGGESTION_CHARS),
      count: Math.round(p.count),
    }))
    // Same backstop as patterns: a nudge is never a reusable prompt.
    .filter((p: { text: string }) => !GENERIC_NUDGES.has(normalizeForMatch(p.text)))
    .slice(0, 12);
  return patterns.length || prompts.length ? { patterns, prompts } : null;
}

// LLM pass over the mined corpus. Two outputs:
// - BEHAVIOR PATTERNS: what the user habitually demands, abstracted from
//   topic, each with one real quote as voice evidence. The suggester APPLIES
//   a pattern to the current conversation; it never replays the quote.
// - REUSABLE PROMPTS: directives the user resends across sessions in nearly
//   the same words ("you are a world class product engineer… do another 10
//   rounds"). These are topic-free by construction — that is WHY they
//   recur — so the suggester may offer them close to verbatim, adapted to
//   the conversation at hand.
// Runs once per profile refresh (12h TTL), so its cost is a rounding error.
// Returns null on any failure so the caller can fall back to n-gram phrases.
export function buildMinerPrompt(inputs: string[]): string {
  // Bare nudges dominate any raw corpus (a "go" for every agent turn) and
  // would surface as the top "habit" — noise that biases the suggester
  // toward exactly what it must never output. Mine only substantive inputs.
  // Long directives are kept nearly whole: a reusable prompt is only useful
  // if the miner sees its full wording.
  const corpus = inputs
    .filter((t) => t.trim().split(/\s+/).length >= 3)
    .slice(0, 250)
    .map((t) => t.replace(/\s+/g, " ").slice(0, 600))
    .join("\n");
  return `You are analyzing one developer's messages to their coding agents, collected across many sessions. Learn two things so another model can predict what they will type into a brand-new conversation: their recurring BEHAVIOR PATTERNS, and the REUSABLE PROMPTS they send again and again.

Return ONLY a JSON object: {"patterns": [{"pattern": string, "example": string, "count": number}], "prompts": [{"text": string, "count": number}]}

patterns — generalized habits:
- "pattern": a short description of the habit, freed from any specific topic, written so it could guide a reply in ANY conversation. Good: "after seeing a finished feature, asks for several concrete ways to make it better", "demands thorough end-to-end testing with visual proof before accepting work", "tells the agent to proceed autonomously and patch everything it found rather than asking". Bad (too topic-bound): "asks about screenshots rendering inline".
- "example": ONE real quote from the messages that best shows the habit and the developer's voice.
- "count": how many distinct messages express this habit.

prompts — reusable directives:
- "text": the FULL text of a standing instruction the developer sends repeatedly across sessions in the same or nearly the same words — how to work: the quality bar, the process, how to iterate, validate, plan, verify. Two tests, both required. Portability: the prompt would make sense sent into an unrelated project; a message that names a particular feature, file, metric, or question is a request, not a reusable prompt, and repetition does not make it one. Authorship: it reads as something the developer typed, not a template or generated body. Quote it in full, in the developer's own wording; when it arrives appended to a task, quote only the standing part; pick the most complete instance when wordings differ slightly. Do not shorten or paraphrase it.
- "count": how many distinct messages contain this prompt or a near-identical version.

Rules:
- Every entry must be supported by at least 2 distinct messages; cluster different wordings of the same intent.
- For patterns, generalize the INTENT and drop the topic: the topic belongs to old conversations, the habit transfers. For prompts, keep the exact wording: it recurs because it works.
- Exclude one-off requests, greetings, filler, and bare nudges ("continue", "go", "do it").
- Sort each list by count descending. At most 15 patterns and 12 prompts. No markdown, no commentary.

Messages (one per line):
${corpus}`;
}

export async function minePatternsWithLLM(
  inputs: string[],
): Promise<(MinedProfile & { usage?: unknown }) | null> {
  const prompt = buildMinerPrompt(inputs);
  // getRecentUserInputs leaves out every conversation whose team may not send to Anthropic.
  const completion = await llmComplete({ provider: "anthropic", prompt, maxTokens: 3000, gate: NO_TEAM_CONTENT_GATE });
  if (!completion) return null;
  const mined = parseMinedProfile(parseJsonBlock(completion.text));
  return mined ? { ...mined, usage: completion.usage } : null;
}

// One past suggestion and what the developer did with it, as the suggester
// reads it back (recentOutcomes).
export type SuggestionOutcome = {
  outcome: "sent" | "edited" | "ignored";
  suggestion: string;
  // What they sent instead, read from the transcript (edited and ignored).
  reply?: string;
};

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + " […]" : t);

export function renderOutcome(o: SuggestionOutcome): string {
  if (o.outcome === "sent") return `- took as written: "${clip(o.suggestion, 200)}"`;
  if (o.outcome === "edited") return `- took and rewrote: "${clip(o.suggestion, 200)}"\n    they sent: "${clip(o.reply ?? "", 200)}"`;
  return `- passed over: "${clip(o.suggestion, 200)}"\n    typed instead: "${clip(o.reply ?? "", 200)}"`;
}

export function buildPrompt(
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
    prompts: Array<{ text: string; count: number }>;
    recent: string[];
    outcomes?: SuggestionOutcome[];
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
  // Reusable prompts are quoted whole: the wording is the point. Recent
  // messages are voice evidence only, so a long one is trimmed here (its
  // full text, if it is a reusable prompt, already appears above).
  const promptsText = profile.prompts.length
    ? profile.prompts.map((p) => `- (×${p.count}) "${p.text}"`).join("\n")
    : "- none mined yet";
  const recentText = profile.recent.length
    ? profile.recent
        .map((t) => `- ${t.length > 300 ? t.slice(0, 300) + " […]" : t}`)
        .join("\n")
    : "- none";

  const outcomesText = profile.outcomes?.length
    ? profile.outcomes.map(renderOutcome).join("\n")
    : "- none recorded yet";

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

  return `You predict what a developer will type next into their coding-agent session. You see the session so far, plus a profile of this developer's HABITS — the things they recurrently ask for, learned across their history. Your job is to apply those habits to THIS conversation's specifics and predict the message they will send next.

Return ONLY a JSON array: [] or [{"text": string, "confidence": number}] — your one prediction or nothing. "confidence" is your probability (0..1) that the developer sends it, as written or lightly edited, rather than anything else. It shows as dim text in their empty composer, one key from being theirs; return [] unless you would put it at ${MIN_CONFIDENCE} or more. No wrapper object, no markdown, no commentary.

The test for every suggestion: the developer reads it and thinks "I was just about to type that." You are predicting what THEY would type, not what would be sensible to do next — a reasonable engineering step they would never have asked for is a miss, however good it is.

A wrong suggestion costs the developer a glance; a right one saves them typing the message. So when the session gives you a real basis for what they will say next, make your best prediction. Return [] when the reply depends on something the session does not show.

Read the moment — the agent's final message decides everything:
- The agent asked a direct question with a small answer space (yes or no, which of these, confirm this) → suggest the most likely answers, phrased the way this developer would phrase them. This is where predictable replies live.
- The agent stopped to ask for a verdict — a plan awaiting go-ahead, a diff awaiting review, a pending decision the session names with its options — → suggest approval in this developer's usual words, or a pushback the session itself supports. A delivered artifact (a page, a deck, a writeup) is not this case: it draws edits, and which edit is theirs to choose.
- The agent delivered a result → predict the follow-up this developer sends after work like this: a part of the original request still owed, a next step the agent named, the check or summary they habitually ask for, or a reusable prompt they send at this point.
- The agent asked the developer for something only they hold — a fact, a date, a file, a URL, a credential — or asked them to act outside the session (sign in, click a link) → []. The reply carries information you do not have; an answer you would have to make up is a fabrication, not a prediction. Never turn the agent's instruction to the developer into the developer's message.
- The agent got something wrong — misread the request, went off course, or produced a result the session shows to be broken → []. The next message is a correction, and only the developer knows what it should say.
- The agent is mid-task, or the reply needs knowledge only the developer has (their opinion, product intent, something outside the session) → [].

The profile has two kinds of evidence, and they work differently:
- HABITS are generalized tendencies, each with one example quote for voice. Apply the TENDENCY to what is on the table right now, filling in this session's actual subject — the feature, file, bug, or decision in front of them. The example shows HOW they talk, not WHAT to say: a suggestion that repeats a habit's example is wrong by definition, because it is about some other conversation. A habit predicts only at the kind of moment it shows up in; a habit you could attach to any moment says nothing about this one.
- REUSABLE PROMPTS are standing instructions this developer deliberately sends again and again, in nearly the same words, whenever the moment fits — a quality bar, a way of working, an iteration loop. These you MAY suggest close to verbatim: keep their wording and force, and adapt only what the moment needs (name the actual feature, file, or task in front of them; drop a clause that does not apply). When the agent has just finished or proposed something and one of these prompts is what this developer typically sends next, it is the best suggestion you can make. Prefer the full prompt over a shortened gist: the length is part of what makes it work.

The suggestion record (below the recent messages) shows your own past predictions for this developer and what became of them: which they took as written, which they took and rewrote, and which they passed over to type their own reply. Learn from it which kinds of replies they take and how they reword them. When they typed their own reply, that text shows what they wanted instead; learn the direction it took, never send those words back.

Voice: copy the developer's register from the prompts, examples and recent messages — casing, punctuation, brevity, bluntness. If they write terse lowercase commands, so do you. Every suggestion must read like THEY typed it, about THIS conversation, and be sendable exactly as written; each is one key away from being sent.

Hard rules:
- Every pill must be a message this developer would plausibly send at this exact moment; a generic step that would fit any session is not one.
- Never suggest a bare continuation nudge — "continue", "go", "proceed", "do it", "yes", or anything the developer could type in one keystroke. A suggestion earns its place by carrying content: a concrete directive, answer, or decision specific to this moment.
- Never replay a habit's example quote, an ordinary past message, or a reply from the suggestion record verbatim or near-verbatim; only its habit transfers. Reusable prompts are the one exception — they are meant to be resent.
- Every suggestion is the developer speaking to the agent: never the agent's voice ("I'll handle…", "Sending you…"), and never the developer restating or summarizing what the agent just said — people do not type recaps back to the agent.
- Length follows the moment: a verdict or an answer stays short; a full working prompt can run several sentences. Never pad, never truncate a reusable prompt to make it look tidy.
- Never repeat what has already been said, asked, or done in the session; never contradict the developer's last instruction. Do not suggest a reusable prompt the developer already sent in this session unless the agent has since completed a full round of work that invites it again.
- Never invent file paths, commands, names, or ids that do not appear in the session.

Session:
${meta || "- (no metadata)"}

This developer's recurring habits (×N = seen in N separate messages across their history):
${habitsText}

Reusable prompts this developer sends again and again (×N = separate messages; quote closely, adapt to this conversation):
${promptsText}

Their most recent messages, for voice only (newest first):
${recentText}

What they did with recent suggestions (newest first):
${outcomesText}

Conversation:
${excerpt}`;
}

// The Anthropic request the suggester and the miner send. The evals replay
// the same object, so what they measure is what prod posts.
export function haikuRequest(prompt: string, maxTokens: number): SurfaceRequest {
  return { model: CHEAP_MODEL, prompt, max_tokens: maxTokens };
}

// One completion call, either provider. The suggester picks its provider from
// the SUGGESTIONS_PROVIDER env var ("openai" → GPT-5.6 Luna, anything else →
// Haiku), so an A/B flip is an env change, not a deploy. Luna quirks:
// temperature is rejected (fixed at 1) and the token cap is
// max_completion_tokens, which also feeds its hidden reasoning tokens — cap
// generously or long prompts return empty content with the budget consumed.
export async function llmComplete(opts: {
  provider: "anthropic" | "openai";
  prompt: string;
  maxTokens: number;
  /** Whose content the prompt carries (lib/vendorGuard). */
  gate: VendorGate;
}): Promise<{ text: string; usage?: unknown } | null> {
  try {
    if (opts.provider === "openai") {
      const response = await openaiFetch(opts.gate, "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          max_completion_tokens: opts.maxTokens,
          messages: [{ role: "user", content: opts.prompt }],
        }),
      });
      if (!response?.ok) return null;
      const data = await response.json();
      const text = data.choices?.[0]?.message?.content?.trim() ?? "";
      return text ? { text, usage: data.usage } : null;
    }
    const response = await postMessages(haikuRequest(opts.prompt, opts.maxTokens), { gate: opts.gate });
    if (!response?.ok) return null;
    const data = await response.json();
    const text = replyText(data);
    return text ? { text, usage: data.usage } : null;
  } catch {
    return null;
  }
}

export { parseJsonBlock };

// Two full reusable prompts plus a verdict fit comfortably; the cap only
// stops a runaway completion.
const SUGGEST_MAX_TOKENS = 1200;

export type StoredProfile = {
  frequent: Array<{ text: string; count: number }>;
  phrases?: Array<{ text: string; count: number }>;
  patterns?: Array<{ pattern: string; example: string; count: number }>;
  prompts?: Array<{ text: string; count: number }>;
  recent: string[];
  generated_at: number;
  // Read fresh from suggestion_outcomes at suggest time, not stored with the
  // mined profile: the record moves with every send.
  outcomes?: SuggestionOutcome[];
};

function profileForPrompt(profile: StoredProfile) {
  return {
    frequent: profile.frequent,
    phrases: profile.phrases ?? [],
    patterns: profile.patterns ?? [],
    prompts: profile.prompts ?? [],
    recent: profile.recent,
    outcomes: profile.outcomes ?? [],
  };
}

// Rebuild one user's profile from their input history: collect, rank, mine,
// store. Shared by the lazy TTL refresh inside the suggester and the
// on-demand internal action below.
async function refreshProfile(ctx: any, userId: Id<"users">, now: number): Promise<StoredProfile> {
  const inputs = await ctx.runQuery(internal.composerSuggestions.getRecentUserInputs, {
    user_id: userId,
  });
  const ranked = rankInputs(inputs, now);
  // Generalized habits beat literal quotes; the n-gram phrases are the
  // fallback when the miner call fails, so a bad LLM day degrades, never
  // blanks.
  const mined = await minePatternsWithLLM(inputs.map((r: { text: string }) => r.text));
  const profile: StoredProfile = {
    frequent: ranked.frequent,
    phrases: ranked.phrases,
    patterns: mined?.patterns,
    prompts: mined?.prompts,
    recent: ranked.recent,
    generated_at: now,
  };
  await ctx.runMutation(internal.composerSuggestions.storeSuggestionProfile, {
    user_id: userId,
    ...profile,
  });
  return profile;
}

// The suggestion request for one moment on the Anthropic branch: the prompt
// predictSuggestions renders, at its token cap.
export function suggestRequest(context: Parameters<typeof buildPrompt>[0], profile: StoredProfile): SurfaceRequest {
  return haikuRequest(buildPrompt(context, profileForPrompt(profile)), SUGGEST_MAX_TOKENS);
}

// The whole prediction, from stored context and profile to press-send-ready
// strings: render the prompt, complete, parse, sanitize. Shared by the live
// action and the evals, which pass their own `complete` to replay the request
// elsewhere, so what the eval grades is exactly what ships. `error` names the
// failing stage.
export async function predictSuggestions(
  context: Parameters<typeof buildPrompt>[0],
  profile: StoredProfile,
  provider: "anthropic" | "openai",
  gate: VendorGate,
  complete: typeof llmComplete = llmComplete,
): Promise<{ suggestions: string[]; error?: "provider_failed" | "invalid_json"; raw?: string }> {
  const req = suggestRequest(context, profile);
  // Anything the user has literally said before — recent messages, mined
  // examples, repeated whole inputs — may not come back as a pill…
  const bannedVerbatim = new Set<string>([
    ...profile.recent.map(normalizeForMatch),
    ...profile.frequent.map((f) => normalizeForMatch(f.text)),
    ...(profile.patterns ?? []).map((p) => normalizeForMatch(p.example)),
    ...context.turns.filter((t) => t.role === "user").map((t) => normalizeForMatch(t.content)),
    // What they typed after past suggestions teaches direction, never words.
    ...(profile.outcomes ?? []).flatMap((o) => (o.reply && o.outcome !== "sent" ? [normalizeForMatch(o.reply)] : [])),
  ]);
  // …except a reusable prompt, which the user resends on purpose. The
  // last-user-message check in sanitizeSuggestions still stops an
  // immediate echo.
  const resendable = (profile.prompts ?? []).map((p) => normalizeForMatch(p.text));
  for (const p of resendable) bannedVerbatim.delete(p);

  const completion = await complete({ provider, prompt: req.prompt, maxTokens: req.max_tokens, gate });
  if (!completion) return { suggestions: [], error: "provider_failed" };
  const parsed = parseJsonBlock(completion.text);
  if (parsed === null) return { suggestions: [], error: "invalid_json", raw: completion.text };
  const lastUser = [...context.turns].reverse().find((t) => t.role === "user");
  return {
    suggestions: sanitizeSuggestions(parsed, lastUser?.content ?? null, bannedVerbatim, resendable),
    raw: completion.text,
  };
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

    // A regulated team's session gets no suggestions while the provider has no BAA (lib/vendorGuard).
    const provider = suggestionsProvider();
    const gate = { ctx, scope: { conversationId: args.conversation_id } };
    if (!(await vendorAllowedFor(ctx, gate.scope, provider))) return { status: "skipped", reason: "vendor_not_covered" };

    let profile: StoredProfile | null = await ctx.runQuery(
      internal.composerSuggestions.getSuggestionProfile,
      { user_id: user._id },
    );
    if (!profile || now - profile.generated_at > PROFILE_TTL_MS) {
      profile = await refreshProfile(ctx, user._id, now);
    }

    const outcomes = await ctx.runQuery(internal.suggestionOutcomes.recent, { user_id: user._id });
    try {
      const predicted = await predictSuggestions(context, { ...profile, outcomes }, provider, gate);
      if (predicted.error) return { status: "error", reason: predicted.error };
      const suggestions = predicted.suggestions;

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
