// Centralized "who is the caller" checks for Convex functions.
//
// Two callers exist: session authed web functions resolve identity via
// `getAuthUserId(ctx)`, and token authed CLI or daemon functions fall back to
// `verifyApiToken(ctx, token)`. `requireUserOrToken` unifies both.
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { GenericId } from "convex/values";
import { verifyApiToken } from "./apiTokens";
import { type AuthTables, resolveTables } from "./tables";

type AuthCtx = { db: any; auth?: any };

export type AccessErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "INVALID_SCOPE";

/** Stable public error envelope for authorization and scope failures. */
export function accessError(code: AccessErrorCode, message: string): ConvexError<{
  code: AccessErrorCode;
  message: string;
}> {
  return new ConvexError({ code, message });
}

export function forbidden(message = "Forbidden"): never {
  throw accessError("FORBIDDEN", message);
}

export function notFound(message = "Not found"): never {
  throw accessError("NOT_FOUND", message);
}

export function invalidScope(message: string): never {
  throw accessError("INVALID_SCOPE", message);
}

// The one canonical "must be signed in" check. Resolves the session user id and
// throws if the caller is anonymous.
export async function requireUser(ctx: AuthCtx): Promise<GenericId<"users">> {
  const userId = await getAuthUserId(ctx as any);
  if (!userId) throw accessError("UNAUTHENTICATED", "Unauthorized");
  return userId;
}

// Resolve identity from either a logged in session OR a CLI api token. Session
// auth wins; a token is the fallback for daemon and CLI callers that have no
// browser session. Returns null when neither resolves; callers decide whether
// that is an error.
export async function getUserOrToken(
  ctx: AuthCtx,
  token?: string,
  tables: AuthTables = resolveTables(),
): Promise<GenericId<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) return sessionUserId;

  if (token) {
    const result = await verifyApiToken(ctx, token, false, tables);
    if (result) return result.userId;
  }

  return null;
}

// Throwing variant of `getUserOrToken`: the canonical "must be a session OR a
// valid token" check for CLI and daemon entry points.
export async function requireUserOrToken(
  ctx: AuthCtx,
  token?: string,
  tables: AuthTables = resolveTables(),
): Promise<GenericId<"users">> {
  const userId = await getUserOrToken(ctx, token, tables);
  if (!userId) throw accessError("UNAUTHENTICATED", "Unauthorized");
  return userId;
}
