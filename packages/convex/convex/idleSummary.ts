import { internalMutation, internalAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

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
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("desc")
      .take(10);

    return messages
      .filter((m: any) => (m.role === "user" || m.role === "assistant") && m.content)
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
          max_tokens: 100,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        console.error("Idle summary API error:", response.status);
        return;
      }

      const data = await response.json();
      const raw = data.content?.[0]?.text?.trim();
      const text = raw?.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").trim();

      if (text && text.length > 0 && text.length < 300) {
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
