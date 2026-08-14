import { mutation, query, internalMutation, internalQuery } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

const CONVEX_URL = process.env.CONVEX_CLOUD_ORIGIN || process.env.CONVEX_CLOUD_URL || process.env.VITE_CONVEX_URL || "";

export async function hashToken(token: string): Promise<string> {
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

    // Funnel: the only caller is the /auth/cli authorize page, so a token mint
    // here IS a completed browser-based `cast auth`.
    await ctx.scheduler.runAfter(0, internal.analytics.capture, {
      event: "cli_authed",
      distinctId: userId.toString(),
      properties: { method: "browser" },
    });

    return { token, userId };
  },
});

export const createSetupToken = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized: must be logged in to create setup token");
    }

    const token = generateToken();
    const tokenHash = await hashToken(token);
    const now = Date.now();
    const expiresAt = now + 60 * 60 * 1000;

    await ctx.db.insert("api_tokens", {
      user_id: userId,
      token_hash: tokenHash,
      name: `setup-${now}`,
      created_at: now,
      last_used_at: now,
      expires_at: expiresAt,
    });

    await ctx.scheduler.runAfter(0, internal.analytics.capture, {
      event: "setup_token_generated",
      distinctId: userId.toString(),
    });

    return { token, expiresAt };
  },
});

// NOTE: a public `createTokenForUser({ user_id, name })` mutation used to live
// here. It authenticated nobody and minted a working plaintext token for any
// supplied user_id — a one-call account takeover. It had zero callers (the CLI
// mints tokens through the authenticated relay in cliAuth.ts / createToken
// above). Removed rather than internalized: nothing should ever mint a token
// for an arbitrary user without the caller proving they are that user.

// NOTE: a public `verifyToken({ token })` mutation used to live here. It took
// any token string and answered {userId, tokenId} when the token was valid.
// This backend has no global auth gate, so anyone able to reach the deployment
// could call it and learn whether a token was live and whose it was — a bearer
// credential oracle with no authenticated caller behind it. It had zero callers:
// every real path goes through `verifyApiToken` below, which is deliberately a
// pure read. Removed rather than internalized, because `verifyApiToken` already
// serves every in-process caller and a wire-callable twin only re-opens this.

export const listTokens = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const tokens = await (ctx.db
      .query("api_tokens") as any)
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();

    return tokens.map((t: any) => ({
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

// last_used_at is telemetry, not a correctness signal. Refresh it at most this
// often, and only from the single daemonHeartbeat call (updateLastUsed=true) —
// never from the message hot path. See updateLastUsed below.
const TOKEN_LAST_USED_THROTTLE_MS = 10 * 60 * 1000;

/** The one hash-and-index lookup every token path shares. */
async function findTokenDoc(ctx: { db: any }, token: string): Promise<any | null> {
  const tokenHash = await hashToken(token);
  return await ctx.db
    .query("api_tokens")
    .withIndex("by_token_hash", (q: any) => q.eq("token_hash", tokenHash))
    .first();
}

export async function verifyApiToken(
  ctx: { db: any },
  token: string,
  // Default false: every authenticated CLI mutation reads this one api_tokens
  // doc, so writing last_used_at here turned a pure-read auth check into a
  // shared-doc write that ALL of a user's concurrent writes (50+ sessions)
  // read. Patching it forced OCC conflicts across every in-flight write, and
  // under load that compounded into a total write-path stall. Auth is now a
  // pure read; only daemonHeartbeat (one call / 30s) refreshes last_used_at.
  updateLastUsed: boolean = false
): Promise<{ userId: Id<"users">; tokenId: Id<"api_tokens"> } | null> {
  const tokenDoc = await findTokenDoc(ctx, token);

  if (!tokenDoc) {
    return null;
  }

  if (tokenDoc.expires_at && tokenDoc.expires_at < Date.now()) {
    return null;
  }

  // The device binding is deliberately NOT checked here. No caller of this
  // function has a device to give it: `cliRoute` (http.ts) asks
  // `deviceBindingAllows` and then DELETES device_id from the body, because the
  // mutations behind those routes validate a closed v.object and reject an
  // unrecognised field. A binding check here would therefore see "no device
  // presented" on every real call and reject every bound token — locking the
  // owner out of their own CLI the first time `cast auth` mints one.

  if (updateLastUsed && Date.now() - (tokenDoc.last_used_at || 0) > TOKEN_LAST_USED_THROTTLE_MS) {
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

export const exchangeSetupToken = internalMutation({
  args: {
    setupToken: v.string(),
  },
  handler: async (ctx, args) => {
    const tokenDoc = await findTokenDoc(ctx, args.setupToken);

    if (!tokenDoc) {
      return null;
    }

    if (tokenDoc.expires_at && tokenDoc.expires_at < Date.now()) {
      await ctx.db.delete(tokenDoc._id);
      return null;
    }

    if (!tokenDoc.name.startsWith("setup-")) {
      return null;
    }

    await ctx.db.delete(tokenDoc._id);

    const newToken = generateToken();
    const newTokenHash = await hashToken(newToken);
    const now = Date.now();

    await ctx.db.insert("api_tokens", {
      user_id: tokenDoc.user_id,
      token_hash: newTokenHash,
      name: `CLI - ${new Date(now).toISOString().split("T")[0]}`,
      created_at: now,
      last_used_at: now,
    });

    // Funnel: a setup-token exchange is a completed `cast login <token>`.
    await ctx.scheduler.runAfter(0, internal.analytics.capture, {
      event: "cli_authed",
      distinctId: tokenDoc.user_id.toString(),
      properties: { method: "setup_token" },
    });

    const user = await ctx.db.get(tokenDoc.user_id);
    const userDoc = user as { team_id?: string } | null;

    return {
      auth_token: newToken,
      user_id: tokenDoc.user_id,
      team_id: userDoc?.team_id,
      convex_url: CONVEX_URL,
    };
  },
});

/**
 * Is this token allowed to act from the device presenting it?
 *
 * This is the ONLY place the binding is enforced. `cliRoute` calls it once for
 * every route it declares, so those routes cannot forget it — and the route that
 * gets forgotten is always the newest one.
 *
 * Coverage today is 122 of the 172 `/cli/*` routes: the other 50 are declared
 * with a bare `http.route` and never reach this gate, `/cli/heartbeat` and
 * `/cli/fork` among them. A bound token still works from any machine on those,
 * so the binding is a partial control until they route through `cliRoute` too.
 *
 * Returns true for an unknown token as well: this answers only the device
 * question, and the handler's own `verifyApiToken` is what rejects a bad token.
 * Returning false here would report a bad token as a device mismatch and send
 * whoever reads the error to the wrong machine.
 *
 * Internal on purpose. Wire-callable, this would answer "is this token real, and
 * which machine is it tied to?" for anyone who reaches the deployment — the same
 * credential oracle the removed `verifyToken` mutation was.
 */
export const deviceBindingAllows = internalQuery({
  args: {
    api_token: v.string(),
    device_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const tokenDoc = await findTokenDoc(ctx, args.api_token);
    if (!tokenDoc) return true;
    if (!tokenDoc.device_id) return true; // unbound: every token minted before this existed
    // A bound token presented with no device_id fails here too. Treating a
    // missing field as "not applicable" would make the check opt-out by
    // omission, and a thief would simply stop sending it.
    return tokenDoc.device_id === args.device_id;
  },
});
