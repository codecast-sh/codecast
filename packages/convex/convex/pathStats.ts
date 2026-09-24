// Exact session totals per folder for the Sync settings page, at any size.
//
// The page used to count a folder by reading its sessions inside the query,
// stopped at 1,024 per index range, and showed "N+": 1,074+ for a folder with
// more than 1,544 on one laptop. Reading every session on every page open does
// not scale either. So a folder's totals live in one small row, rebuilt by a
// job that pages through the folder with no cap, and the page reads the rows.
//
// The job runs when the page asks (refreshPathStats) and the row is older than
// a minute, or at once after a write that changes what the numbers say. The
// folder match is the same as scanConversationsForPath: sessions whose
// checkout root (else working folder) is the folder or lies under it.
//
// "How many started before date X" is answered from a histogram of start
// times: one bucket per hour for the last 180 days, one per day before that,
// in two parallel arrays (Convex caps an object at 1,024 fields and an array
// at 8,192 values; 180 x 24 + ten years of days stays under it).

import { getUserOrToken } from "./lib/auth";
import { v } from "convex/values";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FINE_WINDOW = 180 * DAY;
/** A row younger than this is fresh enough for a page open. */
export const STATS_FRESH_MS = 60_000;
/** A rebuild that has not finished in this long is presumed dead. */
const REFRESH_STALE_MS = 5 * 60_000;
const PAGE = 200;
const MAX_PATHS = 120;

export type PathStatsAcc = {
  count: number;
  first: number | null;
  last: number | null;
  hidden: number;
  manually_shared: number;
  /** Bucket start (ms) to sessions started in it. */
  buckets: Map<number, number>;
};

export function emptyAcc(): PathStatsAcc {
  return { count: 0, first: null, last: null, hidden: 0, manually_shared: 0, buckets: new Map() };
}

function conversationStart(conv: any): number | null {
  const started = conv.started_at ?? conv.updated_at ?? null;
  return typeof started === "number" && Number.isFinite(started) ? started : null;
}

/** The bucket a start time falls in: its hour when recent, its UTC day before. */
export function bucketOf(started: number, now: number): number {
  return now - started <= FINE_WINDOW ? Math.floor(started / HOUR) * HOUR : Math.floor(started / DAY) * DAY;
}

export function foldConversation(acc: PathStatsAcc, conv: any, now: number): void {
  acc.count++;
  const started = conversationStart(conv);
  if (started != null) {
    acc.first = acc.first == null ? started : Math.min(acc.first, started);
    acc.last = acc.last == null ? started : Math.max(acc.last, started);
    const b = bucketOf(started, now);
    acc.buckets.set(b, (acc.buckets.get(b) ?? 0) + 1);
  }
  if (conv.team_visibility === "private") acc.hidden++;
  else if (conv.is_private === false && !conv.auto_shared) acc.manually_shared++;
}

/** Sessions started before `at`, from the histogram. Exact at hour
 *  boundaries in the recent window, which is where a local midnight lands. */
export function startedBefore(buckets: number[], counts: number[], at: number): number {
  let n = 0;
  for (let i = 0; i < buckets.length; i++) if (buckets[i] < at) n += counts[i];
  return n;
}

// The four index ranges a folder spans, in the order the job walks them:
// sessions keyed by checkout root (the folder itself, then roots under it),
// then sessions with no checkout keyed by working folder.
const STAGES = [
  { index: "by_user_git_root", field: "git_root", child: false },
  { index: "by_user_git_root", field: "git_root", child: true },
  { index: "by_user_project_path", field: "project_path", child: false },
  { index: "by_user_project_path", field: "project_path", child: true },
] as const;

function rangeFor(stage: (typeof STAGES)[number], userId: Id<"users">, path: string) {
  const childPrefix = path.endsWith("/") ? path : `${path}/`;
  return stage.child
    ? (q: any) => q.eq("user_id", userId).gte(stage.field, childPrefix).lt(stage.field, `${childPrefix}￿`)
    : (q: any) => q.eq("user_id", userId).eq(stage.field, path);
}

function inFolder(conv: any, path: string, stage: (typeof STAGES)[number]): boolean {
  if (stage.field === "project_path" && conv.git_root) return false;
  const p = conv.git_root || conv.project_path;
  return !!p && (p === path || p.startsWith(`${path}/`));
}

const accValidator = v.object({
  count: v.number(),
  first: v.union(v.number(), v.null()),
  last: v.union(v.number(), v.null()),
  hidden: v.number(),
  manually_shared: v.number(),
  buckets: v.array(v.number()),
  bucket_counts: v.array(v.number()),
});

function packAcc(acc: PathStatsAcc) {
  const keys = [...acc.buckets.keys()].sort((a, b) => a - b);
  return {
    count: acc.count, first: acc.first, last: acc.last, hidden: acc.hidden, manually_shared: acc.manually_shared,
    buckets: keys, bucket_counts: keys.map((k) => acc.buckets.get(k)!),
  };
}

function unpackAcc(packed: ReturnType<typeof packAcc>): PathStatsAcc {
  return {
    count: packed.count, first: packed.first, last: packed.last, hidden: packed.hidden, manually_shared: packed.manually_shared,
    buckets: new Map(packed.buckets.map((b, i) => [b, packed.bucket_counts[i]])),
  };
}

/** One page of one range; schedules the next page until the folder is done,
 *  then writes the totals in one patch. */
export const recomputePathStats = internalMutation({
  args: {
    user_id: v.id("users"),
    path: v.string(),
    stage: v.number(),
    cursor: v.union(v.string(), v.null()),
    acc: accValidator,
    started_at: v.number(),
  },
  handler: async (ctx, args) => {
    const stage = STAGES[args.stage];
    const acc = unpackAcc(args.acc);
    const page = await ctx.db
      .query("conversations")
      .withIndex(stage.index as any, rangeFor(stage, args.user_id, args.path))
      .paginate({ numItems: PAGE, cursor: args.cursor });
    for (const conv of page.page) if (inFolder(conv, args.path, stage)) foldConversation(acc, conv, args.started_at);

    const nextStage = page.isDone ? args.stage + 1 : args.stage;
    if (nextStage < STAGES.length) {
      await ctx.scheduler.runAfter(0, internal.pathStats.recomputePathStats, {
        ...args, stage: nextStage, cursor: page.isDone ? null : page.continueCursor, acc: packAcc(acc),
      });
      return;
    }
    const row = await ctx.db
      .query("path_session_stats")
      .withIndex("by_user_path", (q) => q.eq("user_id", args.user_id).eq("path", args.path))
      .first();
    const packed = packAcc(acc);
    const totals = {
      count: packed.count,
      first_started_at: packed.first ?? undefined,
      last_started_at: packed.last ?? undefined,
      hidden: packed.hidden,
      manually_shared: packed.manually_shared,
      buckets: packed.buckets,
      bucket_counts: packed.bucket_counts,
      computed_at: args.started_at,
      refresh_started_at: undefined,
    };
    if (row) await ctx.db.patch(row._id, totals);
    else await ctx.db.insert("path_session_stats", { user_id: args.user_id, path: args.path, ...totals });
  },
});

/** Queue a rebuild for every folder whose row is missing or stale. `force`
 *  skips the freshness window (after a write), never a rebuild in flight. */
export async function requestPathStats(ctx: any, userId: Id<"users">, paths: string[], force = false): Promise<number> {
  const now = Date.now();
  let queued = 0;
  for (const path of [...new Set(paths)].slice(0, MAX_PATHS)) {
    const row = await ctx.db
      .query("path_session_stats")
      .withIndex("by_user_path", (q: any) => q.eq("user_id", userId).eq("path", path))
      .first();
    if (row?.refresh_started_at && now - row.refresh_started_at < REFRESH_STALE_MS) continue;
    if (!force && row && now - row.computed_at < STATS_FRESH_MS) continue;
    if (row) await ctx.db.patch(row._id, { refresh_started_at: now });
    else await ctx.db.insert("path_session_stats", {
      user_id: userId, path, count: 0, hidden: 0, manually_shared: 0, buckets: [], bucket_counts: [], computed_at: 0, refresh_started_at: now,
    });
    await ctx.scheduler.runAfter(0, internal.pathStats.recomputePathStats, {
      user_id: userId, path, stage: 0, cursor: null, acc: packAcc(emptyAcc()), started_at: now,
    });
    queued++;
  }
  return queued;
}

export const refreshPathStats = mutation({
  args: { paths: v.array(v.string()), force: v.optional(v.boolean()), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getUserOrToken(ctx, args.api_token);
    if (!userId) return { queued: 0 };
    return { queued: await requestPathStats(ctx, userId, args.paths, !!args.force) };
  },
});
