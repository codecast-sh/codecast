import { mutation, query } from "./functions";
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

// Auth (cookie or api_token) is required: an unauthenticated caller gets null.
// A storage id is an unguessable, random handle that only ever reaches a client
// through a conversation/message it already had access to, so requiring auth
// stops an anonymous internet client from resolving signed URLs by id while
// legitimate viewers keep working. The api_token arg exists for the daemon —
// its convex client carries no cookie session, so its downloadImage otherwise
// resolved null and web-sent images were silently dropped from tmux injection.
export const getImageUrl = query({
  args: {
    storageId: v.id("_storage"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    return await ctx.storage.getUrl(args.storageId);
  },
});

export const getImageUrls = query({
  args: {
    storageIds: v.array(v.id("_storage")),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    // null (not {}) so the client can tell "not signed in yet" from "these
    // storage objects don't exist" — an empty object would make it cache every
    // requested id as missing and silently hide the images all session.
    if (!userId) return null;
    const urls: Record<string, string | null> = {};
    for (const id of args.storageIds) {
      urls[id] = await ctx.storage.getUrl(id);
    }
    return urls;
  },
});
