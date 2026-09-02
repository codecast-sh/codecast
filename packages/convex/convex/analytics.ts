import { v } from "convex/values";
import { createServerAnalytics } from "@platform/analytics/server";
import { internalAction } from "./_generated/server";

// Server-side PostHog capture for funnel steps that happen off-browser (CLI
// auth, daemon connect, first synced session). Same project as the web/mobile
// clients; phc_ keys are publishable, and the web bundle already ships this one.
// distinct_id must be the Convex users _id string — the web client identifies
// with user._id, so server and client events merge into one PostHog person.
//
// The payload building and the never-throw send live in @platform/analytics
// (extracted from this file); the key, the host and the "convex" source label
// are codecast's configuration.
const POSTHOG_KEY = "phc_Qfq3Fhk6pyxB8vkDoUVqSKvAgiVkqR3ARoAtwaYqE6Z";
const POSTHOG_HOST = "https://us.i.posthog.com";

const analytics = createServerAnalytics({
  posthogKey: POSTHOG_KEY,
  posthogHost: POSTHOG_HOST,
  source: "convex",
});

// Fire-and-forget: callers schedule this via ctx.scheduler.runAfter(0, ...) so
// a PostHog outage can never slow down or fail the mutation that emitted it.
export const capture = internalAction({
  args: {
    event: v.string(),
    distinctId: v.string(),
    properties: v.optional(v.any()),
  },
  handler: async (_ctx, args) => {
    // capture swallows its own failures — analytics must never surface errors
    // to product flows.
    await analytics.capture(args.event, args.distinctId, args.properties);
  },
});
