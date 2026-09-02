// API tokens: mint, hash, verify, revoke, and the device binding.
//
// The logic lives in @platform/auth/convex — it was extracted from this file.
// What stays here is codecast's: the change-tracking function builders, the
// analytics funnel events, and the two extra fields `cast login` needs back
// from a setup-token exchange.
//
// The export names below are the module's public surface. Convex resolves
// `api.apiTokens.*` and `internal.apiTokens.*` from them, and ~50 files import
// `hashToken` / `verifyApiToken` from here, so they must not move.
import { mutation, query, internalMutation, internalQuery } from "./functions";
import { makeApiTokenFunctions } from "@platform/auth/convex";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const CONVEX_URL = process.env.CONVEX_CLOUD_ORIGIN || process.env.CONVEX_CLOUD_URL || process.env.VITE_CONVEX_URL || "";

export { hashToken, verifyApiToken } from "@platform/auth/convex";

// NOTE: a public `createTokenForUser({ user_id, name })` mutation used to live
// here. It authenticated nobody and minted a working plaintext token for any
// supplied user_id — a one-call account takeover. It had zero callers (the CLI
// mints tokens through the authenticated relay in cliAuth.ts / createToken).
// Removed rather than internalized: nothing should ever mint a token for an
// arbitrary user without the caller proving they are that user.
//
// NOTE: a public `verifyToken({ token })` mutation used to live here. It took
// any token string and answered {userId, tokenId} when the token was valid.
// This backend has no global auth gate, so anyone able to reach the deployment
// could call it and learn whether a token was live and whose it was — a bearer
// credential oracle with no authenticated caller behind it. It had zero callers:
// every real path goes through `verifyApiToken`, which is deliberately a pure
// read. Removed rather than internalized, because `verifyApiToken` already
// serves every in-process caller and a wire-callable twin only re-opens this.
//
// `deviceBindingAllows` stays internal for the same reason: wire-callable, it
// would answer "is this token real, and which machine is it tied to?" for
// anyone who reaches the deployment.
// The wire contract, stated once. The factory builds these with the untyped
// builders it is handed, so without this annotation every export lands as
// `any`, `ApiFromModules` drops the whole module, and `api.apiTokens.*` stops
// existing. These are the same argument and return types the hand-written
// mutations had.
type ApiTokenFunctions = {
  createToken: RegisteredMutation<
    "public",
    { name: string },
    Promise<{ token: string; userId: Id<"users"> }>
  >;
  createSetupToken: RegisteredMutation<
    "public",
    Record<string, never>,
    Promise<{ token: string; expiresAt: number }>
  >;
  listTokens: RegisteredQuery<
    "public",
    Record<string, never>,
    Promise<
      Array<{
        _id: Id<"api_tokens">;
        name: string;
        created_at: number;
        last_used_at: number;
        expires_at?: number;
      }>
    >
  >;
  revokeToken: RegisteredMutation<"public", { token_id: Id<"api_tokens"> }, Promise<void>>;
  renameToken: RegisteredMutation<
    "public",
    { token_id: Id<"api_tokens">; name: string },
    Promise<void>
  >;
  exchangeSetupToken: RegisteredMutation<
    "internal",
    { setupToken: string },
    Promise<{
      auth_token: string;
      user_id: Id<"users">;
      team_id: string | undefined;
      convex_url: string;
    } | null>
  >;
  deviceBindingAllows: RegisteredQuery<
    "internal",
    { api_token: string; device_id?: string },
    Promise<boolean>
  >;
};

export const {
  createToken,
  createSetupToken,
  listTokens,
  revokeToken,
  renameToken,
  exchangeSetupToken,
  deviceBindingAllows,
}: ApiTokenFunctions = makeApiTokenFunctions({
  mutation,
  query,
  internalMutation,
  internalQuery,
  // Funnel: the only caller of createToken is the /auth/cli authorize page, so
  // a mint there IS a completed browser-based `cast auth`; a setup-token
  // exchange is a completed `cast login <token>`.
  onEvent: async (ctx, event) => {
    await ctx.scheduler.runAfter(0, internal.analytics.capture, {
      event: event.name,
      distinctId: event.userId,
      ...(event.name === "cli_authed" ? { properties: { method: event.method } } : {}),
    });
  },
  // `cast login` needs the team and the deployment it just joined, alongside
  // the token it exchanged for.
  exchangeExtras: async (ctx, userId) => {
    const user = await ctx.db.get(userId);
    const userDoc = user as { team_id?: string } | null;
    return { team_id: userDoc?.team_id, convex_url: CONVEX_URL };
  },
});
