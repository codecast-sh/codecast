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

function classifyDocContent(content: string): "plan" | "design" | "spec" | "investigation" | "handoff" | "note" {
  const first2k = content.slice(0, 2000).toLowerCase();
  if (/implementation\s+plan|## phases?\b|## milestones?\b|## timeline/i.test(first2k)) return "plan";
  if (/design\s+doc|architecture|## design|## approach|system\s+design/i.test(first2k)) return "design";
  if (/## spec|specification|## requirements|## api\b|## endpoints/i.test(first2k)) return "spec";
  if (/investigation|root\s+cause|## findings|## analysis|debugging/i.test(first2k)) return "investigation";
  if (/handoff|## status|## context|## next\s+steps/i.test(first2k)) return "handoff";
  return "note";
}

function extractTitleFromContent(content: string): string {
  const h1 = content.match(/^#\s+(.+)/m);
  if (h1) return h1[1].slice(0, 200);
  const h2 = content.match(/^##\s+(.+)/m);
  if (h2) return h2[1].slice(0, 200);
  const firstLine = content.split("\n").find((l) => l.trim().length > 10);
  if (firstLine) return firstLine.replace(/^[#*\->\s]+/, "").slice(0, 200);
  return "Untitled Document";
}

type DocExtractionMessage = {
  role?: string;
  content?: string;
  tool_calls?: Array<{ id: string; name: string; input: string }>;
  timestamp?: number;
};

type DocExtractionConversation = {
  user_id: Id<"users">;
  team_id?: string;
  project_path?: string;
  is_private?: boolean;
  team_visibility?: string;
};

function buildExistingMessagePatch(
  existing: {
    role: string;
    content?: string;
    thinking?: string;
    tool_calls?: unknown;
    tool_results?: unknown;
    images?: unknown;
    subtype?: string;
  },
  incoming: {
    role: string;
    content?: string;
    thinking?: string;
    tool_calls?: unknown;
    tool_results?: unknown;
    images?: unknown;
    subtype?: string;
  },
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};

  if (incoming.role === "assistant") {
    if (incoming.content !== undefined && incoming.content !== existing.content) {
      patch.content = incoming.content;
    }
    if (incoming.thinking !== undefined && incoming.thinking !== existing.thinking) {
      patch.thinking = incoming.thinking;
    }
    if (incoming.subtype !== undefined && incoming.subtype !== existing.subtype) {
      patch.subtype = incoming.subtype;
    }
    if (incoming.tool_calls !== undefined && JSON.stringify(incoming.tool_calls) !== JSON.stringify(existing.tool_calls ?? null)) {
      patch.tool_calls = incoming.tool_calls;
    }
    if (incoming.tool_results !== undefined && JSON.stringify(incoming.tool_results) !== JSON.stringify(existing.tool_results ?? null)) {
      patch.tool_results = incoming.tool_results;
    }
  }

  if (incoming.images && JSON.stringify(incoming.images) !== JSON.stringify(existing.images ?? null)) {
    patch.images = incoming.images;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

async function extractDocsFromMessages(
  ctx: any,
  messages: DocExtractionMessage[],
  conversation: DocExtractionConversation,
  conversation_id: Id<"conversations">,
) {
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.content && msg.content.length > 5000) {
      const headingCount = (msg.content.match(/^#{1,3}\s/gm) || []).length;
      if (headingCount >= 3) {
        const syntheticPath = `inline://${conversation_id}/${Date.now()}`;
        const existing = await ctx.db
          .query("docs")
          .withIndex("by_source_file", (q: any) => q.eq("source_file", syntheticPath))
          .first();
        if (!existing) {
          await ctx.db.insert("docs", {
            user_id: conversation.user_id,
            team_id: conversation.team_id,
            title: extractTitleFromContent(msg.content),
            content: msg.content,
            doc_type: classifyDocContent(msg.content),
            source: "inline_extract",
            source_file: syntheticPath,
            conversation_id,
            project_path: conversation.project_path,
            is_private: conversation.is_private,
            team_visibility: conversation.team_visibility,
            created_at: msg.timestamp || Date.now(),
            updated_at: msg.timestamp || Date.now(),
          });
        }
      }
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.name !== "Write" && tc.name !== "Edit") continue;
        let input: any;
        try { input = JSON.parse(tc.input); } catch { continue; }
        const filePath: string = input.file_path || "";
        if (!filePath.endsWith(".md")) continue;

        const existing = await ctx.db
          .query("docs")
          .withIndex("by_source_file", (q: any) => q.eq("source_file", filePath))
          .first();

        if (tc.name === "Write") {
          const content: string = input.content || "";
          if (content.length < 200) continue;
          const fileName = filePath.split("/").pop() || filePath;
          const docType = fileName.toLowerCase().includes("plan") ? "plan" as const
            : fileName.toLowerCase().includes("design") ? "design" as const
            : fileName.toLowerCase().includes("spec") ? "spec" as const
            : classifyDocContent(content);
          if (existing) {
            await ctx.db.patch(existing._id, {
              title: extractTitleFromContent(content),
              content,
              doc_type: docType,
              updated_at: msg.timestamp || Date.now(),
            });
          } else {
            await ctx.db.insert("docs", {
              user_id: conversation.user_id,
              team_id: conversation.team_id,
              title: extractTitleFromContent(content),
              content,
              doc_type: docType,
              source: "file_sync",
              source_file: filePath,
              conversation_id,
              project_path: conversation.project_path,
              is_private: conversation.is_private,
              team_visibility: conversation.team_visibility,
              created_at: msg.timestamp || Date.now(),
              updated_at: msg.timestamp || Date.now(),
            });
          }
        } else if (tc.name === "Edit" && existing) {
          const oldStr: string = input.old_string || "";
          const newStr: string = input.new_string || "";
          if (!oldStr || !existing.content?.includes(oldStr)) continue;
          const updatedContent = input.replace_all
            ? existing.content.split(oldStr).join(newStr)
            : existing.content.replace(oldStr, newStr);
          await ctx.db.patch(existing._id, {
            title: extractTitleFromContent(updatedContent),
            content: updatedContent,
            updated_at: msg.timestamp || Date.now(),
          });
        }
      }
    }
  }
}

export const getMessageTimestamp = query({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
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
        const patch = buildExistingMessagePatch(existing, {
          role: args.role,
          content: safeContent,
          thinking: safeThinking,
          tool_calls: safeToolCalls,
          tool_results: safeToolResults,
          images: args.images,
          subtype: args.subtype,
        });
        if (patch) {
          await ctx.db.patch(existing._id, patch);
        }
        return existing._id;
      }
    }

    if (args.role === "user") {
      const hasContent = !!safeContent?.trim();
      const hasImages = args.images && args.images.length > 0;
      if (hasContent || hasImages) {
        const recentMessages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (q) =>
            q.eq("conversation_id", args.conversation_id)
          )
          .order("desc")
          .take(5);
        const dup = recentMessages.find(
          (r) =>
            r.role === "user" &&
            redactSecrets(r.content || "").trim() === (safeContent || "").trim() &&
            Math.abs(msgTimestamp - r.timestamp) < (hasContent ? 5 * 60 * 1000 : 30_000)
        );
        if (dup) {
          return dup._id;
        }
      }
    }

    let images = args.images;
    let contentToStore = safeContent;
    let clientIdToStore: string | undefined;
    if (args.role === "user") {
      const pendingMsgs = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
        .collect();
      const c = (safeContent || "").replace(/\[Image[:\s][^\]]*\]/gi, "").trim();
      const cFlat = c.replace(/\s+/g, " ").trim();
      const sorted = [...pendingMsgs].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      const matchingPending = sorted.find(pm => {
        const pc = redactSecrets(pm.content).replace(/\[image\]/gi, "").trim();
        const pcFlat = pc.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
        const contentMatch = cFlat === pcFlat || c === pc;
        if (!contentMatch) return false;
        if (!cFlat && !pcFlat) {
          return Math.abs(msgTimestamp - (pm.created_at || 0)) < 120_000;
        }
        return true;
      });
      if (matchingPending) {
        contentToStore = redactSecrets(matchingPending.content);
        clientIdToStore = matchingPending.client_id;
        if (!images || images.length === 0) {
          const ids = matchingPending.image_storage_ids ?? (matchingPending.image_storage_id ? [matchingPending.image_storage_id] : []);
          if (ids.length > 0) {
            images = ids.map(id => ({ media_type: "image/png", storage_id: id }));
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
      client_id: clientIdToStore,
      timestamp: msgTimestamp,
    });
    const newMessageCount = conversation.message_count + 1;
    const now = Date.now();
    const convPatch: Record<string, unknown> = {
      message_count: newMessageCount,
      updated_at: now,
      last_message_role: args.role,
    };
    if (args.role === "user" && contentToStore?.trim()) {
      convPatch.last_message_preview = redactSecrets(contentToStore).replace(/\[Image[:\s][^\]]*\]/gi, "").trim().slice(0, 200);
      convPatch.last_user_message_at = msgTimestamp;
    } else if (args.role === "user") {
      convPatch.last_user_message_at = msgTimestamp;
    }
    await ctx.db.patch(args.conversation_id, convPatch);

    if (args.role === "assistant") {
      const session = await ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id))
        .first();
      if (session && session.agent_status === "idle") {
        await ctx.db.patch(session._id, {
          agent_status: "working" as const,
          agent_status_updated_at: Date.now(),
        });
      }
    }

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

    try {
      await extractDocsFromMessages(ctx, [args], conversation, args.conversation_id);
    } catch {}

    if (args.role === "user" && safeContent) {
      const planMentions = safeContent.match(/\bpl-[a-z0-9]{3,8}\b/gi);
      if (planMentions) {
        const uniquePlanMentions = [...new Set(planMentions.map(m => m.toLowerCase()))];
        for (const mention of uniquePlanMentions) {
          const plan = await ctx.db
            .query("plans")
            .withIndex("by_short_id", (q) => q.eq("short_id", mention))
            .first();
          if (plan) {
            const convPlanIds = (conversation as any).plan_ids || [];
            if (!convPlanIds.some((pid: any) => pid.toString() === plan._id.toString())) {
              convPlanIds.push(plan._id);
              await ctx.db.patch(args.conversation_id, { plan_ids: convPlanIds });
            }
            const planSessionIds = plan.session_ids || [];
            if (!planSessionIds.some((sid: any) => sid.toString() === args.conversation_id.toString())) {
              planSessionIds.push(args.conversation_id);
              await ctx.db.patch(plan._id, { session_ids: planSessionIds, updated_at: Date.now() });
            }
          }
        }
      }

      const taskMentions = safeContent.match(/\bct-[a-z0-9]{3,8}\b/gi);
      if (taskMentions) {
        const uniqueTaskMentions = [...new Set(taskMentions.map(m => m.toLowerCase()))];
        for (const mention of uniqueTaskMentions) {
          const task = await ctx.db
            .query("tasks")
            .withIndex("by_short_id", (q) => q.eq("short_id", mention))
            .first();
          if (task) {
            const taskConvIds = task.conversation_ids || [];
            if (!taskConvIds.some((cid: any) => cid.toString() === args.conversation_id.toString())) {
              taskConvIds.push(args.conversation_id);
              await ctx.db.patch(task._id, { conversation_ids: taskConvIds });
            }
          }
        }
      }
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
    let lastUserContentStored: string | undefined;

    for (const msg of args.messages) {
      const msgTimestamp = msg.timestamp || Date.now();

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
          const patch = buildExistingMessagePatch(existing, {
            role: msg.role,
            content: safeContent,
            thinking: safeThinking,
            tool_calls: safeToolCalls,
            tool_results: safeToolResults,
            images: msg.images,
            subtype: msg.subtype,
          });
          if (patch) {
            await ctx.db.patch(existing._id, patch);
          }
          ids.push(existing._id);
          continue;
        }
      }

      if (msg.role === "user") {
        const hasContent = !!safeContent?.trim();
        const hasImages = msg.images && msg.images.length > 0;
        if (hasContent || hasImages) {
          const recentMessages = await ctx.db
            .query("messages")
            .withIndex("by_conversation_timestamp", (q) =>
              q.eq("conversation_id", args.conversation_id)
            )
            .order("desc")
            .take(5);
          const dup = recentMessages.find(
            (r) =>
              r.role === "user" &&
              redactSecrets(r.content || "").trim() === (safeContent || "").trim() &&
              Math.abs(msgTimestamp - r.timestamp) < (hasContent ? 5 * 60 * 1000 : 30_000)
          );
          if (dup) {
            // If incoming message has images/tool_results that the existing doesn't, patch them in.
            // This handles the race where a fast sync path stores the message without images,
            // and the image-aware sync arrives later matching by content dedup.
            const patch: Record<string, unknown> = {};
            if (msg.images && msg.images.length > 0 && (!dup.images || dup.images.length === 0)) {
              patch.images = msg.images;
            }
            if (msg.tool_results && msg.tool_results.length > 0 && (!dup.tool_results || dup.tool_results.length === 0)) {
              patch.tool_results = safeToolResults;
            }
            if (Object.keys(patch).length > 0) {
              await ctx.db.patch(dup._id, patch);
            }
            ids.push(dup._id);
            continue;
          }
        }
      }

      let images = msg.images;
      let contentToStore = safeContent;
      let clientIdToStore: string | undefined;
      if (msg.role === "user") {
        const pendingMsgs = await ctx.db
          .query("pending_messages")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
          .collect();
        const c = (safeContent || "").replace(/\[Image[:\s][^\]]*\]/gi, "").trim();
        const cFlat = c.replace(/\s+/g, " ").trim();
        const sorted = [...pendingMsgs].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        const matchingPending = sorted.find(pm => {
          const pc = redactSecrets(pm.content).replace(/\[image\]/gi, "").trim();
          const pcFlat = pc.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
          const contentMatch = cFlat === pcFlat || c === pc;
          if (!contentMatch) return false;
          if (!cFlat && !pcFlat) {
            return Math.abs(msgTimestamp - (pm.created_at || 0)) < 120_000;
          }
          return true;
        });
        if (matchingPending) {
          contentToStore = redactSecrets(matchingPending.content);
          clientIdToStore = matchingPending.client_id;
          if (!images || images.length === 0) {
            const ids = matchingPending.image_storage_ids ?? (matchingPending.image_storage_id ? [matchingPending.image_storage_id] : []);
            if (ids.length > 0) {
              images = ids.map(id => ({ media_type: "image/png", storage_id: id }));
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
        client_id: clientIdToStore,
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
        updated_at: Date.now(),
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

      const hasAssistantMsg = args.messages.some((m) => m.role === "assistant");
      if (hasAssistantMsg) {
        const session = await ctx.db
          .query("managed_sessions")
          .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id))
          .first();
        if (session && session.agent_status === "idle") {
          await ctx.db.patch(session._id, {
            agent_status: "working" as const,
            agent_status_updated_at: Date.now(),
          });
        }
      }

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

    try {
      await extractDocsFromMessages(ctx, args.messages, conversation, args.conversation_id);
    } catch {}

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

function parseSearchTermsServer(query: string): string[] {
  const terms: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    const term = match[1] || match[2];
    if (term) terms.push(term.toLowerCase());
  }
  return terms;
}

function countMatches(content: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = content.toLowerCase();
  let count = 0;
  for (const term of terms) {
    if (!term) continue;
    let pos = 0;
    while ((pos = lower.indexOf(term, pos)) !== -1) {
      count++;
      pos += term.length;
    }
  }
  return count;
}

export const findAllMessagesByContent = query({
  args: {
    conversation_id: v.id("conversations"),
    search_term: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return [];
    const isOwner = authUserId && conversation.user_id.toString() === authUserId.toString();
    const isShared = !!conversation.share_token;
    let hasTeamAccess = false;
    if (authUserId && !isOwner) {
      hasTeamAccess = await canTeamMemberAccess(ctx, authUserId, conversation);
    }
    if (!isOwner && !hasTeamAccess && !isShared) return [];

    const terms = parseSearchTermsServer(args.search_term);
    if (terms.length === 0) return [];

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .collect();

    const matches: { message_id: string; timestamp: number; match_count: number }[] = [];
    for (const msg of messages) {
      if (!msg.content) continue;
      const count = countMatches(msg.content, terms);
      if (count > 0) {
        matches.push({ message_id: msg._id, timestamp: msg.timestamp, match_count: count });
      }
    }
    return matches;
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
