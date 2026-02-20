import { internalMutation, internalAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const setTitleAndSubtitle = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    title: v.string(),
    subtitle: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversation_id, {
      title: args.title,
      subtitle: args.subtitle,
    });
  },
});

export const generateTitle = internalAction({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY not configured");
      return;
    }

    const conversation = await ctx.runQuery(internal.titleGeneration.getConversationForTitle, {
      conversation_id: args.conversation_id,
    });

    if (!conversation || conversation.messages.length === 0) {
      return;
    }

    const { messages } = conversation;

    const firstSlice = messages.slice(0, 6);
    const lastSlice = messages.length > 15 ? messages.slice(-9) : [];

    const selectedMessages = [...firstSlice];
    for (const msg of lastSlice) {
      if (!selectedMessages.find(m => m._id === msg._id)) {
        selectedMessages.push(msg);
      }
    }

    const truncateMessage = (content: string | undefined, maxLen: number) => {
      if (!content) return "[no text]";
      if (content.length <= maxLen) return content;
      return content.slice(0, maxLen) + "...";
    };

    const messageText = selectedMessages
      .map(m => {
        const role = m.role === "assistant" ? "Assistant" : "User";
        const content = truncateMessage(m.content, 400);
        return `${role}: ${content}`;
      })
      .join("\n\n");

    const prompt = `Generate a title and subtitle for this coding session. Be direct and information-dense. Never use filler phrases like "Please", "Let me", "I'll help", "Sure", etc.

Title: 3-8 words. The specific task, e.g. "Fix auth redirect loop" or "Add dark mode to settings page"

Subtitle: 1-2 short lines. State what was done or is being done. Use telegraphic style - omit articles and filler.
Good: "Refactored auth middleware to handle OAuth refresh tokens. Fixed race condition in session validation."
Bad: "Please let me explain what was accomplished in this session..."

Output ONLY valid JSON, no markdown:
{"title": "...", "subtitle": "..."}

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
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        console.error("Haiku API error:", response.status, await response.text());
        return;
      }

      const data = await response.json();
      const text = data.content?.[0]?.text?.trim();

      if (!text) return;

      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

      try {
        const parsed = JSON.parse(cleaned);
        const title = parsed.title?.trim();
        const subtitle = parsed.subtitle?.trim();

        if (title && title.length > 0 && title.length < 200) {
          await ctx.runMutation(internal.titleGeneration.setTitleAndSubtitle, {
            conversation_id: args.conversation_id,
            title,
            subtitle: subtitle || "",
          });
        }
      } catch {
        if (cleaned.length > 0 && cleaned.length < 200) {
          await ctx.runMutation(internal.titleGeneration.setTitleAndSubtitle, {
            conversation_id: args.conversation_id,
            title: cleaned,
            subtitle: "",
          });
        }
      }
    } catch (error) {
      console.error("Failed to generate title:", error);
    }
  },
});

export const getConversationForTitle = internalQuery({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .take(100);

    const filteredMessages = messages.filter(m =>
      (m.role === "user" || m.role === "assistant") &&
      m.content &&
      !m.tool_results?.length
    );

    return {
      ...conversation,
      messages: filteredMessages,
    };
  },
});

export function shouldGenerateTitle(messageCount: number): boolean {
  if (messageCount === 2) return true;
  if (messageCount > 2 && (messageCount - 2) % 15 === 0) return true;
  return false;
}
