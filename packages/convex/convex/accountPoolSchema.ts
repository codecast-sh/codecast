import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The team's shared account pool (accountPool.ts): a person's Claude account
 * opened to one of their teams, the way device_shares opens a machine. Every
 * teammate's machines then run on it as one more saved profile.
 */
export const accountPoolTables = {
  // One row per account per team; its presence is the whole fact, as for
  // device_shares. Membership is the access rule: a share counts only while
  // its contributor is on the team, and a machine draws on it only while its
  // owner is too (accountPool.shareCounts).
  account_shares: defineTable({
    user_id: v.id("users"),
    provider: v.literal("claude"),
    // The account, by the email every account read here keys on
    // (fallbackProfiles, fleetAccount). Lowercased.
    email: v.string(),
    // The machine that keeps the account's setup-token and seals copies of it
    // to every teammate's machine. Its heartbeat is the one home of the
    // account's usage meter.
    holder_device_id: v.string(),
    team_id: v.id("teams"),
    shared_at: v.number(),
  })
    .index("by_team", ["team_id"])
    .index("by_user_email", ["user_id", "email"]),

  // A copy of a shared account's setup-token, sealed by the holder to one
  // machine's provider_key_pubkey. Only that machine can open it; no query
  // returns it to anyone else. Deleted with its share.
  account_pool_copies: defineTable({
    share_id: v.id("account_shares"),
    user_id: v.id("users"),
    device_id: v.string(),
    sealed: v.object({ provider: v.string(), epk: v.string(), iv: v.string(), ct: v.string() }),
    // When the holder stored the token: the copy's one-year lifetime runs from here.
    token_stored_at: v.number(),
    // The machine key the copy was sealed to. A machine that regenerates its
    // key cannot open the old copy, so a key change asks the holder to reseal.
    pubkey: v.optional(v.string()),
    sealed_at: v.number(),
  })
    .index("by_share", ["share_id"])
    .index("by_user_device", ["user_id", "device_id"]),

  // Tokens a person spent on an account, per UTC day: the pool's per-person
  // split. Folded from usage_pending rows that carry the account they ran on
  // (lib/usageDaily.ts), beside the per-person user_usage_daily.
  account_usage_daily: defineTable({
    email: v.string(),
    user_id: v.id("users"),
    day_start: v.number(),
    tokens: v.number(),
    updated_at: v.number(),
  })
    .index("by_email_day", ["email", "day_start"])
    .index("by_email_user_day", ["email", "user_id", "day_start"]),
};
