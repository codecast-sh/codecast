import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { checkRateLimit, MESSAGE_LIMIT } from "./rateLimit";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { shouldGenerateTitle } from "./titleGeneration";
import { canTeamMemberAccess } from "./privacy";

export const getMessageTimestamp = query({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
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

    const message = await ctx.db.get(args.message_id);
    if (!message || message.conversation_id.toString() !== args.conversation_id.toString()) {
      return null;
    }

    return { timestamp: message.timestamp };
  },
});

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

export const addMessage = mutation({
  args: {
    conversation_id: v.id("conversations"),
    message_uuid: v.optional(v.string()),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool")
    ),
    content: v.optional(v.string()),
    thinking: v.optional(v.string()),
    tool_calls: v.optional(v.array(v.object({
      id: v.string(),
      name: v.string(),
      input: v.string(),
    }))),
    tool_results: v.optional(v.array(v.object({
      tool_use_id: v.string(),
      content: v.string(),
      is_error: v.optional(v.boolean()),
    }))),
    images: v.optional(v.array(v.object({
      media_type: v.string(),
      data: v.optional(v.string()),
      storage_id: v.optional(v.id("_storage")),
    }))),
    subtype: v.optional(v.string()),
    timestamp: v.optional(v.number()),
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
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only add messages to your own conversations");
    }

    await checkRateLimit(ctx, conversation.user_id, "addMessage", MESSAGE_LIMIT);

    const msgTimestamp = args.timestamp || Date.now();

    if (args.message_uuid) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_conversation_uuid", (q) =>
          q.eq("conversation_id", args.conversation_id).eq("message_uuid", args.message_uuid)
        )
        .first();

      if (existing) {
        if (args.images && args.images.length > 0 && (!existing.images || existing.images.length === 0)) {
          await ctx.db.patch(existing._id, { images: args.images });
        }
        return existing._id;
      }
    }

    let images = args.images;
    if (args.role === "user" && (!images || images.length === 0)) {
      const pendingWithImage = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
        .filter((q) => q.neq(q.field("image_storage_id"), undefined))
        .order("desc")
        .first();
      if (pendingWithImage?.image_storage_id) {
        const c = (args.content || "").replace(/\[Image\s+\/tmp\/codecast\/images\/[^\]]*\]/gi, "").replace(/\[image\]/gi, "").trim();
          const pc = pendingWithImage.content.replace(/\[image\]/gi, "").trim();
          const contentMatch = c === pc;
        if (contentMatch) {
          images = [{ media_type: "image/png", storage_id: pendingWithImage.image_storage_id }];
        }
      }
    }

    const messageId = await ctx.db.insert("messages", {
      conversation_id: args.conversation_id,
      message_uuid: args.message_uuid,
      role: args.role,
      content: args.content,
      thinking: args.thinking,
      tool_calls: args.tool_calls,
      tool_results: args.tool_results,
      images,
      subtype: args.subtype,
      timestamp: msgTimestamp,
    });
    const newMessageCount = conversation.message_count + 1;
    const convPatch: Record<string, unknown> = {
      message_count: newMessageCount,
      updated_at: msgTimestamp,
    };
    if (args.role === "user") {
      convPatch.last_user_message_at = msgTimestamp;
    }
    await ctx.db.patch(args.conversation_id, convPatch);

    const userPatch: Record<string, unknown> = {};
    if (args.api_token) {
      userPatch.daemon_last_seen = Date.now();
    }
    if (args.role === "user") {
      const user = await ctx.db.get(conversation.user_id);
      if (!user?.last_message_sent_at || msgTimestamp > user.last_message_sent_at) {
        userPatch.last_message_sent_at = msgTimestamp;
      }
    }
    if (Object.keys(userPatch).length > 0) {
      await ctx.db.patch(conversation.user_id, userPatch);
    }

    if (!conversation.skip_title_generation && shouldGenerateTitle(newMessageCount)) {
      await ctx.scheduler.runAfter(0, internal.titleGeneration.generateTitle, {
        conversation_id: args.conversation_id,
      });
    }

    return messageId;
  },
});

const MAX_BATCH_SIZE = 25;

const messageValidator = v.object({
  message_uuid: v.optional(v.string()),
  role: v.union(
    v.literal("user"),
    v.literal("assistant"),
    v.literal("system"),
    v.literal("tool")
  ),
  content: v.optional(v.string()),
  thinking: v.optional(v.string()),
  tool_calls: v.optional(v.array(v.object({
    id: v.string(),
    name: v.string(),
    input: v.string(),
  }))),
  tool_results: v.optional(v.array(v.object({
    tool_use_id: v.string(),
    content: v.string(),
    is_error: v.optional(v.boolean()),
  }))),
  images: v.optional(v.array(v.object({
    media_type: v.string(),
    data: v.optional(v.string()),
    storage_id: v.optional(v.id("_storage")),
  }))),
  subtype: v.optional(v.string()),
  timestamp: v.optional(v.number()),
});

export const addMessages = mutation({
  args: {
    conversation_id: v.id("conversations"),
    messages: v.array(messageValidator),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.messages.length === 0) {
      return { inserted: 0, ids: [] };
    }
    if (args.messages.length > MAX_BATCH_SIZE) {
      throw new Error(`Batch size ${args.messages.length} exceeds maximum of ${MAX_BATCH_SIZE}`);
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only add messages to your own conversations");
    }

    await checkRateLimit(ctx, conversation.user_id, "addMessage", MESSAGE_LIMIT, args.messages.length);

    const ids: Id<"messages">[] = [];
    let insertedCount = 0;
    let maxTimestamp = conversation.updated_at;

    for (const msg of args.messages) {
      const msgTimestamp = msg.timestamp || Date.now();
      if (msgTimestamp > maxTimestamp) {
        maxTimestamp = msgTimestamp;
      }

      if (msg.message_uuid) {
        const existing = await ctx.db
          .query("messages")
          .withIndex("by_conversation_uuid", (q) =>
            q.eq("conversation_id", args.conversation_id).eq("message_uuid", msg.message_uuid)
          )
          .first();

        if (existing) {
          if (msg.images && msg.images.length > 0 && (!existing.images || existing.images.length === 0)) {
            await ctx.db.patch(existing._id, { images: msg.images });
          }
          ids.push(existing._id);
          continue;
        }
      }

      let images = msg.images;
      if (msg.role === "user" && (!images || images.length === 0)) {
        const pendingWithImage = await ctx.db
          .query("pending_messages")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
          .filter((q) => q.neq(q.field("image_storage_id"), undefined))
          .order("desc")
          .first();
        if (pendingWithImage?.image_storage_id) {
          const c = (msg.content || "").replace(/\[Image\s+\/tmp\/codecast\/images\/[^\]]*\]/gi, "").replace(/\[image\]/gi, "").trim();
            const pc = pendingWithImage.content.replace(/\[image\]/gi, "").trim();
            const contentMatch = c === pc;
          if (contentMatch) {
            images = [{ media_type: "image/png", storage_id: pendingWithImage.image_storage_id }];
          }
        }
      }

      const messageId = await ctx.db.insert("messages", {
        conversation_id: args.conversation_id,
        message_uuid: msg.message_uuid,
        role: msg.role,
        content: msg.content,
        thinking: msg.thinking,
        tool_calls: msg.tool_calls,
        tool_results: msg.tool_results,
        images,
        subtype: msg.subtype,
        timestamp: msgTimestamp,
      });
      ids.push(messageId);
      insertedCount++;
    }

    if (insertedCount > 0) {
      const newMessageCount = conversation.message_count + insertedCount;
      const convPatch: Record<string, unknown> = {
        message_count: newMessageCount,
        updated_at: maxTimestamp,
      };
      const hasUserMsg = args.messages.some((m) => m.role === "user");
      if (hasUserMsg) {
        const lastUserTs = args.messages
          .filter((m) => m.role === "user")
          .reduce((max, m) => Math.max(max, m.timestamp || 0), 0);
        if (lastUserTs > 0) {
          convPatch.last_user_message_at = lastUserTs;
        }
      }
      await ctx.db.patch(args.conversation_id, convPatch);

      const userPatch: Record<string, unknown> = {};
      if (args.api_token) {
        userPatch.daemon_last_seen = Date.now();
      }
      if (hasUserMsg) {
        const lastUserTs = args.messages
          .filter((m) => m.role === "user")
          .reduce((max, m) => Math.max(max, m.timestamp || 0), 0);
        if (lastUserTs > 0) {
          const user = await ctx.db.get(conversation.user_id);
          if (!user?.last_message_sent_at || lastUserTs > user.last_message_sent_at) {
            userPatch.last_message_sent_at = lastUserTs;
          }
        }
      }
      if (Object.keys(userPatch).length > 0) {
        await ctx.db.patch(conversation.user_id, userPatch);
      }

      if (!conversation.skip_title_generation && shouldGenerateTitle(newMessageCount) && !shouldGenerateTitle(conversation.message_count)) {
        await ctx.scheduler.runAfter(0, internal.titleGeneration.generateTitle, {
          conversation_id: args.conversation_id,
        });
      }
    }

    return { inserted: insertedCount, ids };
  },
});

function generateShareToken(): string {
  return crypto.randomUUID();
}

export const generateMessageShareLink = mutation({
  args: {
    message_id: v.id("messages"),
    context_before: v.optional(v.number()),
    context_after: v.optional(v.number()),
    message_ids: v.optional(v.array(v.id("messages"))),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }

    const message = await ctx.db.get(args.message_id);
    if (!message) {
      throw new Error("Message not found");
    }

    const conversation = await ctx.db.get(message.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      if (!(await canTeamMemberAccess(ctx, authUserId, conversation))) {
        throw new Error("Unauthorized: can only share messages from your own conversations");
      }
    }

    const shareToken = generateShareToken();
    await ctx.db.insert("message_shares", {
      share_token: shareToken,
      message_id: args.message_id,
      user_id: authUserId,
      context_before: args.context_before,
      context_after: args.context_after,
      message_ids: args.message_ids,
      note: args.note,
      created_at: Date.now(),
    });

    return shareToken;
  },
});

export const findMessageByContent = query({
  args: {
    conversation_id: v.id("conversations"),
    search_term: v.string(),
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

    const searchLower = args.search_term.toLowerCase();
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .collect();

    for (const msg of messages) {
      if (msg.content && msg.content.toLowerCase().includes(searchLower)) {
        return { message_id: msg._id, timestamp: msg.timestamp };
      }
    }

    return null;
  },
});

export const findMessageByContentPublic = query({
  args: {
    conversation_id: v.id("conversations"),
    search_term: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    if (!conversation.share_token) {
      return null;
    }

    const searchLower = args.search_term.toLowerCase();
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .collect();

    for (const msg of messages) {
      if (msg.content && msg.content.toLowerCase().includes(searchLower)) {
        return { message_id: msg._id, timestamp: msg.timestamp };
      }
    }

    return null;
  },
});

export const getSharedMessage = query({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const share = await ctx.db
      .query("message_shares")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .first();

    if (!share) {
      return null;
    }

    const message = await ctx.db.get(share.message_id);
    if (!message) {
      return null;
    }

    const conversation = await ctx.db.get(message.conversation_id);
    if (!conversation) {
      return null;
    }

    const user = await ctx.db.get(conversation.user_id);

    let sharedMessages: typeof message[] = [];

    if (share.message_ids && share.message_ids.length > 0) {
      const msgs = await Promise.all(share.message_ids.map(id => ctx.db.get(id)));
      sharedMessages = msgs.filter((m): m is NonNullable<typeof m> => m !== null);
      sharedMessages.sort((a, b) => a.timestamp - b.timestamp);
    } else if (share.context_before || share.context_after) {
      const allMessages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", message.conversation_id)
        )
        .collect();

      const sorted = allMessages.sort((a, b) => a.timestamp - b.timestamp);
      const targetIndex = sorted.findIndex((m) => m._id === message._id);

      if (targetIndex !== -1) {
        const startIdx = Math.max(0, targetIndex - (share.context_before || 0));
        const endIdx = Math.min(sorted.length, targetIndex + (share.context_after || 0) + 1);
        sharedMessages = sorted.slice(startIdx, endIdx);
      }
    }

    return {
      message,
      contextMessages: sharedMessages.length > 0 ? sharedMessages : [message],
      conversation: {
        _id: conversation._id,
        title: conversation.title,
        project_path: conversation.project_path,
        agent_type: conversation.agent_type,
      },
      user: user ? { name: user.name, image: user.image } : null,
      note: share.note,
      sharedAt: share.created_at,
    };
  },
});

export const getSharedMessageMeta = query({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const share = await ctx.db
      .query("message_shares")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .first();

    if (!share) return null;

    const message = await ctx.db.get(share.message_id);
    if (!message) return null;

    const conversation = await ctx.db.get(message.conversation_id);
    if (!conversation) return null;

    const user = await ctx.db.get(conversation.user_id);

    const raw = message.content?.trim() || "";
    const plain = raw.replace(/[*_`#~\[\]()>]/g, "").replace(/\n{2,}/g, " ").replace(/\n/g, " ");
    const description = plain.length > 200 ? plain.slice(0, 200) + "..." : plain;

    return {
      title: conversation.title || null,
      description,
      role: message.role,
      author: user?.name || null,
      note: share.note || null,
    };
  },
});
