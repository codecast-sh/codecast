import { internalMutation, internalAction, internalQuery } from "./functions";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { isLowSignalPrompt } from "./titleGeneration";

// Which rows carry human-readable conversation: real user/assistant text, not
// tool-result carriers or machine noise (task notifications, interruption
// markers, bare image sends). Mirrors titleGeneration's filtering — without
// it, an agentic session's tail can be 100% plumbing, and asking the model to
// summarize a conversation containing none stores its refusal prose
// ("I don't see a recent conversation to analyze…") as the idle_summary.
export function isSummarizableMessage(m: {
  role?: string;
  content?: string | null;
  tool_results?: unknown[] | null;
}): boolean {
  return (
    (m.role === "user" || m.role === "assistant") &&
    !!m.content?.trim() &&
    !m.tool_results?.length &&
    !isLowSignalPrompt(m.content)
  );
}

// The prompt states hard rules — start with a verb, one sentence, never
// "please"/"the user" — but never enforced them, so rule-breaking output
// (in practice always refusal/meta prose) sailed into storage. First-person
// openers are the refusal signature; a verb-first summary never needs one.
export function isUsableIdleSummary(text: string): boolean {
  const t = text.trim();
  if (!t || t.length >= 300) return false;
  if (/^i['\s]/i.test(t)) return false;
  if (/\b(please|the user)\b/i.test(t)) return false;
  return true;
}

// Refusal prose in a TITLE or SUBTITLE (fields idleSummary never writes but
// the same model-refusal class polluted before the write guards existed):
// first-person opener. Legit subtitles are "- " bullets and legit titles are
// noun phrases, so /^I /-shaped text is unambiguous refusal residue.
export function isRefusalProse(text: string): boolean {
  return /^i['\s]/i.test(text.trim());
}

// Candidate finder for the cleanup below: search the display-field indexes
// for refusal-shaped text and return only rows the write guards would reject
// today. Over-matching is fine — cleanup re-validates every field itself.
export const findRefusalSummaryCandidates = internalQuery({
  args: { searchQuery: v.string() },
  handler: async (ctx, args) => {
    const [byIdle, bySubtitle] = await Promise.all([
      ctx.db
        .query("conversations")
        .withSearchIndex("search_idle_summary", (q) => q.search("idle_summary", args.searchQuery))
        .take(100),
      ctx.db
        .query("conversations")
        .withSearchIndex("search_subtitle", (q) => q.search("subtitle", args.searchQuery))
        .take(100),
    ]);
    const seen = new Set<string>();
    const out: Array<{ id: string; idle_summary?: string; subtitle?: string }> = [];
    for (const c of [...byIdle, ...bySubtitle]) {
      if (seen.has(c._id)) continue;
      seen.add(c._id);
      const badIdle = !!c.idle_summary && !isUsableIdleSummary(c.idle_summary);
      const badSubtitle = !!c.subtitle && isRefusalProse(c.subtitle);
      if (badIdle || badSubtitle) {
        out.push({ id: c._id, idle_summary: c.idle_summary, subtitle: c.subtitle?.slice(0, 160) });
      }
    }
    return out;
  },
});

// One-time cleanup of pre-guard residue: model refusals stored as display
// fields. Takes candidate ids (cheap to over-supply — typically from the
// title/subtitle/idle_summary search index) and re-validates each field with
// the same guards that now gate writes, clearing only what fails. A bad value
// otherwise persists forever: generation only OVERWRITES on usable output, so
// a session whose tail is all tool-plumbing never self-heals.
export const cleanupUnusableSummaries = internalMutation({
  args: {
    conversation_ids: v.array(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const cleared: Array<{ id: string; fields: string[] }> = [];
    for (const id of args.conversation_ids.slice(0, 200)) {
      const conv = await ctx.db.get(id);
      if (!conv) continue;
      const patch: Record<string, undefined> = {};
      if (conv.idle_summary && !isUsableIdleSummary(conv.idle_summary)) {
        patch.idle_summary = undefined;
      }
      if (conv.subtitle && isRefusalProse(conv.subtitle)) {
        patch.subtitle = undefined;
      }
      if (conv.title && !conv.title_is_custom && isRefusalProse(conv.title)) {
        patch.title = undefined;
      }
      const fields = Object.keys(patch);
      if (fields.length) {
        await ctx.db.patch(id, patch);
        cleared.push({ id, fields });
      }
    }
    return cleared;
  },
});

export const setIdleSummary = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    idle_summary: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversation_id, {
      idle_summary: args.idle_summary,
    });
  },
});

export const getMessagesForSummary = internalQuery({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    // 20, not 10: agentic tails are mostly tool-result carriers, and a window
    // that filters down to nothing produces no summary at all.
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("desc")
      .take(20);

    return messages
      .filter(isSummarizableMessage)
      .reverse()
      .map((m: any) => ({
        role: m.role,
        content: (m.content || "").slice(0, 500),
      }));
  },
});

export const generateIdleSummary = internalAction({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const messages = await ctx.runQuery(internal.idleSummary.getMessagesForSummary, {
      conversation_id: args.conversation_id,
    });

    if (messages.length === 0) return;

    const messageText = messages
      .map((m: any) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
      .join("\n\n");

    const prompt = `This agent session is idle. Based on the recent conversation below, write ONE short sentence.

If the agent is clearly blocked waiting for specific user input, write an imperative action starting with a verb:
  "Confirm the exact UI change needed"
  "Provide the API endpoint details"
  "Choose between the two proposed approaches"

If there is no clear next action needed from the user (agent just finished work, delivered results, or is at a natural stopping point), summarize what was last completed:
  "Deployed auth fix and verified tests pass"
  "Refactored the payment module into three files"
  "Fixed the infinite scroll regression"

Rules: never use "please", "the user", or "you". Start with a verb. Be specific. One sentence max. No quotes or JSON formatting.

Conversation:
${messageText}`;

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
          max_tokens: 200,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        console.error("Idle summary API error:", response.status);
        return;
      }

      const data = await response.json();
      const raw = data.content?.[0]?.text?.trim();
      const text = raw?.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").replace(/\s*\.{3,}\s*$/, "").replace(/\s+to\s*$/, "").trim();

      if (text && isUsableIdleSummary(text)) {
        await ctx.runMutation(internal.idleSummary.setIdleSummary, {
          conversation_id: args.conversation_id,
          idle_summary: text,
        });

        await ctx.runAction(internal.sessionInsights.generateSessionInsight, {
          conversation_id: args.conversation_id,
          reason: "idle",
        });
      }
    } catch (error) {
      console.error("Failed to generate idle summary:", error);
    }
  },
});
