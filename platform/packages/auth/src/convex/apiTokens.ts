// API tokens: mint, hash, verify, revoke, and the device binding.
//
// A token is 32 random bytes as hex, returned once. Only its sha256 hex is
// stored. The pure helpers below take a `{ db }` ctx and are what the tests
// drive; `createApiTokenDefinitions` wraps them into `{ args, handler }`
// definitions the app hands to its own Convex builders and exports from its own
// apiTokens.ts.
import { v } from "convex/values";
import type { GenericId } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { type AuthTables, type DbCtx, resolveTables } from "./tables";

export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// last_used_at is telemetry, not a correctness signal. Refresh it at most this
// often, and only from the single heartbeat call (updateLastUsed=true), never
// from the message hot path. See updateLastUsed below.
export const TOKEN_LAST_USED_THROTTLE_MS = 10 * 60 * 1000;

export const SETUP_TOKEN_TTL_MS = 60 * 60 * 1000;

/** The one hash-and-index lookup every token path shares. */
export async function findTokenDoc(
  ctx: DbCtx,
  token: string,
  tables: AuthTables = resolveTables(),
): Promise<any | null> {
  const tokenHash = await hashToken(token);
  return await ctx.db
    .query(tables.apiTokens)
    .withIndex(tables.apiTokensByHashIndex, (q: any) => q.eq("token_hash", tokenHash))
    .first();
}

export async function verifyApiToken(
  ctx: DbCtx,
  token: string,
  // Default false: every authenticated CLI mutation reads this one api_tokens
  // doc, so writing last_used_at here turned a pure read auth check into a
  // shared document write that ALL of a user's concurrent writes (50+ sessions)
  // read. Patching it forced OCC conflicts across every in-flight write, and
  // under load that compounded into a total write path stall. Auth is now a
  // pure read; only the daemon heartbeat refreshes last_used_at.
  updateLastUsed: boolean = false,
  tables: AuthTables = resolveTables(),
): Promise<{ userId: GenericId<"users">; tokenId: GenericId<"api_tokens"> } | null> {
  const tokenDoc = await findTokenDoc(ctx, token, tables);

  if (!tokenDoc) {
    return null;
  }

  if (tokenDoc.expires_at && tokenDoc.expires_at < Date.now()) {
    return null;
  }

  // The device binding is deliberately NOT checked here. No caller of this
  // function has a device to give it: the app's `cliRoute` asks
  // `deviceBindingAllows` and then DELETES device_id from the body, because the
  // mutations behind those routes validate a closed v.object and reject an
  // unrecognised field. A binding check here would therefore see "no device
  // presented" on every real call and reject every bound token, locking the
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

/**
 * Is this token allowed to act from the device presenting it?
 *
 * This is the ONLY place the binding is enforced. The app's `cliRoute` calls
 * it once for every route it declares, so those routes cannot forget it. The
 * route that gets forgotten is always the newest one.
 *
 * Returns true for an unknown token as well: this answers only the device
 * question, and the handler's own `verifyApiToken` is what rejects a bad token.
 * Returning false here would report a bad token as a device mismatch and send
 * whoever reads the error to the wrong machine.
 *
 * Wrapped as an internal query on purpose. Wire callable, this would answer
 * "is this token real, and which machine is it tied to?" for anyone who reaches
 * the deployment.
 */
export async function deviceBindingAllows(
  ctx: DbCtx,
  args: { api_token: string; device_id?: string },
  tables: AuthTables = resolveTables(),
): Promise<boolean> {
  const tokenDoc = await findTokenDoc(ctx, args.api_token, tables);
  if (!tokenDoc) return true;
  if (!tokenDoc.device_id) return true; // unbound: every token minted before this existed
  // A bound token presented with no device_id fails here too. Treating a
  // missing field as "not applicable" would make the check opt out by
  // omission, and a thief would simply stop sending it.
  return tokenDoc.device_id === args.device_id;
}

/** Exchange a one hour setup token for a long lived token. Pure; exported for tests. */
export async function exchangeSetupTokenFor(
  ctx: DbCtx,
  setupToken: string,
  tables: AuthTables = resolveTables(),
): Promise<{ auth_token: string; user_id: GenericId<"users"> } | null> {
  const tokenDoc = await findTokenDoc(ctx, setupToken, tables);

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

  await ctx.db.insert(tables.apiTokens, {
    user_id: tokenDoc.user_id,
    token_hash: newTokenHash,
    name: `CLI - ${new Date(now).toISOString().split("T")[0]}`,
    created_at: now,
    last_used_at: now,
  });

  return { auth_token: newToken, user_id: tokenDoc.user_id };
}

export type ApiTokenEvent =
  | { name: "cli_authed"; userId: string; method: "browser" | "setup_token" }
  | { name: "setup_token_generated"; userId: string };

/** One row of `listTokens`. The plaintext token is never part of it. */
export type ApiTokenSummary = {
  _id: GenericId<string>;
  name: string;
  created_at: number;
  last_used_at: number;
  expires_at?: number;
};

export type ApiTokenDefinitionParams<Extras extends Record<string, unknown> = Record<string, unknown>> = {
  tables?: Partial<AuthTables>;
  /**
   * Funnel hook: called after a token mint or a setup token exchange. Codecast
   * schedules its analytics capture here. Runs inside the mutation, so use the
   * scheduler for anything that can fail.
   */
  onEvent?: (ctx: any, event: ApiTokenEvent) => Promise<void>;
  /**
   * Extra fields returned from `exchangeSetupToken` alongside auth_token and
   * user_id. Codecast adds `team_id` from the user row and `convex_url`. The
   * fields it returns are part of the exchange return type, so the app keeps
   * its own typing on them.
   */
  exchangeExtras?: (ctx: any, userId: GenericId<"users">) => Promise<Extras>;
};

export type ApiTokenFunctionsParams<Extras extends Record<string, unknown> = Record<string, unknown>> =
  ApiTokenDefinitionParams<Extras> & {
    /** The app's Convex function builders. Pass the wrapped ones if the app has them. */
    mutation: any;
    query: any;
    internalMutation: any;
    internalQuery: any;
  };

/**
 * The token functions as plain Convex definitions, grouped by the builder each
 * one needs. This is the form to use. The app calls its own builders:
 *
 *   const defs = createApiTokenDefinitions({ onEvent, exchangeExtras });
 *   export const createToken = mutation(defs.mutations.createToken);
 *   export const listTokens = query(defs.queries.listTokens);
 *   export const exchangeSetupToken = internalMutation(defs.internalMutations.exchangeSetupToken);
 *   export const deviceBindingAllows = internalQuery(defs.internalQueries.deviceBindingAllows);
 *
 * Convex's builder is generic over its own args validator, so handing it
 * through an injected function loses that inference: every built function falls
 * back to `any`, `ApiFromModules` then drops the whole module, and
 * `api.apiTokens.*` stops existing for callers. Calling the builder at the app
 * keeps it. Same reason as `createDispatchDefinition` in engine-convex.
 *
 * The grouping is not decoration. It names the visibility each function must be
 * registered at, and one of those is a security boundary: wire callable,
 * `deviceBindingAllows` would answer "is this token real, and which machine is
 * it tied to?" for anyone who reaches the deployment.
 */
export function createApiTokenDefinitions<Extras extends Record<string, unknown> = Record<string, unknown>>(
  params: ApiTokenDefinitionParams<Extras> = {},
) {
  const tables = resolveTables(params.tables);
  const onEvent = params.onEvent ?? (async () => {});
  const exchangeExtras = params.exchangeExtras ?? (async () => ({}) as Extras);

  const createToken = {
    args: {
      name: v.string(),
    },
    handler: async (ctx: any, args: { name: string }) => {
      const userId = await getAuthUserId(ctx);
      if (!userId) {
        throw new Error("Unauthorized: must be logged in to create API token");
      }

      const token = generateToken();
      const tokenHash = await hashToken(token);
      const now = Date.now();

      await ctx.db.insert(tables.apiTokens, {
        user_id: userId,
        token_hash: tokenHash,
        name: args.name,
        created_at: now,
        last_used_at: now,
      });

      // Funnel: the only caller is the authorize page, so a token mint here IS a
      // completed browser based CLI auth.
      await onEvent(ctx, { name: "cli_authed", userId: userId.toString(), method: "browser" });

      return { token, userId };
    },
  };

  const createSetupToken = {
    args: {},
    handler: async (ctx: any) => {
      const userId = await getAuthUserId(ctx);
      if (!userId) {
        throw new Error("Unauthorized: must be logged in to create setup token");
      }

      const token = generateToken();
      const tokenHash = await hashToken(token);
      const now = Date.now();
      const expiresAt = now + SETUP_TOKEN_TTL_MS;

      await ctx.db.insert(tables.apiTokens, {
        user_id: userId,
        token_hash: tokenHash,
        name: `setup-${now}`,
        created_at: now,
        last_used_at: now,
        expires_at: expiresAt,
      });

      await onEvent(ctx, { name: "setup_token_generated", userId: userId.toString() });

      return { token, expiresAt };
    },
  };

  // No `createTokenForUser` and no public `verifyToken` live here, on purpose.
  // The first minted a token for any supplied user id without authenticating
  // anyone; the second was a bearer credential oracle. Every real path goes
  // through the authenticated mutations above or `verifyApiToken` in process.

  const listTokens = {
    args: {},
    handler: async (ctx: any): Promise<ApiTokenSummary[]> => {
      const userId = await getAuthUserId(ctx);
      if (!userId) {
        return [];
      }

      const tokens = await ctx.db
        .query(tables.apiTokens)
        .withIndex(tables.apiTokensByUserIndex, (q: any) => q.eq("user_id", userId))
        .collect();

      return tokens.map((t: any) => ({
        _id: t._id,
        name: t.name,
        created_at: t.created_at,
        last_used_at: t.last_used_at,
        expires_at: t.expires_at,
      }));
    },
  };

  const revokeToken = {
    args: {
      token_id: v.id(tables.apiTokens),
    },
    handler: async (ctx: any, args: { token_id: any }) => {
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
  };

  const renameToken = {
    args: {
      token_id: v.id(tables.apiTokens),
      name: v.string(),
    },
    handler: async (ctx: any, args: { token_id: any; name: string }) => {
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
  };

  const exchangeSetupToken = {
    args: {
      setupToken: v.string(),
    },
    handler: async (
      ctx: any,
      args: { setupToken: string },
    ): Promise<({ auth_token: string; user_id: GenericId<"users"> } & Extras) | null> => {
      const exchanged = await exchangeSetupTokenFor(ctx, args.setupToken, tables);
      if (!exchanged) return null;

      // Funnel: a setup token exchange is a completed `cast login <token>`.
      await onEvent(ctx, {
        name: "cli_authed",
        userId: exchanged.user_id.toString(),
        method: "setup_token",
      });

      return { ...exchanged, ...(await exchangeExtras(ctx, exchanged.user_id)) };
    },
  };

  const deviceBindingAllowsQuery = {
    args: {
      api_token: v.string(),
      device_id: v.optional(v.string()),
    },
    handler: async (ctx: any, args: { api_token: string; device_id?: string }): Promise<boolean> =>
      deviceBindingAllows(ctx, args, tables),
  };

  return {
    mutations: { createToken, createSetupToken, revokeToken, renameToken },
    queries: { listTokens },
    internalMutations: { exchangeSetupToken },
    internalQueries: { deviceBindingAllows: deviceBindingAllowsQuery },
  };
}

/**
 * The older form: this package calls the app's builders for it.
 *
 * Everything it returns is `any`, because the builders arrive as parameters and
 * Convex's inference does not survive the trip. An app on this form must state
 * the wire contract of each export by hand, or `api.apiTokens.*` will not
 * exist. Prefer `createApiTokenDefinitions` above.
 *
 *   export const { createToken, createSetupToken, listTokens, revokeToken,
 *     renameToken, exchangeSetupToken, deviceBindingAllows } = makeApiTokenFunctions({...});
 */
export function makeApiTokenFunctions<Extras extends Record<string, unknown> = Record<string, unknown>>(
  params: ApiTokenFunctionsParams<Extras>,
) {
  const { mutation, query, internalMutation, internalQuery } = params;
  const defs = createApiTokenDefinitions<Extras>(params);

  return {
    createToken: mutation(defs.mutations.createToken),
    createSetupToken: mutation(defs.mutations.createSetupToken),
    listTokens: query(defs.queries.listTokens),
    revokeToken: mutation(defs.mutations.revokeToken),
    renameToken: mutation(defs.mutations.renameToken),
    exchangeSetupToken: internalMutation(defs.internalMutations.exchangeSetupToken),
    deviceBindingAllows: internalQuery(defs.internalQueries.deviceBindingAllows),
  };
}
