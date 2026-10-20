import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Accepted Expo push tickets waiting for their receipt (pushReceipts.ts). */
export const pushReceiptTables = {
  push_tickets: defineTable({
    ticket_id: v.string(),
    push_token: v.string(),
    user_id: v.optional(v.id("users")),
    sent_at: v.number(),
  }).index("by_sent_at", ["sent_at"]),
};
