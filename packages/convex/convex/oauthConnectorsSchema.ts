// One table for every OAuth-connected app that is not Slack, GitHub or Google
// (those three predate this and keep their own tables). Keyed by provider so a
// new connector is a config row in oauthConnectors.ts, not a new table.
//
// Spliced into schema.ts with one spread, like the capability tables.

import { defineTable } from "convex/server";
import { v } from "convex/values";

export const oauthConnectorTables = {
  app_installations: defineTable({
    /** "linear" | "notion" | … — a ConnectorId from oauthConnectors.ts. A bare
     *  string so adding a provider needs no schema migration. */
    provider: v.string(),
    /** Team-scoped connectors (Linear, Notion) bind to a workspace; personal
     *  ones to a user. Exactly one of these is set. */
    scope_user_id: v.optional(v.id("users")),
    team_id: v.optional(v.id("teams")),
    /** Who clicked Connect. */
    connected_by: v.id("users"),
    /** The external account (a Linear workspace name, a Notion workspace). */
    account_label: v.optional(v.string()),
    account_id: v.optional(v.string()),
    /** Encrypted with the same AES-GCM/HKDF scheme googleOAuth uses. Notion
     *  issues no refresh token (its access tokens do not expire); Linear does.
     *  So access_token_enc is always present and refresh_token_enc is optional. */
    access_token_enc: v.string(),
    refresh_token_enc: v.optional(v.string()),
    granted_scopes: v.array(v.string()),
    /** Same two-phase confirm as Google: the row is PENDING until the
     *  authenticated browser session confirms it owns the redirect. */
    pending_confirm_hash: v.optional(v.string()),
    pending_expires_at: v.optional(v.number()),
    /** Health stamps read by the integrations page. issue-sync.md S1.5 —
     *  the same three fields github_app_installations carries, so one card
     *  renderer serves both. */
    last_webhook_at: v.optional(v.number()),
    last_sync_at: v.optional(v.number()),
    last_error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_provider_user", ["provider", "scope_user_id"])
    .index("by_provider_team", ["provider", "team_id"]),
};
