// One-time backfill for the milestone key mark (prioritiesSchema
// step_key_max): every priority's mark becomes the highest of the mark it
// holds, its milestones' keys and every one of its sessions' keys. Until it
// runs, a write takes the mark from the milestones and the newest sessions
// only (lib/priorityGroup stepKeyMark), so a mark written since the deploy may
// be short; this lifts it, and never lowers one, so a second run writes
// nothing. A run reads at most SESSION_BUDGET sessions and goes on from the
// session it stopped at in the next.
// Run it after deploy.sh:
//   packages/convex/run.sh priorityStepKeyBackfill:run '{}'                              (dry run, one page)
//   packages/convex/run.sh priorityStepKeyBackfill:run '{"dryRun":false,"auto":true}'
// Dry run by default; auto:true drains the table page by page.

import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { stepKeyMax } from "./lib/priorityPass";

/** The most sessions one run reads. */
export const SESSION_BUDGET = 1000;
const SESSION_PAGE = 200;

const resumeArg = v.object({ priority_id: v.id("priorities"), after: v.number(), mark: v.number() });

export const run = internalMutation({
  args: { dryRun: v.optional(v.boolean()), cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()), auto: v.optional(v.boolean()), resume: v.optional(resumeArg) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = args.numItems ?? 25;
    const cursor = args.cursor ?? null;
    const page = await ctx.db.query("priorities").paginate({ cursor, numItems });
    const again = (rest: Record<string, unknown>) => ctx.scheduler.runAfter(0, (internal as any).priorityStepKeyBackfill.run, { dryRun, numItems, auto: true, ...rest });
    // A run that stopped inside a priority starts again at it, from the session it stopped at.
    let resume = args.resume && page.page.some((p) => String(p._id) === String(args.resume!.priority_id)) ? args.resume : undefined;
    const counts = { lifted: 0, scanned: 0, sessions_read: 0 };
    let budget = SESSION_BUDGET;
    for (const listed of page.page) {
      if (resume && String(listed._id) !== String(resume.priority_id)) continue;
      let after = resume?.after ?? 0;
      let mark = resume?.mark ?? 0;
      resume = undefined;
      for (;;) {
        if (budget < SESSION_PAGE) {
          if (args.auto) await again({ cursor, resume: { priority_id: listed._id, after, mark } });
          return { dryRun, ...counts, done: false, cursor, resume: { priority_id: listed._id as Id<"priorities">, after, mark } };
        }
        const sessions: Doc<"conversations">[] = await ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", listed._id).gt("_creationTime", after)).take(SESSION_PAGE);
        budget -= sessions.length;
        counts.sessions_read += sessions.length;
        mark = stepKeyMax(sessions.flatMap((c) => (c.priority_step_key ? [{ key: c.priority_step_key }] : [])), mark);
        if (sessions.length < SESSION_PAGE) break;
        after = sessions[sessions.length - 1]._creationTime;
      }
      counts.scanned++;
      // Read again: a write since the scan began may have spent a key past it.
      const p: Doc<"priorities"> | null = await ctx.db.get(listed._id);
      if (!p) continue;
      const lifted = stepKeyMax(p.steps, Math.max(mark, p.step_key_max ?? 0));
      if (lifted === p.step_key_max) continue;
      if (!dryRun) await ctx.db.patch(p._id, { step_key_max: lifted });
      counts.lifted++;
    }
    if (args.auto && !page.isDone) await again({ cursor: page.continueCursor });
    return { dryRun, ...counts, done: page.isDone, cursor: page.continueCursor };
  },
});
