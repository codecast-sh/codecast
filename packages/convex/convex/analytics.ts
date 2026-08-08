import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// Server-side PostHog capture for funnel steps that happen off-browser (CLI
// auth, daemon connect, first synced session). Same project as the web/mobile
// clients; phc_ keys are publishable, and the web bundle already ships this one.
// distinct_id must be the Convex users _id string — the web client identifies
// with user._id, so server and client events merge into one PostHog person.
const POSTHOG_KEY = "phc_Qfq3Fhk6pyxB8vkDoUVqSKvAgiVkqR3ARoAtwaYqE6Z";
const POSTHOG_HOST = "https://us.i.posthog.com";

// Fire-and-forget: callers schedule this via ctx.scheduler.runAfter(0, ...) so
// a PostHog outage can never slow down or fail the mutation that emitted it.
export const capture = internalAction({
  args: {
    event: v.string(),
    distinctId: v.string(),
    properties: v.optional(v.any()),
  },
  handler: async (_ctx, args) => {
    try {
      await fetch(`${POSTHOG_HOST}/i/v0/e/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: POSTHOG_KEY,
          event: args.event,
          distinct_id: args.distinctId,
          properties: { source: "convex", ...args.properties },
        }),
      });
    } catch {
      // Analytics must never surface errors to product flows.
    }
  },
});
