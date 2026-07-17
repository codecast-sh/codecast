import { mutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { resolveCreationPrivacy } from "./privacy";
import { enqueueStartSession } from "./devices";
import { enqueuePendingMessage } from "./pendingMessages";

async function getAuthenticatedUserId(
  ctx: { db: any },
  apiToken?: string,
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) return sessionUserId;
  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) return result.userId;
  }
  return null;
}

// createSessionFromCli — start a fresh, inbox-visible session (NOT a subagent)
// and optionally seed its first turn. The backend for `cast spawn`.
//
// This is the api_token-authenticated sibling of conversations.createQuickSession
// (the UI's "New Session" path): same team/privacy resolution + start_session
// enqueue, but it authenticates a CLI caller and delivers a first prompt so a
// running session can hand fresh work to the human's inbox. It deliberately does
// NOT set is_subagent / parent_conversation_id — that absence is what makes the
// new session land in the inbox instead of nesting as a hidden helper.
export const createSessionFromCli = mutation({
  args: {
    api_token: v.optional(v.string()),
    prompt: v.optional(v.string()),
    agent_type: v.optional(
      v.union(
        v.literal("claude_code"),
        v.literal("codex"),
        v.literal("cursor"),
        v.literal("gemini"),
        v.literal("opencode"),
        v.literal("pi"),
      ),
    ),
    project_path: v.optional(v.string()),
    git_root: v.optional(v.string()),
    model: v.optional(v.string()),
    isolated: v.optional(v.boolean()),
    worktree_name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const agentType = args.agent_type || "claude_code";

    const privacy = await resolveCreationPrivacy(ctx, userId, args.git_root || args.project_path);

    const conversationId = await ctx.db.insert("conversations", {
      user_id: userId,
      agent_type: agentType,
      session_id: sessionId,
      project_path: args.project_path,
      git_root: args.git_root,
      started_at: now,
      updated_at: now,
      message_count: 0,
      ...privacy,
      status: "active",
    });

    await ctx.db.patch(conversationId, {
      short_id: conversationId.toString().slice(0, 7),
    });

    const daemonAgentType =
      agentType === "codex" ? "codex" : agentType === "gemini" ? "gemini" : "claude";
    await enqueueStartSession(ctx, userId, {
      conversationId,
      agentType: daemonAgentType,
      projectPath: args.project_path || args.git_root,
      sessionId,
      isolated: args.isolated,
      worktreeName: args.worktree_name,
      model: args.model,
      createdAt: now,
    });

    // Seed the first turn as a plain user message (raw, not wrapped as a
    // session-message) over the same pending-message rail the UI uses for a new
    // session's first message — delivered once the daemon spawns and the agent
    // is ready.
    const prompt = (args.prompt ?? "").trim();
    if (prompt) {
      const conversation = await ctx.db.get(conversationId);
      await enqueuePendingMessage(ctx, conversation, userId, { content: prompt });
    }

    return {
      conversation_id: conversationId,
      short_id: conversationId.toString().slice(0, 7),
    };
  },
});
