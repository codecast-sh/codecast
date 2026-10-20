// Regrouping stored recordings into replay_issue groups (docs/architecture/
// external-data.md X5, "Replay issues"). A recording is grouped when its
// stream is read (assembly, a vendor import); this pass reads the ones stored
// before that, or again after the rules change. A recording counts once per
// group (ingest.recordReplayIssues), so running it twice adds nothing.
//
// `dry_run` reads and groups without writing, and answers the groups it would
// make, so a person can judge the rules on real recordings first.
import { v } from "convex/values";
import { internalAction, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { applyIssues, readReplayChunks } from "./replays";
import { replaysBucketFromEnv } from "./lib/r2";
import { replayIssues, type ReplayIssue } from "@codecast/shared/replay";

/** Recordings one call reads; a longer window continues from the returned cursor. */
export const REGROUP_PAGE = 150;
const CONCURRENCY = 6;

export const regroupPage = internalQuery({
  args: { source_id: v.id("event_sources"), since: v.number(), before: v.optional(v.number()), limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("replays")
      .withIndex("by_source_started", (q) => {
        const from = q.eq("source_id", args.source_id).gte("started_at", args.since);
        return args.before !== undefined ? from.lt("started_at", args.before) : from;
      })
      .order("desc")
      .take(args.limit);
    return rows.map((r) => ({ _id: r._id, short_id: r.short_id, started_at: r.started_at, url: r.url, chunk_keys: r.chunk_keys }));
  },
});

type Tally = { kind: string; title: string; count: number; replays: string[]; first: number; last: number };

export const regroupSource = internalAction({
  args: {
    source_id: v.id("event_sources"),
    days: v.number(),
    dry_run: v.optional(v.boolean()),
    /** started_at of the last recording a previous call read: this call reads older ones. */
    before: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const bucket = replaysBucketFromEnv();
    if (!bucket) throw new Error("Replays storage is not configured (REPLAYS_R2_*)");
    const rows: Array<{ _id: Id<"replays">; short_id: string; started_at: number; url?: string; chunk_keys: string[] }> = await ctx.runQuery(internal.replayIssues.regroupPage, {
      source_id: args.source_id,
      since: Date.now() - args.days * 86_400_000,
      before: args.before,
      limit: REGROUP_PAGE,
    });
    const tally = new Map<string, Tally>();
    let read = 0, withIssues = 0, groups = 0, transitions = 0, failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const row = rows[next++];
        if (!row.chunk_keys.length) continue;
        try {
          const { events } = await readReplayChunks(bucket, row.chunk_keys);
          read++;
          const start = row.url ?? events.find((e) => e.type === "nav")?.url;
          const issues: ReplayIssue[] = replayIssues(events, start);
          if (issues.length) withIssues++;
          for (const i of issues) {
            const at = row.started_at + i.t;
            const t = tally.get(i.fp) ?? { kind: i.kind, title: i.title, count: 0, replays: [], first: at, last: at };
            t.count++;
            if (t.replays.length < 8) t.replays.push(row.short_id);
            t.first = Math.min(t.first, at);
            t.last = Math.max(t.last, at);
            tally.set(i.fp, t);
          }
          if (!args.dry_run && issues.length) {
            const out = await applyIssues(ctx, row._id, events, start);
            groups += out.groups;
            transitions += out.transitions;
          }
        } catch {
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return {
      recordings: rows.length,
      read,
      with_issues: withIssues,
      failed,
      ...(args.dry_run ? {} : { groups_written: groups, transitions }),
      next_before: rows.length === REGROUP_PAGE ? rows[rows.length - 1].started_at : null,
      groups: [...tally.entries()].sort((a, b) => b[1].count - a[1].count).map(([fp, t]) => ({ fp, ...t })),
    };
  },
});
