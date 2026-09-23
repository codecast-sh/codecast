// API tokens: mint, hash, verify, revoke, and the device binding.
//
// A token is 32 random bytes as hex, returned once. Only its sha256 hex is
// stored. The pure helpers below take a `{ db }` ctx and are what the tests
// drive; `createApiTokenDefinitions` wraps them into `{ args, handler }`
// definitions the app hands to its own Convex builders and exports from its own
// apiTokens.ts.
//
// Device binding. A mint that names a device stores that device on the row and
// hands back a secret marked with DEVICE_BOUND_TOKEN_PREFIX (tokenFormat.ts).
// From then on the token authenticates only when it arrives as
// `<secret>.<device_id>` with the device the row names. The check lives in
// `verifyApiToken`, which every authenticated function calls, so it holds on
// both doors: a direct Convex call and an HTTP route through the app's
// `cliRoute`. The HTTP edge asks `deviceBindingAllows` first only to answer a
// wrong machine with a 403 and a pointer to `cast auth` instead of a bare 401.
// A row with no device is unbound and behaves exactly as it always has, which
// is what makes the rollout migration free: no existing token changes on the
// wire, and a bound token exists only where a client that presents devices
// asked for one.
import { v } from "convex/values";
import type { GenericId } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { type AuthTables, type DbCtx, resolveTables } from "./tables";
import { DEVICE_BOUND_TOKEN_PREFIX, splitPresentedToken } from "../tokenFormat";

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

/**
 * A fresh long lived token row for `userId`, bound to `deviceId` when one is
 * given. The one place a bearer secret is minted, so the mark and the stored
 * device can never disagree: a marked secret always has a device on its row,
 * and a row with a device always handed out a marked secret.
 */
async function mintBearerToken(
  ctx: DbCtx,
  userId: GenericId<"users">,
  name: string,
  deviceId: string | undefined,
  tables: AuthTables,
): Promise<string> {
  const token = `${deviceId ? DEVICE_BOUND_TOKEN_PREFIX : ""}${generateToken()}`;
  const now = Date.now();
  await ctx.db.insert(tables.apiTokens, {
    user_id: userId,
    token_hash: await hashToken(token),
    name,
    created_at: now,
    last_used_at: now,
    ...(deviceId ? { device_id: deviceId } : {}),
  });
  return token;
}

// last_used_at is telemetry, not a correctness signal. Refresh it at most this
// often, and only from the single heartbeat call (updateLastUsed=true), never
// from the message hot path. See updateLastUsed below.
export const TOKEN_LAST_USED_THROTTLE_MS = 10 * 60 * 1000;

export const SETUP_TOKEN_TTL_MS = 60 * 60 * 1000;

const SETUP_TOKEN_PREFIX = "setup-";

function isSetupToken(tokenDoc: { name: string }): boolean {
  return tokenDoc.name.startsWith(SETUP_TOKEN_PREFIX);
}

/**
 * The one hash-and-index lookup every token path shares. Takes the token as it
 * arrived on the wire: a presented device id is split off before hashing, so a
 * bound token's row is found whether or not the client presented one.
 */
export async function findTokenDoc(
  ctx: DbCtx,
  token: string,
  tables: AuthTables = resolveTables(),
): Promise<any | null> {
  const tokenHash = await hashToken(splitPresentedToken(token).secret);
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

  // A setup token is a one hour voucher for `exchangeSetupTokenFor` and
  // nothing else. It must never act as the account's bearer credential.
  if (isSetupToken(tokenDoc)) {
    return null;
  }

  // The device binding, enforced where every authenticated function already
  // passes through. The device arrives inside `token` itself (tokenFormat.ts),
  // which is why this check can live here: a direct Convex call and an HTTP
  // route forward `api_token` alike, and neither needs a field its closed
  // validator does not name. A bound token presented with no device fails
  // too; treating the omission as "not applicable" would let a thief opt out
  // by sending less.
  if (!deviceBindingAllowsDoc(tokenDoc, token)) {
    return null;
  }

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

/** The binding rule itself, on a row already looked up: unbound rows allow everything. */
function deviceBindingAllowsDoc(tokenDoc: { device_id?: string }, presented: string): boolean {
  if (!tokenDoc.device_id) return true; // unbound: every token minted before this existed
  return tokenDoc.device_id === splitPresentedToken(presented).deviceId;
}

/**
 * Is this token allowed to act from the device presenting it?
 *
 * The same rule `verifyApiToken` enforces, asked ahead of the handler by the
 * app's `cliRoute` so a request from the wrong machine gets a 403 that names
 * the fix instead of the bare 401 authentication would give it. The handler
 * still authenticates on its own; this is the better error, not the fence.
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
  args: { api_token: string },
  tables: AuthTables = resolveTables(),
): Promise<boolean> {
  const tokenDoc = await findTokenDoc(ctx, args.api_token, tables);
  if (!tokenDoc) return true;
  return deviceBindingAllowsDoc(tokenDoc, args.api_token);
}

/**
 * Exchange a one hour setup token for a long lived token, bound to `deviceId`
 * when the redeeming machine names itself. Pure; exported for tests.
 */
export async function exchangeSetupTokenFor(
  ctx: DbCtx,
  setupToken: string,
  tables: AuthTables = resolveTables(),
  deviceId?: string,
): Promise<{ auth_token: string; user_id: GenericId<"users"> } | null> {
  const tokenDoc = await findTokenDoc(ctx, setupToken, tables);

  if (!tokenDoc) {
    return null;
  }

  if (tokenDoc.expires_at && tokenDoc.expires_at < Date.now()) {
    await ctx.db.delete(tokenDoc._id);
    return null;
  }

  if (!isSetupToken(tokenDoc)) {
    return null;
  }

  await ctx.db.delete(tokenDoc._id);

  const newToken = await mintBearerToken(
    ctx,
    tokenDoc.user_id,
    `CLI - ${new Date().toISOString().split("T")[0]}`,
    deviceId,
    tables,
  );

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
      // The machine the token is for, carried from the CLI through the
      // authorize page. Present, the token binds to it; absent (an older CLI,
      // the desktop sign in), the token is unbound as before.
      device_id: v.optional(v.string()),
    },
    handler: async (ctx: any, args: { name: string; device_id?: string }) => {
      const userId = await getAuthUserId(ctx);
      if (!userId) {
        throw new Error("Unauthorized: must be logged in to create API token");
      }

      const token = await mintBearerToken(ctx, userId, args.name, args.device_id, tables);

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
        name: `${SETUP_TOKEN_PREFIX}${now}`,
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
      // The name is what marks a setup voucher, so a rename must never move a
      // token across that line in either direction.
      if (isSetupToken(token) || args.name.startsWith(SETUP_TOKEN_PREFIX)) {
        throw new Error("Setup tokens cannot be renamed");
      }

      await ctx.db.patch(args.token_id, { name: args.name });
    },
  };

  const exchangeSetupToken = {
    args: {
      setupToken: v.string(),
      device_id: v.optional(v.string()),
    },
    handler: async (
      ctx: any,
      args: { setupToken: string; device_id?: string },
    ): Promise<({ auth_token: string; user_id: GenericId<"users"> } & Extras) | null> => {
      const exchanged = await exchangeSetupTokenFor(ctx, args.setupToken, tables, args.device_id);
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
    },
    handler: async (ctx: any, args: { api_token: string }): Promise<boolean> =>
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
