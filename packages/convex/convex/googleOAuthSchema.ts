// Google OAuth connections (Gmail). Spliced into schema.ts as
// `...googleOAuthTables` (the capabilitiesSchema.ts pattern).
//
// USER-scoped only: mail is personal, so a connection binds to scope_user_id and
// never to a team (unlike slack_installations, which can bind either way). One
// row per (user, Google account email) — a user can connect several accounts.
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const googleOAuthTables = {
  google_installations: defineTable({
    // The codecast user who connected the account. Never a team.
    scope_user_id: v.id("users"),
    // Email of the CONNECTED Google account (from the Gmail profile), not the
    // codecast login — the upsert key alongside scope_user_id, and what the
    // Apps tab shows.
    email: v.string(),
    // The offline refresh token, encrypted at rest — "v1.<iv b64>.<ct b64>",
    // AES-256-GCM under a key HKDF-derived from GOOGLE_OAUTH_CLIENT_SECRET
    // (googleOAuth.ts encryptRefreshToken). Plaintext never touches the db.
    refresh_token_enc: v.string(),
    // Every scope Google reports as granted for this token (the token response's
    // `scope` field — with include_granted_scopes it is the FULL accumulated
    // set, so incremental grants replace rather than append here).
    granted_scopes: v.array(v.string()),
    // Present only while a NEW connection awaits confirmConnection (the relay
    // defense — googleOAuth.ts module header). The hash of a random token that
    // travels only in the callback redirect; a pending row is unusable, and a
    // mismatched confirm deletes it. Cleared (set undefined) on confirmation.
    pending_confirm_hash: v.optional(v.string()),
    pending_expires_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_scope_user", ["scope_user_id"])
    .index("by_user_email", ["scope_user_id", "email"]),
};
