// Linear webhook ingest. The mirror of githubWebhooks.storeWebhookEvent for
// the other issue provider: verify, dedupe on delivery id, store the raw event,
// schedule the handler. docs/architecture/issue-sync.md S1.4, S6.
//
// Nothing here interprets the payload. Mapping a Linear issue onto a task is
// issueSync.onLinearEvent's job, and keeping the split means a payload shape we
// mis-read is a replayable row rather than a lost delivery.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";

/**
 * HMAC SHA-256 of the RAW body under LINEAR_WEBHOOK_SECRET, hex, compared in
 * constant time. Linear sends it in the `Linear-Signature` header.
 *
 * Lives here rather than in linearApi.ts because it is ingest, not API client:
 * the route needs it before any Linear call is made, and it must not drag the
 * GraphQL client into the http module's import graph.
 */
export async function verifyLinearSignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined,
): Promise<boolean> {
  // Fail closed: an unset secret would otherwise accept every unsigned payload.
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

export const storeWebhookEvent = internalMutation({
  args: {
    delivery_id: v.string(),
    event_type: v.string(),   // Linear `type`: Issue | Comment | IssueLabel
    action: v.optional(v.string()),  // create | update | remove
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("linear_webhook_events")
      .withIndex("by_delivery_id", (q) => q.eq("delivery_id", args.delivery_id))
      .first();
    if (existing) return { success: true, duplicate: true };

    const eventId = await ctx.db.insert("linear_webhook_events", {
      delivery_id: args.delivery_id,
      event_type: args.event_type,
      action: args.action,
      payload: args.payload,
      processed: false,
      created_at: Date.now(),
    });

    // One handler for every Linear shape: it reads `type` off the stored row and
    // branches there, so a new Linear entity needs no change at this layer.
    void ctx.scheduler.runAfter(0, internal.issueSync.onLinearEvent, { event_id: eventId });

    return { success: true, duplicate: false };
  },
});

export const getWebhookEvent = internalQuery({
  args: { event_id: v.id("linear_webhook_events") },
  handler: async (ctx, args) => await ctx.db.get(args.event_id),
});
