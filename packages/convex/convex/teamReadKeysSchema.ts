import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Team read keys (teamReadKeys.ts): a team admin mints a named key that a
 * server presents to GET /cli/v1/team/sessions to read the team's shared
 * session metadata. Every key expires; only its sha256 is stored.
 */
export const teamReadKeyTables = {
  team_read_keys: defineTable({
    team_id: v.id("teams"),
    created_by: v.id("users"),
    name: v.string(),
    // sha256 of the cc_trk_ secret; the plaintext is shown once at creation.
    key_hash: v.string(),
    // The first characters of the secret, so an admin can tell keys apart.
    prefix: v.string(),
    created_at: v.number(),
    expires_at: v.number(),
    revoked_at: v.optional(v.number()),
    // Moved by recordUse at most once per USE_WINDOW_MS, with the use's audit event.
    last_used_at: v.optional(v.number()),
  })
    .index("by_team", ["team_id"])
    .index("by_key_hash", ["key_hash"]),
};
