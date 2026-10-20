// Regrouping stored recordings into replay_issue groups (docs/architecture/
// external-data.md X5, "Replay issues"). A recording is grouped when its
// stream is read (assembly, a vendor import); this pass reads the ones stored
// before that, or again after the rules change. A recording counts once per
// group (ingest.recordReplayIssues), so running it twice adds nothing.
//
// It walks a source's recordings oldest first from `after`, and answers where
// it stopped. `max_transitions` stops it once that many groups opened or
// regressed, because a source promotes at most SOURCE_CAPS.promotions_per_hour
// and drops the rest: a backfill of history runs in slices an hour apart so
// every new group reaches the line. `dry_run` reads and groups without
// writing, so a person can judge the rules on real recordings first.
import { v } from "convex/values";
import { internalAction, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { applyIssues, readReplayChunks } from "./replays";
import { replaysBucketFromEnv } from "./lib/r2";
import { replayIssues, type ReplayIssue } from "@codecast/shared/replay";
import type { ReplayProvider } from "@codecast/shared/contracts/replay";

/** Recordings one call reads at most; a longer window continues from the returned cursor. */
export const REGROUP_PAGE = 150;
const CONCURRENCY = 6;

type Row = { _id: Id<"replays">; short_id: string; provider: ReplayProvider; started_at: number; url?: string; chunk_keys: string[] };

export const regroupPage = internalQuery({
  args: { source_id: v.id("event_sources"), after: v.number(), limit: v.number() },
  handler: async (ctx, args): Promise<Row[]> => {
    const rows = await ctx.db
      .query("replays")
      .withIndex("by_source_started", (q) => q.eq("source_id", args.source_id).gt("started_at", args.after))
      .take(args.limit);
    return rows.map((r) => ({ _id: r._id, short_id: r.short_id, provider: r.provider, started_at: r.started_at, url: r.url, chunk_keys: r.chunk_keys }));
  },
});

type Tally = { kind: string; title: string; count: number; replays: string[]; first: number; last: number };

export const regroupSource = internalAction({
  args: {
    source_id: v.id("event_sources"),
    days: v.number(),
    dry_run: v.optional(v.boolean()),
    /** started_at of the last recording a previous call finished: this call reads newer ones. */
    after: v.optional(v.number()),
    max_transitions: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const bucket = replaysBucketFromEnv();
    if (!bucket) throw new Error("Replays storage is not configured (REPLAYS_R2_*)");
    const rows: Row[] = await ctx.runQuery(internal.replayIssues.regroupPage, {
      source_id: args.source_id,
      after: Math.max(args.after ?? 0, Date.now() - args.days * 86_400_000),
      limit: REGROUP_PAGE,
    });
    const read = async (row: Row) => {
      const { events, skipped } = await readReplayChunks(bucket, row.chunk_keys, { serverWritten: row.provider !== "sdk" });
      const start = row.url ?? events.find((e) => e.type === "nav")?.url;
      return { events, skipped, start, issues: replayIssues(events, start, row.provider === "sdk" ? 0 : events[0]?.t ?? 0) };
    };
    // Streams are read ahead in parallel; writes go in order, so the cursor is exact.
    const reads: Array<Promise<Awaited<ReturnType<typeof read>> | null>> = [];
    let next = 0;
    const pump = () => {
      while (reads.length < rows.length && reads.length - next < CONCURRENCY) {
        const row = rows[reads.length];
        reads.push(row.chunk_keys.length ? read(row).catch(() => null) : Promise.resolve(null));
      }
    };

    const tally = new Map<string, Tally>();
    let done = 0, eventsRead = 0, chunksSkipped = 0, withIssues = 0, groups = 0, transitions = 0, failed = 0;
    let cursor: number | null = null;
    for (; next < rows.length; next++) {
      pump();
      const row = rows[next];
      const got = await reads[next];
      if (row.chunk_keys.length && !got) failed++;
      if (got) {
        eventsRead += got.events.length;
        chunksSkipped += got.skipped;
        if (got.issues.length) withIssues++;
        for (const i of got.issues as ReplayIssue[]) {
          const at = row.started_at + i.t;
          const t = tally.get(i.fp) ?? { kind: i.kind, title: i.title, count: 0, replays: [], first: at, last: at };
          t.count++;
          if (t.replays.length < 8) t.replays.push(row.short_id);
          t.first = Math.min(t.first, at);
          t.last = Math.max(t.last, at);
          tally.set(i.fp, t);
        }
        if (!args.dry_run && got.issues.length) {
          const out = await applyIssues(ctx, row._id, row.provider, got.events, got.start);
          groups += out.groups;
          transitions += out.transitions;
        }
      }
      done++;
      cursor = row.started_at;
      if (args.max_transitions !== undefined && transitions >= args.max_transitions) break;
    }
    const more = done < rows.length || rows.length === REGROUP_PAGE;
    return {
      recordings: done,
      events: eventsRead,
      chunks_skipped: chunksSkipped,
      with_issues: withIssues,
      failed,
      ...(args.dry_run ? {} : { groups_written: groups, transitions }),
      next_after: more ? cursor : null,
      groups: [...tally.entries()].sort((a, b) => b[1].count - a[1].count).map(([fp, t]) => ({ fp, ...t })),
    };
  },
});
