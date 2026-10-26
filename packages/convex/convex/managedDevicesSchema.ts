import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A team's managed policy (shared/contracts/managedPolicy.ts TeamPolicy), as
 * stored on teams.policy. Written only through parseTeamPolicy, so the stored
 * shape never holds a key the catalog does not know.
 */
export const teamPolicyValidator = v.object({
  public_sharing_disabled: v.optional(v.boolean()),
  browser_control_disabled: v.optional(v.boolean()),
  computer_control_disabled: v.optional(v.boolean()),
  cloud_hosts_disabled: v.optional(v.boolean()),
  auto_update: v.optional(v.union(v.literal("on"), v.literal("off"))),
  excluded_paths: v.optional(v.array(v.string())),
});

/**
 * Managed devices (managedDevices.ts): a team admin mints enrollment tokens,
 * an MDM profile carries one to each Mac, and each device that presents it
 * becomes an enrollment the admin can see and revoke.
 */
export const managedDeviceTables = {
  team_enrollment_tokens: defineTable({
    team_id: v.id("teams"),
    created_by: v.id("users"),
    name: v.string(),
    // sha256 of the cc_enr_ secret; the plaintext is shown once at creation.
    token_hash: v.string(),
    // The first characters of the secret, so an admin can tell tokens apart.
    prefix: v.string(),
    created_at: v.number(),
    revoked_at: v.optional(v.number()),
    last_used_at: v.optional(v.number()),
  })
    .index("by_team", ["team_id"])
    .index("by_token_hash", ["token_hash"]),

  device_enrollments: defineTable({
    team_id: v.id("teams"),
    token_id: v.id("team_enrollment_tokens"),
    device_id: v.string(),
    // The person the profile names ($EMAIL). Sign-in must match when present.
    email: v.optional(v.string()),
    hostname: v.optional(v.string()),
    platform: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("revoked")),
    user_id: v.optional(v.id("users")),
    created_at: v.number(),
    enrolled_at: v.optional(v.number()),
    revoked_at: v.optional(v.number()),
  })
    .index("by_team", ["team_id"])
    .index("by_team_device", ["team_id", "device_id"])
    .index("by_device", ["device_id"]),
};
