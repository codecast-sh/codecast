import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The account pool (accountPool.ts). A person's Claude account reaches every
 * one of their own machines by default (a personal row, no team), and a team
 * when they open it to one, the way device_shares opens a machine. Every
 * machine that draws on it runs it as one more saved profile.
 */
export const accountPoolTables = {
  // One personal row per account (team_id absent): the account on every one
  // of its owner's machines, written by default (accountPool
  // .ensurePersonalShares). And one row per account per team it is opened
  // to, as for device_shares: its presence is the whole fact. The owner's
  // machines draw an account through one row (accountPool.servingRow); a
  // teammate's only while both are on the team (accountPool.mayDraw).
  account_shares: defineTable({
    user_id: v.id("users"),
    provider: v.literal("claude"),
    // The account, by the email every account read here keys on
    // (fallbackProfiles, fleetAccount). Lowercased.
    email: v.string(),
    // The machine preferred to keep the account's setup-token and seal copies
    // of it. Any of the owner's machines holding a live token takes over when
    // this one stops (accountPool.sealerFor). The sealer's heartbeat is the
    // one home of the account's usage meter.
    holder_device_id: v.string(),
    // Absent: the personal row, the owner's machines alone.
    team_id: v.optional(v.id("teams")),
    // The kinds of work that may draw on the account besides the team's
    // members' own machines. "line": the team's line hosts (cloud hosts with
    // line_slots) get a sealed copy and run their stations on it. Absent: the
    // team pool alone.
    pools: v.optional(v.array(v.string())),
    // Personal row only: the owner's machines the account is narrowed to.
    // Absent: every one of them.
    device_ids: v.optional(v.array(v.string())),
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
