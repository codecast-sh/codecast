import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";

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

export const generateUploadUrl = mutation({
  args: {
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) {
      throw new Error("Authentication required");
    }
    return await ctx.storage.generateUploadUrl();
  },
});

export const getImageUrl = query({
  args: {
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

export const getImageUrls = query({
  args: {
    storageIds: v.array(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const urls: Record<string, string | null> = {};
    for (const id of args.storageIds) {
      urls[id] = await ctx.storage.getUrl(id);
    }
    return urls;
  },
});

export const debugMessagesWithImages = query({
  args: {
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let messages;
    if (args.conversation_id) {
      messages = await ctx.db.query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", args.conversation_id as Id<"conversations">)
        )
        .collect();
    } else {
      messages = await ctx.db.query("messages").order("desc").take(2000);
    }
    const withImages = messages.filter(m => m.images && m.images.length > 0);
    return {
      totalChecked: messages.length,
      withImages: withImages.length,
      samples: withImages.slice(0, 5).map(m => ({
        id: m._id,
        imagesCount: m.images?.length,
        images: m.images?.map(i => ({
          hasStorageId: !!i.storage_id,
          hasData: !!i.data,
          mediaType: i.media_type,
          toolUseId: i.tool_use_id || null,
        })),
        role: m.role,
        conversationId: m.conversation_id,
      })),
    };
  },
});
