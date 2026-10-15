// Names the moments read before a moment carried `who` (contracts/moments
// momentWho): each ready moment whose body codecast keeps is read once from
// R2 and its row takes the name. A body kept on the host, or past its 30
// days, has nothing to read, and its row stays unnamed. One page per run;
// each run schedules the next until the table is walked.
//   npx convex run momentWhoBackfill:run
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { momentWho } from "@codecast/shared/contracts/moments";
import { liveBodyKey, readKeptBody } from "./lib/momentBody";

const PAGE = 40;

export const page = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const res = await ctx.db.query("moments").withIndex("by_status_due", (q: any) => q.eq("status", "ready")).paginate({ cursor: args.cursor, numItems: PAGE });
    const now = Date.now();
    return {
      todo: (res.page as Doc<"moments">[]).filter((m) => !m.who).flatMap((m) => { const key = liveBodyKey(m, now); return key ? [{ id: m._id, key }] : []; }),
      cursor: res.isDone ? null : res.continueCursor,
    };
  },
});

export const setWho = internalMutation({
  args: { id: v.id("moments"), who: v.string() },
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.id);
    if (m && !m.who) await ctx.db.patch(args.id, { who: args.who });
  },
});

export const run = internalAction({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<{ named: number; next: string | null }> => {
    const { todo, cursor }: { todo: Array<{ id: Id<"moments">; key: string }>; cursor: string | null } = await ctx.runQuery(internal.momentWhoBackfill.page, { cursor: args.cursor ?? null });
    let named = 0;
    for (const t of todo) {
      const body = await readKeptBody(t.key).catch(() => null);
      const who = body ? momentWho(body) : null;
      if (!who) continue;
      await ctx.runMutation(internal.momentWhoBackfill.setWho, { id: t.id, who });
      named++;
    }
    if (cursor) await ctx.scheduler.runAfter(0, internal.momentWhoBackfill.run, { cursor });
    return { named, next: cursor };
  },
});
