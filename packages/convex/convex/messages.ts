import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { checkRateLimit, MESSAGE_LIMIT } from "./rateLimit";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { shouldGenerateTitle } from "./titleGeneration";
import { canTeamMemberAccess } from "./privacy";
import { redactSecrets } from "./redact";

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
      tool_use_id: v.optional(v.string()),
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

    const safeContent = args.content ? redactSecrets(args.content) : args.content;
    const safeThinking = args.thinking ? redactSecrets(args.thinking) : args.thinking;
    const safeToolCalls = args.tool_calls?.map(tc => ({
      ...tc,
      input: redactSecrets(tc.input),
    }));
    const safeToolResults = args.tool_results?.map(tr => ({
      ...tr,
      content: redactSecrets(tr.content),
    }));

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

    if (args.role === "user" && safeContent?.trim()) {
      const recent = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", args.conversation_id)
        )
        .order("desc")
        .first();
      if (
        recent &&
        recent.role === "user" &&
        redactSecrets(recent.content || "").trim() === safeContent.trim() &&
        Math.abs(msgTimestamp - recent.timestamp) < 5 * 60 * 1000
      ) {
        return recent._id;
      }
    }

    let images = args.images;
    let contentToStore = safeContent;
    if (args.role === "user") {
      const pendingMsg = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
        .order("desc")
        .first();
      if (pendingMsg) {
        const c = (safeContent || "").replace(/\[Image[:\s][^\]]*\]/gi, "").trim();
        const pc = redactSecrets(pendingMsg.content).replace(/\[image\]/gi, "").trim();
        const pcFlat = pc.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
        const cFlat = c.replace(/\s+/g, " ").trim();
        if (cFlat === pcFlat || c === pc) {
          contentToStore = redactSecrets(pendingMsg.content);
          if (!images || images.length === 0) {
            const ids = pendingMsg.image_storage_ids ?? (pendingMsg.image_storage_id ? [pendingMsg.image_storage_id] : []);
            if (ids.length > 0) {
              images = ids.map(id => ({ media_type: "image/png", storage_id: id }));
            }
          }
        }
      }
    }

    const messageId = await ctx.db.insert("messages", {
      conversation_id: args.conversation_id,
      message_uuid: args.message_uuid,
      role: args.role,
      content: contentToStore,
      thinking: safeThinking,
      tool_calls: safeToolCalls,
      tool_results: safeToolResults,
      images,
      subtype: args.subtype,
      timestamp: msgTimestamp,
    });
    const newMessageCount = conversation.message_count + 1;
    const convPatch: Record<string, unknown> = {
      message_count: newMessageCount,
      updated_at: msgTimestamp,
      last_message_role: args.role,
    };
    if (args.role === "user" && contentToStore?.trim()) {
      convPatch.last_message_preview = redactSecrets(contentToStore).replace(/\[Image[:\s][^\]]*\]/gi, "").trim().slice(0, 200);
      convPatch.last_user_message_at = msgTimestamp;
    } else if (args.role === "user") {
      convPatch.last_user_message_at = msgTimestamp;
    }
    await ctx.db.patch(args.conversation_id, convPatch);

    if (args.api_token || args.role === "user") {
      await ctx.scheduler.runAfter(0, internal.users.updateUserActivity, {
        userId: conversation.user_id,
        daemonSeen: !!args.api_token,
        messageTimestamp: args.role === "user" ? msgTimestamp : undefined,
      });
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
    tool_use_id: v.optional(v.string()),
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
    let lastUserContentStored: string | undefined;

    for (const msg of args.messages) {
      const msgTimestamp = msg.timestamp || Date.now();
      if (msgTimestamp > maxTimestamp) {
        maxTimestamp = msgTimestamp;
      }

      const safeContent = msg.content ? redactSecrets(msg.content) : msg.content;
      const safeThinking = msg.thinking ? redactSecrets(msg.thinking) : msg.thinking;
      const safeToolCalls = msg.tool_calls?.map(tc => ({
        ...tc,
        input: redactSecrets(tc.input),
      }));
      const safeToolResults = msg.tool_results?.map(tr => ({
        ...tr,
        content: redactSecrets(tr.content),
      }));

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

      if (msg.role === "user" && safeContent?.trim()) {
        const recent = await ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (q) =>
            q.eq("conversation_id", args.conversation_id)
          )
          .order("desc")
          .first();
        if (
          recent &&
          recent.role === "user" &&
          redactSecrets(recent.content || "").trim() === safeContent.trim() &&
          Math.abs(msgTimestamp - recent.timestamp) < 5 * 60 * 1000
        ) {
          ids.push(recent._id);
          continue;
        }
      }

      let images = msg.images;
      let contentToStore = safeContent;
      if (msg.role === "user") {
        const pendingMsg = await ctx.db
          .query("pending_messages")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
          .order("desc")
          .first();
        if (pendingMsg) {
          const c = (safeContent || "").replace(/\[Image[:\s][^\]]*\]/gi, "").trim();
          const pc = redactSecrets(pendingMsg.content).replace(/\[image\]/gi, "").trim();
          const pcFlat = pc.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
          const cFlat = c.replace(/\s+/g, " ").trim();
          if (cFlat === pcFlat || c === pc) {
            contentToStore = redactSecrets(pendingMsg.content);
            if (!images || images.length === 0) {
              const ids = pendingMsg.image_storage_ids ?? (pendingMsg.image_storage_id ? [pendingMsg.image_storage_id] : []);
              if (ids.length > 0) {
                images = ids.map(id => ({ media_type: "image/png", storage_id: id }));
              }
            }
          }
        }
      }

      const messageId = await ctx.db.insert("messages", {
        conversation_id: args.conversation_id,
        message_uuid: msg.message_uuid,
        role: msg.role,
        content: contentToStore,
        thinking: safeThinking,
        tool_calls: safeToolCalls,
        tool_results: safeToolResults,
        images,
        subtype: msg.subtype,
        timestamp: msgTimestamp,
      });
      ids.push(messageId);
      insertedCount++;
      if (msg.role === "user") lastUserContentStored = contentToStore;
    }

    if (insertedCount > 0) {
      const newMessageCount = conversation.message_count + insertedCount;
      const lastMsg = args.messages[args.messages.length - 1];
      const convPatch: Record<string, unknown> = {
        message_count: newMessageCount,
        updated_at: maxTimestamp,
        last_message_role: lastMsg.role,
      };
      const userMsgs = args.messages.filter((m) => m.role === "user");
      if (userMsgs.length > 0) {
        const lastUserMsg = userMsgs[userMsgs.length - 1];
        const lastUserTs = userMsgs.reduce((max, m) => Math.max(max, m.timestamp || 0), 0);
        if (lastUserTs > 0) {
          convPatch.last_user_message_at = lastUserTs;
        }
        const previewSrc = lastUserContentStored || lastUserMsg.content;
        const preview = redactSecrets(previewSrc || "").replace(/\[Image[:\s][^\]]*\]/gi, "").trim().slice(0, 200);
        if (preview) {
          convPatch.last_message_preview = preview;
        }
      }
      await ctx.db.patch(args.conversation_id, convPatch);

      const lastUserTs = userMsgs.length > 0
        ? userMsgs.reduce((max, m) => Math.max(max, m.timestamp || 0), 0)
        : 0;
      if (args.api_token || lastUserTs > 0) {
        await ctx.scheduler.runAfter(0, internal.users.updateUserActivity, {
          userId: conversation.user_id,
          daemonSeen: !!args.api_token,
          messageTimestamp: lastUserTs > 0 ? lastUserTs : undefined,
        });
      }

      if (!conversation.skip_title_generation) {
        let shouldGen = false;
        for (let c = conversation.message_count + 1; c <= newMessageCount; c++) {
          if (shouldGenerateTitle(c)) { shouldGen = true; break; }
        }
        if (!shouldGen && conversation.subtitle === undefined && newMessageCount > 2) {
          shouldGen = true;
        }
        if (shouldGen) {
          await ctx.scheduler.runAfter(0, internal.titleGeneration.generateTitle, {
            conversation_id: args.conversation_id,
          });
        }
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
    const plain = raw.replace(/[*_`#~\[\]()>]/g, "").replace(/\n{2,}/g, " ").replace(/\n/g, " ").trim();
    const messagePreview = plain.length > 200 ? plain.slice(0, 200) + "..." : plain;

    const title = conversation.title
      || conversation.subtitle
      || "Coding Session";

    const description = share.note
      || messagePreview
      || conversation.subtitle
      || conversation.idle_summary
      || `Shared ${message.role === "user" ? "prompt" : "response"}${user?.name ? ` from ${user.name}` : ""}`;

    return {
      title,
      description,
      role: message.role,
      author: user?.name || null,
      note: share.note || null,
    };
  },
});

