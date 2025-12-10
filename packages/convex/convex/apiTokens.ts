import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const createToken = mutation({
  args: {
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized: must be logged in to create API token");
    }

    const token = generateToken();
    const tokenHash = await hashToken(token);
    const now = Date.now();

    await ctx.db.insert("api_tokens", {
      user_id: userId,
      token_hash: tokenHash,
      name: args.name,
      created_at: now,
      last_used_at: now,
    });

    return { token, userId };
  },
});

export const verifyToken = mutation({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const tokenHash = await hashToken(args.token);
    const tokenDoc = await ctx.db
      .query("api_tokens")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", tokenHash))
      .first();

    if (!tokenDoc) {
      return null;
    }

    if (tokenDoc.expires_at && tokenDoc.expires_at < Date.now()) {
      return null;
    }

    await ctx.db.patch(tokenDoc._id, {
      last_used_at: Date.now(),
    });

    return {
      userId: tokenDoc.user_id,
      tokenId: tokenDoc._id,
    };
  },
});

export const listTokens = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const tokens = await ctx.db
      .query("api_tokens")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();

    return tokens.map((t) => ({
      _id: t._id,
      name: t.name,
      created_at: t.created_at,
      last_used_at: t.last_used_at,
      expires_at: t.expires_at,
    }));
  },
});

export const revokeToken = mutation({
  args: {
    token_id: v.id("api_tokens"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized");
    }

    const token = await ctx.db.get(args.token_id);
    if (!token || token.user_id !== userId) {
      throw new Error("Token not found");
    }

    await ctx.db.delete(args.token_id);
  },
});

export const renameToken = mutation({
  args: {
    token_id: v.id("api_tokens"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized");
    }

    const token = await ctx.db.get(args.token_id);
    if (!token || token.user_id !== userId) {
      throw new Error("Token not found");
    }

    await ctx.db.patch(args.token_id, { name: args.name });
  },
});

export async function verifyApiToken(
  ctx: { db: any },
  token: string,
  updateLastUsed: boolean = true
): Promise<{ userId: Id<"users">; tokenId: Id<"api_tokens"> } | null> {
  const tokenHash = await hashToken(token);
  const tokenDoc = await ctx.db
    .query("api_tokens")
    .withIndex("by_token_hash", (q: any) => q.eq("token_hash", tokenHash))
    .first();

  if (!tokenDoc) {
    return null;
  }

  if (tokenDoc.expires_at && tokenDoc.expires_at < Date.now()) {
    return null;
  }

  if (updateLastUsed) {
    try {
      await ctx.db.patch(tokenDoc._id, {
        last_used_at: Date.now(),
      });
    } catch {
      // Ignore - may be in a query context where writes aren't allowed
    }
  }

  return {
    userId: tokenDoc.user_id,
    tokenId: tokenDoc._id,
  };
}
