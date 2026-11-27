// One-time backfill for conversations.runs_in_parent: every row written before
// the field gets the answer its process gates already read for it
// (shared legacyRunsInParent), and the retired adopted_at is cleared. A row
// that holds runs_in_parent keeps it, so a second run writes nothing.
// Run it right after deploy.sh:
//   packages/convex/run.sh runsInParentBackfill:run                       (dry run)
//   packages/convex/run.sh runsInParentBackfill:run '{"dryRun":false,"auto":true}'
// auto:true drains the table page by page.

import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { legacyRunsInParent } from "@codecast/shared/contracts/runsInParent";

export const run = internalMutation({
  args: { dryRun: v.optional(v.boolean()), cursor: v.optional(v.string()), numItems: v.optional(v.number()), auto: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = args.numItems ?? 200;
    const page = await ctx.db.query("conversations").paginate({ cursor: args.cursor ?? null, numItems });
    const counts = { stampedTrue: 0, stampedFalse: 0, adoptedCleared: 0 };
    for (const conv of page.page) {
      const patch: { runs_in_parent?: boolean; adopted_at?: undefined } = {};
      if (conv.runs_in_parent === undefined) {
        patch.runs_in_parent = legacyRunsInParent(conv);
        counts[patch.runs_in_parent ? "stampedTrue" : "stampedFalse"]++;
      }
      if (conv.adopted_at !== undefined) {
        patch.adopted_at = undefined;
        counts.adoptedCleared++;
      }
      if (!dryRun && Object.keys(patch).length > 0) await ctx.db.patch(conv._id, patch);
    }
    if (args.auto && !page.isDone) {
      await ctx.scheduler.runAfter(0, (internal as any).runsInParentBackfill.run, { dryRun, cursor: page.continueCursor, numItems, auto: true });
    }
    return { dryRun, ...counts, scanned: page.page.length, done: page.isDone, cursor: page.continueCursor };
  },
});
