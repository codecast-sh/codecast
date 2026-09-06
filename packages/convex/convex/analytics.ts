import { v } from "convex/values";
import { createServerAnalytics } from "@platform/analytics/server";
import { CODECAST_EVENTS, TELEMETRY_DISABLED_VAR } from "@codecast/shared/analytics";
import { internalAction } from "./_generated/server";

// Server-side PostHog capture for funnel steps that happen off-browser (CLI
// auth, daemon connect, first synced session). Same project as the web/mobile
// clients; phc_ keys are publishable, and the web bundle already ships this one.
// distinct_id must be the Convex users _id string — the web client identifies
// with user._id, so server and client events merge into one PostHog person.
//
// The payload building and the never-throw send live in @platform/analytics
// (extracted from this file); the key, the host, the "convex" source label and
// the event catalog are codecast's configuration.
//
// The key comes from the deployment environment, read the way every other
// Convex secret is (ct-49565). It used to be a literal in this file, which put
// a rotation behind a code deploy and made the value diverge from the one
// Railway bakes into the web bundle. Unset means no analytics object at all,
// so `capture` degrades to a no-op instead of posting to a bogus project.
const POSTHOG_KEY = process.env.POSTHOG_KEY || process.env.VITE_POSTHOG_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";

const analytics = POSTHOG_KEY
  ? createServerAnalytics({
      posthogKey: POSTHOG_KEY,
      posthogHost: POSTHOG_HOST,
      source: "convex",
      // Drops any event the catalog does not describe, and stops after 1000
      // events so a scheduler loop cannot flood the project.
      catalog: CODECAST_EVENTS,
      // A deployment somebody runs themselves has no user agent to carry Do Not
      // Track, so DO_NOT_TRACK and this variable are how they say no. The
      // package consults no environment unless it is handed one.
      env: process.env,
      optOutVars: [TELEMETRY_DISABLED_VAR],
    })
  : null;

if (!analytics) {
  // A deployment missing the variable would otherwise look identical to one
  // where nobody happens to be authing: silent, green, and reporting nothing.
  console.warn("[analytics] POSTHOG_KEY is unset on this deployment — Convex funnel events go nowhere");
}

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
    await analytics?.capture(args.event, args.distinctId, args.properties);
  },
});
