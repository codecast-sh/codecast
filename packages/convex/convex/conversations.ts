import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { checkRateLimit } from "./rateLimit";
import { verifyApiToken } from "./apiTokens";
import { internal } from "./_generated/api";

async function isTeamMember(ctx: { db: any }, userId: Id<"users">, teamId: Id<"teams">): Promise<boolean> {
  const m = await ctx.db.query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId)).first();
  return !!m;
}

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
      v.literal("cursor")
    ),
    session_id: v.string(),
    project_hash: v.optional(v.string()),
    project_path: v.optional(v.string()),
    slug: v.optional(v.string()),
    title: v.optional(v.string()),
    started_at: v.optional(v.number()),
    parent_message_uuid: v.optional(v.string()),
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
      return existing._id;
    }

    const now = Date.now();
    const startedAt = args.started_at ?? now;

    const user = await ctx.db.get(args.user_id);
    let resolvedTeamId = args.team_id;
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
      // No fallback - if no directory mapping, conversation has no team_id ("Only Me")
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

    const allConversations = await ctx.db.query("conversations").collect();
    const filtered = allConversations.filter((c) => {
      const isOwn = c.user_id.toString() === args.user_id.toString();
      if (isOwn) return true;
      if (c.is_private !== false) return false;
      if (c.team_id && userTeamIds.has(c.team_id.toString())) {
        return true;
      }
      return false;
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
      if (conversation.is_private !== false) {
        return null;
      }
      if (!conversation.team_id || !(await isTeamMember(ctx, authUserId, conversation.team_id))) {
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
      || `Session ${conversation.session_id.slice(0, 8)}`;

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

    if (authUserId && !isOwner && conversation.is_private === false && conversation.team_id) {
      hasTeamAccess = await isTeamMember(ctx, authUserId, conversation.team_id);
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
      || `Session ${conversation.session_id.slice(0, 8)}`;

    const childConversations: Array<{ _id: string; title: string }> = [];
    const childConversationMap: Record<string, string> = {};

    if (messages.length > 0) {
      const childConvs = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", conversation.user_id))
        .filter((q) => q.neq(q.field("parent_message_uuid"), undefined))
        .take(100);

      const messageUuids = new Set(messages.filter((m) => m.message_uuid).map((m) => m.message_uuid!));
      for (const conv of childConvs) {
        if (conv.parent_message_uuid && messageUuids.has(conv.parent_message_uuid)) {
          const childTitle = conv.title || `Session ${conv.session_id.slice(0, 8)}`;
          childConversations.push({ _id: conv._id, title: childTitle });
          childConversationMap[conv.parent_message_uuid] = conv._id;
        }
      }
    }

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
          title: fork.title || `Session ${fork.session_id.slice(0, 8)}`,
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
      user: user ? { name: user.name, email: user.email } : null,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
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

    if (authUserId && !isOwner && conversation.is_private === false && conversation.team_id) {
      hasTeamAccess = await isTeamMember(ctx, authUserId, conversation.team_id);
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
      || `Session ${conversation.session_id.slice(0, 8)}`;

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

    const childConversations: Array<{ _id: string; title: string }> = [];
    const childConversationMap: Record<string, string> = {};

    if (messages.length > 0) {
      const childConvs = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", conversation.user_id))
        .filter((q) => q.neq(q.field("parent_message_uuid"), undefined))
        .take(100);

      const messageUuids = new Set(messages.filter((m) => m.message_uuid).map((m) => m.message_uuid!));
      for (const conv of childConvs) {
        if (conv.parent_message_uuid && messageUuids.has(conv.parent_message_uuid)) {
          const childTitle = conv.title || `Session ${conv.session_id.slice(0, 8)}`;
          childConversations.push({ _id: conv._id, title: childTitle });
          childConversationMap[conv.parent_message_uuid] = conv._id;
        }
      }
    }

    return {
      ...conversation,
      title,
      messages,
      user: user ? { name: user.name, email: user.email } : null,
      last_timestamp: newestTimestamp,
      oldest_timestamp: oldestTimestamp,
      has_more_above: hasMoreAbove,
      has_more_below: hasMoreBelow,
      parent_conversation_id: parentConversationId,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
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
      if (conversation.is_private !== false) {
        return null;
      }
      if (!conversation.team_id || !(await isTeamMember(ctx, authUserId, conversation.team_id))) {
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

    const childConversations: Array<{ _id: string; title: string }> = [];
    const childConversationMap: Record<string, string> = {};

    if (messages.length > 0) {
      const childConvs = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", conversation.user_id))
        .filter((q) => q.neq(q.field("parent_message_uuid"), undefined))
        .take(100);

      const messageUuids = new Set(messages.filter((m) => m.message_uuid).map((m) => m.message_uuid!));
      for (const conv of childConvs) {
        if (conv.parent_message_uuid && messageUuids.has(conv.parent_message_uuid)) {
          const childTitle = conv.title || `Session ${conv.session_id.slice(0, 8)}`;
          childConversations.push({ _id: conv._id, title: childTitle });
          childConversationMap[conv.parent_message_uuid] = conv._id;
        }
      }
    }

    return {
      messages,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
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
      if (conversation.is_private !== false) {
        return null;
      }
      if (!conversation.team_id || !(await isTeamMember(ctx, authUserId, conversation.team_id))) {
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

    const childConversations: Array<{ _id: string; title: string }> = [];
    const childConversationMap: Record<string, string> = {};

    const childConvs = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", conversation.user_id))
      .filter((q) => q.neq(q.field("parent_message_uuid"), undefined))
      .take(100);

    const messageUuids = new Set(messages.filter((m) => m.message_uuid).map((m) => m.message_uuid!));
    for (const conv of childConvs) {
      if (conv.parent_message_uuid && messageUuids.has(conv.parent_message_uuid)) {
        const childTitle = conv.title || `Session ${conv.session_id.slice(0, 8)}`;
        childConversations.push({ _id: conv._id, title: childTitle });
        childConversationMap[conv.parent_message_uuid] = conv._id;
      }
    }

    return {
      messages,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
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
      if (conversation.is_private !== false) {
        return null;
      }
      if (!conversation.team_id || !(await isTeamMember(ctx, authUserId, conversation.team_id))) {
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
      if (conversation.is_private !== false) {
        return null;
      }
      if (!conversation.team_id || !(await isTeamMember(ctx, authUserId, conversation.team_id))) {
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
    memberId: v.optional(v.id("users")),
    activeTeamId: v.optional(v.id("teams")),
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

    const limit = args.limit ?? 50;
    const cursorTimestamp = args.cursor ? parseInt(args.cursor, 10) : null;

    const effectiveTeamId = args.activeTeamId || user.active_team_id;

    // Get team members for the effective team
    const teamUsers = effectiveTeamId
      ? await ctx.db
          .query("users")
          .withIndex("by_team_id", (q) => q.eq("team_id", effectiveTeamId))
          .collect()
      : [];
    // Also get members via team_memberships for multi-team support
    const teamMemberships = effectiveTeamId
      ? await ctx.db
          .query("team_memberships")
          .withIndex("by_team_id", (q) => q.eq("team_id", effectiveTeamId))
          .collect()
      : [];
    const membershipUserIds = new Set(teamMemberships.map(m => m.user_id.toString()));
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

    let conversations;
    if (args.filter === "my") {
      // Use by_user_updated index to sort by updated_at (most recent activity first)
      const query = ctx.db
        .query("conversations")
        .withIndex("by_user_updated", (q) =>
          cursorTimestamp
            ? q.eq("user_id", userId).lt("updated_at", cursorTimestamp)
            : q.eq("user_id", userId)
        )
        .order("desc");

      conversations = await query.take(limit + 1);
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

      // Filter by privacy and project visibility
      const fetched = await query.take((limit + 1) * 2);
      conversations = fetched.filter((c) => {
        if (c.is_private !== false) return false;
        const projectPath = c.git_root || c.project_path;
        return isProjectVisibleToTeam(c.user_id.toString(), projectPath);
      }).slice(0, limit + 1);
    } else {
      // Query recent conversations from each visible team member and merge
      // This ensures all team members' conversations appear regardless of activity level
      const visibleMembers = teamMemberships.filter(m => {
        const visibility = m.visibility || "summary";
        return visibility !== "hidden";
      });

      const perMemberLimit = Math.max(5, Math.ceil((limit + 1) * 2 / Math.max(visibleMembers.length, 1)));

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

          const convs = await query.take(perMemberLimit * 2);
          return convs.filter((c) => {
            if (c.is_private !== false) return false;
            const projectPath = c.git_root || c.project_path;
            return isProjectVisibleToTeam(c.user_id.toString(), projectPath);
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
        const conversationUser = await ctx.db.get(c.user_id);

        type VisibilityMode = "full" | "detailed" | "summary" | "minimal";

        function getTeamVisibility(): VisibilityMode {
          if (args.filter !== "team") return "full";
          if (c.team_visibility) {
            return c.team_visibility as VisibilityMode;
          }
          const ownerVisibility = membershipVisibilityMap.get(c.user_id.toString()) || "activity";
          const visibilityMapping: Record<string, VisibilityMode> = {
            "hidden": "minimal",
            "activity": "minimal",
            "summary": "summary",
            "full": "full",
            "detailed": "detailed",
            "minimal": "minimal",
          };
          return visibilityMapping[ownerVisibility] || "detailed";
        }

        const visibilityMode = getTeamVisibility();
        const authorName = conversationUser?.name || conversationUser?.email?.split("@")[0] || "Unknown";
        const authorAvatar = conversationUser?.image || conversationUser?.github_avatar_url || null;
        const projectName = (c.project_path || c.git_root)?.split("/").pop() || "unknown project";
        const durationMs = c.updated_at - c.started_at;
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        const isActive = c.status === "active" && c.updated_at > fiveMinutesAgo;
        const title = c.title || `Session ${c.session_id.slice(0, 8)}`;

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
            project_path: c.project_path || null,
            git_root: c.git_root || null,
            tool_names: [],
            subagent_types: [],
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

        const fullTitle = c.title || firstUserMessage || `Session ${c.session_id.slice(0, 8)}`;

        let parentConversationId: string | null = null;
        let parentTitle: string | null = null;
        if (c.parent_message_uuid) {
          const parentMsg = await ctx.db
            .query("messages")
            .withIndex("by_message_uuid", (q) => q.eq("message_uuid", c.parent_message_uuid))
            .first();
          if (parentMsg) {
            parentConversationId = parentMsg.conversation_id;
            const parentConv = await ctx.db.get(parentMsg.conversation_id as Id<"conversations">);
            if (parentConv) {
              parentTitle = parentConv.title || `Session ${parentConv.session_id.slice(0, 8)}`;
            }
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
      || `Session ${conversation.session_id.slice(0, 8)}`;

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
    let accessLevel: "owner" | "team" | "shared" | "denied" = "denied";

    if (authUserId) {
      const isOwner = conversation.user_id.toString() === authUserId.toString();
      if (isOwner) {
        accessLevel = "owner";
      } else if (conversation.is_private === false && conversation.team_id) {
        if (await isTeamMember(ctx, authUserId, conversation.team_id)) {
          accessLevel = "team";
        }
      }
    }

    if (accessLevel === "denied" && conversation.share_token) {
      accessLevel = "shared";
    }

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
      || `Session ${conversation.session_id.slice(0, 8)}`;

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
        user: user ? { name: user.name, email: user.email } : null,
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

      // Check access - user can see their own conversations, or non-private
      // conversations from team members whose team_id matches the effective team
      const isOwn = conv.user_id.toString() === userId.toString();
      if (!isOwn) {
        if (conv.is_private !== false) continue;
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
        || `Session ${conv.session_id.slice(0, 8)}`;

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

    const updates: { is_private: boolean; team_id?: Id<"teams"> } = {
      is_private: args.is_private,
    };

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

    // Get all users with team_id to build a lookup map
    const usersWithTeams = await ctx.db
      .query("users")
      .filter((q) => q.neq(q.field("team_id"), undefined))
      .collect();

    const userTeamMap = new Map<string, Id<"teams">>();
    for (const user of usersWithTeams) {
      if (user.team_id) {
        userTeamMap.set(user._id.toString(), user.team_id);
      }
    }

    // Paginate through conversations
    const result = await ctx.db
      .query("conversations")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let updated = 0;
    for (const conv of result.page) {
      const userTeamId = userTeamMap.get(conv.user_id.toString());
      // Update if user has team_id and conversation doesn't, or they differ
      if (userTeamId && conv.team_id?.toString() !== userTeamId.toString()) {
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

      // Check access - user can see their own conversations, or non-private
      // conversations from team members whose team_id matches the effective team
      const isOwn = conv.user_id.toString() === authUserId.toString();
      if (!isOwn) {
        if (!teamUserIds.has(conv.user_id.toString())) continue;
        if (conv.is_private !== false) continue;
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
        || `Session ${conv.session_id.slice(0, 8)}`;

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
      if (conv.is_private !== false) {
        return { error: "Access denied" };
      }
      if (!conv.team_id || !(await isTeamMember(ctx, authUserId, conv.team_id))) {
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
      || `Session ${conv.session_id.slice(0, 8)}`;

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
      if (conv.is_private !== false) {
        return { error: "Access denied" };
      }
      if (!conv.team_id || !(await isTeamMember(ctx, authUserId, conv.team_id))) {
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
        title: conv.title || `Session ${conv.session_id.slice(0, 8)}`,
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
      if (conv.is_private !== false) {
        return { error: "Access denied" };
      }
      if (!conv.team_id || !(await isTeamMember(ctx, authUserId, conv.team_id))) {
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
        title: conv.title || `Session ${conv.session_id.slice(0, 8)}`,
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

    if (conversation.project_path === args.project_path) {
      return { updated: false };
    }

    await ctx.db.patch(conversation._id, {
      project_path: args.project_path,
    });

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
          || `Session ${c.session_id.slice(0, 8)}`;

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
      if (original.is_private !== false) {
        throw new Error("Access denied");
      }
      if (!original.team_id || !(await isTeamMember(ctx, userId, original.team_id))) {
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
      if (conv.is_private !== false) {
        return { error: "Access denied" };
      }
      if (!conv.team_id || !(await isTeamMember(ctx, userId, conv.team_id))) {
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
        title: node.title || `Session ${node.session_id.slice(0, 8)}`,
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
        if (conv.is_private !== false) {
          hasAccess = false;
        } else if (conv.team_id && await isTeamMember(ctx, userId, conv.team_id)) {
          hasAccess = true;
        }
      }

      if (!hasAccess) {
        conversationCache.set(convId, null);
        return null;
      }

      const convUser = await ctx.db.get(conv.user_id);
      const info = {
        hasAccess: true,
        title: conv.title || (conv.slug ? formatSlugAsTitle(conv.slug) : `Session ${conv.session_id.slice(0, 8)}`),
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
        c.is_private === false &&
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
            c.is_private === false &&
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
        || `Session ${conv.session_id.slice(0, 8)}`;

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

    if (!conversation.share_token) {
      const authUserId = await getAuthUserId(ctx);
      if (!authUserId || conversation.user_id.toString() !== authUserId.toString()) {
        return null;
      }
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
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || `Session ${conversation.session_id.slice(0, 8)}`;

    return {
      title,
      description: firstUserMessage || conversation.subtitle || null,
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

      const title = conv.title || (preview ? preview.slice(0, 80) : `Session ${sessionId.slice(0, 8)}`);

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
