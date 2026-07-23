// Centralized authentication layer for Convex functions.
//
// Wave-1 strangler-fig seed: this is the canonical home for "who is the caller"
// checks. Wave 2 will migrate the ~336 inline auth preambles to use these
// helpers; for now it establishes the seam without forcing any caller to change.
//
// Two callers exist today:
//   - Session-authed web functions resolve identity via `getAuthUserId(ctx)`.
//   - Token-authed CLI/daemon functions fall back to `verifyApiToken(ctx, token)`.
// The managedSessions.ts `getAuthenticatedUserId` helper already unifies both;
// `requireUserOrToken` below mirrors that pattern so the two entry points share
// one shape.

import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { verifyApiToken } from "../apiTokens";

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
// throws if the caller is anonymous. Use this in any session-authed function in
// place of the `const userId = await getAuthUserId(ctx); if (!userId) throw ...`
// preamble.
export async function requireUser(ctx: AuthCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx as any);
  if (!userId) throw accessError("UNAUTHENTICATED", "Unauthorized");
  return userId;
}

// Resolve identity from either a logged-in session OR a CLI api token, mirroring
// managedSessions.ts `getAuthenticatedUserId`. Session auth wins; a token is the
// fallback for daemon/CLI callers that have no browser session. Returns null
// when neither resolves — callers decide whether that's an error.
export async function getUserOrToken(
  ctx: AuthCtx,
  token?: string,
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) return sessionUserId;

  if (token) {
    const result = await verifyApiToken(ctx, token);
    if (result) return result.userId;
  }

  return null;
}

// Throwing variant of `getUserOrToken` — the canonical "must be a session OR a
// valid token" check for CLI/daemon entry points.
export async function requireUserOrToken(
  ctx: AuthCtx,
  token?: string,
): Promise<Id<"users">> {
  const userId = await getUserOrToken(ctx, token);
  if (!userId) throw accessError("UNAUTHENTICATED", "Unauthorized");
  return userId;
}
