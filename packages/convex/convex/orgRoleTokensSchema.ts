// A role's tokens today, one row per conversation that works for it
// (lib/orgCaps roleTokensToday): each session's transcript writes only its
// own row, so they never conflict with a spawn reading the role.

import { defineTable } from "convex/server";
import { v } from "convex/values";

export const orgRoleTokenTables = {
  org_role_tokens: defineTable({
    role_id: v.id("org_roles"),
    conversation_id: v.id("conversations"),
    day: v.string(),
    tokens: v.number(),
  })
    .index("by_conversation_day", ["conversation_id", "day"])
    .index("by_role_day", ["role_id", "day"]),
};
