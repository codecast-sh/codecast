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
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return;
    const patch: { title?: string; subtitle?: string } = { subtitle: args.subtitle };
    if (!conv.title_is_custom) patch.title = args.title;
    await ctx.db.patch(args.conversation_id, patch);
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

    const messageText = buildTitleMessageContext(messages);

    const prompt = `Generate a title and subtitle for this coding session.

Title: 2-5 words max. Short noun phrase or verb phrase naming what the session is CURRENTLY working on. Think git branch names but readable. Sessions often start on one task and drift to another — when the most recent activity has moved on from how the session started, title it after the current focus, not the original request.
Examples: "Auth redirect fix", "Dark mode settings", "Replace chokidar", "Inbox card redesign", "FD leak debug"
Anti-examples (too verbose): "Investigate Non-Resumable Session Root Cause", "Implement agent-triggered community chat with leave option", "Add Sessions tab to mobile with chronological summaries"

Subtitle: Bullet points (2-4 lines) describing what was done. Each bullet starts with "- ". Cover: what was built/fixed/changed, key files or components, current state.
Examples:
"- Switched from chokidar to native fs.watch, cut FD usage 3x\n- Updated daemon.ts and fileWatcher.ts\n- Working, deployed"
"- Fixed OAuth refresh token race condition in auth middleware\n- Added retry logic in sessionValidator.ts\n- In progress, needs testing"

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

    const filterMsg = (m: { role: string; content?: string | null; tool_results?: unknown[] | null }) =>
      (m.role === "user" || m.role === "assistant") && m.content && !m.tool_results?.length;

    const earliest = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .take(30);

    const latest = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("desc")
      .take(50);

    const seenIds = new Set(earliest.map(m => m._id));
    const combined = [...earliest];
    for (const m of latest.reverse()) {
      if (!seenIds.has(m._id)) {
        combined.push(m);
      }
    }

    const filteredMessages = combined.filter(filterMsg);

    return {
      ...conversation,
      messages: filteredMessages,
    };
  },
});

// Build the conversation excerpt fed to the title model. Weighted toward recent
// activity: a small "how it started" window for origin context plus a larger,
// explicitly-labeled "most recent activity" window. The labels let the prompt's
// "title after the current focus" instruction bind to the right block — without
// them the model can't tell which messages are "now" and reliably re-derives the
// session's opening task, leaving the title stuck while the work moves on.
export function buildTitleMessageContext(
  messages: Array<{ role: string; content?: string }>,
): string {
  const truncate = (content: string | undefined, maxLen: number) => {
    if (!content) return "[no text]";
    return content.length <= maxLen ? content : content.slice(0, maxLen) + "...";
  };
  const fmt = (m: { role: string; content?: string }) =>
    `${m.role === "assistant" ? "Assistant" : "User"}: ${truncate(m.content, 400)}`;

  const HEAD = 3;
  const RECENT = 14;
  const head = messages.slice(0, HEAD);
  // Non-overlapping recent window. For short sessions this is just the remainder.
  const recent =
    messages.length > HEAD + RECENT ? messages.slice(-RECENT) : messages.slice(HEAD);

  const sections: string[] = [];
  if (head.length) sections.push(`=== How the session started ===\n${head.map(fmt).join("\n\n")}`);
  if (recent.length) sections.push(`=== Most recent activity ===\n${recent.map(fmt).join("\n\n")}`);
  return sections.join("\n\n");
}

export function shouldGenerateTitle(messageCount: number): boolean {
  if (messageCount === 2) return true;
  if (messageCount <= 20) return messageCount % 5 === 0;
  if (messageCount <= 60) return messageCount % 10 === 0;
  return messageCount % 20 === 0;
}
