import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

function looksLikeUserMessage(content: string | undefined): boolean {
  if (!content) return false;
  const c = content.trim().toLowerCase();

  // Assistant message patterns - if it starts with these, it's NOT a user message
  const assistantPatterns = [
    "i'll ", "i will ", "let me ", "i can ", "i'm going to ", "i am going to ",
    "here's ", "here is ", "i've ", "i have ", "i would ", "i'd ",
    "based on ", "looking at ", "after ", "now ", "the ", "this ",
    "first, ", "to ", "yes, ", "sure, ", "great, ", "okay, ",
    "i understand", "i see", "i notice", "i found", "i analyzed",
    "```", "done.", "completed.", "finished.", "fixed.",
  ];

  for (const pattern of assistantPatterns) {
    if (c.startsWith(pattern)) return false;
  }

  // Very long messages are likely assistant messages
  if (content.length > 500) return false;

  // User message patterns - questions, commands, short messages
  const userPatterns = [
    "?", // questions
    "can you ", "could you ", "please ", "help ", "what ", "how ", "why ",
    "where ", "when ", "which ", "who ", "do ", "does ", "is ", "are ",
    "tell me ", "show me ", "explain ", "describe ", "list ", "find ",
    "create ", "make ", "add ", "remove ", "delete ", "update ", "change ",
    "fix ", "run ", "test ", "check ", "verify ", "debug ",
    "yes", "no", "ok", "okay", "sure", "thanks", "continue", "go ahead",
    "so what ", "we will ", "we need ", "we want ", "i want ", "i need ",
    "lets ", "let's ", "@", // file references in cursor/claude
  ];

  for (const pattern of userPatterns) {
    if (c.includes(pattern)) return true;
  }

  // Short messages are more likely user messages
  if (content.length < 100) return true;

  return false;
}

export const setAdminRole = internalMutation({
  args: {
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const users = await ctx.db.query("users").collect();
    const user = users.find((u) => u.email === args.email);
    if (!user) {
      return { success: false, error: `User with email ${args.email} not found` };
    }
    await ctx.db.patch(user._id, { role: "admin" });
    return { success: true, userId: user._id, email: user.email };
  },
});

export const fixCorruptedMessageRoles = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;

    const allConversations = await ctx.db
      .query("conversations")
      .order("desc")
      .take(limit + offset);

    const conversations = allConversations.slice(offset);

    let fixedCount = 0;
    let checkedConversations = 0;
    const fixes: Array<{ conversationId: string; messageId: string; oldRole: string; newRole: string; preview: string }> = [];

    for (const conv of conversations) {
      checkedConversations++;

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
        .take(20);

      if (messages.length === 0) continue;

      messages.sort((a, b) => a.timestamp - b.timestamp);

      const firstMsg = messages[0];
      if (firstMsg.role === "assistant" && !firstMsg.tool_calls?.length && !firstMsg.thinking && looksLikeUserMessage(firstMsg.content)) {
        fixes.push({
          conversationId: conv._id,
          messageId: firstMsg._id,
          oldRole: firstMsg.role,
          newRole: "user",
          preview: (firstMsg.content || "").slice(0, 80),
        });

        if (!dryRun) {
          await ctx.db.patch(firstMsg._id, { role: "user" });
        }
        fixedCount++;
      }

      for (let i = 1; i < messages.length && i < 15; i++) {
        const msg = messages[i];
        const prevMsg = messages[i - 1];

        if (
          msg.role === "assistant" &&
          prevMsg.role === "assistant" &&
          !msg.tool_calls?.length &&
          !msg.thinking &&
          !msg.tool_results?.length &&
          looksLikeUserMessage(msg.content)
        ) {
          fixes.push({
            conversationId: conv._id,
            messageId: msg._id,
            oldRole: msg.role,
            newRole: "user",
            preview: (msg.content || "").slice(0, 80),
          });

          if (!dryRun) {
            await ctx.db.patch(msg._id, { role: "user" });
          }
          fixedCount++;
        }
      }
    }

    return {
      dryRun,
      checkedConversations,
      fixedCount,
      fixes: fixes.slice(0, 50),
    };
  },
});

export const fixTaskSourceFromAgent = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;

    const tasks = await ctx.db.query("tasks").collect();
    const convCache = new Map<string, string | null>();

    let checked = 0;
    let fixed = 0;
    const fixes: Array<{ taskId: string; title: string; agentType: string }> = [];

    for (const task of tasks) {
      checked++;
      if (task.source !== "human" || !task.created_from_conversation) continue;

      const convIdStr = task.created_from_conversation.toString();
      let agentType: string | null;
      if (convCache.has(convIdStr)) {
        agentType = convCache.get(convIdStr)!;
      } else {
        try {
          const conv = await ctx.db.get(task.created_from_conversation);
          agentType = conv?.agent_type || null;
        } catch {
          agentType = null;
        }
        convCache.set(convIdStr, agentType);
      }

      if (agentType) {
        fixes.push({
          taskId: task._id,
          title: task.title,
          agentType,
        });
        if (!dryRun) {
          await ctx.db.patch(task._id, { source: "agent" as any });
        }
        fixed++;
      }
    }

    return { dryRun, checked, fixed, fixCount: fixes.length };
  },
});

export const analyzeMessageRoles = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 20, 50);

    const conversations = await ctx.db
      .query("conversations")
      .order("desc")
      .take(limit);

    const stats = {
      totalConversations: conversations.length,
      conversationsChecked: 0,
      conversationsWithMessages: 0,
      conversationsWithIssues: 0,
      firstMessageNotUser: 0,
      consecutiveAssistant: 0,
      examples: [] as Array<{
        conversationId: string;
        title: string | undefined;
        firstMessageRole: string;
        firstMessagePreview: string;
        messageCount: number;
      }>,
    };

    for (const conv of conversations) {
      stats.conversationsChecked++;

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
        .take(10);

      if (messages.length === 0) continue;
      stats.conversationsWithMessages++;

      messages.sort((a, b) => a.timestamp - b.timestamp);

      const firstMsg = messages[0];
      if (firstMsg.role !== "user") {
        stats.firstMessageNotUser++;
        stats.conversationsWithIssues++;

        if (stats.examples.length < 10) {
          stats.examples.push({
            conversationId: conv._id,
            title: conv.title,
            firstMessageRole: firstMsg.role,
            firstMessagePreview: (firstMsg.content || "").slice(0, 100),
            messageCount: conv.message_count,
          });
        }
      }

      for (let i = 1; i < messages.length; i++) {
        if (messages[i].role === "assistant" && messages[i - 1].role === "assistant") {
          if (!messages[i].tool_calls?.length && !messages[i].thinking) {
            stats.consecutiveAssistant++;
            break;
          }
        }
      }
    }

    return stats;
  },
});
