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

    const firstSlice = messages.slice(0, 3);
    const lastSlice = messages.length > 6 ? messages.slice(-3) : [];

    const selectedMessages = [...firstSlice];
    for (const msg of lastSlice) {
      if (!selectedMessages.find(m => m._id === msg._id)) {
        selectedMessages.push(msg);
      }
    }

    const messageText = selectedMessages
      .map(m => {
        const role = m.role === "assistant" ? "Assistant" : "User";
        const content = m.content?.slice(0, 500) || "[no text]";
        return `${role}: ${content}`;
      })
      .join("\n\n");

    const prompt = `Summarize this conversation with a title and subtitle.

Title: 3-8 words, captures the main topic/goal
Subtitle: 1-2 sentences describing what was accomplished or discussed

Respond in this exact JSON format only, no markdown:
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
          model: "claude-3-5-haiku-latest",
          max_tokens: 200,
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

      try {
        const parsed = JSON.parse(text);
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
        if (text.length > 0 && text.length < 200) {
          await ctx.runMutation(internal.titleGeneration.setTitleAndSubtitle, {
            conversation_id: args.conversation_id,
            title: text,
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
  if (messageCount > 2 && (messageCount - 2) % 10 === 0) return true;
  return false;
}
