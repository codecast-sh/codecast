// "Report this app" (SPEC "Safety and limits"): the room can flag an app for a
// person to look at. A report is stored and nothing else happens; there is no
// moderation UI in v1. One report per visitor per app, so reporting again is
// a no-op rather than a way to pile on.
import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { fail } from "./lib/errors";
import { REPORT_REASON_MAX } from "./lib/limits";
import { cleanLine } from "./lib/room";
import { takeRate } from "./limits";
import { requireApp } from "./model";
import { requireVisitor } from "./visitors";
import { visitorArgs } from "./validators";

function reportRow(ctx: QueryCtx, appId: Id<"apps">, visitorId: Id<"visitors">) {
  return ctx.db
    .query("reports")
    .withIndex("by_app_visitor", (q) => q.eq("app_id", appId).eq("visitor_id", visitorId))
    .unique();
}

/** Report an app. `version` is the one on screen (the live one when omitted). */
export const report = mutation({
  args: { ...visitorArgs, app_id: v.id("apps"), version: v.optional(v.number()), reason: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ fresh: boolean }> => {
    const visitor = await requireVisitor(ctx, args);
    const app = await requireApp(ctx, args.app_id);
    const version = args.version ?? app.live_version;
    if (!Number.isInteger(version) || version < 1 || version > app.version_count) fail("invalid", "That version does not exist.");
    if (await reportRow(ctx, app._id, visitor._id)) return { fresh: false };
    await takeRate(ctx, "report", visitor._id);
    const reason = args.reason === undefined ? null : cleanLine(args.reason, REPORT_REASON_MAX);
    await ctx.db.insert("reports", {
      app_id: app._id,
      visitor_id: visitor._id,
      version,
      ...(reason ? { reason } : {}),
      created_at: Date.now(),
    });
    return { fresh: true };
  },
});

/** Whether this visitor already reported the app, so the menu can say so. */
export const reported = query({
  args: { ...visitorArgs, app_id: v.id("apps") },
  handler: async (ctx, args): Promise<boolean> => {
    const visitor = await requireVisitor(ctx, args);
    return !!(await reportRow(ctx, args.app_id, visitor._id));
  },
});
