// Recounting a source's replay tallies whole (lib/replayTallies.ts): the tend
// cron runs it daily for vendor sources, and once for every source with
// `packages/convex/run.sh replayTallies:rebuildAll '{}'` after the table was
// added. Live writes keep the tallies between recounts.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { foldTallies, mergeTallySums, writeTallySums, type TallySum } from "./lib/replayTallies";

/** How often the tend cron recounts a vendor source's tallies. */
export const TALLY_REBUILD_EVERY_MS = 24 * 60 * 60_000;
const PAGE = 300;
const WRITE_CHUNK = 200;

/** One page of a source's recordings, folded into per-person sums. */
export const rebuildPage = internalQuery({
  args: { source_id: v.id("event_sources"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("replays").withIndex("by_source_started", (q) => q.eq("source_id", args.source_id)).paginate({ cursor: args.cursor, numItems: PAGE });
    return { sums: [...foldTallies(page.page).values()], cursor: page.continueCursor, done: page.isDone };
  },
});

const sumValidator = v.object({
  person_key: v.optional(v.string()),
  shard: v.optional(v.number()),
  label: v.optional(v.string()),
  anonymous: v.optional(v.boolean()),
  n: v.number(),
  ms: v.number(),
  errors: v.number(),
  failed: v.number(),
  short_n: v.number(),
  short_ms: v.number(),
  short_errors: v.number(),
  short_failed: v.number(),
  first_at: v.number(),
  last_at: v.number(),
});

export const writeSums = internalMutation({
  args: { source_id: v.id("event_sources"), stamp: v.number(), sums: v.array(sumValidator) },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source) return;
    await writeTallySums(ctx, { workspace: source.workspace, source_id: source._id }, args.sums, args.stamp);
  },
});

/** Delete the rows neither this recount nor a live write since touched (a person who has no recordings left), a page at a time; then stamp the source. */
export const pruneAndStamp = internalMutation({
  args: { source_id: v.id("event_sources"), stamp: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<{ cursor: string; done: boolean }> => {
    const page = await ctx.db.query("replay_tallies").withIndex("by_source_person", (q) => q.eq("source_id", args.source_id)).paginate({ cursor: args.cursor, numItems: 500 });
    for (const r of page.page) if (r.updated_at < args.stamp) await ctx.db.delete(r._id);
    if (page.isDone) {
      const source = await ctx.db.get(args.source_id);
      if (source) await ctx.db.patch(source._id, { replay_tally_at: args.stamp });
    }
    return { cursor: page.continueCursor, done: page.isDone };
  },
});

/** Count one source's recordings whole onto its tally rows. */
export const rebuild = internalAction({
  args: { source_id: v.id("event_sources") },
  handler: async (ctx, args): Promise<{ people: number; recordings: number }> => {
    const stamp = Date.now();
    const sums = new Map<string, TallySum>();
    let cursor: string | null = null;
    for (let i = 0; i < 1000; i++) {
      const page: { sums: TallySum[]; cursor: string; done: boolean } = await ctx.runQuery(internal.replayTallies.rebuildPage, { source_id: args.source_id, cursor });
      mergeTallySums(sums, page.sums);
      if (page.done) break;
      cursor = page.cursor;
    }
    const all = [...sums.values()];
    for (let i = 0; i < all.length; i += WRITE_CHUNK) await ctx.runMutation(internal.replayTallies.writeSums, { source_id: args.source_id, stamp, sums: all.slice(i, i + WRITE_CHUNK) });
    let prune: string | null = null;
    for (let i = 0; i < 1000; i++) {
      const out: { cursor: string; done: boolean } = await ctx.runMutation(internal.replayTallies.pruneAndStamp, { source_id: args.source_id, stamp, cursor: prune });
      if (out.done) break;
      prune = out.cursor;
    }
    return { people: all.filter((s) => s.person_key !== undefined).length, recordings: all.reduce((n, s) => n + s.n, 0) };
  },
});

/** Every source's id, for rebuildAll. */
export const allSources = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("event_sources").collect()).map((s) => s._id),
});

/** Recount every source, one after another: `packages/convex/run.sh replayTallies:rebuildAll '{}'`. */
export const rebuildAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sources: number }> => {
    const ids: Id<"event_sources">[] = await ctx.runQuery(internal.replayTallies.allSources, {});
    for (let i = 0; i < ids.length; i++) await ctx.scheduler.runAfter(i * 2_000, internal.replayTallies.rebuild, { source_id: ids[i] });
    return { sources: ids.length };
  },
});
