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
};
