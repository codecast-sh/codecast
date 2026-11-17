// Codecast for outside agents (docs/architecture/agent-mcp.md). Spliced into
// schema.ts as `...mcpTables`.
//
// A grant is its own row, never an api_tokens row: a CLI token authorizes every
// `cast` mutation, and a read grant must not reach any of them. Tokens are
// stored only as SHA-256 hashes (hashToken); plaintext exists only in the
// response that hands it out.
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const mcpTables = {
  // A client that registered itself (RFC 7591). Public clients only: no secret.
  // The name is the client's own claim; the consent screen shows the redirect
  // host beside it, which is the fact.
  mcp_clients: defineTable({
    client_id: v.string(),
    client_name: v.string(),
    redirect_uris: v.array(v.string()),
    created_at: v.number(),
    // Set when a person first approves it; an unapproved client is swept.
    approved_at: v.optional(v.number()),
  })
    .index("by_client_id", ["client_id"])
    .index("by_approved_created", ["approved_at", "created_at"]),

  // A one-time authorization code: hashed, 60 s, deleted on exchange.
  mcp_auth_codes: defineTable({
    code_hash: v.string(),
    client_id: v.string(),
    user_id: v.id("users"),
    redirect_uri: v.string(),
    code_challenge: v.string(),
    scope: v.string(),
    resource: v.optional(v.string()),
    expires_at: v.number(),
  })
    .index("by_code_hash", ["code_hash"])
    .index("by_expires", ["expires_at"]),

  // One connected agent. Disconnect deletes the row; the next call is a 401.
  mcp_grants: defineTable({
    user_id: v.id("users"),
    client_id: v.string(),
    client_name: v.string(),
    redirect_host: v.string(),
    scope: v.string(),
    created_at: v.number(),
    last_used_at: v.optional(v.number()),
    access_hash: v.string(),
    access_expires_at: v.number(),
    refresh_hash: v.string(),
    refresh_expires_at: v.number(),
    // The refresh token this one replaced: presented again, it revokes the
    // grant (a stolen copy and the real client cannot both keep it).
    previous_refresh_hash: v.optional(v.string()),
  })
    .index("by_user", ["user_id"])
    .index("by_access_hash", ["access_hash"])
    .index("by_refresh_hash", ["refresh_hash"])
    .index("by_previous_refresh_hash", ["previous_refresh_hash"])
    .index("by_refresh_expires", ["refresh_expires_at"]),

  // A `cast` CLI token used as a bearer on /mcp, so a leaked token reading
  // through MCP shows on the Connected agents list. One row per token.
  mcp_bearer_reads: defineTable({
    user_id: v.id("users"),
    token_id: v.id("api_tokens"),
    first_read_at: v.number(),
    last_read_at: v.number(),
  })
    .index("by_token", ["token_id"])
    .index("by_user", ["user_id"]),
};
