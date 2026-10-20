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
import { internalAction, internalMutation, internalQuery } from "./functions";
import { patchSourceStats } from "./ingest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { applyIssues, readReplayChunks } from "./replays";
import { replaysBucketFromEnv } from "./lib/r2";
import { isFailedRequest, replayIssues, type ReplayIssue } from "@codecast/shared/replay";
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
    /**
     * With dry_run: each recording's grouping-relevant events (navigations,
     * errors, failed requests, clicks) come back, so a change to the rules can
     * be compared on real recordings before it ships. Never kept anywhere.
     */
    export_events: v.optional(v.boolean()),
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

    const exported: Array<{ replay: string; provider: string; start?: string; events: unknown[] }> = [];
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
        if (args.dry_run && args.export_events) {
          const kept = got.events.filter((e) => e.type === "nav" || e.type === "error" || e.type === "click" || (e.type === "console" && e.level === "error") || (e.type === "network" && isFailedRequest(e)));
          exported.push({ replay: row.short_id, provider: row.provider, start: got.start, events: kept });
        }
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
      // Too large to print: stored once, read from its url, deleted by the caller (deleteExport).
      ...(exported.length ? await exportUrl(ctx, exported) : {}),
    };
  },
});

async function exportUrl(ctx: any, exported: unknown[]): Promise<{ export_id: string; export_url: string | null }> {
  const id = await ctx.storage.store(new Blob([JSON.stringify(exported)], { type: "application/json" }));
  return { export_id: String(id), export_url: await ctx.storage.getUrl(id) };
}

/** A regroup export, gone once read. */
export const deleteExport = internalAction({
  args: { export_id: v.id("_storage") },
  handler: async (ctx, args) => {
    await ctx.storage.delete(args.export_id);
  },
});

/**
 * A source's replay_issue groups taken down so a regroup pass can build them
 * again under changed rules: each group with its samples, tally, timeline
 * rows and held signals, and the recordings' links to it. A group that
 * already reached a cause is kept, since the line holds work on it. One call
 * clears up to `limit` groups; it answers how many it cleared and kept.
 */
export const clearGroups = internalMutation({
  args: { source_id: v.id("event_sources"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source) return { cleared: 0, kept: 0 };
    const all = await ctx.db.query("event_groups").withIndex("by_source_last_seen", (q) => q.eq("source_id", args.source_id)).collect();
    const issues = all.filter((g) => g.kind === "replay_issue");
    const kept = issues.filter((g) => g.signal_task_id);
    const clear = issues.filter((g) => !g.signal_task_id).slice(0, args.limit ?? 200);
    const ids = new Set(clear.map((g) => String(g._id)));
    if (!ids.size) return { cleared: 0, kept: kept.length };
    const signalSource = `${source.provider}:${source.name}`;
    for (const g of clear) {
      for (const s of await ctx.db.query("event_samples").withIndex("by_group_at", (q) => q.eq("group_id", g._id)).collect()) await ctx.db.delete(s._id);
      for (const t of await ctx.db.query("event_group_tallies").withIndex("by_group", (q) => q.eq("group_id", g._id)).collect()) await ctx.db.delete(t._id);
      const signals = await ctx.db.query("signals").withIndex("by_workspace_subject", (q) => q.eq("workspace", source.workspace).eq("subject", g.short_id)).collect();
      for (const s of signals) if (s.source === signalSource && !s.task_id) await ctx.db.delete(s._id);
      await ctx.db.delete(g._id);
    }
    for (const e of await ctx.db.query("external_events").withIndex("by_source_created", (q) => q.eq("source_id", args.source_id)).collect()) {
      if (e.group_id && ids.has(String(e.group_id))) await ctx.db.delete(e._id);
    }
    for (const r of await ctx.db.query("replays").withIndex("by_source_started", (q) => q.eq("source_id", args.source_id)).collect()) {
      const left = r.group_ids.filter((id) => !ids.has(String(id)));
      if (left.length !== r.group_ids.length) await ctx.db.patch(r._id, { group_ids: left });
    }
    const open = clear.filter((g) => g.status === "open").length;
    if (open) await patchSourceStats(ctx, source, (s) => ({ groups_open: Math.max(0, (s.groups_open ?? 0) - open) }));
    return { cleared: clear.length, kept: kept.length };
  },
});
