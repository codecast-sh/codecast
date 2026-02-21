import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { checkRateLimit } from "./rateLimit";
import { verifyApiToken } from "./apiTokens";
import { internal } from "./_generated/api";
import {
  isTeamMember,
  canTeamMemberAccess,
  checkConversationAccess,
  isConversationVisibleInFeed,
  isConversationTeamVisible,
  resolveVisibilityMode,
  type VisibilityMode,
} from "./privacy";

async function getAuthenticatedUserId(
  ctx: { db: any },
  apiToken?: string
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) {
    return sessionUserId;
  }

  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) {
      return result.userId;
    }
  }

  return null;
}

async function getAuthenticatedUserIdReadOnly(
  ctx: { db: any },
  apiToken?: string
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) {
    return sessionUserId;
  }

  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken, false);
    if (result) {
      return result.userId;
    }
  }

  return null;
}

function matchChildByPrompt(
  prompt: string,
  subagents: Array<{ _id: string; preview: string }>,
): string | undefined {
  if (!prompt || subagents.length === 0) return undefined;
  const promptStart = prompt.slice(0, 100).toLowerCase().trim();
  for (const child of subagents) {
    const preview = child.preview.slice(0, 100).toLowerCase().trim();
    if (promptStart === preview || promptStart.startsWith(preview) || preview.startsWith(promptStart)) {
      return child._id;
    }
  }
  return undefined;
}

async function findChildConversations(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  messages: Array<{ message_uuid?: string; tool_calls?: Array<{ name: string; input: string }> }>,
): Promise<{
  children: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>;
  map: Record<string, string>;
  agentNameMap: Record<string, string>;
}> {
  const map: Record<string, string> = {};

  const allChildren = await ctx.db
    .query("conversations")
    .withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", conversationId))
    .collect();

  const subagentChildren = allChildren.filter((c: any) => c.is_subagent || !c.parent_message_uuid);
  const firstMessagePreviews = new Map<string, string>();
  for (const child of subagentChildren) {
    const firstMsg = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", child._id))
      .first();
    if (firstMsg?.content) {
      const content = typeof firstMsg.content === "string" ? firstMsg.content : "";
      const cleaned = content.replace(/<[^>]+>/g, "").trim();
      firstMessagePreviews.set(child._id as string, cleaned.slice(0, 150));
    }
  }

  const NOISE_TITLE_PREFIXES = ["[Using:", "[Request", "[SUGGESTION MODE:"];
  const children = allChildren
    .filter((conv: any) => !NOISE_TITLE_PREFIXES.some((p) => (conv.title || "").startsWith(p)))
    .map((conv: any) => ({
      _id: conv._id,
      title: conv.title || "New Session",
      is_subagent: conv.is_subagent || !conv.parent_message_uuid,
      first_message_preview: firstMessagePreviews.get(conv._id as string),
    }));

  const childByParentUuid = new Map<string, string>(
    allChildren
      .filter((c: any) => c.parent_message_uuid)
      .map((c: any) => [c.parent_message_uuid as string, c._id as string])
  );
  for (const msg of messages) {
    if (msg.message_uuid && childByParentUuid.has(msg.message_uuid)) {
      map[msg.message_uuid] = childByParentUuid.get(msg.message_uuid)!;
    }
  }

  // Build agent name -> child conversation ID map from Task tool calls
  const agentNameMap: Record<string, string> = {};
  if (subagentChildren.length > 0) {
    const subagentMatchData = subagentChildren
      .filter((c: any) => firstMessagePreviews.has(c._id as string))
      .map((c: any) => ({ _id: c._id as string, preview: firstMessagePreviews.get(c._id as string)! }));

    // First try from the provided (paginated) messages
    for (const msg of messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.name === "Task") {
            try {
              const inp = JSON.parse(tc.input);
              if (inp.name && inp.prompt) {
                const childId = matchChildByPrompt(inp.prompt, subagentMatchData);
                if (childId) agentNameMap[inp.name] = childId;
              }
            } catch {}
          }
        }
      }
    }

    // If we didn't find all agents, scan all parent messages for Task tool calls
    if (Object.keys(agentNameMap).length < subagentChildren.length) {
      const allParentMessages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
        .collect();
      for (const msg of allParentMessages) {
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.name === "Task" && !agentNameMap[tc.input]) {
              try {
                const inp = JSON.parse(tc.input);
                if (inp.name && inp.prompt && !agentNameMap[inp.name]) {
                  const childId = matchChildByPrompt(inp.prompt, subagentMatchData);
                  if (childId) agentNameMap[inp.name] = childId;
                }
              } catch {}
            }
          }
        }
      }
    }
  }

  return { children, map, agentNameMap };
}

function generateShareToken(): string {
  return crypto.randomUUID();
}

function parseSearchTerms(query: string): { phrases: string[]; words: string[]; all: string[] } {
  const phrases: string[] = [];
  const words: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    if (match[1]) {
      phrases.push(match[1].toLowerCase());
    } else if (match[2]) {
      words.push(match[2].toLowerCase());
    }
  }
  return { phrases, words, all: [...phrases, ...words] };
}

function contentMatchesSearch(content: string, terms: { phrases: string[]; words: string[] }): boolean {
  const lowerContent = content.toLowerCase();
  for (const phrase of terms.phrases) {
    if (!lowerContent.includes(phrase)) return false;
  }
  for (const word of terms.words) {
    if (!lowerContent.includes(word)) return false;
  }
  return true;
}

function contentMatchesAnyTerm(content: string, terms: { phrases: string[]; words: string[]; all: string[] }): boolean {
  const lowerContent = content.toLowerCase();
  return terms.all.some(t => lowerContent.includes(t));
}

function conversationMatchesAllTerms(
  messages: Array<{ content?: string | null }>,
  terms: { phrases: string[]; words: string[] }
): boolean {
  const allContent = messages.map(m => (m.content || "").toLowerCase()).join(" ");
  return contentMatchesSearch(allContent, terms);
}

function calculateProximityScore(
  messages: Array<{ content?: string | null; _id: { toString(): string } }>,
  terms: { all: string[] }
): number {
  if (terms.all.length <= 1) return 0;

  const termPositions: Map<string, number[]> = new Map();
  for (const term of terms.all) {
    termPositions.set(term, []);
  }

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const content = (messages[msgIdx].content || "").toLowerCase();
    for (const term of terms.all) {
      if (content.includes(term)) {
        termPositions.get(term)!.push(msgIdx);
      }
    }
  }

  // Check if all terms appear in same message (best case)
  const messageIndicesWithAllTerms = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const content = (messages[i].content || "").toLowerCase();
    if (terms.all.every(t => content.includes(t))) {
      return 0; // Best score - all terms in one message
    }
  }

  // Calculate minimum span across messages
  let minSpan = Infinity;
  const firstTermPositions = termPositions.get(terms.all[0]) || [];

  for (const startPos of firstTermPositions) {
    let maxEnd = startPos;
    let valid = true;

    for (const term of terms.all.slice(1)) {
      const positions = termPositions.get(term) || [];
      if (positions.length === 0) {
        valid = false;
        break;
      }
      // Find closest position to current range
      let closest = positions[0];
      for (const pos of positions) {
        if (Math.abs(pos - startPos) < Math.abs(closest - startPos)) {
          closest = pos;
        }
      }
      maxEnd = Math.max(maxEnd, closest);
    }

    if (valid) {
      minSpan = Math.min(minSpan, maxEnd - startPos + 1);
    }
  }

  return minSpan === Infinity ? 1000 : minSpan;
}

function formatSlugAsTitle(slug: string): string {
  return slug
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

type MessageLike = {
  content?: string | null;
  tool_calls?: unknown[] | null;
  tool_results?: unknown[] | null;
};

function isNonEmptyMessage(m: MessageLike): boolean {
  const hasContent = m.content && m.content.trim();
  const hasToolCalls = m.tool_calls && m.tool_calls.length > 0;
  const hasToolResults = m.tool_results && m.tool_results.length > 0;
  return !!(hasContent || hasToolCalls || hasToolResults);
}

export const resolveTeamFromDirectory = query({
  args: {
    api_token: v.string(),
    project_path: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return null;
    }

    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .collect();

    let bestMatch: { teamId: Id<"teams">; pathLength: number } | null = null;
    for (const mapping of mappings) {
      if (args.project_path === mapping.path_prefix || args.project_path.startsWith(mapping.path_prefix + "/")) {
        if (!bestMatch || mapping.path_prefix.length > bestMatch.pathLength) {
          bestMatch = {
            teamId: mapping.team_id,
            pathLength: mapping.path_prefix.length,
          };
        }
      }
    }

    return bestMatch?.teamId || null;
  },
});

export const createConversation = mutation({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    agent_type: v.union(
      v.literal("claude_code"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini")
    ),
    session_id: v.string(),
    project_hash: v.optional(v.string()),
    project_path: v.optional(v.string()),
    slug: v.optional(v.string()),
    title: v.optional(v.string()),
    started_at: v.optional(v.number()),
    parent_message_uuid: v.optional(v.string()),
    parent_conversation_id: v.optional(v.string()),
    git_commit_hash: v.optional(v.string()),
    git_branch: v.optional(v.string()),
    git_remote_url: v.optional(v.string()),
    git_status: v.optional(v.string()),
    git_diff: v.optional(v.string()),
    git_diff_staged: v.optional(v.string()),
    git_root: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    if (authUserId.toString() !== args.user_id.toString()) {
      throw new Error("Unauthorized: can only create conversations for yourself");
    }

    await checkRateLimit(ctx, args.user_id, "createConversation");

    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), args.user_id))
      .first();

    if (existing) {
      if (args.parent_conversation_id && !existing.parent_conversation_id) {
        const isSubagent = !!args.parent_conversation_id && !args.parent_message_uuid;
        await ctx.db.patch(existing._id, {
          parent_conversation_id: args.parent_conversation_id as Id<"conversations">,
          is_subagent: isSubagent || undefined,
        });
      }
      return existing._id;
    }

    const now = Date.now();
    const startedAt = args.started_at ?? now;

    const user = await ctx.db.get(args.user_id);
    let resolvedTeamId = args.team_id || (user as any)?.active_team_id || (user as any)?.team_id;
    let isPrivate = true;
    let autoShared = false;

    const conversationPath = args.git_root || args.project_path;
    if (conversationPath) {
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
        .collect();

      let bestMatch: { teamId: Id<"teams">; pathLength: number; autoShare: boolean } | null = null;
      for (const mapping of mappings) {
        if (conversationPath === mapping.path_prefix || conversationPath.startsWith(mapping.path_prefix + "/")) {
          if (!bestMatch || mapping.path_prefix.length > bestMatch.pathLength) {
            bestMatch = {
              teamId: mapping.team_id,
              pathLength: mapping.path_prefix.length,
              autoShare: mapping.auto_share,
            };
          }
        }
      }

      if (bestMatch) {
        resolvedTeamId = bestMatch.teamId;
        if (bestMatch.autoShare) {
          isPrivate = false;
          autoShared = true;
        }
      }
      // If no directory mapping matches, resolvedTeamId stays as user's active_team_id
    }

    if (!autoShared && user?.team_share_paths && user.team_share_paths.length > 0 && resolvedTeamId && conversationPath) {
      for (const sharePath of user.team_share_paths) {
        if (conversationPath === sharePath || conversationPath.startsWith(sharePath + "/")) {
          isPrivate = false;
          autoShared = true;
          break;
        }
      }
    }

    let parentConversationId: Id<"conversations"> | undefined;
    if (args.parent_conversation_id) {
      parentConversationId = args.parent_conversation_id as Id<"conversations">;
    } else if (args.parent_message_uuid) {
      const parentMsg = await ctx.db
        .query("messages")
        .withIndex("by_message_uuid", (q) => q.eq("message_uuid", args.parent_message_uuid!))
        .first();
      if (parentMsg) {
        parentConversationId = parentMsg.conversation_id;
      }
    }

    const conversationId = await ctx.db.insert("conversations", {
      user_id: args.user_id,
      team_id: resolvedTeamId,
      agent_type: args.agent_type,
      session_id: args.session_id,
      slug: args.slug,
      title: args.title,
      project_hash: args.project_hash,
      project_path: args.project_path,
      started_at: startedAt,
      updated_at: startedAt,
      message_count: 0,
      is_private: isPrivate,
      auto_shared: autoShared || undefined,
      status: "active",
      parent_message_uuid: args.parent_message_uuid,
      parent_conversation_id: parentConversationId,
      is_subagent: (!!parentConversationId && !args.parent_message_uuid) || undefined,
      git_commit_hash: args.git_commit_hash,
      git_branch: args.git_branch,
      git_remote_url: args.git_remote_url,
      git_status: args.git_status,
      git_diff: args.git_diff,
      git_diff_staged: args.git_diff_staged,
      git_root: args.git_root,
    });
    // Set short_id for O(1) lookup by truncated ID
    await ctx.db.patch(conversationId, {
      short_id: conversationId.toString().slice(0, 7),
    });

    // Auto-dismiss parent for plan handoffs and continuation children
    if (parentConversationId && (!args.parent_message_uuid || args.parent_message_uuid === "plan-handoff")) {
      const parent = await ctx.db.get(parentConversationId);
      if (parent && !parent.inbox_dismissed_at) {
        await ctx.db.patch(parentConversationId, {
          inbox_dismissed_at: Date.now(),
          status: "completed",
        });
      }
    }

    if (args.api_token) {
      await ctx.db.patch(args.user_id, {
        daemon_last_seen: now,
      });
    }

    if (resolvedTeamId && !existing) {
      await ctx.scheduler.runAfter(0, internal.notifications.notifyTeamSessionStart, {
        conversation_id: conversationId,
        user_id: args.user_id,
      });

      await ctx.scheduler.runAfter(0, internal.teamActivity.recordTeamActivity, {
        team_id: resolvedTeamId,
        actor_user_id: args.user_id,
        event_type: "session_started" as const,
        title: args.title || (args.slug ? formatSlugAsTitle(args.slug) : "New session"),
        description: args.project_path,
        related_conversation_id: conversationId,
        metadata: {
          git_branch: args.git_branch,
        },
      });
    }

    return conversationId;
  },
});

export const createQuickSession = mutation({
  args: {
    agent_type: v.optional(v.union(
      v.literal("claude_code"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini")
    )),
    project_path: v.optional(v.string()),
    git_root: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    await checkRateLimit(ctx, userId, "createConversation");

    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const agentType = args.agent_type || "claude_code";

    const user = await ctx.db.get(userId);
    let resolvedTeamId = (user as any)?.active_team_id || (user as any)?.team_id;
    let isPrivate = true;
    let autoShared = false;

    const conversationPath = args.git_root || args.project_path;
    if (conversationPath) {
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();

      let bestMatch: { teamId: Id<"teams">; pathLength: number; autoShare: boolean } | null = null;
      for (const mapping of mappings) {
        if (conversationPath === mapping.path_prefix || conversationPath.startsWith(mapping.path_prefix + "/")) {
          if (!bestMatch || mapping.path_prefix.length > bestMatch.pathLength) {
            bestMatch = {
              teamId: mapping.team_id,
              pathLength: mapping.path_prefix.length,
              autoShare: mapping.auto_share,
            };
          }
        }
      }

      if (bestMatch) {
        resolvedTeamId = bestMatch.teamId;
        if (bestMatch.autoShare) {
          isPrivate = false;
          autoShared = true;
        }
      }
    }

    if (!autoShared && user?.team_share_paths && user.team_share_paths.length > 0 && resolvedTeamId && conversationPath) {
      for (const sharePath of user.team_share_paths) {
        if (conversationPath === sharePath || conversationPath.startsWith(sharePath + "/")) {
          isPrivate = false;
          autoShared = true;
          break;
        }
      }
    }

    const conversationId = await ctx.db.insert("conversations", {
      user_id: userId,
      team_id: resolvedTeamId,
      agent_type: agentType,
      session_id: sessionId,
      project_path: args.project_path,
      git_root: args.git_root,
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: isPrivate,
      auto_shared: autoShared || undefined,
      status: "active",
    });

    await ctx.db.patch(conversationId, {
      short_id: conversationId.toString().slice(0, 7),
    });

    const daemonAgentType = agentType === "claude_code" ? "claude" : agentType === "codex" ? "codex" : "gemini";
    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "start_session",
      args: JSON.stringify({
        agent_type: daemonAgentType,
        project_path: args.project_path || args.git_root,
        conversation_id: conversationId,
      }),
      created_at: now,
    });

    return conversationId;
  },
});

export const getConversations = query({
  args: {
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId || authUserId.toString() !== args.user_id.toString()) {
      return [];
    }
    const user = await ctx.db.get(args.user_id);
    if (!user) {
      return [];
    }
    const memberships = await ctx.db.query("team_memberships")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", args.user_id))
      .collect();
    const userTeamIds = new Set(memberships.map((m: any) => m.team_id.toString()));
    const ownerVisMap = new Map<string, string>();
    for (const teamId of userTeamIds) {
      const teamMembers = await ctx.db.query("team_memberships")
        .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
        .collect();
      for (const m of teamMembers) ownerVisMap.set(m.user_id.toString(), m.visibility || "summary");
    }

    const allConversations = await ctx.db.query("conversations").collect();
    const filtered = allConversations.filter((c) => {
      const isOwn = c.user_id.toString() === args.user_id.toString();
      if (isOwn) return true;
      if (!c.team_id || !userTeamIds.has(c.team_id.toString())) return false;
      if (c.is_private === false) return true;
      if (c.team_visibility && c.team_visibility !== "private") return true;
      const ownerVis = ownerVisMap.get(c.user_id.toString()) || "summary";
      return ownerVis !== "hidden" && ownerVis !== "activity";
    });
    return filtered.sort((a, b) => b.updated_at - a.updated_at);
  },
});

export const getConversation = query({
  args: {
    conversation_id: v.id("conversations"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      if (!(await canTeamMemberAccess(ctx, authUserId, conversation))) {
        return null;
      }
    }

    const limit = args.limit ?? 100;
    // Fetch most recent messages (descending), then reverse for display
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("desc")
      .take(limit + 1);

    const hasMore = messages.length > limit;
    const resultMessages = hasMore ? messages.slice(0, limit) : messages;
    const sortedMessages = resultMessages.sort((a, b) => a.timestamp - b.timestamp);
    const oldestTimestamp = sortedMessages.length > 0 ? sortedMessages[0].timestamp : null;

    const user = await ctx.db.get(conversation.user_id);

    let firstUserMessage = "";
    for (const msg of sortedMessages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "New Session";

    return {
      ...conversation,
      title,
      messages: sortedMessages,
      user: user ? { name: user.name, email: user.email } : null,
      has_more_above: hasMore,
      oldest_timestamp: oldestTimestamp,
    };
  },
});

export const getAllMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    limit: v.optional(v.number()),
    before_timestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }

    const isOwner = authUserId && conversation.user_id.toString() === authUserId.toString();
    const isShared = !!conversation.share_token;
    let hasTeamAccess = false;

    if (authUserId && !isOwner) {
      hasTeamAccess = await canTeamMemberAccess(ctx, authUserId, conversation);
    }

    if (!isOwner && !hasTeamAccess && !isShared) {
      return null;
    }

    const messageLimit = Math.min(args.limit ?? 50, 100);

    let messagesQuery = ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      );

    if (args.before_timestamp !== undefined) {
      messagesQuery = messagesQuery.filter((q) =>
        q.lt(q.field("timestamp"), args.before_timestamp!)
      );
    }

    const messages = await messagesQuery
      .order("desc")
      .take(messageLimit + 1);

    const hasMore = messages.length > messageLimit;
    if (hasMore) {
      messages.pop();
    }
    messages.reverse();

    const user = await ctx.db.get(conversation.user_id);

    let firstUserMessage = "";
    for (const msg of messages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "New Session";

    const { children: childConversations, map: childConversationMap, agentNameMap } =
      messages.length > 0
        ? await findChildConversations(ctx, args.conversation_id, messages)
        : { children: [], map: {}, agentNameMap: {} };

    let forkedFromDetails = null;
    if (conversation.forked_from) {
      const originalConv = await ctx.db.get(conversation.forked_from);
      if (originalConv) {
        const originalUser = await ctx.db.get(originalConv.user_id);
        forkedFromDetails = {
          conversation_id: originalConv._id,
          share_token: originalConv.share_token,
          username: originalUser?.name || originalUser?.email?.split("@")[0] || "Unknown",
        };
      }
    }

    const compactionCount = messages.filter(m => m.subtype === "compact_boundary").length;

    let parentConversationId: string | null = null;
    if (conversation.parent_message_uuid) {
      const parentMsg = await ctx.db
        .query("messages")
        .withIndex("by_message_uuid", (q) => q.eq("message_uuid", conversation.parent_message_uuid))
        .first();
      if (parentMsg) {
        parentConversationId = parentMsg.conversation_id;
      }
    }

    const forkChildren = await ctx.db
      .query("conversations")
      .withIndex("by_forked_from", (q) => q.eq("forked_from", args.conversation_id))
      .collect();

    const forkChildrenDetails = await Promise.all(
      forkChildren.map(async (fork) => {
        const forkUser = await ctx.db.get(fork.user_id);
        return {
          _id: fork._id,
          title: fork.title || "New Session",
          short_id: fork.short_id,
          started_at: fork.started_at,
          username: forkUser?.name || forkUser?.email?.split("@")[0] || "Unknown",
          parent_message_uuid: fork.parent_message_uuid,
        };
      })
    );

    const oldestTimestamp = messages.length > 0 ? messages[0].timestamp : null;

    return {
      ...conversation,
      title,
      messages,
      user: user ? { name: user.name, email: user.email, avatar_url: user.image || user.github_avatar_url || null } : null,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
      agent_name_map: agentNameMap,
      last_timestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
      has_more_above: hasMore,
      oldest_timestamp: oldestTimestamp,
      fork_count: conversation.fork_count,
      forked_from: conversation.forked_from,
      forked_from_details: forkedFromDetails,
      compaction_count: compactionCount,
      fork_children: forkChildrenDetails,
      parent_conversation_id: parentConversationId,
    };
  },
});

export const getMessagesAroundTimestamp = query({
  args: {
    conversation_id: v.id("conversations"),
    center_timestamp: v.number(),
    limit_before: v.optional(v.number()),
    limit_after: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }

    const isOwner = authUserId && conversation.user_id.toString() === authUserId.toString();
    const isShared = !!conversation.share_token;
    let hasTeamAccess = false;

    if (authUserId && !isOwner) {
      hasTeamAccess = await canTeamMemberAccess(ctx, authUserId, conversation);
    }

    if (!isOwner && !hasTeamAccess && !isShared) {
      return null;
    }

    const limitBefore = Math.min(args.limit_before ?? 50, 100);
    const limitAfter = Math.min(args.limit_after ?? 50, 100);

    const messagesBefore = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .filter((q) => q.lt(q.field("timestamp"), args.center_timestamp))
      .order("desc")
      .take(limitBefore + 1);

    const hasMoreAbove = messagesBefore.length > limitBefore;
    if (hasMoreAbove) {
      messagesBefore.pop();
    }
    messagesBefore.reverse();

    const messagesAfter = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .filter((q) => q.gte(q.field("timestamp"), args.center_timestamp))
      .order("asc")
      .take(limitAfter + 1);

    const hasMoreBelow = messagesAfter.length > limitAfter;
    if (hasMoreBelow) {
      messagesAfter.pop();
    }

    const messages = [...messagesBefore, ...messagesAfter];

    const user = await ctx.db.get(conversation.user_id);

    let firstUserMessage = "";
    for (const msg of messages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "New Session";

    const oldestTimestamp = messages.length > 0 ? messages[0].timestamp : null;
    const newestTimestamp = messages.length > 0 ? messages[messages.length - 1].timestamp : null;

    let parentConversationId: string | null = null;
    if (conversation.parent_message_uuid) {
      const parentMsg = await ctx.db
        .query("messages")
        .withIndex("by_message_uuid", (q) => q.eq("message_uuid", conversation.parent_message_uuid))
        .first();
      if (parentMsg) {
        parentConversationId = parentMsg.conversation_id;
      }
    }

    const { children: childConversations, map: childConversationMap, agentNameMap } =
      messages.length > 0
        ? await findChildConversations(ctx, args.conversation_id, messages)
        : { children: [], map: {}, agentNameMap: {} };

    return {
      ...conversation,
      title,
      messages,
      user: user ? { name: user.name, email: user.email, avatar_url: user.image || user.github_avatar_url || null } : null,
      last_timestamp: newestTimestamp,
      oldest_timestamp: oldestTimestamp,
      has_more_above: hasMoreAbove,
      has_more_below: hasMoreBelow,
      parent_conversation_id: parentConversationId,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
      agent_name_map: agentNameMap,
    };
  },
});

export const getNewMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    after_timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      if (!(await canTeamMemberAccess(ctx, authUserId, conversation))) {
        return null;
      }
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id).gt("timestamp", args.after_timestamp)
      )
      .order("asc")
      .collect();

    const { children: childConversations, map: childConversationMap, agentNameMap } =
      messages.length > 0
        ? await findChildConversations(ctx, args.conversation_id, messages)
        : { children: [], map: {}, agentNameMap: {} };

    return {
      messages,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
      agent_name_map: agentNameMap,
      last_timestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
      updated_at: conversation.updated_at,
      title: conversation.title,
    };
  },
});

export const getConversationMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    after_timestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      if (!(await canTeamMemberAccess(ctx, authUserId, conversation))) {
        return null;
      }
    }

    let messages;
    if (args.after_timestamp) {
      messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", args.conversation_id).gt("timestamp", args.after_timestamp!)
        )
        .order("asc")
        .collect();
    } else {
      messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", args.conversation_id)
        )
        .order("asc")
        .collect();
    }

    const { children: childConversations, map: childConversationMap, agentNameMap } =
      messages.length > 0
        ? await findChildConversations(ctx, args.conversation_id, messages)
        : { children: [], map: {}, agentNameMap: {} };

    return {
      messages,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
      agent_name_map: agentNameMap,
      last_timestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
    };
  },
});

export const getMoreMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    cursor: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      if (!(await canTeamMemberAccess(ctx, authUserId, conversation))) {
        return null;
      }
    }

    const limit = args.limit ?? 100;
    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .filter((q) => q.gt(q.field("timestamp"), args.cursor))
      .take(limit + 1);

    const hasMore = allMessages.length > limit;
    const messages = hasMore ? allMessages.slice(0, limit) : allMessages;
    const nextCursor = hasMore ? messages[messages.length - 1].timestamp : null;

    return {
      messages,
      has_more: hasMore,
      next_cursor: nextCursor,
    };
  },
});

export const getOlderMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    before_timestamp: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      if (!(await canTeamMemberAccess(ctx, authUserId, conversation))) {
        return null;
      }
    }

    const limit = args.limit ?? 100;
    // Fetch messages older than the cursor, in descending order (newest of the older ones first)
    const olderMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("desc")
      .filter((q) => q.lt(q.field("timestamp"), args.before_timestamp))
      .take(limit + 1);

    const hasMore = olderMessages.length > limit;
    const resultMessages = hasMore ? olderMessages.slice(0, limit) : olderMessages;
    // Sort ascending for display (oldest first)
    const messages = resultMessages.sort((a, b) => a.timestamp - b.timestamp);
    const oldestTimestamp = messages.length > 0 ? messages[0].timestamp : null;

    return {
      messages,
      has_more: hasMore,
      oldest_timestamp: oldestTimestamp,
    };
  },
});

export const listConversations = query({
  args: {
    filter: v.union(v.literal("my"), v.literal("team")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    include_message_previews: v.optional(v.boolean()),
    memberId: v.optional(v.id("users")),
    activeTeamId: v.optional(v.id("teams")),
    subagentFilter: v.optional(v.union(v.literal("main"), v.literal("subagent"))),
    directoryFilter: v.optional(v.string()),
    timeFilter: v.optional(v.union(v.literal("long"), v.literal("active"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { conversations: [], nextCursor: null };
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return { conversations: [], nextCursor: null };
    }

    const limit = Math.min(args.limit ?? 20, 200);
    const includeMessagePreviews = args.include_message_previews ?? false;
    const cursorTimestamp = args.cursor ? parseInt(args.cursor, 10) : null;

    const effectiveTeamId = args.filter === "team" ? (args.activeTeamId || user.active_team_id) : undefined;

    const teamUsers = args.filter === "team" && effectiveTeamId
      ? await ctx.db
          .query("users")
          .withIndex("by_team_id", (q) => q.eq("team_id", effectiveTeamId))
          .collect()
      : [];

    const teamMemberships = args.filter === "team" && effectiveTeamId
      ? await ctx.db
          .query("team_memberships")
          .withIndex("by_team_id", (q) => q.eq("team_id", effectiveTeamId))
          .collect()
      : [];

    const additionalUsers = await Promise.all(
      teamMemberships
        .filter(m => !teamUsers.some(u => u._id.toString() === m.user_id.toString()))
        .map(m => ctx.db.get(m.user_id))
    );
    const allTeamUsers = [...teamUsers, ...additionalUsers.filter((u): u is NonNullable<typeof u> => u !== null)];
    const teamUserMap = new Map(allTeamUsers.map(u => [u._id.toString(), u]));
    const membershipVisibilityMap = new Map(teamMemberships.map(m => [m.user_id.toString(), m.visibility || "summary"]));

    // Fetch directory_team_mappings for all team members to check project visibility
    const allMappings = args.filter === "team" && effectiveTeamId
      ? await Promise.all(
          allTeamUsers.map(u =>
            ctx.db
              .query("directory_team_mappings")
              .withIndex("by_user_team", (q) => q.eq("user_id", u._id).eq("team_id", effectiveTeamId))
              .collect()
          )
        ).then(results => results.flat())
      : [];

    // Build a map of users who have explicit directory mappings
    const userHasMappings = new Map<string, boolean>();
    for (const m of allMappings) {
      userHasMappings.set(m.user_id.toString(), true);
    }

    // Helper to check if a project should show in team feed
    // - If user has no mappings: show all their conversations (permissive default)
    // - If user has mappings: only show conversations from mapped paths
    const isProjectVisibleToTeam = (userId: string, projectPath: string | undefined): boolean => {
      const hasMappings = userHasMappings.get(userId);
      if (!hasMappings) {
        // No mappings configured - show all conversations from this user
        return true;
      }
      // User has mappings - check if this project is mapped
      if (!projectPath) return false;
      return allMappings.some(
        m => m.user_id.toString() === userId &&
             (projectPath === m.path_prefix || projectPath.startsWith(m.path_prefix + "/"))
      );
    };

    const normalizeToRoot = (path: string): string => {
      const parts = path.split('/');
      const srcIndex = parts.findIndex(p => p === 'src' || p === 'projects' || p === 'repos' || p === 'code');
      if (srcIndex >= 0 && srcIndex < parts.length - 1) {
        return parts.slice(0, srcIndex + 2).join('/');
      }
      return path;
    };
    const deriveGitRoot = (c: { git_root?: string; project_path?: string }): string | null => {
      const rawPath = c.git_root || c.project_path;
      if (!rawPath) return null;
      return normalizeToRoot(rawPath);
    };

    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    const HEARTBEAT_ALIVE_MS = 90 * 1000;

    const managedSessions = await ctx.db
      .query("managed_sessions")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const liveConvIds = new Set(
      managedSessions
        .filter((s) => now - s.last_heartbeat < HEARTBEAT_ALIVE_MS && s.conversation_id)
        .map((s) => s.conversation_id!.toString())
    );

    const needsBatchScan = !!(args.subagentFilter || args.directoryFilter || args.timeFilter);

    const matchesFilters = (c: any): boolean => {
      if (args.subagentFilter) {
        const isSub = !!(c.parent_conversation_id && !c.parent_message_uuid);
        if (args.subagentFilter === "subagent" && !isSub) return false;
        if (args.subagentFilter === "main" && isSub) return false;
      }
      if (args.directoryFilter) {
        const root = deriveGitRoot(c);
        if (!root) return false;
        if (root !== args.directoryFilter && !root.startsWith(args.directoryFilter + '/')) return false;
      }
      if (args.timeFilter === "active") {
        const isActive = c.status === "active" && (c.updated_at > fiveMinutesAgo || liveConvIds.has(c._id.toString()));
        if (!isActive) return false;
      }
      if (args.timeFilter === "long") {
        if ((c.updated_at - c.started_at) < 20 * 60 * 1000) return false;
      }
      return true;
    };

    let conversations;
    if (args.filter === "my") {
      if (needsBatchScan) {
        const results: any[] = [];
        let scanCursor = cursorTimestamp;
        const batchSize = Math.min(limit * 3, 50);
        const maxBatches = 5;

        for (let i = 0; i < maxBatches && results.length < limit + 1; i++) {
          const batch = await ctx.db
            .query("conversations")
            .withIndex("by_user_updated", (q) =>
              scanCursor
                ? q.eq("user_id", userId).lt("updated_at", scanCursor)
                : q.eq("user_id", userId)
            )
            .order("desc")
            .take(batchSize);

          if (batch.length === 0) break;

          for (const c of batch) {
            if (matchesFilters(c)) {
              results.push(c);
              if (results.length >= limit + 1) break;
            }
          }

          scanCursor = batch[batch.length - 1].updated_at;
          if (batch.length < batchSize) break;
        }

        conversations = results;
      } else {
        const query = ctx.db
          .query("conversations")
          .withIndex("by_user_updated", (q) =>
            cursorTimestamp
              ? q.eq("user_id", userId).lt("updated_at", cursorTimestamp)
              : q.eq("user_id", userId)
          )
          .order("desc");
        conversations = await query.take(limit + 1);
      }
    } else if (args.memberId) {
      // Filter by specific team member - use index for efficient pagination
      const targetMember = teamUserMap.get(args.memberId.toString());
      if (!targetMember) {
        return { conversations: [], nextCursor: null };
      }
      const visibility = membershipVisibilityMap.get(args.memberId.toString()) || "summary";
      if (visibility === "hidden") {
        return { conversations: [], nextCursor: null };
      }

      const query = ctx.db
        .query("conversations")
        .withIndex("by_team_user_updated", (q) =>
          cursorTimestamp
            ? q.eq("team_id", effectiveTeamId!).eq("user_id", args.memberId!).lt("updated_at", cursorTimestamp)
            : q.eq("team_id", effectiveTeamId!).eq("user_id", args.memberId!)
        )
        .order("desc");

      const memberHasMappings = userHasMappings.get(args.memberId!.toString());
      if (needsBatchScan) {
        const results: any[] = [];
        let memberScanCursor = cursorTimestamp;
        const memberBatchSize = Math.min(limit * 3, 50);
        for (let i = 0; i < 5 && results.length < limit + 1; i++) {
          const batch = await ctx.db
            .query("conversations")
            .withIndex("by_team_user_updated", (q) =>
              memberScanCursor
                ? q.eq("team_id", effectiveTeamId!).eq("user_id", args.memberId!).lt("updated_at", memberScanCursor)
                : q.eq("team_id", effectiveTeamId!).eq("user_id", args.memberId!)
            )
            .order("desc")
            .take(memberBatchSize);
          if (batch.length === 0) break;
          for (const c of batch) {
            if (!isConversationVisibleInFeed(c, !!memberHasMappings)) continue;
            const projectPath = c.git_root || c.project_path;
            if (!isProjectVisibleToTeam(c.user_id.toString(), projectPath)) continue;
            if (!matchesFilters(c)) continue;
            results.push(c);
            if (results.length >= limit + 1) break;
          }
          memberScanCursor = batch[batch.length - 1].updated_at;
          if (batch.length < memberBatchSize) break;
        }
        conversations = results;
      } else {
        const fetched = await query.take((limit + 1) * 2);
        conversations = fetched.filter((c) => {
          if (!isConversationVisibleInFeed(c, !!memberHasMappings)) return false;
          const projectPath = c.git_root || c.project_path;
          return isProjectVisibleToTeam(c.user_id.toString(), projectPath);
        }).slice(0, limit + 1);
      }
    } else {
      // Query recent conversations from each visible team member and merge
      // This ensures all team members' conversations appear regardless of activity level
      const visibleMembers = teamMemberships.filter(m => {
        const visibility = m.visibility || "summary";
        return visibility !== "hidden";
      });

      const maxTotalReads = 100;
      const perMemberFetch = Math.max(3, Math.min(
        Math.ceil((limit + 1) * 2 / Math.max(visibleMembers.length, 1)),
        Math.floor(maxTotalReads / Math.max(visibleMembers.length, 1))
      ));
      const perMemberLimit = Math.max(3, Math.ceil((limit + 1) / Math.max(visibleMembers.length, 1)));

      const memberConversations = await Promise.all(
        visibleMembers.map(async (member) => {
          const query = ctx.db
            .query("conversations")
            .withIndex("by_team_user_updated", (q) =>
              cursorTimestamp
                ? q.eq("team_id", effectiveTeamId!).eq("user_id", member.user_id).lt("updated_at", cursorTimestamp)
                : q.eq("team_id", effectiveTeamId!).eq("user_id", member.user_id)
            )
            .order("desc");

          const convs = await query.take(perMemberFetch);
          const memberHasMappings = userHasMappings.get(member.user_id.toString());
          return convs.filter((c) => {
            if (!isConversationVisibleInFeed(c, !!memberHasMappings)) return false;
            const projectPath = c.git_root || c.project_path;
            if (!isProjectVisibleToTeam(c.user_id.toString(), projectPath)) return false;
            if (!matchesFilters(c)) return false;
            return true;
          }).slice(0, perMemberLimit);
        })
      );

      // Merge and sort by updated_at descending
      const allFiltered = memberConversations.flat();
      allFiltered.sort((a, b) => b.updated_at - a.updated_at);
      conversations = allFiltered.slice(0, limit + 1);
    }

    const hasMore = conversations.length > limit;
    const resultConversations = hasMore ? conversations.slice(0, limit) : conversations;
    const nextCursor = hasMore ? String(resultConversations[resultConversations.length - 1].updated_at) : null;

    const conversationsWithUsers = await Promise.all(
      resultConversations.map(async (c) => {
        const conversationUser =
          c.user_id.toString() === userId.toString()
            ? user
            : teamUserMap.get(c.user_id.toString()) || await ctx.db.get(c.user_id);

        const visibilityMode = resolveVisibilityMode(
          c.team_visibility,
          membershipVisibilityMap.get(c.user_id.toString()),
          args.filter === "team"
        );
        const authorName = (conversationUser as any)?.name || (conversationUser as any)?.email?.split("@")[0] || "Unknown";
        const authorAvatar = (conversationUser as any)?.image || (conversationUser as any)?.github_avatar_url || null;
        const projectName = (c.project_path || c.git_root)?.split("/").pop() || "unknown project";
        const durationMs = c.updated_at - c.started_at;
        const isActive = c.status === "active" && (c.updated_at > fiveMinutesAgo || liveConvIds.has(c._id.toString()));
        const title = c.title || "New Session";

        if (visibilityMode === "minimal") {
          return {
            _id: c._id,
            user_id: c.user_id,
            visibility_mode: visibilityMode,
            author_name: authorName,
            author_avatar: authorAvatar,
            is_own: c.user_id.toString() === userId.toString(),
            is_active: isActive,
            updated_at: c.updated_at,
            started_at: c.started_at,
            duration_ms: durationMs,
            message_count: c.message_count,
            activity_summary: `1 agent in ${projectName}`,
            project_path: c.project_path || null,
            git_root: c.git_root || null,
          };
        }

        if (visibilityMode === "summary") {
          return {
            _id: c._id,
            user_id: c.user_id,
            visibility_mode: visibilityMode,
            title,
            subtitle: c.subtitle || null,
            author_name: authorName,
            author_avatar: authorAvatar,
            is_own: c.user_id.toString() === userId.toString(),
            is_active: isActive,
            updated_at: c.updated_at,
            started_at: c.started_at,
            duration_ms: durationMs,
            message_count: c.message_count,
            project_path: c.project_path || null,
            git_root: c.git_root || null,
            tool_names: [],
            subagent_types: [],
          };
        }

        if (!includeMessagePreviews) {
          const fullTitle = c.title || "New Session";
          return {
            _id: c._id,
            user_id: c.user_id,
            visibility_mode: visibilityMode,
            title: fullTitle,
            subtitle: (visibilityMode === "full" || visibilityMode === "detailed") ? (c.subtitle || null) : null,
            first_user_message: null,
            first_assistant_message: null,
            message_alternates: [],
            tool_names: [],
            subagent_types: [],
            agent_type: c.agent_type,
            model: c.model || null,
            slug: visibilityMode === "full" ? (c.slug || null) : null,
            started_at: c.started_at,
            updated_at: c.updated_at,
            duration_ms: durationMs,
            message_count: c.message_count,
            ai_message_count: 0,
            tool_call_count: 0,
            is_active: isActive,
            author_name: authorName,
            author_avatar: authorAvatar,
            is_own: c.user_id.toString() === userId.toString(),
            parent_conversation_id: c.parent_conversation_id || null,
            parent_message_uuid: c.parent_message_uuid || null,
            is_subagent: !!(c.is_subagent || (c.parent_conversation_id && !c.parent_message_uuid)),
            parent_title: null,
            latest_todos: undefined,
            project_path: c.project_path || null,
            git_root: c.git_root || null,
            git_branch: c.git_branch || null,
            git_remote_url: c.git_remote_url || null,
            is_favorite: c.is_favorite || false,
            fork_count: c.fork_count || 0,
            forked_from: c.forked_from || null,
            is_private: c.is_private,
            team_visibility: c.team_visibility || null,
            auto_shared: c.auto_shared || false,
          };
        }

        // Only fetch messages for full/detailed visibility
        const msgLimit = args.filter === "team" ? 3 : 5;
        const firstMessages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_id", (q) =>
            q.eq("conversation_id", c._id)
          )
          .order("asc")
          .take(msgLimit);

        const recentMessages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_id", (q) =>
            q.eq("conversation_id", c._id)
          )
          .order("desc")
          .take(msgLimit);

        const messageIds = new Set<string>();
        const messages = [];
        for (const m of firstMessages) {
          if (!messageIds.has(m._id)) {
            messageIds.add(m._id);
            messages.push(m);
          }
        }
        for (const m of recentMessages) {
          if (!messageIds.has(m._id)) {
            messageIds.add(m._id);
            messages.push(m);
          }
        }

        let toolCallCount = 0;
        const toolNames: string[] = [];
        const subagentTypes: string[] = [];
        let aiMessageCount = 0;
        const messageAlternates: Array<{ role: "user" | "assistant"; content: string }> = [];
        let latestTodos: { todos: any[]; timestamp: number } | undefined;

        for (const msg of messages) {
          if (msg.tool_calls) {
            toolCallCount += msg.tool_calls.length;
            for (const tc of msg.tool_calls) {
              if (toolNames.length < 5 && !toolNames.includes(tc.name)) {
                toolNames.push(tc.name);
              }
              if (tc.name === "Task" && tc.input) {
                try {
                  const input = JSON.parse(tc.input);
                  if (input.subagent_type && !subagentTypes.includes(input.subagent_type)) {
                    subagentTypes.push(input.subagent_type);
                  }
                } catch {}
              }
              if (tc.name === "TodoWrite" && tc.input) {
                try {
                  const input = JSON.parse(tc.input);
                  if (input.todos) {
                    if (!latestTodos || msg.timestamp > latestTodos.timestamp) {
                      latestTodos = {
                        todos: input.todos,
                        timestamp: msg.timestamp,
                      };
                    }
                  }
                } catch {}
              }
            }
          }
          if (msg.role === "user") {
            const text = msg.content?.trim();
            if (text) {
              const truncated = text.length > 120 ? text.slice(0, 120) + "..." : text;
              messageAlternates.push({ role: "user", content: truncated });
            }
          }
          if (msg.role === "assistant") {
            aiMessageCount++;
            let text = msg.content?.trim();
            if (!text && msg.thinking) {
              text = msg.thinking.trim();
            }
            if (!text && msg.tool_calls && msg.tool_calls.length > 0) {
              const toolNames = msg.tool_calls.map(tc => tc.name).join(", ");
              text = `[Using: ${toolNames}]`;
            }
            if (text) {
              const truncated = text.length > 120 ? text.slice(0, 120) + "..." : text;
              messageAlternates.push({ role: "assistant", content: truncated });
            }
          }
        }

        const firstUserMessage = messageAlternates.find(m => m.role === "user")?.content || "";
        const firstAssistantMessage = messageAlternates.find(m => m.role === "assistant")?.content || "";

        const fullTitle = c.title || firstUserMessage || "New Session";

        let parentConversationId: string | null = c.parent_conversation_id || null;
        let parentTitle: string | null = null;
        if (!parentConversationId && c.parent_message_uuid) {
          const parentMsg = await ctx.db
            .query("messages")
            .withIndex("by_message_uuid", (q) => q.eq("message_uuid", c.parent_message_uuid))
            .first();
          if (parentMsg) {
            parentConversationId = parentMsg.conversation_id;
          }
        }
        if (parentConversationId) {
          const parentConv = await ctx.db.get(parentConversationId as Id<"conversations">);
          if (parentConv) {
            parentTitle = parentConv.title || "New Session";
          }
        }

        return {
          _id: c._id,
          user_id: c.user_id,
          visibility_mode: visibilityMode,
          title: fullTitle,
          subtitle: (visibilityMode === "full" || visibilityMode === "detailed") ? (c.subtitle || null) : null,
          first_user_message: visibilityMode === "full" ? firstUserMessage : null,
          first_assistant_message: visibilityMode === "full" ? firstAssistantMessage : null,
          message_alternates: visibilityMode === "full" ? messageAlternates : [],
          tool_names: toolNames,
          subagent_types: subagentTypes,
          agent_type: c.agent_type,
          model: c.model || null,
          slug: visibilityMode === "full" ? (c.slug || null) : null,
          started_at: c.started_at,
          updated_at: c.updated_at,
          duration_ms: durationMs,
          message_count: c.message_count,
          ai_message_count: aiMessageCount,
          tool_call_count: toolCallCount,
          is_active: isActive,
          author_name: authorName,
          author_avatar: authorAvatar,
          is_own: c.user_id.toString() === userId.toString(),
          parent_conversation_id: visibilityMode === "full" ? parentConversationId : null,
          parent_message_uuid: c.parent_message_uuid || null,
          is_subagent: !!(c.is_subagent || (c.parent_conversation_id && !c.parent_message_uuid)),
          parent_title: visibilityMode === "full" ? parentTitle : null,
          latest_todos: visibilityMode === "full" ? latestTodos : undefined,
          project_path: c.project_path || null,
          git_root: c.git_root || null,
          git_branch: c.git_branch || null,
          git_remote_url: c.git_remote_url || null,
          is_favorite: c.is_favorite || false,
          fork_count: c.fork_count || 0,
          forked_from: c.forked_from || null,
          is_private: c.is_private,
          team_visibility: c.team_visibility || null,
          auto_shared: c.auto_shared || false,
        };
      })
    );

    return {
      conversations: conversationsWithUsers.sort((a, b) => (b as { updated_at: number }).updated_at - (a as { updated_at: number }).updated_at),
      nextCursor,
      hasSubagents: true,
    };
  },
});

export const generateShareLink = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      throw new Error("Unauthorized: can only share your own conversations");
    }
    if (conversation.share_token) {
      return conversation.share_token;
    }
    const shareToken = generateShareToken();
    await ctx.db.patch(args.conversation_id, {
      share_token: shareToken,
    });
    return shareToken;
  },
});

export const getSharedConversation = query({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .collect();

    if (conversations.length === 0) {
      return null;
    }

    const conversation = conversations[0];

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", conversation._id)
      )
      .collect();

    const sortedMessages = messages.sort((a, b) => a.timestamp - b.timestamp);
    const user = await ctx.db.get(conversation.user_id);

    let firstUserMessage = "";
    for (const msg of sortedMessages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "New Session";

    return {
      ...conversation,
      title,
      messages: sortedMessages,
      user: user ? { name: user.name, email: user.email } : null,
      fork_count: conversation.fork_count,
      forked_from: conversation.forked_from,
    };
  },
});

export const getSharedConversationMeta = query({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .collect();

    if (conversations.length === 0) return null;

    const conversation = conversations[0];
    const user = await ctx.db.get(conversation.user_id);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", conversation._id)
      )
      .order("asc")
      .take(10);

    let firstUserMessage = "";
    for (const msg of messages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 200);
          if (text.length > 200) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "Coding Session";

    const description = conversation.subtitle
      || conversation.idle_summary
      || (conversation.title ? firstUserMessage : null)
      || `${conversation.message_count || 0} messages${user?.name ? ` by ${user.name}` : ""}${conversation.project_path ? ` in ${conversation.project_path.split("/").pop()}` : ""}`;

    return {
      title,
      description,
      author: user?.name || null,
      message_count: conversation.message_count || 0,
    };
  },
});

export const getConversationPublic = query({
  args: {
    conversation_id: v.id("conversations"),
    limit: v.optional(v.number()),
    before_timestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return { access_level: "not_found" as const, conversation: null };
    }

    const authUserId = await getAuthUserId(ctx);
    const accessLevel = await checkConversationAccess(ctx, authUserId, conversation);

    if (accessLevel === "denied") {
      return { access_level: "denied" as const, conversation: null };
    }

    const limit = args.limit ?? 100;
    let messagesQuery = ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      );

    if (args.before_timestamp !== undefined) {
      messagesQuery = messagesQuery.filter((q) =>
        q.lt(q.field("timestamp"), args.before_timestamp!)
      );
    }

    const messages = await messagesQuery
      .order("desc")
      .take(limit + 1);

    const hasMore = messages.length > limit;
    const resultMessages = hasMore ? messages.slice(0, limit) : messages;
    const sortedMessages = resultMessages.sort((a, b) => a.timestamp - b.timestamp);
    const oldestTimestamp = sortedMessages.length > 0 ? sortedMessages[0].timestamp : null;

    const user = await ctx.db.get(conversation.user_id);

    let firstUserMessage = "";
    for (const msg of sortedMessages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "New Session";

    let parentConversationId: string | null = null;
    if (conversation.parent_message_uuid) {
      const parentMsg = await ctx.db
        .query("messages")
        .withIndex("by_message_uuid", (q) => q.eq("message_uuid", conversation.parent_message_uuid))
        .first();
      if (parentMsg) {
        parentConversationId = parentMsg.conversation_id;
      }
    }

    return {
      access_level: accessLevel,
      conversation: {
        ...conversation,
        title,
        messages: sortedMessages,
        user: user ? { name: user.name, email: user.email, avatar_url: user.image || user.github_avatar_url || null } : null,
        has_more_above: hasMore,
        oldest_timestamp: oldestTimestamp,
        fork_count: conversation.fork_count,
        forked_from: conversation.forked_from,
        parent_conversation_id: parentConversationId,
      },
    };
  },
});

export const searchConversations = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    userOnly: v.optional(v.boolean()),
    activeTeamId: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return [];
    }

    const userMemberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const userTeamIds = userMemberships.map(m => m.team_id);

    const effectiveTeamIds = args.activeTeamId ? [args.activeTeamId] : userTeamIds;

    type UserDoc = NonNullable<Awaited<ReturnType<typeof ctx.db.get<"users">>>>;
    const allTeamUsers: UserDoc[] = [];
    for (const teamId of effectiveTeamIds) {
      const teamMemberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
        .collect();
      const memberUsers = await Promise.all(
        teamMemberships.map(m => ctx.db.get(m.user_id))
      );
      allTeamUsers.push(...memberUsers.filter((u): u is UserDoc => u !== null));
    }
    const teamUsers = [...new Map(allTeamUsers.map(u => [u._id.toString(), u])).values()];
    const teamUserIds = new Set(teamUsers.map(u => u._id.toString()));
    const effectiveTeamIdSet = new Set(effectiveTeamIds.map(id => id.toString()));

    const searchTerm = args.query.trim();
    if (!searchTerm || searchTerm.length < 2) {
      return [];
    }

    const limit = args.limit ?? 20;
    const userOnly = args.userOnly ?? false;
    const terms = parseSearchTerms(searchTerm);
    const searchQuery = terms.all.join(" ");

    // Use full-text search on messages
    const searchResults = await ctx.db
      .query("messages")
      .withSearchIndex("search_content", (q) => q.search("content", searchQuery))
      .take(200);

    // Group messages by conversation (keep messages matching ANY term for context)
    const conversationMessages = new Map<string, typeof searchResults>();
    for (const msg of searchResults) {
      if (userOnly && msg.role !== "user") {
        continue;
      }
      if (!contentMatchesAnyTerm(msg.content || "", terms)) {
        continue;
      }
      const convId = msg.conversation_id.toString();
      if (!conversationMessages.has(convId)) {
        conversationMessages.set(convId, []);
      }
      conversationMessages.get(convId)!.push(msg);
    }

    // Filter to conversations where ALL terms appear (across any messages)
    const conversationMatches = new Map<string, typeof searchResults>();
    for (const [convId, messages] of conversationMessages) {
      if (conversationMatchesAllTerms(messages, terms)) {
        conversationMatches.set(convId, messages);
      }
    }

    const results: Array<{
      conversationId: string;
      title: string;
      matches: Array<{
        messageId: string;
        content: string;
        role: string;
        timestamp: number;
      }>;
      updatedAt: number;
      authorName: string;
      isOwn: boolean;
      messageCount: number;
      proximityScore: number;
    }> = [];

    for (const [convId, messages] of conversationMatches) {
      const conv = await ctx.db.get(messages[0].conversation_id);
      if (!conv) continue;

      const isOwn = conv.user_id.toString() === userId.toString();
      if (!isOwn) {
        if (!(await isConversationTeamVisible(ctx, conv))) continue;
        if (!teamUserIds.has(conv.user_id.toString())) continue;
        if (!conv.team_id || !effectiveTeamIdSet.has(conv.team_id.toString())) continue;
      }

      const conversationUser = await ctx.db.get(conv.user_id);

      // Get first user message for title fallback
      let firstUserMessage = "";
      const firstMessages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .order("asc")
        .take(10);
      for (const msg of firstMessages) {
        const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
        if (msg.role === "user" && !hasToolResults) {
          const text = msg.content?.trim();
          if (text) {
            firstUserMessage = text.slice(0, 120);
            if (text.length > 120) firstUserMessage += "...";
            break;
          }
        }
      }

      const title = conv.title
        || firstUserMessage
        || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
        || "New Session";

      const proximityScore = calculateProximityScore(messages, terms);

      results.push({
        conversationId: conv._id,
        title,
        matches: messages.slice(0, 5).map((m) => {
          const content = m.content || "";
          const lowerContent = content.toLowerCase();
          let bestIdx = -1;
          for (const term of terms.all) {
            const idx = lowerContent.indexOf(term);
            if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
              bestIdx = idx;
            }
          }
          const start = Math.max(0, bestIdx > -1 ? bestIdx - 80 : 0);
          const end = Math.min(content.length, bestIdx > -1 ? bestIdx + 220 : 300);
          let snippet = content.slice(start, end);
          if (start > 0) snippet = "..." + snippet;
          if (end < content.length) snippet = snippet + "...";
          return {
            messageId: m._id,
            content: snippet,
            role: m.role,
            timestamp: m.timestamp,
          };
        }),
        updatedAt: conv.updated_at,
        authorName: conversationUser?.name || "Unknown",
        isOwn,
        messageCount: conv.message_count || 0,
        proximityScore,
      });
    }

    // Sort by proximity first (lower = better), then by recency
    const sorted = results.sort((a, b) => {
      if (a.proximityScore !== b.proximityScore) {
        return a.proximityScore - b.proximityScore;
      }
      return b.updatedAt - a.updatedAt;
    });
    return { results: sorted.slice(0, limit), totalMatches: searchResults.length };
  },
});

export const updateSlug = mutation({
  args: {
    conversation_id: v.id("conversations"),
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only update your own conversations");
    }
    await ctx.db.patch(args.conversation_id, {
      slug: args.slug,
    });
  },
});

export const setPrivacy = mutation({
  args: {
    conversation_id: v.id("conversations"),
    is_private: v.boolean(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      throw new Error("Unauthorized: can only change privacy of your own conversations");
    }

    const updates: { is_private: boolean; team_id?: Id<"teams">; team_visibility?: "summary" | "full" | "private" } = {
      is_private: args.is_private,
    };

    if (args.is_private) {
      updates.team_visibility = "private";
    }

    // When unlocking, ensure team_id is synced to user's current team
    if (!args.is_private) {
      const user = await ctx.db.get(authUserId);
      if (user?.team_id && conversation.team_id?.toString() !== user.team_id.toString()) {
        updates.team_id = user.team_id;
      }
    }

    await ctx.db.patch(args.conversation_id, updates);
  },
});

export const setTeamVisibility = mutation({
  args: {
    conversation_id: v.id("conversations"),
    team_visibility: v.union(v.literal("summary"), v.literal("full"), v.null()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      throw new Error("Unauthorized: can only change visibility of your own conversations");
    }

    await ctx.db.patch(args.conversation_id, {
      team_visibility: args.team_visibility ?? undefined,
      is_private: false,
    });
  },
});

export const setPrivacyBySessionId = mutation({
  args: {
    session_id: v.string(),
    is_private: v.boolean(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    if (!conversation) {
      throw new Error(`Conversation not found with session_id: ${args.session_id}`);
    }

    await ctx.db.patch(conversation._id, {
      is_private: args.is_private,
    });

    if (args.api_token) {
      await ctx.db.patch(authUserId, {
        daemon_last_seen: Date.now(),
      });
    }
  },
});

export const makeAllPrivate = mutation({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .filter((q) => q.neq(q.field("is_private"), true))
      .collect();

    let updated = 0;
    for (const conv of conversations) {
      await ctx.db.patch(conv._id, { is_private: true });
      updated++;
    }

    return { updated, total: conversations.length };
  },
});

export const makeAllPrivateAdmin = internalMutation({
  args: {
    user_id: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.limit ?? 100;
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_private", (q) =>
        q.eq("user_id", args.user_id).eq("is_private", false)
      )
      .take(batchSize);

    let updated = 0;
    for (const conv of conversations) {
      await ctx.db.patch(conv._id, { is_private: true });
      updated++;
    }

    return { updated, hasMore: conversations.length === batchSize };
  },
});

export const backfillShortIds = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.limit ?? 100;
    // Use cursor-based pagination to avoid full table scan
    const result = await ctx.db
      .query("conversations")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let updated = 0;
    for (const conv of result.page) {
      if (!conv.short_id) {
        await ctx.db.patch(conv._id, {
          short_id: conv._id.toString().slice(0, 7),
        });
        updated++;
      }
    }

    return {
      updated,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const backfillTeamIds = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.limit ?? 100;

    // Get all users with team_id or active_team_id to build a lookup map
    const allUsers = await ctx.db
      .query("users")
      .collect();

    const userTeamMap = new Map<string, Id<"teams">>();
    for (const user of allUsers) {
      const teamId = (user as any).active_team_id || user.team_id;
      if (teamId) {
        userTeamMap.set(user._id.toString(), teamId);
      }
    }

    // Paginate through conversations missing team_id
    const result = await ctx.db
      .query("conversations")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let updated = 0;
    for (const conv of result.page) {
      if (conv.team_id) continue;
      const userTeamId = userTeamMap.get(conv.user_id.toString());
      if (userTeamId) {
        await ctx.db.patch(conv._id, { team_id: userTeamId });
        updated++;
      }
    }

    return {
      updated,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const diagnoseTeamIds = internalQuery({
  args: {
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get users with teams (lightweight query)
    const usersWithTeams = await ctx.db
      .query("users")
      .filter((q) => q.neq(q.field("team_id"), undefined))
      .collect();

    const userTeamMap = new Map<string, string>();
    for (const user of usersWithTeams) {
      if (user.team_id) {
        userTeamMap.set(user._id.toString(), user.team_id.toString());
      }
    }

    // Paginate through conversations
    const result = await ctx.db
      .query("conversations")
      .paginate({ cursor: args.cursor ?? null, numItems: 500 });

    let withTeamId = 0;
    let withoutTeamId = 0;
    let userHasTeamButConvDoesnt = 0;
    let mismatch = 0;

    for (const conv of result.page) {
      const convTeamId = conv.team_id?.toString();
      const userTeamId = userTeamMap.get(conv.user_id.toString());

      if (convTeamId) {
        withTeamId++;
      } else {
        withoutTeamId++;
      }

      if (userTeamId && !convTeamId) {
        userHasTeamButConvDoesnt++;
      }

      if (userTeamId && convTeamId && userTeamId !== convTeamId) {
        mismatch++;
      }
    }

    return {
      pageConversations: result.page.length,
      withTeamId,
      withoutTeamId,
      userHasTeamButConvDoesnt,
      mismatch,
      usersWithTeams: usersWithTeams.length,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const backfillUserTeamIds = internalMutation({
  args: { userId: v.string(), teamId: v.string() },
  handler: async (ctx, args) => {
    const userId = args.userId as any;
    const teamId = args.teamId as any;
    let updated = 0;
    let alreadyHad = 0;
    let cursor: string | null = null;
    do {
      const result = await ctx.db
        .query("conversations")
        .withIndex("by_user_updated", (q) => q.eq("user_id", userId))
        .paginate({ cursor: cursor ?? null, numItems: 100 });
      for (const conv of result.page) {
        if (conv.team_id) {
          alreadyHad++;
          continue;
        }
        await ctx.db.patch(conv._id, { team_id: teamId });
        updated++;
      }
      cursor = result.continueCursor;
      if (result.isDone) break;
    } while (true);
    return { updated, alreadyHad };
  },
});

export const getConversationBySessionId = query({
  args: {
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    return conversation ? { _id: conversation._id } : null;
  },
});

export const getSessionLinks = mutation({
  args: {
    session_id: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    if (!conversation) {
      return { error: "Session not found" };
    }

    let shareToken = conversation.share_token;
    if (!shareToken) {
      shareToken = generateShareToken();
      await ctx.db.patch(conversation._id, { share_token: shareToken });
    }

    return {
      conversation_id: conversation._id,
      share_token: shareToken,
      title: conversation.title,
      slug: conversation.slug,
      started_at: conversation.started_at,
    };
  },
});

export const searchForCLI = query({
  args: {
    api_token: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    start_time: v.optional(v.number()),
    end_time: v.optional(v.number()),
    context_before: v.optional(v.number()),
    context_after: v.optional(v.number()),
    project_path: v.optional(v.string()),
    user_only: v.optional(v.boolean()),
    team_id: v.optional(v.id("teams")),
    member_name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(authUserId);
    if (!user) {
      return { error: "User not found" };
    }

    const userMemberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .collect();
    const userTeamIds = userMemberships.map(m => m.team_id);

    let resolvedTeamId: Id<"teams"> | undefined;
    if (args.team_id) {
      resolvedTeamId = args.team_id;
    } else if (args.project_path) {
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
        .collect();
      let bestMatch: { teamId: Id<"teams">; pathLength: number } | null = null;
      for (const mapping of mappings) {
        if (args.project_path === mapping.path_prefix || args.project_path.startsWith(mapping.path_prefix + "/")) {
          if (!bestMatch || mapping.path_prefix.length > bestMatch.pathLength) {
            bestMatch = { teamId: mapping.team_id, pathLength: mapping.path_prefix.length };
          }
        }
      }
      resolvedTeamId = bestMatch?.teamId;
    }
    const effectiveTeamIds = resolvedTeamId ? [resolvedTeamId] : userTeamIds;

    type UserDoc = NonNullable<Awaited<ReturnType<typeof ctx.db.get<"users">>>>;
    const allTeamUsers: UserDoc[] = [];
    for (const teamId of effectiveTeamIds) {
      const teamMemberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
        .collect();
      const memberUsers = await Promise.all(
        teamMemberships.map(m => ctx.db.get(m.user_id))
      );
      allTeamUsers.push(...memberUsers.filter((u): u is UserDoc => u !== null));
    }
    const teamUsers = [...new Map(allTeamUsers.map(u => [u._id.toString(), u])).values()];
    const teamUserIds = new Set(teamUsers.map(u => u._id.toString()));
    const teamUserMap = new Map(teamUsers.map(u => [u._id.toString(), u]));
    const effectiveTeamIdSet = new Set(effectiveTeamIds.map(id => id.toString()));

    let filterUserId: string | null = null;
    if (args.member_name) {
      const memberNameLower = args.member_name.toLowerCase();
      const matchingMember = teamUsers.find(u => {
        const name = u.name?.toLowerCase() || "";
        const email = u.email?.toLowerCase() || "";
        return name.includes(memberNameLower) || email.includes(memberNameLower);
      });
      if (!matchingMember) {
        return { error: `No team member found matching "${args.member_name}"` };
      }
      filterUserId = matchingMember._id.toString();
    }

    const searchTerm = args.query.trim();
    if (!searchTerm || searchTerm.length < 2) {
      return { error: "Query must be at least 2 characters" };
    }

    const limit = args.limit ?? 10;
    const offset = args.offset ?? 0;
    const startTime = args.start_time;
    const endTime = args.end_time ?? Date.now();
    const contextBefore = args.context_before ?? 0;
    const contextAfter = args.context_after ?? 0;
    const projectPath = args.project_path;
    const userOnly = args.user_only ?? false;
    const terms = parseSearchTerms(searchTerm);

    // Search for each term separately to ensure we get results for all terms
    // Then combine and deduplicate by message ID
    const allSearchResults = new Map<string, any>();
    for (const term of terms.all) {
      const results = await ctx.db
        .query("messages")
        .withSearchIndex("search_content", (q) => q.search("content", term))
        .take(200);
      for (const msg of results) {
        const msgId = msg._id.toString();
        if (!allSearchResults.has(msgId)) {
          allSearchResults.set(msgId, msg);
        }
      }
    }
    const searchResults = Array.from(allSearchResults.values());

    // Group messages by conversation (keep messages matching ANY term for context)
    const conversationMessages = new Map<string, typeof searchResults>();
    for (const msg of searchResults) {
      if (userOnly && msg.role !== "user") continue;
      if (!contentMatchesAnyTerm(msg.content || "", terms)) {
        continue;
      }
      const convId = msg.conversation_id.toString();
      if (!conversationMessages.has(convId)) {
        conversationMessages.set(convId, []);
      }
      conversationMessages.get(convId)!.push(msg);
    }

    // Filter to conversations where ALL terms appear (across any messages)
    const conversationMatches = new Map<string, typeof searchResults>();
    for (const [convId, messages] of conversationMessages) {
      if (conversationMatchesAllTerms(messages, terms)) {
        conversationMatches.set(convId, messages);
      }
    }

    const results: Array<{
      id: string;
      title: string;
      project_path: string | null;
      updated_at: string;
      message_count: number;
      proximityScore: number;
      user?: { name: string | null; email: string | null };
      matches: Array<{
        line: number;
        role: string;
        content: string;
        timestamp: string;
      }>;
      context: Array<{
        line: number;
        role: string;
        content: string;
      }>;
    }> = [];

    let totalMatches = 0;
    let conversationsSkipped = 0;

    for (const [, messages] of conversationMatches) {
      if (results.length >= limit) break;

      const conv = await ctx.db.get(messages[0].conversation_id) as any;
      if (!conv) continue;

      const isOwn = conv.user_id.toString() === authUserId.toString();
      if (!isOwn) {
        if (!(await isConversationTeamVisible(ctx, conv))) continue;
        if (!teamUserIds.has(conv.user_id.toString())) continue;
        if (!conv.team_id || !effectiveTeamIdSet.has(conv.team_id.toString())) continue;
      }

      // Filter by specific member if requested
      if (filterUserId && conv.user_id.toString() !== filterUserId) {
        continue;
      }

      // Match sessions at or under the search path (not parent directories)
      // Skip path filter for other team members since absolute paths differ per user
      if (projectPath && !filterUserId) {
        const convPath = conv.project_path || "";
        const convGitRoot = conv.git_root || "";
        // Match: exact path, or session is in a subdirectory of search path
        const isPathMatch = convPath === projectPath ||
          convPath.startsWith(projectPath + "/") ||
          convGitRoot === projectPath ||
          convGitRoot.startsWith(projectPath + "/");
        if (!isPathMatch) {
          continue;
        }
      }

      if (startTime && conv.updated_at < startTime) continue;
      if (endTime && conv.updated_at > endTime) continue;

      if (conversationsSkipped < offset) {
        conversationsSkipped++;
        continue;
      }

      const firstMessages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .order("asc")
        .take(20);

      let firstUserMessage = "";
      for (const msg of firstMessages) {
        const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
        if (msg.role === "user" && !hasToolResults) {
          const text = msg.content?.trim();
          if (text) {
            firstUserMessage = text.slice(0, 120);
            if (text.length > 120) firstUserMessage += "...";
            break;
          }
        }
      }

      const title = conv.title
        || firstUserMessage
        || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
        || "New Session";

      const matchedMessages = messages.slice(0, 5);
      totalMatches += matchedMessages.length;

      // For CLI search, we estimate line numbers without fetching all messages
      // Line numbers are approximate (based on message order in matches)
      const messageIdToLine = new Map<string, number>();
      matchedMessages.forEach((m, idx) => {
        // Use index + 1 as approximate line number for display
        // Exact line numbers would require fetching all messages which hits read limits
        messageIdToLine.set(m._id.toString(), idx + 1);
      });

      // Extract snippets around matches (same logic as web search)
      const formattedMatches = matchedMessages.map((m) => {
        const content = m.content || "";
        const lowerContent = content.toLowerCase();

        // Find best position to show snippet around
        let bestIdx = -1;
        for (const term of terms.all) {
          const idx = lowerContent.indexOf(term);
          if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
            bestIdx = idx;
          }
        }

        // Extract ~300 char snippet around match
        const start = Math.max(0, bestIdx > -1 ? bestIdx - 80 : 0);
        const end = Math.min(content.length, bestIdx > -1 ? bestIdx + 220 : 300);
        let snippet = content.slice(start, end);
        if (start > 0) snippet = "..." + snippet;
        if (end < content.length) snippet = snippet + "...";

        return {
          line: messageIdToLine.get(m._id.toString()) || 0,
          role: m.role,
          content: snippet,
          timestamp: new Date(m.timestamp).toISOString(),
          tool_calls_count: m.tool_calls?.length,
          tool_results_count: m.tool_results?.length,
        };
      });

      // Sort matches by line number (chronological order)
      formattedMatches.sort((a, b) => a.line - b.line);

      const proximityScore = calculateProximityScore(messages, terms);

      const owner = teamUserMap.get(conv.user_id.toString()) || (conv.user_id.toString() === authUserId.toString() ? user : null);
      const isOwnConv = conv.user_id.toString() === authUserId.toString();

      results.push({
        id: conv.short_id || conv._id.toString().slice(0, 7),
        title,
        project_path: conv.project_path || null,
        updated_at: new Date(conv.updated_at).toISOString(),
        message_count: conv.message_count || 0,
        proximityScore,
        user: !isOwnConv && owner ? { name: owner.name || null, email: owner.email || null } : undefined,
        matches: formattedMatches,
        context: [],
      });
    }

    // Sort by proximity first (lower = better), then by recency
    results.sort((a, b) => {
      if (a.proximityScore !== b.proximityScore) {
        return a.proximityScore - b.proximityScore;
      }
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

    return {
      total_matches: totalMatches,
      conversations: results.slice(0, limit),
      search_scope: projectPath || "global",
    };
  },
});

export const readConversationMessages = query({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
    start_line: v.optional(v.number()),
    end_line: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(authUserId);
    if (!user) {
      return { error: "User not found" };
    }

    let conv = null;

    try {
      conv = await ctx.db.get(args.conversation_id as Id<"conversations">);
    } catch {
      // ID format invalid, try prefix search
    }

    if (!conv) {
      // Try indexed short_id lookup (O(1) instead of iterating)
      conv = await ctx.db
        .query("conversations")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.conversation_id))
        .first();
    }

    if (!conv) {
      return { error: "Conversation not found" };
    }

    // Check access - user can see their own conversations, or non-private
    // conversations from team members
    const isOwn = conv.user_id.toString() === authUserId.toString();
    if (!isOwn) {
      if (!(await canTeamMemberAccess(ctx, authUserId, conv))) {
        return { error: "Access denied" };
      }
    }

    const firstMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .order("asc")
      .take(10);

    let firstUserMessage = "";
    for (const msg of firstMessages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conv.title
      || firstUserMessage
      || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
      || "New Session";

    // Get all messages and filter out empty ones (streaming artifacts)
    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .order("asc")
      .collect();

    const nonEmptyMessages = allMessages.filter(isNonEmptyMessage);

    const nonEmptyCount = nonEmptyMessages.length;
    const startLine = args.start_line ?? 1;
    const endLine = args.end_line ?? Math.min(nonEmptyCount, 20);

    const startIdx = Math.max(0, startLine - 1);
    const count = Math.min(endLine - startLine + 1, 50);

    const slicedMessages = nonEmptyMessages.slice(startIdx, startIdx + count);

    const messages = slicedMessages.map((m, idx) => {
      const truncateToolCalls = (calls: typeof m.tool_calls) => {
        if (!calls) return undefined;
        return calls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input && tc.input.length > 500 ? tc.input.slice(0, 500) + "..." : tc.input,
        }));
      };

      const truncateToolResults = (results: typeof m.tool_results) => {
        if (!results) return undefined;
        return results.map((tr) => ({
          tool_use_id: tr.tool_use_id,
          content: tr.content && tr.content.length > 1000 ? tr.content.slice(0, 1000) + "..." : tr.content,
          is_error: tr.is_error,
        }));
      };

      return {
        line: startIdx + idx + 1,
        role: m.role,
        content: m.content || "",
        timestamp: new Date(m.timestamp).toISOString(),
        tool_calls: truncateToolCalls(m.tool_calls),
        tool_results: truncateToolResults(m.tool_results),
      };
    });

    return {
      conversation: {
        id: conv._id,
        title,
        project_path: conv.project_path || null,
        message_count: nonEmptyCount,
        updated_at: new Date(conv.updated_at).toISOString(),
      },
      messages,
    };
  },
});

export const exportConversationMessages = query({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(authUserId);
    if (!user) {
      return { error: "User not found" };
    }

    let conv = null;
    try {
      conv = await ctx.db.get(args.conversation_id as Id<"conversations">);
    } catch {
      // ID format invalid, try prefix search
    }
    if (!conv) {
      conv = await ctx.db
        .query("conversations")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.conversation_id))
        .first();
    }
    if (!conv) {
      return { error: "Conversation not found" };
    }

    const isOwn = conv.user_id.toString() === authUserId.toString();
    if (!isOwn) {
      if (!(await canTeamMemberAccess(ctx, authUserId, conv))) {
        return { error: "Access denied" };
      }
    }

    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .order("asc")
      .collect();

    const nonEmptyMessages = allMessages.filter(isNonEmptyMessage);

    return {
      conversation: {
        id: conv._id,
        title: conv.title || "New Session",
        session_id: conv.session_id,
        agent_type: conv.agent_type,
        project_path: conv.project_path || null,
        model: conv.model || null,
        message_count: nonEmptyMessages.length,
        started_at: new Date(conv.started_at).toISOString(),
        updated_at: new Date(conv.updated_at).toISOString(),
      },
      messages: nonEmptyMessages.map((m) => ({
        role: m.role,
        content: m.content || "",
        thinking: m.thinking || undefined,
        timestamp: new Date(m.timestamp).toISOString(),
        message_uuid: m.message_uuid || undefined,
        tool_calls: m.tool_calls,
        tool_results: m.tool_results,
      })),
    };
  },
});

export const exportConversationMessagesPage = query({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(authUserId);
    if (!user) {
      return { error: "User not found" };
    }

    let conv = null;
    try {
      conv = await ctx.db.get(args.conversation_id as Id<"conversations">);
    } catch {
    }
    if (!conv) {
      conv = await ctx.db
        .query("conversations")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.conversation_id))
        .first();
    }
    if (!conv) {
      return { error: "Conversation not found" };
    }

    const isOwn = conv.user_id.toString() === authUserId.toString();
    if (!isOwn) {
      if (!(await canTeamMemberAccess(ctx, authUserId, conv))) {
        return { error: "Access denied" };
      }
    }

    const pageSize = Math.max(1, Math.min(args.limit ?? 500, 1000));
    const page = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .order("asc")
      .paginate({ cursor: args.cursor ?? null, numItems: pageSize });

    const messages = page.page
      .filter(isNonEmptyMessage)
      .map((m) => ({
        role: m.role,
        content: m.content || "",
        thinking: m.thinking || undefined,
        timestamp: new Date(m.timestamp).toISOString(),
        message_uuid: m.message_uuid || undefined,
        tool_calls: m.tool_calls,
        tool_results: m.tool_results,
      }));

    return {
      conversation: {
        id: conv._id,
        title: conv.title || "New Session",
        session_id: conv.session_id,
        agent_type: conv.agent_type,
        project_path: conv.project_path || null,
        model: conv.model || null,
        message_count: conv.message_count || 0,
        started_at: new Date(conv.started_at).toISOString(),
        updated_at: new Date(conv.updated_at).toISOString(),
      },
      messages,
      next_cursor: page.isDone ? null : page.continueCursor,
      done: page.isDone,
    };
  },
});

export const updateTitle = mutation({
  args: {
    conversation_id: v.id("conversations"),
    title: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const isOwner = conversation.user_id.toString() === authUserId.toString();
    let hasTeamAccess = false;
    if (!isOwner && conversation.team_id) {
      hasTeamAccess = await isTeamMember(ctx, authUserId, conversation.team_id);
    }

    if (!isOwner && !hasTeamAccess) {
      throw new Error("Unauthorized: can only update your own conversations");
    }

    await ctx.db.patch(args.conversation_id, {
      title: args.title,
    });

    if (args.api_token) {
      await ctx.db.patch(conversation.user_id, {
        daemon_last_seen: Date.now(),
      });
    }
  },
});

export const updateProjectPath = mutation({
  args: {
    session_id: v.string(),
    project_path: v.string(),
    git_root: v.optional(v.string()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed");
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    if (!conversation) {
      return { updated: false };
    }

    if (conversation.project_path === args.project_path && (!args.git_root || conversation.git_root === args.git_root)) {
      return { updated: false };
    }

    const patch: Record<string, string> = { project_path: args.project_path };
    if (args.git_root) {
      patch.git_root = args.git_root;
    }
    await ctx.db.patch(conversation._id, patch);

    return { updated: true, id: conversation._id };
  },
});

export const setSkipTitleGeneration = mutation({
  args: {
    conversation_id: v.id("conversations"),
    skip: v.boolean(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const isOwner = conversation.user_id.toString() === authUserId.toString();
    let hasTeamAccess = false;
    if (!isOwner && conversation.team_id) {
      hasTeamAccess = await isTeamMember(ctx, authUserId, conversation.team_id);
    }

    if (!isOwner && !hasTeamAccess) {
      throw new Error("Unauthorized: can only update your own conversations");
    }

    await ctx.db.patch(args.conversation_id, {
      skip_title_generation: args.skip,
    });

    if (args.api_token) {
      await ctx.db.patch(conversation.user_id, {
        daemon_last_seen: Date.now(),
      });
    }
  },
});

export const listPrivateConversations = query({
  args: {
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized: valid API token required");
    }

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .filter((q) => q.eq(q.field("is_private"), true))
      .collect();

    const result = await Promise.all(
      conversations.map(async (c) => {
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", c._id))
          .order("asc")
          .take(20);

        let firstUserMessage = "";
        for (const msg of messages) {
          const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
          if (msg.role === "user" && !hasToolResults) {
            const text = msg.content?.trim();
            if (text) {
              firstUserMessage = text.slice(0, 120);
              if (text.length > 120) firstUserMessage += "...";
              break;
            }
          }
        }

        const title = c.title
          || firstUserMessage
          || (c.slug ? formatSlugAsTitle(c.slug) : null)
          || "New Session";

        return {
          conversation_id: c._id,
          session_id: c.session_id,
          title,
          agent_type: c.agent_type,
          started_at: c.started_at,
          updated_at: c.updated_at,
          message_count: c.message_count,
          project_path: c.project_path,
        };
      })
    );

    return result.sort((a, b) => b.updated_at - a.updated_at);
  },
});

export const publishToDirectory = mutation({
  args: {
    conversation_id: v.id("conversations"),
    title: v.string(),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      throw new Error("Unauthorized: can only publish your own conversations");
    }

    if (!conversation.share_token) {
      throw new Error("Conversation must be shared before publishing to directory");
    }

    const existingPublic = await ctx.db
      .query("public_conversations")
      .filter((q) => q.eq(q.field("conversation_id"), args.conversation_id))
      .first();

    if (existingPublic) {
      await ctx.db.patch(existingPublic._id, {
        title: args.title,
        description: args.description,
        tags: args.tags,
      });
      return existingPublic._id;
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .order("asc")
      .take(10);

    let previewText = "";
    for (const msg of messages) {
      if (msg.role === "user" && msg.content) {
        const text = msg.content.trim();
        if (text) {
          previewText = text.slice(0, 200);
          break;
        }
      }
    }

    if (!previewText) {
      previewText = "No preview available";
    }

    const publicConversationId = await ctx.db.insert("public_conversations", {
      conversation_id: args.conversation_id,
      user_id: conversation.user_id,
      title: args.title,
      description: args.description,
      tags: args.tags,
      preview_text: previewText,
      agent_type: conversation.agent_type,
      message_count: conversation.message_count,
      created_at: Date.now(),
      view_count: 0,
    });

    return publicConversationId;
  },
});

export const listPublicConversations = query({
  args: {
    search: v.optional(v.string()),
    sort: v.optional(v.union(v.literal("recent"), v.literal("popular"))),
    agent_type: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const sort = args.sort ?? "recent";

    let publicConversations = await ctx.db
      .query("public_conversations")
      .collect();

    if (args.agent_type) {
      publicConversations = publicConversations.filter(
        (pc) => pc.agent_type === args.agent_type
      );
    }

    if (args.search && args.search.trim().length > 0) {
      const searchLower = args.search.toLowerCase();
      publicConversations = publicConversations.filter((pc) => {
        const titleMatch = pc.title.toLowerCase().includes(searchLower);
        const descMatch = pc.description?.toLowerCase().includes(searchLower);
        const previewMatch = pc.preview_text.toLowerCase().includes(searchLower);
        return titleMatch || descMatch || previewMatch;
      });
    }

    if (sort === "popular") {
      publicConversations.sort((a, b) => b.view_count - a.view_count);
    } else {
      publicConversations.sort((a, b) => b.created_at - a.created_at);
    }

    const results = await Promise.all(
      publicConversations.slice(0, limit).map(async (pc) => {
        const user = await ctx.db.get(pc.user_id);
        const conversation = await ctx.db.get(pc.conversation_id);

        return {
          _id: pc._id,
          title: pc.title,
          description: pc.description,
          tags: pc.tags,
          preview_text: pc.preview_text,
          agent_type: pc.agent_type,
          message_count: pc.message_count,
          created_at: pc.created_at,
          view_count: pc.view_count,
          author_name: user?.name || user?.email?.split("@")[0] || "Unknown",
          author_avatar: user?.image || user?.github_avatar_url,
          share_token: conversation?.share_token || null,
        };
      })
    );

    return results;
  },
});

export const forkConversation = mutation({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in to fork conversations");
    }

    const originalConversations = await ctx.db
      .query("conversations")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .collect();

    if (originalConversations.length === 0) {
      throw new Error("Conversation not found");
    }

    const original = originalConversations[0];

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", original._id))
      .collect();

    const now = Date.now();
    const newConversationId = await ctx.db.insert("conversations", {
      user_id: authUserId,
      team_id: original.team_id,
      agent_type: original.agent_type,
      session_id: `forked-${original.session_id}-${crypto.randomUUID()}`,
      slug: original.slug,
      title: original.title,
      subtitle: original.subtitle,
      project_hash: original.project_hash,
      project_path: original.project_path,
      model: original.model,
      started_at: now,
      updated_at: now,
      message_count: messages.length,
      is_private: true,
      status: "completed",
      forked_from: original._id,
    });
    // Set short_id for O(1) lookup
    await ctx.db.patch(newConversationId, {
      short_id: newConversationId.toString().slice(0, 7),
    });

    for (const msg of messages) {
      await ctx.db.insert("messages", {
        conversation_id: newConversationId,
        message_uuid: msg.message_uuid,
        role: msg.role,
        content: msg.content,
        thinking: msg.thinking,
        tool_calls: msg.tool_calls,
        tool_results: msg.tool_results,
        images: msg.images,
        subtype: msg.subtype,
        timestamp: msg.timestamp,
        tokens_used: msg.tokens_used,
        usage: msg.usage,
      });
    }

    const currentForkCount = original.fork_count ?? 0;
    await ctx.db.patch(original._id, {
      fork_count: currentForkCount + 1,
    });

    return newConversationId;
  },
});

export const forkFromMessage = mutation({
  args: {
    conversation_id: v.string(),
    message_uuid: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) {
      throw new Error("Unauthorized");
    }

    let original = null;
    try {
      original = await ctx.db.get(args.conversation_id as Id<"conversations">);
    } catch {
      // not a valid Convex ID, try short_id
    }
    if (!original) {
      original = await ctx.db
        .query("conversations")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.conversation_id))
        .first();
    }
    if (!original) {
      throw new Error("Conversation not found");
    }

    const isOwner = original.user_id.toString() === userId.toString();
    if (!isOwner) {
      if (!(await canTeamMemberAccess(ctx, userId, original))) {
        throw new Error("Access denied");
      }
    }

    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", original!._id)
      )
      .order("asc")
      .collect();

    let messagesToCopy = allMessages;
    if (args.message_uuid) {
      const forkIndex = allMessages.findIndex((m) => m.message_uuid === args.message_uuid);
      if (forkIndex === -1) {
        throw new Error("Fork point message not found");
      }
      messagesToCopy = allMessages.slice(0, forkIndex + 1);
    }

    const now = Date.now();
    const newConversationId = await ctx.db.insert("conversations", {
      user_id: userId,
      team_id: original.team_id,
      agent_type: original.agent_type,
      session_id: `forked-${original.session_id}-${crypto.randomUUID()}`,
      slug: original.slug,
      title: original.title ? `Fork: ${original.title}` : undefined,
      subtitle: original.subtitle,
      project_hash: original.project_hash,
      project_path: original.project_path,
      model: original.model,
      started_at: now,
      updated_at: now,
      message_count: messagesToCopy.length,
      is_private: true,
      status: "completed",
      forked_from: original._id,
      parent_message_uuid: args.message_uuid,
    });

    await ctx.db.patch(newConversationId, {
      short_id: newConversationId.toString().slice(0, 7),
    });

    for (const msg of messagesToCopy) {
      await ctx.db.insert("messages", {
        conversation_id: newConversationId,
        message_uuid: msg.message_uuid,
        role: msg.role,
        content: msg.content,
        thinking: msg.thinking,
        tool_calls: msg.tool_calls,
        tool_results: msg.tool_results,
        images: msg.images,
        subtype: msg.subtype,
        timestamp: msg.timestamp,
        tokens_used: msg.tokens_used,
        usage: msg.usage,
      });
    }

    const currentForkCount = original.fork_count ?? 0;
    await ctx.db.patch(original._id, {
      fork_count: currentForkCount + 1,
    });

    return {
      conversation_id: newConversationId,
      short_id: newConversationId.toString().slice(0, 7),
    };
  },
});

export const getConversationTree = query({
  args: {
    conversation_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!userId) {
      return { error: "Unauthorized" };
    }

    let conv = null;
    try {
      conv = await ctx.db.get(args.conversation_id as Id<"conversations">);
    } catch {
      // try short_id
    }
    if (!conv) {
      conv = await ctx.db
        .query("conversations")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.conversation_id))
        .first();
    }
    if (!conv) {
      return { error: "Conversation not found" };
    }

    const isOwner = conv.user_id.toString() === userId.toString();
    if (!isOwner) {
      if (!(await canTeamMemberAccess(ctx, userId, conv))) {
        return { error: "Access denied" };
      }
    }

    // Walk up to find root
    let root = conv;
    const visited = new Set<string>([root._id.toString()]);
    while (root.forked_from) {
      const parent = await ctx.db.get(root.forked_from);
      if (!parent || visited.has(parent._id.toString())) break;
      visited.add(parent._id.toString());
      root = parent;
    }

    // Recursively build tree from root
    type TreeNode = {
      id: string;
      short_id?: string;
      title: string;
      message_count: number;
      parent_message_uuid?: string;
      started_at: number;
      status: string;
      is_current: boolean;
      children: TreeNode[];
    };

    const buildTree = async (node: typeof root): Promise<TreeNode> => {
      const children = await ctx.db
        .query("conversations")
        .withIndex("by_forked_from", (q) => q.eq("forked_from", node._id))
        .collect();

      const childTrees = await Promise.all(children.map((c) => buildTree(c)));

      return {
        id: node._id.toString(),
        short_id: node.short_id,
        title: node.title || "New Session",
        message_count: node.message_count,
        parent_message_uuid: node.parent_message_uuid,
        started_at: node.started_at,
        status: node.status,
        is_current: node._id.toString() === conv!._id.toString(),
        children: childTrees,
      };
    };

    const tree = await buildTree(root);
    return { tree };
  },
});

export const getForkBranchMessages = query({
  args: {
    conversation_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!userId) {
      return { error: "Unauthorized" };
    }

    let conv = null;
    try {
      conv = await ctx.db.get(args.conversation_id as Id<"conversations">);
    } catch {
      // try short_id
    }
    if (!conv) {
      conv = await ctx.db
        .query("conversations")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.conversation_id))
        .first();
    }
    if (!conv) {
      return { error: "Conversation not found" };
    }

    const isOwner = conv.user_id.toString() === userId.toString();
    if (!isOwner) {
      if (!(await canTeamMemberAccess(ctx, userId, conv))) {
        return { error: "Access denied" };
      }
    }

    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", conv!._id)
      )
      .order("asc")
      .collect();

    if (!conv.parent_message_uuid) {
      return { messages: allMessages, fork_point_uuid: null };
    }

    const forkPointIdx = allMessages.findIndex(
      (m) => m.message_uuid === conv!.parent_message_uuid
    );

    if (forkPointIdx === -1) {
      return { messages: allMessages, fork_point_uuid: conv.parent_message_uuid };
    }

    const divergentMessages = allMessages.slice(forkPointIdx + 1);
    return {
      messages: divergentMessages,
      fork_point_uuid: conv.parent_message_uuid,
    };
  },
});

export const toggleFavorite = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Can only favorite your own conversations");
    }

    const newValue = !conversation.is_favorite;
    await ctx.db.patch(args.conversation_id, {
      is_favorite: newValue,
    });

    return newValue;
  },
});

export const listFavorites = query({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return [];
    }

    const favorites = await ctx.db
      .query("conversations")
      .withIndex("by_user_favorite", (q) =>
        q.eq("user_id", authUserId).eq("is_favorite", true)
      )
      .collect();

    return favorites
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((conv) => ({
        _id: conv._id,
        title: conv.title,
        session_id: conv.session_id,
        updated_at: conv.updated_at,
        message_count: conv.message_count,
        agent_type: conv.agent_type,
        is_favorite: conv.is_favorite,
      }));
  },
});

export const getMessageFeed = query({
  args: {
    filter: v.union(v.literal("my"), v.literal("team")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { messages: [], nextCursor: null };
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return { messages: [], nextCursor: null };
    }

    const limit = args.limit ?? 30;

    // Cache for conversation access and info
    const conversationCache = new Map<string, {
      hasAccess: boolean;
      title: string;
      session_id: string;
      author_name: string;
      is_own: boolean;
    } | null>();

    const checkConversationAccess = async (convId: Id<"conversations">) => {
      const cached = conversationCache.get(convId);
      if (cached !== undefined) return cached;

      const conv = await ctx.db.get(convId);
      if (!conv) {
        conversationCache.set(convId, null);
        return null;
      }

      const isOwn = conv.user_id.toString() === userId.toString();
      let hasAccess = false;

      if (args.filter === "my") {
        hasAccess = isOwn;
      } else {
        hasAccess = await canTeamMemberAccess(ctx, userId, conv);
      }

      if (!hasAccess) {
        conversationCache.set(convId, null);
        return null;
      }

      const convUser = await ctx.db.get(conv.user_id);
      const info = {
        hasAccess: true,
        title: conv.title || (conv.slug ? formatSlugAsTitle(conv.slug) : "New Session"),
        session_id: conv.session_id,
        author_name: convUser?.name || convUser?.email?.split("@")[0] || "Unknown",
        is_own: isOwn,
      };
      conversationCache.set(convId, info);
      return info;
    };

    // Filter messages by access and content - fetch in batches if needed
    const filteredMessages: Array<{
      _id: string;
      conversation_id: string;
      role: string;
      content: string | undefined;
      timestamp: number;
      has_tool_calls: boolean;
      has_tool_results: boolean;
      convInfo: NonNullable<Awaited<ReturnType<typeof checkConversationAccess>>>;
    }> = [];

    let currentCursor = args.cursor;
    let attempts = 0;
    const maxAttempts = 10; // Limit iterations to avoid timeout

    while (filteredMessages.length < limit + 1 && attempts < maxAttempts) {
      attempts++;

      // Query messages using timestamp index
      let msgQuery = ctx.db
        .query("messages")
        .withIndex("by_timestamp");

      if (currentCursor !== undefined) {
        const cursor = currentCursor;
        msgQuery = msgQuery.filter((q) => q.lt(q.field("timestamp"), cursor));
      }

      const rawMessages = await msgQuery.order("desc").take(200);

      if (rawMessages.length === 0) break; // No more messages

      for (const msg of rawMessages) {
        if (filteredMessages.length >= limit + 1) break;

        // Only user/assistant messages
        if (msg.role !== "user" && msg.role !== "assistant") continue;

        // Skip messages with no meaningful content
        const hasContent = msg.content && msg.content.trim().length > 10;
        if (!hasContent) continue;

        const convInfo = await checkConversationAccess(msg.conversation_id);
        if (!convInfo) continue;

        filteredMessages.push({
          _id: msg._id,
          conversation_id: msg.conversation_id,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          has_tool_calls: (msg.tool_calls && msg.tool_calls.length > 0) || false,
          has_tool_results: (msg.tool_results && msg.tool_results.length > 0) || false,
          convInfo,
        });
      }

      // Update cursor for next batch
      if (rawMessages.length > 0) {
        currentCursor = rawMessages[rawMessages.length - 1].timestamp;
      }
    }

    const hasMore = filteredMessages.length > limit;
    const finalMessages = hasMore ? filteredMessages.slice(0, limit) : filteredMessages;

    const messagesWithConversation = finalMessages.map((msg) => ({
      _id: msg._id,
      conversation_id: msg.conversation_id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      has_tool_calls: msg.has_tool_calls,
      has_tool_results: msg.has_tool_results,
      conversation_title: msg.convInfo.title,
      conversation_session_id: msg.convInfo.session_id,
      author_name: msg.convInfo.author_name,
      is_own: msg.convInfo.is_own,
    }));

    const nextCursor = hasMore ? finalMessages[finalMessages.length - 1].timestamp : null;

    return {
      messages: messagesWithConversation,
      nextCursor,
    };
  },
});

export const clearParentMessageUuid = mutation({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Can only modify your own conversations");
    }
    await ctx.db.patch(args.conversation_id, {
      parent_message_uuid: undefined,
    });
    return true;
  },
});

export const feedForCLI = query({
  args: {
    api_token: v.string(),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    start_time: v.optional(v.number()),
    end_time: v.optional(v.number()),
    query: v.optional(v.string()),
    project_path: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    member_name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(authUserId);
    if (!user) {
      return { error: "User not found" };
    }

    const limit = args.limit ?? 10;
    const offset = args.offset ?? 0;
    const projectPath = args.project_path;
    const startTime = args.start_time;
    const endTime = args.end_time ?? Date.now();
    const query = args.query?.trim();

    const userMemberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .collect();
    const userTeamIds = userMemberships.map(m => m.team_id);

    let resolvedTeamId: Id<"teams"> | undefined;
    if (args.team_id) {
      resolvedTeamId = args.team_id;
    } else if (args.project_path) {
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
        .collect();
      let bestMatch: { teamId: Id<"teams">; pathLength: number } | null = null;
      for (const mapping of mappings) {
        if (args.project_path === mapping.path_prefix || args.project_path.startsWith(mapping.path_prefix + "/")) {
          if (!bestMatch || mapping.path_prefix.length > bestMatch.pathLength) {
            bestMatch = { teamId: mapping.team_id, pathLength: mapping.path_prefix.length };
          }
        }
      }
      resolvedTeamId = bestMatch?.teamId;
    }
    const effectiveTeamIds = resolvedTeamId ? [resolvedTeamId] : userTeamIds;

    type UserDoc = NonNullable<Awaited<ReturnType<typeof ctx.db.get<"users">>>>;
    const allTeamUsers: UserDoc[] = [];
    const memberVisibilityMap = new Map<string, string>();
    for (const teamId of effectiveTeamIds) {
      const teamMemberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
        .collect();
      for (const m of teamMemberships) {
        memberVisibilityMap.set(m.user_id.toString(), m.visibility || "summary");
      }
      const memberUsers = await Promise.all(
        teamMemberships.map(m => ctx.db.get(m.user_id))
      );
      allTeamUsers.push(...memberUsers.filter((u): u is UserDoc => u !== null));
    }
    const teamUsers = [...new Map(allTeamUsers.map(u => [u._id.toString(), u])).values()];
    const teamUserMap = new Map(teamUsers.map(u => [u._id.toString(), u]));
    const effectiveTeamIdSet = new Set(effectiveTeamIds.map(id => id.toString()));

    const isTeamConversationVisible = (c: { is_private: boolean; team_visibility?: string; user_id: Id<"users">; team_id?: Id<"teams"> }) => {
      if (c.is_private === false) return true;
      if (c.team_visibility && c.team_visibility !== "private") return true;
      const ownerVis = memberVisibilityMap.get(c.user_id.toString()) || "summary";
      return ownerVis !== "hidden" && ownerVis !== "activity";
    };

    let filterUserId: string | null = null;
    if (args.member_name) {
      const memberNameLower = args.member_name.toLowerCase();
      const matchingMember = teamUsers.find(u => {
        const name = u.name?.toLowerCase() || "";
        const email = u.email?.toLowerCase() || "";
        return name.includes(memberNameLower) || email.includes(memberNameLower);
      });
      if (!matchingMember) {
        return { error: `No team member found matching "${args.member_name}"` };
      }
      filterUserId = matchingMember._id.toString();
    }

    let matchingConvIds: Set<string> | null = null;
    let queryMatchedOwnConversations: typeof ownConversations = [];
    let queryMatchedTeamConversations: typeof ownConversations = [];
    if (query && query.length >= 2) {
      // Search for each term separately to ensure we get results for all terms
      const terms = parseSearchTerms(query);
      const allSearchResults = new Map<string, any>();
      for (const term of terms.all) {
        const results = await ctx.db
          .query("messages")
          .withSearchIndex("search_content", (q) => q.search("content", term))
          .take(200);
        for (const msg of results) {
          const msgId = msg._id.toString();
          if (!allSearchResults.has(msgId)) {
            allSearchResults.set(msgId, msg);
          }
        }
      }
      const searchResults = Array.from(allSearchResults.values());

      // Group messages by conversation and filter to those matching ALL terms
      const conversationMessages = new Map<string, typeof searchResults>();
      for (const msg of searchResults) {
        const convId = msg.conversation_id.toString();
        if (!conversationMessages.has(convId)) {
          conversationMessages.set(convId, []);
        }
        conversationMessages.get(convId)!.push(msg);
      }

      // Only include conversations where ALL terms appear across messages
      for (const [convId, messages] of conversationMessages) {
        if (!conversationMatchesAllTerms(messages, terms)) {
          conversationMessages.delete(convId);
        }
      }

      matchingConvIds = new Set(conversationMessages.keys());

      const matchedConvs = await Promise.all(
        Array.from(matchingConvIds).slice(0, 25).map(async (convId) => {
          try {
            return await ctx.db.get(convId as Id<"conversations">);
          } catch {
            return null;
          }
        })
      );
      const validConvs = matchedConvs.filter((c): c is NonNullable<typeof c> => c !== null);

      // Filter own conversations by project path if specified
      queryMatchedOwnConversations = validConvs.filter(c => {
        if (c.user_id.toString() !== authUserId.toString()) return false;

        // Apply project path filter for own conversations
        if (projectPath) {
          const convPath = c.project_path || "";
          const convGitRoot = c.git_root || "";
          const isPathMatch = convPath === projectPath ||
            (convPath && convPath.startsWith(projectPath + "/")) ||
            convGitRoot === projectPath ||
            (convGitRoot && convGitRoot.startsWith(projectPath + "/"));
          if (!isPathMatch) return false;
        }

        return true;
      });

      const teamUserIdSet = new Set(teamUsers.filter(u => u._id.toString() !== authUserId.toString()).map(u => u._id.toString()));
      queryMatchedTeamConversations = validConvs.filter(c =>
        teamUserIdSet.has(c.user_id.toString()) &&
        isTeamConversationVisible(c) &&
        c.team_id != null && effectiveTeamIdSet.has(c.team_id.toString())
      );
    }

    const fetchLimit = query
      ? Math.min(offset + limit + 20, 100)
      : projectPath ? 200 : Math.min(offset + limit + 50, 200);
    let ownConversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) => q.eq("user_id", authUserId))
      .order("desc")
      .take(fetchLimit);

    // Merge in query-matched conversations that might be older
    if (queryMatchedOwnConversations.length > 0) {
      const existingIds = new Set(ownConversations.map(c => c._id.toString()));
      const additionalConvs = queryMatchedOwnConversations.filter(c => !existingIds.has(c._id.toString()));
      ownConversations = [...ownConversations, ...additionalConvs];
    }

    // Include non-private team conversations whose team_id matches effective teams
    let teamConversations: typeof ownConversations = [];
    if (effectiveTeamIds.length > 0) {
      const visibleTeamMembers = teamUsers.filter(u =>
        u._id.toString() !== authUserId.toString() &&
        (u.activity_visibility || "detailed") !== "hidden"
      );

      const teamMemberConvos = await Promise.all(
        visibleTeamMembers.map(async (member) => {
          const convos = await ctx.db
            .query("conversations")
            .withIndex("by_user_updated", (q) => q.eq("user_id", member._id))
            .order("desc")
            .take(10);
          return convos.filter(c =>
            isTeamConversationVisible(c) &&
            c.team_id != null && effectiveTeamIdSet.has(c.team_id.toString())
          );
        })
      );

      teamConversations = teamMemberConvos.flat();

      // Merge in query-matched team conversations that might be older than top-20
      if (queryMatchedTeamConversations.length > 0) {
        const existingTeamIds = new Set(teamConversations.map(c => c._id.toString()));
        const additionalTeam = queryMatchedTeamConversations.filter(c => !existingTeamIds.has(c._id.toString()));
        teamConversations = [...teamConversations, ...additionalTeam];
      }
    }

    const isOwnConversation = (c: typeof ownConversations[number]) => c.user_id.toString() === authUserId.toString();

    const allConversations = [...ownConversations, ...teamConversations]
      .filter((c): c is typeof ownConversations[number] => {
        if (filterUserId && c.user_id.toString() !== filterUserId) return false;

        // Path filter: when in a specific project, filter to same git repository
        if (projectPath && !filterUserId) {
          const convPath = c.project_path || "";
          const convGitRoot = c.git_root || "";

          if (isOwnConversation(c)) {
            // Own conversations: match full path or git root
            const isPathMatch = convPath === projectPath ||
              (convPath && convPath.startsWith(projectPath + "/")) ||
              convGitRoot === projectPath ||
              (convGitRoot && convGitRoot.startsWith(projectPath + "/"));
            if (!isPathMatch) return false;
          } else {
            // Team conversations: filter to same git repo (different home dirs, but same repo name)
            // Extract repo name from paths like ~/src/codecast or /Users/jason/code/union-mobile/outreach
            const getRepoName = (path: string) => {
              const parts = path.split("/");
              // Find the last meaningful directory (not ~ or empty)
              for (let i = parts.length - 1; i >= 0; i--) {
                if (parts[i] && parts[i] !== "~" && !parts[i].startsWith(".")) {
                  return parts[i];
                }
              }
              return "";
            };

            const projectRepo = getRepoName(projectPath);
            const convRepo = getRepoName(convGitRoot || convPath);

            if (!projectRepo || !convRepo || projectRepo !== convRepo) {
              return false;
            }
          }
        }
        if (startTime && c.updated_at < startTime) return false;
        if (endTime && c.updated_at > endTime) return false;
        if (matchingConvIds && !matchingConvIds.has(c._id.toString())) {
          // Also match on conversation title/subtitle
          const titleText = [c.title, c.subtitle].filter(Boolean).join(" ").toLowerCase();
          const queryLower = query?.toLowerCase() || "";
          const queryTerms = queryLower.split(/\s+/).filter(w => w.length > 1);
          const titleMatch = queryTerms.length > 0 && queryTerms.every(w => titleText.includes(w));
          if (!titleMatch) return false;
        }
        return true;
      })
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(offset, offset + Math.min(limit, 100));

    const results: Array<{
      id: string;
      session_id: string;
      title: string;
      subtitle: string | null;
      project_path: string | null;
      updated_at: string;
      message_count: number;
      agent_type?: string;
      user?: { name: string | null; email: string | null };
      preview: Array<{
        line: number;
        role: string;
        content: string;
        tool_calls_count?: number;
        tool_results_count?: number;
      }>;
    }> = [];

    // Only load messages for conversations in the final result set
    for (const conv of allConversations) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .order("asc")
        .take(6);

      let firstUserMessage = "";
      for (const msg of messages) {
        const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
        if (msg.role === "user" && !hasToolResults) {
          const text = msg.content?.trim();
          if (text) {
            firstUserMessage = text.slice(0, 120);
            if (text.length > 120) firstUserMessage += "...";
            break;
          }
        }
      }

      const title = conv.title
        || firstUserMessage
        || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
        || "New Session";

      const preview: Array<{
        line: number;
        role: string;
        content: string;
        tool_calls_count?: number;
        tool_results_count?: number;
      }> = [];

      let lineNum = 0;
      for (const msg of messages) {
        lineNum++;
        if (msg.role === "user") {
          const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
          if (!hasToolResults && msg.content?.trim()) {
            let content = msg.content.trim();
            if (content.length > 200) content = content.slice(0, 200) + "...";
            preview.push({
              line: lineNum,
              role: "user",
              content,
            });
          }
        } else if (msg.role === "assistant" && preview.length > 0) {
          let content = msg.content?.trim() || "";
          if (!content) continue;
          if (content.length > 60) content = content.slice(0, 60) + "...";
          preview.push({
            line: lineNum,
            role: "assistant",
            content,
            tool_calls_count: msg.tool_calls?.length,
            tool_results_count: msg.tool_results?.length,
          });
          if (preview.length >= 6) break;
        }
      }

      const owner = teamUserMap.get(conv.user_id.toString()) || (conv.user_id.toString() === authUserId.toString() ? user : null);
      const isOwnConv = conv.user_id.toString() === authUserId.toString();

      results.push({
        id: conv._id,
        session_id: conv.session_id,
        title,
        subtitle: conv.subtitle || null,
        project_path: conv.project_path || null,
        updated_at: new Date(conv.updated_at).toISOString(),
        message_count: conv.message_count || 0,
        agent_type: conv.agent_type,
        user: !isOwnConv && owner ? { name: owner.name || null, email: owner.email || null } : undefined,
        preview: preview.slice(0, 4),
      });
    }

    return {
      conversations: results,
      scope: projectPath || "global",
    };
  },
});

export const listProjectHashes = query({
  args: { api_token: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) throw new Error("Not authenticated");

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .take(args.limit || 100);

    const hashes = new Map<string, { count: number; sample_title: string | null }>();
    for (const conv of conversations) {
      const hash = conv.project_hash || "__no_project__";
      const existing = hashes.get(hash);
      if (existing) {
        existing.count++;
      } else {
        hashes.set(hash, { count: 1, sample_title: conv.title || null });
      }
    }

    return Array.from(hashes.entries())
      .map(([hash, data]) => ({ hash, count: data.count, sample_title: data.sample_title }))
      .sort((a, b) => b.count - a.count);
  },
});

export const deleteByProjectHash = mutation({
  args: { project_hash: v.string(), api_token: v.optional(v.string()), conv_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) throw new Error("Not authenticated");

    let convId: Id<"conversations"> | null = null;
    if (args.conv_id) {
      convId = args.conv_id as Id<"conversations">;
    } else {
      const convs = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
        .take(100);
      const conv = convs.find(c => c.project_hash === args.project_hash);
      if (!conv) return { deleted: 0, hasMore: false, conv_id: null };
      convId = conv._id;
    }

    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", convId))
      .take(50);

    for (const m of msgs) await ctx.db.delete(m._id);

    const hasMoreMsgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", convId))
      .first();

    if (!hasMoreMsgs) {
      await ctx.db.delete(convId);
      return { deleted: 1, hasMore: false, conv_id: null };
    }
    return { deleted: 0, hasMore: true, conv_id: convId };
  },
});

export const getMessageCountsForReconciliation = query({
  args: {
    session_ids: v.array(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const results: Array<{
      session_id: string;
      conversation_id: string;
      message_count: number;
      updated_at: number;
    }> = [];

    for (const sessionId of args.session_ids.slice(0, 100)) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", sessionId))
        .first();

      if (conv && conv.user_id.toString() === authUserId.toString()) {
        results.push({
          session_id: sessionId,
          conversation_id: conv._id,
          message_count: conv.message_count || 0,
          updated_at: conv.updated_at || conv._creationTime,
        });
      }
    }

    return results;
  },
});

export const getTeamUnreadCount = query({
  args: {
    teamId: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return 0;
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return 0;
    }

    const effectiveTeamId = args.teamId || user.active_team_id;
    if (!effectiveTeamId) {
      return 0;
    }

    // Get all directory mappings for this team to filter by project visibility
    const teamMappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_team_id", (q) => q.eq("team_id", effectiveTeamId))
      .collect();

    // Track which users have configured mappings
    const userHasMappings = new Map<string, boolean>();
    for (const m of teamMappings) {
      userHasMappings.set(m.user_id.toString(), true);
    }

    const isProjectVisibleToTeam = (convUserId: string, projectPath: string | undefined): boolean => {
      if (!userHasMappings.get(convUserId)) {
        return true; // No mappings = show all conversations
      }
      if (!projectPath) return false;
      return teamMappings.some(
        m => m.user_id.toString() === convUserId &&
             (projectPath === m.path_prefix || projectPath.startsWith(m.path_prefix + "/"))
      );
    };

    const lastSeen = user.team_conversations_last_seen || 0;

    const recentConversations = await ctx.db
      .query("conversations")
      .withIndex("by_team_id", (q) => q.eq("team_id", effectiveTeamId))
      .order("desc")
      .take(100);

    let count = 0;
    for (const conv of recentConversations) {
      if (conv.updated_at > lastSeen && conv.user_id.toString() !== userId.toString()) {
        const projectPath = conv.git_root || conv.project_path;
        if (isProjectVisibleToTeam(conv.user_id.toString(), projectPath)) {
          count++;
        }
      }
    }

    return count;
  },
});

export const markTeamConversationsSeen = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    await ctx.db.patch(userId, {
      team_conversations_last_seen: Date.now(),
    });

    return { success: true };
  },
});

export const backfillConversationTeamIds = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 500;
    let updated = 0;

    const users = args.userId
      ? [await ctx.db.get(args.userId)].filter(Boolean)
      : await ctx.db.query("users").take(100);

    for (const user of users) {
      if (!user) continue;

      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
        .collect();

      if (mappings.length === 0) continue;

      const conversations = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
        .take(limit);

      for (const conv of conversations) {
        const projectPath = conv.git_root || conv.project_path;
        if (!projectPath) continue;

        let bestMatch: { teamId: Id<"teams">; pathLength: number; autoShare: boolean } | null = null;
        for (const mapping of mappings) {
          if (projectPath === mapping.path_prefix || projectPath.startsWith(mapping.path_prefix + "/")) {
            if (!bestMatch || mapping.path_prefix.length > bestMatch.pathLength) {
              bestMatch = {
                teamId: mapping.team_id,
                pathLength: mapping.path_prefix.length,
                autoShare: mapping.auto_share,
              };
            }
          }
        }

        if (bestMatch && conv.team_id?.toString() !== bestMatch.teamId.toString()) {
          await ctx.db.patch(conv._id, { team_id: bestMatch.teamId });
          updated++;
        }
      }
    }

    return { updated };
  },
});

// Debug function to investigate why a conversation isn't showing in team feed
export const debugConversationVisibility = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Not authenticated" };

    const user = await ctx.db.get(userId);
    if (!user) return { error: "User not found" };

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return { error: "Conversation not found" };

    const convOwner = await ctx.db.get(conversation.user_id);

    // Get the team this conversation belongs to
    const convTeam = conversation.team_id ? await ctx.db.get(conversation.team_id) : null;

    // Get the user's active team
    const userTeamId = user.team_id;
    const userTeam = userTeamId ? await ctx.db.get(userTeamId) : null;

    // Check team membership for conversation owner
    const ownerTeamMembership = convOwner && userTeamId
      ? await ctx.db
          .query("team_memberships")
          .withIndex("by_user_team", (q) => q.eq("user_id", conversation.user_id).eq("team_id", userTeamId))
          .first()
      : null;

    // Check directory mappings for the owner
    const ownerMappings = userTeamId
      ? await ctx.db
          .query("directory_team_mappings")
          .withIndex("by_user_team", (q) => q.eq("user_id", conversation.user_id).eq("team_id", userTeamId))
          .collect()
      : [];

    const projectPath = conversation.git_root || conversation.project_path;
    const isProjectMapped = ownerMappings.some(
      m => projectPath && (projectPath === m.path_prefix || projectPath.startsWith(m.path_prefix + "/"))
    );

    return {
      conversation: {
        _id: conversation._id,
        title: conversation.title,
        team_id: conversation.team_id,
        user_id: conversation.user_id,
        is_private: conversation.is_private,
        project_path: conversation.project_path,
        git_root: conversation.git_root,
      },
      convOwner: convOwner ? {
        _id: convOwner._id,
        name: convOwner.name,
        email: convOwner.email,
        team_id: convOwner.team_id,
      } : null,
      convTeam: convTeam ? { _id: convTeam._id, name: convTeam.name } : null,
      currentUser: {
        _id: user._id,
        team_id: user.team_id,
      },
      userTeam: userTeam ? { _id: userTeam._id, name: userTeam.name } : null,
      checks: {
        teamsMatch: conversation.team_id?.toString() === user.team_id?.toString(),
        ownerInTeam: !!ownerTeamMembership,
        ownerVisibility: ownerTeamMembership?.visibility || "no membership",
        ownerHasMappings: ownerMappings.length > 0,
        projectPath,
        isProjectMapped,
        wouldShowWithPermissiveDefault: ownerMappings.length === 0 || isProjectMapped,
      },
    };
  },
});

export const getConversationMeta = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }

    const user = await ctx.db.get(conversation.user_id);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .take(10);

    let firstUserMessage = "";
    for (const msg of messages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 200);
          if (text.length > 200) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "Coding Session";

    const description = conversation.subtitle
      || conversation.idle_summary
      || (conversation.title ? firstUserMessage : null)
      || `${conversation.message_count || 0} messages${user?.name ? ` by ${user.name}` : ""}${conversation.project_path ? ` in ${conversation.project_path.split("/").pop()}` : ""}`;

    return {
      title,
      description,
      author: user?.name || null,
      message_count: conversation.message_count || 0,
      project_path: conversation.project_path || null,
    };
  },
});

export const backfillAutoSharedConversations = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    dry_run: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const allMappings = await ctx.db.query("directory_team_mappings")
      .filter((q: any) => q.eq(q.field("auto_share"), true))
      .collect();

    if (allMappings.length === 0) {
      return { scanned: 0, fixed: 0, nextCursor: null, dry_run: !!args.dry_run };
    }

    const mappingsByKey = new Map<string, typeof allMappings>();
    for (const m of allMappings) {
      const key = `${m.user_id}|${m.team_id}`;
      const arr = mappingsByKey.get(key) || [];
      arr.push(m);
      mappingsByKey.set(key, arr);
    }

    const result = await ctx.db.query("conversations")
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems: 20 });

    let fixed = 0;
    for (const conv of result.page) {
      if (!conv.team_id || conv.is_private !== true || !conv.project_path) continue;

      const key = `${conv.user_id}|${conv.team_id}`;
      const userMappings = mappingsByKey.get(key);
      if (!userMappings) continue;

      const matchesMapping = userMappings.some(
        (m) => conv.project_path === m.path_prefix || conv.project_path!.startsWith(m.path_prefix + "/")
      );
      if (!matchesMapping) continue;

      if (!args.dry_run) {
        await ctx.db.patch(conv._id, { is_private: false });
      }
      fixed++;
    }

    const nextCursor = !result.isDone ? result.continueCursor : null;
    return { scanned: result.page.length, fixed, nextCursor, dry_run: !!args.dry_run };
  },
});

export const setParentConversation = mutation({
  args: {
    conversation_id: v.id("conversations"),
    parent_conversation_id: v.id("conversations"),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id !== userId) throw new Error("Not found");
    if (conv.parent_conversation_id) return;
    const isSubagent = !conv.parent_message_uuid;
    await ctx.db.patch(args.conversation_id, {
      parent_conversation_id: args.parent_conversation_id,
      is_subagent: isSubagent || undefined,
    });
  },
});

export const backfillIsSubagent = mutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const batchSize = args.limit ?? 200;
    const result = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .paginate({ numItems: batchSize, cursor: args.cursor ?? null });

    let patched = 0;
    for (const conv of result.page) {
      if (conv.is_subagent !== undefined) continue;
      if (conv.parent_conversation_id && !conv.parent_message_uuid) {
        await ctx.db.patch(conv._id, { is_subagent: true });
        patched++;
      }
    }
    const nextCursor = !result.isDone ? result.continueCursor : null;
    return { scanned: result.page.length, patched, nextCursor };
  },
});

export const backfillParentConversationIds = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.limit ?? 50;
    const result = await ctx.db.query("conversations")
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let updated = 0;
    for (const conv of result.page) {
      if (conv.parent_message_uuid && !conv.parent_conversation_id) {
        const parentMsg = await ctx.db
          .query("messages")
          .withIndex("by_message_uuid", (q) => q.eq("message_uuid", conv.parent_message_uuid!))
          .first();
        if (parentMsg) {
          await ctx.db.patch(conv._id, {
            parent_conversation_id: parentMsg.conversation_id,
          });
          updated++;
        }
      }
    }

    return {
      updated,
      nextCursor: !result.isDone ? result.continueCursor : null,
      isDone: result.isDone,
    };
  },
});

export const getConversationsBySessionIds = query({
  args: {
    api_token: v.string(),
    session_ids: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) return { error: "Unauthorized" };

    const results: Array<{
      conversation_id: string;
      session_id: string;
      title: string;
      subtitle: string | null;
      message_count: number;
      updated_at: string;
      preview: string | null;
      agent_type: string | null;
      project_path: string | null;
    }> = [];

    for (const sessionId of args.session_ids.slice(0, 100)) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", sessionId))
        .first();
      if (!conv) continue;

      let preview: string | null = null;
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .take(3);
      const firstUser = msgs.find((m) => m.role === "user" && m.content);
      if (firstUser) {
        preview = typeof firstUser.content === "string"
          ? firstUser.content.slice(0, 200)
          : null;
      }

      const title = conv.title || (preview ? preview.slice(0, 80) : "New Session");

      results.push({
        conversation_id: conv._id.toString(),
        session_id: sessionId,
        title,
        subtitle: conv.subtitle || null,
        message_count: conv.message_count ?? 0,
        updated_at: conv.updated_at
          ? new Date(conv.updated_at).toISOString()
          : new Date(conv._creationTime).toISOString(),
        preview,
        agent_type: conv.agent_type || null,
        project_path: conv.project_path || null,
      });
    }

    return { conversations: results };
  },
});

export const listIdleSessions = query({
  args: {
    show_all: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const now = Date.now();
    const HEARTBEAT_ALIVE_MS = 90 * 1000;
    const WINDOW_MS = 48 * 60 * 60 * 1000;
    const CLUSTER_WINDOW_MS = 60 * 60 * 1000;
    const cutoff = now - WINDOW_MS;

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) =>
        q.eq("user_id", userId).gte("updated_at", cutoff)
      )
      .order("desc")
      .filter((q) => q.eq(q.field("status"), "active"))
      .take(100);

    const managedSessions = await ctx.db
      .query("managed_sessions")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();

    const liveConvIds = new Set(
      managedSessions
        .filter((s) => now - s.last_heartbeat < HEARTBEAT_ALIVE_MS && s.conversation_id)
        .map((s) => s.conversation_id!.toString())
    );

    const AGENT_STATUS_FRESH_MS = 5 * 60 * 1000;
    const agentStatusMap = new Map<string, "working" | "idle" | "permission_blocked">();
    for (const s of managedSessions) {
      if (s.conversation_id && s.agent_status && s.agent_status_updated_at &&
          (now - s.agent_status_updated_at) < AGENT_STATUS_FRESH_MS) {
        agentStatusMap.set(s.conversation_id.toString(), s.agent_status);
      }
    }

    const NOISE_TITLE_PREFIXES = ["[Using:", "[Request", "[SUGGESTION MODE:"];

    const user = await ctx.db.get(userId);
    const userDaemonAlive = !!user?.daemon_last_seen && (now - (user.daemon_last_seen as number)) < 6 * 60 * 1000;
    const clusterStart = user?.work_cluster_started_at ?? user?.last_message_sent_at ?? 0;
    const clusterCutoff = clusterStart > 0 ? clusterStart - CLUSTER_WINDOW_MS : 0;

    const candidates = [];
    for (const conv of conversations) {
      if (conv.is_subagent || (conv.parent_conversation_id && !conv.parent_message_uuid)) continue;

      const title = conv.title?.trim() || "";
      if (title.toLowerCase() === "warmup") continue;
      if (NOISE_TITLE_PREFIXES.some((p) => title.startsWith(p))) continue;

      const hasPendingForConv = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .filter((q) => q.eq(q.field("status"), "pending"))
        .first();

      if (!args.show_all && clusterCutoff > 0 && conv.updated_at < clusterCutoff && !hasPendingForConv) continue;

      const dismissed = conv.inbox_dismissed_at && conv.inbox_dismissed_at >= conv.updated_at;
      if (dismissed && !hasPendingForConv) continue;

      candidates.push({ conv, hasPendingForConv });
    }

    const NOISE_MSG_PREFIXES = [
      "[Request interrupted",
      "This session is being continued",
      "continue",
    ];
    const isNoiseMsg = (c: string) => {
      const t = c.trim();
      return NOISE_MSG_PREFIXES.some((p) => t.startsWith(p)) || t.length < 4;
    };

    const results = [];
    for (const { conv, hasPendingForConv } of candidates) {
      const daemonAlive = liveConvIds.has(conv._id.toString()) ||
        (userDaemonAlive && (now - conv.updated_at) < 10 * 60 * 1000);

      const hasPending = hasPendingForConv;

      const lastMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", conv._id)
        )
        .order("desc")
        .first();

      const lastRoleIsUser = lastMsg?.role === "user";
      const recentlyActive = (now - conv.updated_at) < 10 * 60 * 1000;
      const recentlyUpdated = (now - conv.updated_at) < 45 * 1000;

      const isUnresponsive = conv.status === "active" && !daemonAlive && (
        (lastRoleIsUser && !recentlyUpdated) ||
        (!!hasPending && (now - hasPending.created_at) > 15_000)
      );

      const agentStatus = agentStatusMap.get(conv._id.toString());
      const isIdle = agentStatus
        ? agentStatus !== "working"
        : daemonAlive
          ? (!hasPending && !lastRoleIsUser && !recentlyUpdated)
          : !recentlyUpdated;

      let lastUserMsg = null;
      if (lastMsg?.role === "user" && lastMsg.content?.trim() && !isNoiseMsg(lastMsg.content)) {
        lastUserMsg = lastMsg;
      } else {
        const msgCandidates = await ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (q) =>
            q.eq("conversation_id", conv._id)
          )
          .order("desc")
          .filter((q) =>
            q.and(
              q.eq(q.field("role"), "user"),
              q.neq(q.field("content"), ""),
              q.neq(q.field("content"), undefined),
            )
          )
          .take(5);
        const good = msgCandidates.find((m) => m.content?.trim() && !isNoiseMsg(m.content!));
        if (good) {
          lastUserMsg = good;
        }
      }

      const deferred = conv.inbox_deferred_at && conv.inbox_deferred_at >= conv.updated_at;

      results.push({
        _id: conv._id,
        session_id: conv.session_id,
        title: conv.title,
        subtitle: conv.subtitle,
        updated_at: conv.updated_at,
        started_at: conv.started_at,
        project_path: conv.project_path,
        git_root: conv.git_root,
        git_branch: conv.git_branch,
        agent_type: conv.agent_type,
        message_count: conv.message_count,
        idle_summary: conv.idle_summary,
        is_idle: isIdle,
        is_unresponsive: isUnresponsive,
        is_connected: !!daemonAlive,
        has_pending: !!hasPending,
        is_deferred: !!deferred,
        agent_status: agentStatus,
        last_user_message: lastUserMsg?.content?.replace(/\[Image\s+\/tmp\/codecast\/images\/[^\]]*\]/gi, "").trim().slice(0, 200) || null,
      });
    }

    results.sort((a, b) => {
      const aNew = a.message_count === 0;
      const bNew = b.message_count === 0;
      if (aNew !== bNew) return aNew ? -1 : 1;
      if (a.is_idle !== b.is_idle) return a.is_idle ? -1 : 1;
      if (a.is_deferred !== b.is_deferred) return a.is_deferred ? 1 : -1;
      if (a.is_idle) return a.updated_at - b.updated_at;
      return b.started_at - a.started_at;
    });

    return results;
  },
});

export const dismissFromInbox = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id !== userId) throw new Error("Not found");
    await ctx.db.patch(args.conversation_id, {
      inbox_dismissed_at: Date.now(),
    });
  },
});

const PATCHABLE_FIELDS = new Set([
  "inbox_dismissed_at",
  "inbox_deferred_at",
  "draft_message",
  "project_path",
  "git_root",
]);

export const patchConversation = mutation({
  args: {
    id: v.id("conversations"),
    fields: v.any(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db.get(args.id);
    if (!conv || conv.user_id !== userId) throw new Error("Not found");

    const patch: Record<string, any> = {};
    for (const [key, value] of Object.entries(args.fields as Record<string, any>)) {
      if (!PATCHABLE_FIELDS.has(key)) continue;
      patch[key] = value === null ? undefined : value;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.id, patch);
    }
  },
});

export const linkSessions = mutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    child_conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const parent = await ctx.db.get(args.parent_conversation_id);
    if (!parent || parent.user_id !== userId) throw new Error("Parent not found");

    const child = await ctx.db.get(args.child_conversation_id);
    if (!child || child.user_id !== userId) throw new Error("Child not found");

    if (child.parent_conversation_id) return;

    await ctx.db.patch(args.child_conversation_id, {
      parent_conversation_id: args.parent_conversation_id,
      is_subagent: true,
      inbox_dismissed_at: Date.now(),
    });
  },
});

export const linkSessionsInternal = internalMutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    child_conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const child = await ctx.db.get(args.child_conversation_id);
    if (!child) throw new Error("Child not found");
    await ctx.db.patch(args.child_conversation_id, {
      parent_conversation_id: args.parent_conversation_id,
      is_subagent: true,
      inbox_dismissed_at: Date.now(),
    });
  },
});

export const adminLookupConversation = mutation({
  args: {
    conversation_id: v.optional(v.id("conversations")),
    session_id: v.optional(v.string()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    let conv;
    if (args.conversation_id) {
      conv = await ctx.db.get(args.conversation_id);
      if (conv && conv.user_id.toString() !== userId.toString()) conv = null;
    } else if (args.session_id) {
      conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
        .filter((q: any) => q.eq(q.field("user_id"), userId))
        .first();
    }
    if (!conv) return null;
    return {
      _id: conv._id,
      session_id: conv.session_id,
      title: conv.title,
      parent_conversation_id: conv.parent_conversation_id,
      is_subagent: conv.is_subagent,
      inbox_dismissed_at: conv.inbox_dismissed_at,
      project_path: conv.project_path,
      created_at: conv._creationTime,
    };
  },
});

export const adminFindChildren = mutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const children = await ctx.db
      .query("conversations")
      .withIndex("by_parent_conversation_id", (q) =>
        q.eq("parent_conversation_id", args.parent_conversation_id)
      )
      .collect();
    return children.map((c) => ({
      _id: c._id,
      session_id: c.session_id,
      title: c.title,
      is_subagent: c.is_subagent,
      parent_conversation_id: c.parent_conversation_id,
    }));
  },
});

export const adminLinkChildrenBySessionId = mutation({
  args: {
    parent_session_id: v.string(),
    child_session_ids: v.array(v.string()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");

    const parent = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.parent_session_id))
      .filter((q) => q.eq(q.field("user_id"), userId))
      .first();
    if (!parent) throw new Error("Parent not found");

    const results: Array<{session_id: string; status: string; conversation_id?: string}> = [];
    for (const childSessionId of args.child_session_ids) {
      const child = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", childSessionId))
        .filter((q) => q.eq(q.field("user_id"), userId))
        .first();
      if (!child) {
        results.push({ session_id: childSessionId, status: "not_found" });
        continue;
      }
      if (child.parent_conversation_id === parent._id) {
        results.push({ session_id: childSessionId, status: "already_linked", conversation_id: child._id });
        continue;
      }
      await ctx.db.patch(child._id, {
        parent_conversation_id: parent._id,
        is_subagent: true,
        inbox_dismissed_at: Date.now(),
      });
      results.push({ session_id: childSessionId, status: "linked", conversation_id: child._id });
    }
    return { parent_id: parent._id, parent_session_id: parent.session_id, results };
  },
});

export const adminUnlinkSession = mutation({
  args: {
    session_id: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), userId))
      .first();
    if (!conv) throw new Error("Not found");
    await ctx.db.patch(conv._id, {
      parent_conversation_id: undefined,
      is_subagent: undefined,
      inbox_dismissed_at: undefined,
    });
    return { unlinked: conv._id };
  },
});

export const updateSessionId = mutation({
  args: {
    conversation_id: v.id("conversations"),
    session_id: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Unauthorized");

    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) {
      throw new Error("Not found");
    }

    await ctx.db.patch(args.conversation_id, { session_id: args.session_id });
    return { updated: true };
  },
});

export const listDismissedSessions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const now = Date.now();
    const WINDOW_MS = 48 * 60 * 60 * 1000;
    const cutoff = now - WINDOW_MS;

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) =>
        q.eq("user_id", userId).gte("updated_at", cutoff)
      )
      .order("desc")
      .filter((q) =>
        q.or(
          q.eq(q.field("status"), "active"),
          q.eq(q.field("status"), "completed")
        )
      )
      .take(100);

    const NOISE_TITLE_PREFIXES = ["[Using:", "[Request", "[SUGGESTION MODE:"];
    const results = [];

    for (const conv of conversations) {
      if (conv.is_subagent || (conv.parent_conversation_id && !conv.parent_message_uuid)) continue;

      const title = conv.title?.trim() || "";
      if (title.toLowerCase() === "warmup") continue;
      if (NOISE_TITLE_PREFIXES.some((p) => title.startsWith(p))) continue;

      const isDismissedActive = conv.status === "active" && conv.inbox_dismissed_at && conv.inbox_dismissed_at >= conv.updated_at;
      const isDismissedCompleted = conv.status === "completed" && conv.inbox_dismissed_at;
      if (!isDismissedActive && !isDismissedCompleted) continue;

      let implementationSession: { _id: string; title?: string } | undefined;
      if (isDismissedCompleted) {
        const children = await ctx.db
          .query("conversations")
          .withIndex("by_parent_conversation_id", (q) =>
            q.eq("parent_conversation_id", conv._id)
          )
          .take(5);
        const implChild = children.find(
          (c) => c.parent_message_uuid === "plan-handoff" && !c.is_subagent
        );
        if (implChild) {
          implementationSession = { _id: implChild._id.toString(), title: implChild.title };
        }
      }

      results.push({
        _id: conv._id,
        session_id: conv.session_id,
        title: conv.title,
        subtitle: conv.subtitle,
        updated_at: conv.updated_at,
        project_path: conv.project_path,
        git_root: conv.git_root,
        git_branch: conv.git_branch,
        agent_type: conv.agent_type,
        message_count: conv.message_count,
        idle_summary: conv.idle_summary,
        is_idle: true,
        has_pending: false,
        implementation_session: implementationSession,
      });
    }

    results.sort((a, b) => b.updated_at - a.updated_at);
    return results;
  },
});


export const backfillLastUserMessageAt = internalMutation({
  args: { user_id: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    if (!args.user_id) return { patched: 0 };
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) =>
        q.eq("user_id", args.user_id!).gte("updated_at", cutoff)
      )
      .collect();

    let maxUserMsgAt = 0;
    let patched = 0;
    for (const conv of convs) {
      if (!conv.last_user_message_at) {
        const lastUserMsg = await ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
          .filter((q) => q.eq(q.field("role"), "user"))
          .order("desc")
          .first();
        if (lastUserMsg) {
          await ctx.db.patch(conv._id, { last_user_message_at: lastUserMsg.timestamp });
          maxUserMsgAt = Math.max(maxUserMsgAt, lastUserMsg.timestamp);
          patched++;
        }
      } else {
        maxUserMsgAt = Math.max(maxUserMsgAt, conv.last_user_message_at);
      }
    }

    if (maxUserMsgAt > 0) {
      const user = await ctx.db.get(args.user_id);
      if (user && (!user.last_message_sent_at || user.last_message_sent_at < maxUserMsgAt)) {
        const patch: Record<string, unknown> = { last_message_sent_at: maxUserMsgAt };
        if (user.last_message_sent_at) {
          patch.prev_message_sent_at = user.last_message_sent_at;
          const GAP_THRESHOLD_MS = 2 * 60 * 60 * 1000;
          if (maxUserMsgAt - user.last_message_sent_at > GAP_THRESHOLD_MS) {
            patch.work_cluster_started_at = maxUserMsgAt;
          }
        }
        await ctx.db.patch(args.user_id, patch);
      }
    }

    return { patched, maxUserMsgAt: maxUserMsgAt > 0 ? new Date(maxUserMsgAt).toISOString() : "none" };
  },
});

export const sendEscapeToSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id !== userId) throw new Error("Not authorized");

    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "escape",
      args: JSON.stringify({ conversation_id: args.conversation_id }),
      created_at: Date.now(),
    });
  },
});

export const killSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id !== userId) throw new Error("Not authorized");

    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "kill_session",
      args: JSON.stringify({ conversation_id: args.conversation_id }),
      created_at: Date.now(),
    });
  },
});

export const switchSessionProject = mutation({
  args: {
    conversation_id: v.id("conversations"),
    project_path: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id !== userId) throw new Error("Not authorized");

    const now = Date.now();

    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "kill_session",
      args: JSON.stringify({ conversation_id: args.conversation_id }),
      created_at: now,
    });

    await ctx.db.patch(args.conversation_id, {
      project_path: args.project_path,
      git_root: args.project_path,
    });

    const agentType = conv.agent_type || "claude_code";
    const daemonAgentType = agentType === "claude_code" ? "claude" : agentType === "codex" ? "codex" : "gemini";
    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "start_session",
      args: JSON.stringify({
        agent_type: daemonAgentType,
        project_path: args.project_path,
        conversation_id: args.conversation_id,
      }),
      created_at: now + 1,
    });
  },
});
