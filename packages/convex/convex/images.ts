import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { checkConversationAccess } from "./privacy";

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

// Guest verification scan cap: how many of a conversation's messages we're
// willing to read to prove requested storage ids belong to it. Images past
// this depth in a single conversation stay unresolved for guests.
const GUEST_IMAGE_SCAN_CAP = 5000;

export const getImageUrls = query({
  args: {
    storageIds: v.array(v.id("_storage")),
    api_token: v.optional(v.string()),
    // Share-scope fallback for unauthenticated viewers: a guest on a public
    // share link names the conversation the ids came from. Ignored for
    // authenticated callers.
    conversation_id: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (userId) {
      const urls: Record<string, string | null> = {};
      for (const id of args.storageIds) {
        urls[id] = await ctx.storage.getUrl(id);
      }
      return urls;
    }
    // Unauthenticated without a share scope: null (not {}) so the client can
    // tell "not signed in yet" from "these storage objects don't exist" — an
    // empty object would make it cache every requested id as missing and
    // silently hide the images all session.
    if (!args.conversation_id) return null;
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;
    if ((await checkConversationAccess(ctx, null, conversation)) === "denied") return null;
    // Resolve only ids that verifiably belong to the shared conversation —
    // membership is proven by scanning its messages' inline image attachments
    // (the only place storage-backed transcript images live). Early exit once
    // every requested id is found; typical transcripts have few image rows.
    const wanted = new Set<string>(args.storageIds.map((id) => id.toString()));
    const verified = new Set<string>();
    let scanned = 0;
    for await (const msg of ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id!)
      )) {
      if (++scanned > GUEST_IMAGE_SCAN_CAP) break;
      for (const img of msg.images ?? []) {
        if (img.storage_id && wanted.has(img.storage_id.toString())) {
          verified.add(img.storage_id.toString());
        }
      }
      if (verified.size === wanted.size) break;
    }
    // Unverified ids resolve to null — a definitive "not part of this share"
    // verdict (cached in memory, never persisted), not a transient miss.
    const urls: Record<string, string | null> = {};
    for (const id of args.storageIds) {
      urls[id] = verified.has(id.toString()) ? await ctx.storage.getUrl(id) : null;
    }
    return urls;
  },
});
