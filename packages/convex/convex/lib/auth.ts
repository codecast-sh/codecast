// Centralized authentication layer for Convex functions.
//
// This is the canonical home for "who is the caller" checks. Two callers exist:
//   - Session-authed web functions resolve identity via `getAuthUserId(ctx)`.
//   - Token-authed CLI/daemon functions fall back to `verifyApiToken(ctx, token)`.
// `requireUserOrToken` unifies the two entry points into one shape.
//
// The helpers themselves were extracted into @platform/auth/convex; this module
// keeps the import path every caller in convex/ already uses.
export {
  accessError,
  forbidden,
  notFound,
  invalidScope,
  requireUser,
  getUserOrToken,
  requireUserOrToken,
} from "@platform/auth/convex";
export type { AccessErrorCode } from "@platform/auth/convex";
