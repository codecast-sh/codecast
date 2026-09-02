// Server mediated half of the CLI auth flow, for CLIs the browser can't reach.
//
// The primary auth path has the browser POST the freshly minted token to the
// CLI's localhost listener. That assumes browser and CLI share a machine,
// which is false for SSH'd boxes, where the loopback POST lands on the user's
// laptop and fails. When that happens the web page deposits the token here
// instead, keyed by a hash of the CLI's one time nonce, and the CLI (which
// polls /cli/claim-auth alongside its localhost wait) claims it. Rows are
// single use and short lived: deleted on claim, or swept, with their orphaned
// api token revoked, after the relay TTL.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { hashToken } from "./apiTokens";
import { type AuthTables, type DbCtx, resolveTables } from "./tables";

export const CLI_AUTH_TTL_MS = 10 * 60 * 1000;

// Exported for tests; ctx is the standard mutation ctx shape.
export async function claimCliAuthRequest(
  ctx: DbCtx,
  nonce: string,
  now: number = Date.now(),
  ttlMs: number = CLI_AUTH_TTL_MS,
  tables: AuthTables = resolveTables(),
): Promise<{ user_id: string; auth_token: string } | null> {
  const nonceHash = await hashToken(nonce);
  const row = await ctx.db
    .query(tables.cliAuthRequests)
    .withIndex(tables.cliAuthRequestsByNonceIndex, (q: any) => q.eq("nonce_hash", nonceHash))
    .first();

  if (!row) return null;

  // Single use: the row dies on first claim, fresh or stale.
  await ctx.db.delete(row._id);

  if (now - row.created_at > ttlMs) return null;

  return { user_id: row.user_id, auth_token: row.token };
}

// Exported for tests. Desktop redemption of a relay deposit: same single use
// claim as the CLI, except the desktop app wants a first class auth session,
// not an api token. So the relayed token is consumed (deleted) in the same
// transaction and only the user id travels on to the auth provider. Nothing
// long lived is left behind: a completed desktop sign-in leaves no api_tokens
// row, and an abandoned one is revoked by the existing sweep.
export async function claimDesktopAuthExchange(
  ctx: DbCtx,
  nonce: string,
  now: number = Date.now(),
  ttlMs: number = CLI_AUTH_TTL_MS,
  tables: AuthTables = resolveTables(),
): Promise<{ userId: string } | null> {
  const claimed = await claimCliAuthRequest(ctx, nonce, now, ttlMs, tables);
  if (!claimed) return null;

  // deposit() verified the token existed and belonged to the depositor; a
  // missing or mismatched row now means it was revoked since. Refuse.
  const tokenHash = await hashToken(claimed.auth_token);
  const tokenDoc = await ctx.db
    .query(tables.apiTokens)
    .withIndex(tables.apiTokensByHashIndex, (q: any) => q.eq("token_hash", tokenHash))
    .first();
  if (!tokenDoc || tokenDoc.user_id !== claimed.user_id) return null;
  await ctx.db.delete(tokenDoc._id);

  return { userId: claimed.user_id };
}

// Exported for tests; deletes expired relay rows and revokes the tokens they
// carried. An unclaimed deposit means the credential was never delivered
// anywhere, so it must not stay live in api_tokens.
export async function sweepExpiredCliAuthRequests(
  ctx: DbCtx,
  now: number = Date.now(),
  ttlMs: number = CLI_AUTH_TTL_MS,
  tables: AuthTables = resolveTables(),
): Promise<number> {
  const cutoff = now - ttlMs;
  const expired = await ctx.db
    .query(tables.cliAuthRequests)
    .withIndex(tables.cliAuthRequestsByCreatedIndex, (q: any) => q.lt("created_at", cutoff))
    .take(50);

  for (const row of expired) {
    const tokenHash = await hashToken(row.token);
    const tokenDoc = await ctx.db
      .query(tables.apiTokens)
      .withIndex(tables.apiTokensByHashIndex, (q: any) => q.eq("token_hash", tokenHash))
      .first();
    if (tokenDoc) {
      await ctx.db.delete(tokenDoc._id);
    }
    await ctx.db.delete(row._id);
  }

  return expired.length;
}

export type CliAuthFunctionsParams = {
  mutation: any;
  internalMutation: any;
  query: any;
  tables?: Partial<AuthTables>;
  /** How long a deposit stays claimable. Default 10 minutes. */
  ttlMs?: number;
};

/**
 * Build the relay's Convex functions. The app exports them from its cliAuth.ts:
 *
 *   export const { deposit, claim, pendingDeposit, claimForDesktop, sweepExpired } =
 *     makeCliAuthFunctions({ mutation, internalMutation, query });
 *
 * and hands `internal.cliAuth.claimForDesktop` to `desktopRelayProvider`.
 */
export function makeCliAuthFunctions(params: CliAuthFunctionsParams) {
  const tables = resolveTables(params.tables);
  const ttlMs = params.ttlMs ?? CLI_AUTH_TTL_MS;
  const { mutation, internalMutation, query } = params;

  const deposit = mutation({
    args: {
      nonce: v.string(),
      token: v.string(),
      device_name: v.string(),
    },
    handler: async (ctx: any, args: { nonce: string; token: string; device_name: string }) => {
      const userId = await getAuthUserId(ctx);
      if (!userId) {
        throw new Error("Unauthorized: must be logged in to relay CLI auth");
      }

      // Only relay a token that exists and belongs to the depositor. The relay
      // must not become a way to plant arbitrary credentials.
      const tokenHash = await hashToken(args.token);
      const tokenDoc = await ctx.db
        .query(tables.apiTokens)
        .withIndex(tables.apiTokensByHashIndex, (q: any) => q.eq("token_hash", tokenHash))
        .first();
      if (!tokenDoc || tokenDoc.user_id !== userId) {
        throw new Error("Token not found");
      }

      const nonceHash = await hashToken(args.nonce);
      const existing = await ctx.db
        .query(tables.cliAuthRequests)
        .withIndex(tables.cliAuthRequestsByNonceIndex, (q: any) => q.eq("nonce_hash", nonceHash))
        .first();

      // Re-deposit for the same nonce (page reload re-mints) replaces the row.
      if (existing) {
        await ctx.db.patch(existing._id, {
          user_id: userId,
          token: args.token,
          device_name: args.device_name,
          created_at: Date.now(),
        });
        return;
      }

      await ctx.db.insert(tables.cliAuthRequests, {
        nonce_hash: nonceHash,
        user_id: userId,
        token: args.token,
        device_name: args.device_name,
        created_at: Date.now(),
      });
    },
  });

  const claim = internalMutation({
    args: { nonce: v.string() },
    handler: async (ctx: any, args: { nonce: string }) =>
      claimCliAuthRequest(ctx, args.nonce, Date.now(), ttlMs, tables),
  });

  // Live "has the browser deposited yet?" signal for the desktop sign-in flow.
  // The desktop login page subscribes to this while the user completes auth in
  // their system browser, then redeems via the desktop-relay auth provider the
  // moment it flips true. Unauthenticated by design: it returns only a boolean,
  // keyed by the caller's own high entropy one time nonce.
  const pendingDeposit = query({
    args: { nonce: v.string() },
    handler: async (ctx: any, args: { nonce: string }) => {
      const nonceHash = await hashToken(args.nonce);
      const row = await ctx.db
        .query(tables.cliAuthRequests)
        .withIndex(tables.cliAuthRequestsByNonceIndex, (q: any) => q.eq("nonce_hash", nonceHash))
        .first();
      return !!row && Date.now() - row.created_at <= ttlMs;
    },
  });

  const claimForDesktop = internalMutation({
    args: { nonce: v.string() },
    handler: async (ctx: any, args: { nonce: string }) =>
      claimDesktopAuthExchange(ctx, args.nonce, Date.now(), ttlMs, tables),
  });

  const sweepExpired = internalMutation({
    args: {},
    handler: async (ctx: any) => sweepExpiredCliAuthRequests(ctx, Date.now(), ttlMs, tables),
  });

  return { deposit, claim, pendingDeposit, claimForDesktop, sweepExpired };
}
