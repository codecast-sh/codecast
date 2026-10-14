import { defineTable } from "convex/server";
import { v } from "convex/values";

export const syncOutboxTables = {
  sync_outbox: defineTable({
    scope_key: v.string(),
    entity_type: v.string(),
    entity_id: v.string(),
    revision: v.number(),
    delivered_revision: v.number(),
    position: v.number(),
    pending: v.boolean(),
    updated_at: v.number(),
    op: v.string(),
    cargo: v.optional(v.any()),
    access: v.optional(v.any()),
    events: v.optional(v.array(v.object({ op: v.string(), revision: v.number() }))),
  })
    .index("by_scope_entity", ["scope_key", "entity_id"])
    .index("by_pending", ["pending", "updated_at"])
    .index("by_scope_pending", ["scope_key", "pending", "updated_at"]),

  // Whether a drain is on its way for a scope. A save that makes a slot pending
  // schedules a drain only when none is, and the drain that finds the scope
  // empty clears it. Saves write it only on that idle-to-busy edge.
  sync_outbox_drains: defineTable({
    scope_key: v.string(),
    scheduled: v.boolean(),
  }).index("by_scope", ["scope_key"]),
};
