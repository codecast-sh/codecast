// Retention for the pin trail (prioritiesSchema.ts thread_state_events): the
// priorities pass reads only pins newer than its last run, so a month is ample.
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";

export const THREAD_STATE_EVENT_RETENTION_MS = 30 * 24 * 3600_000;
const PAGE = 500;

/** Deletes one page of events past the window, and schedules the next page while a full one came back. */
export const prune = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const cutoff = Date.now() - THREAD_STATE_EVENT_RETENTION_MS;
    const old = await ctx.db.query("thread_state_events").withIndex("by_at", (q) => q.lt("at", cutoff)).take(PAGE);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === PAGE) await ctx.scheduler.runAfter(0, (internal as any).threadStateEvents.prune, {});
    return old.length;
  },
});
