// Watched metrics (docs/architecture/external-data.md X7, X3). A watch names
// one number a source can answer (a PostHog HogQL query or saved insight), a
// line and a direction, and how often to look. The poll keeps the last
// GROUP_RULES.metric_points values on the watch and hands each one to the
// group upsert as a `metric` occurrence, so crossing the line is a
// metric_alert transition and coming back is metric_recovered: the same
// timeline row, trigger and promotion path every other group takes.
//
// Every public function authenticates itself through ingest.scopeOf and holds
// the watch to the caller's stored workspace key, never to team_id.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { invalidScope, notFound, requireUserOrToken } from "./lib/auth";
import { nextShortId } from "./counters";
import { patchSourceStats, scopeArgs, scopeOf, sourceByRef, upsertGroup } from "./ingest";
import { rowByRef } from "./lib/rowByRef";
import { appendMetricPoint, mergeMetricHistory, planMetric } from "./lib/ingestGroups";
import { connFor, fetchMetricHistory, fetchMetricValue, validWatchQuery } from "./sources/posthog";
import { isTokenRefusal } from "./lib/sourceHealth";
import { INGEST_LIMITS, INGEST_SHORT_ID_PREFIX, METRIC_WATCH_LIMITS, type SourceProvider, type WatchKind } from "@codecast/shared/contracts/ingest";
import { watchDirectionValidator as directionValidator, watchKindValidator } from "./ingestSchema";

/** Which watch kinds a source can answer. A provider absent here has no polled metrics. */
export const WATCH_KINDS_BY_PROVIDER: Partial<Record<SourceProvider, readonly WatchKind[]>> = {
  posthog: ["hogql", "insight"],
};


/** How many due watches one claim takes; a full page claims the next at once. */
const POLL_CLAIM_MAX = 50;
const LIST_MAX = 200;

export function clampInterval(ms: number | undefined): number {
  if (ms === undefined) return METRIC_WATCH_LIMITS.interval_default_ms;
  if (!Number.isFinite(ms)) invalidScope("The interval must be a number of milliseconds");
  return Math.min(Math.max(Math.round(ms), METRIC_WATCH_LIMITS.interval_min_ms), METRIC_WATCH_LIMITS.interval_max_ms);
}

/** Why a watch cannot be made on this source, or null. */
export function watchProblem(provider: SourceProvider, kind: WatchKind, queryText: string, threshold: number): string | null {
  const kinds = WATCH_KINDS_BY_PROVIDER[provider];
  if (!kinds?.includes(kind)) return `A ${provider} source cannot watch a ${kind} metric${kinds ? ` (it takes ${kinds.join(" or ")})` : ""}`;
  if (!Number.isFinite(threshold)) return "The threshold must be a number";
  if (kind === "hogql" || kind === "insight") return validWatchQuery(kind, queryText);
  return null;
}

async function watchByRef(ctx: any, userId: Id<"users">, ref: string): Promise<Doc<"metric_watches">> {
  return await rowByRef(ctx, "metric_watches", userId, ref, "Metric watch");
}

/** A watch as readers see it, with its latest value and source named. */
function watchView(row: Doc<"metric_watches">, source: Pick<Doc<"event_sources">, "short_id" | "name"> | null) {
  const last = row.points[row.points.length - 1];
  return { ...row, last_value: last?.value ?? null, last_at: last?.at ?? null, source_name: source?.name ?? null, source_short_id: source?.short_id ?? null };
}

// ── CRUD ──

export const createWatch = mutation({
  args: {
    ...scopeArgs,
    source: v.string(),
    name: v.string(),
    query_kind: watchKindValidator,
    query: v.string(),
    threshold: v.number(),
    direction: directionValidator,
    interval_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const source = await sourceByRef(ctx, userId, workspaceKey, args.source);
    const name = args.name.trim();
    if (!name || name.length > INGEST_LIMITS.name_chars) invalidScope("A watch needs a name");
    const problem = watchProblem(source.provider, args.query_kind, args.query, args.threshold);
    if (problem) invalidScope(problem);
    const now = Date.now();
    const id = await ctx.db.insert("metric_watches", {
      workspace: source.workspace,
      team_id: source.team_id,
      source_id: source._id,
      short_id: await nextShortId(ctx.db, INGEST_SHORT_ID_PREFIX.metric_watch),
      created_by: userId,
      name,
      query_kind: args.query_kind,
      query: args.query.trim(),
      threshold: args.threshold,
      direction: args.direction,
      interval_ms: clampInterval(args.interval_ms),
      status: "active",
      // Due at once, so a new watch shows a value on the next cron tick.
      next_check_at: now,
      points: [],
      state: "ok",
      history: { at: now, added: 0, reading: true },
      created_at: now,
      updated_at: now,
    });
    // The past the source already holds comes over now, not one poll at a time.
    await ctx.scheduler.runAfter(0, internal.metrics.readHistory, { watch_id: id });
    return { watch: watchView((await ctx.db.get(id))!, source) };
  },
});

export const updateWatch = mutation({
  args: {
    ...scopeArgs,
    watch: v.string(),
    name: v.optional(v.string()),
    query: v.optional(v.string()),
    threshold: v.optional(v.number()),
    direction: v.optional(directionValidator),
    interval_ms: v.optional(v.number()),
    status: v.optional(v.union(v.literal("active"), v.literal("paused"))),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await watchByRef(ctx, userId, args.watch);
    const source = await ctx.db.get(row.source_id);
    if (!source) notFound("The watch's source was removed");
    const now = Date.now();
    const patch: Partial<Doc<"metric_watches">> = { updated_at: now };
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name || name.length > INGEST_LIMITS.name_chars) invalidScope("A watch needs a name");
      patch.name = name;
    }
    if (args.query !== undefined) patch.query = args.query.trim();
    if (args.threshold !== undefined) patch.threshold = args.threshold;
    if (args.direction) patch.direction = args.direction;
    if (args.interval_ms !== undefined) patch.interval_ms = clampInterval(args.interval_ms);
    const problem = watchProblem(source!.provider, row.query_kind, patch.query ?? row.query, patch.threshold ?? row.threshold);
    if (problem) invalidScope(problem);
    if (args.status) {
      patch.status = args.status;
      // A paused watch leaves the poll index; resuming makes it due at once.
      patch.next_check_at = args.status === "active" ? now : undefined;
      if (args.status === "active") patch.last_error = undefined;
    } else if (row.status === "active" && (patch.query !== undefined || patch.interval_ms !== undefined)) {
      patch.next_check_at = now;
    }
    await ctx.db.patch(row._id, patch);
    return { watch: watchView((await ctx.db.get(row._id))!, source) };
  },
});

/** Removes the watch. Its group and the transitions it announced stay as history. */
export const removeWatch = mutation({
  args: { ...scopeArgs, watch: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await watchByRef(ctx, userId, args.watch);
    await ctx.db.delete(row._id);
    return { removed: row.short_id };
  },
});

export const listWatches = query({
  args: { ...scopeArgs, source: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const source = args.source ? await sourceByRef(ctx, userId, workspaceKey, args.source) : null;
    const rows: Doc<"metric_watches">[] = await (source
      ? ctx.db.query("metric_watches").withIndex("by_source", (q) => q.eq("source_id", source._id))
      : ctx.db.query("metric_watches").withIndex("by_workspace", (q) => q.eq("workspace", workspaceKey))
    ).take(LIST_MAX);
    const sources = new Map<string, Doc<"event_sources"> | null>();
    const out = [];
    for (const row of rows) {
      if (row.workspace !== workspaceKey) continue;
      const key = String(row.source_id);
      if (!sources.has(key)) sources.set(key, await ctx.db.get(row.source_id));
      out.push(watchView(row, sources.get(key) ?? null));
    }
    return out;
  },
});

export const getWatch = query({
  args: { ...scopeArgs, watch: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await watchByRef(ctx, userId, args.watch);
    const group = row.group_id ? await ctx.db.get(row.group_id) : null;
    return {
      watch: watchView(row, await ctx.db.get(row.source_id)),
      group: group ? { _id: group._id, short_id: group.short_id, status: group.status, title: group.title, count: group.count, last_transition: group.last_transition ?? null, last_transition_at: group.last_transition_at ?? null } : null,
    };
  },
});

// ── The poll (crons.ts) ──

/**
 * Every minute: claim the due watches by moving each one's next check a full
 * interval ahead, then poll each in its own action. Claiming first means a
 * slow or failing poll is never started twice, and one bad watch never holds
 * up the rest.
 */
export const pollDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // The lower bound matters: an absent next_check_at (a paused watch) sorts
    // before every number, and would otherwise fill the claim forever.
    const due = await ctx.db
      .query("metric_watches")
      .withIndex("by_next_check", (q) => q.gte("next_check_at", 0).lte("next_check_at", now))
      .take(POLL_CLAIM_MAX);
    let claimed = 0;
    for (const row of due) {
      if (row.status !== "active" || row.next_check_at === undefined || row.next_check_at > now) continue;
      await ctx.db.patch(row._id, { next_check_at: now + row.interval_ms });
      claimed++;
      // A source stopped on a lost connection (lib/sourceHealth) or paused is
      // not polled: the claim moves on, no action runs, nothing is fetched.
      const source = await ctx.db.get(row.source_id);
      if (source?.status !== "active") continue;
      await ctx.scheduler.runAfter(0, internal.metrics.pollWatch, { watch_id: row._id });
    }
    // A full page means more are due: claim the next page now rather than
    // letting every watch past the first page slip a minute per tick.
    if (claimed === POLL_CLAIM_MAX) await ctx.scheduler.runAfter(0, internal.metrics.pollDue, {});
    return claimed;
  },
});

export const pollInputs = internalQuery({
  args: { watch_id: v.id("metric_watches") },
  handler: async (ctx, args) => {
    const watch = await ctx.db.get(args.watch_id);
    return watch && watch.status === "active" ? { query_kind: watch.query_kind, query: watch.query, source_id: watch.source_id } : null;
  },
});

/** Read one watch's value from its source and record it. */
export const pollWatch = internalAction({
  args: { watch_id: v.id("metric_watches") },
  handler: async (ctx, args): Promise<{ value?: number; error?: string } | null> => {
    const watch = await ctx.runQuery(internal.metrics.pollInputs, args);
    if (!watch) return null;
    const source = await ctx.runQuery(internal.sources.posthog.sourceForPoll, { source_id: watch.source_id });
    if (!source || source.status !== "active") return null;
    const at = Date.now();
    const conn = await connFor(ctx, source);
    const read = "error" in conn ? { ok: false as const, error: conn.error, lost: true } : await fetchMetricValue(conn, watch);
    const result = read.ok ? { value: read.value } : { error: read.error };
    await ctx.runMutation(internal.metrics.recordPoint, { watch_id: args.watch_id, at, ...result });
    // No connection, or one PostHog refuses: the source stops polling (lib/sourceHealth).
    if (!read.ok && ("lost" in read || isTokenRefusal(read.status))) {
      await ctx.runMutation(internal.ingest.sourceConnectionLost, { source_id: source.source_id, error: read.error });
    }
    return result;
  },
});

/**
 * One polled value (or the reason there is none) onto the watch, and the
 * value through the group upsert, which decides whether it is a transition.
 */
export const recordPoint = internalMutation({
  args: { watch_id: v.id("metric_watches"), at: v.number(), value: v.optional(v.number()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const watch = await ctx.db.get(args.watch_id);
    if (!watch || watch.status !== "active") return null;
    const source = await ctx.db.get(watch.source_id);
    if (!source || source.status !== "active") return null;
    const now = Date.now();
    if (args.value === undefined || !Number.isFinite(args.value)) {
      // A failed read is not a value: the state and the group stay where they were.
      await ctx.db.patch(watch._id, { last_error: (args.error ?? "No value").slice(0, INGEST_LIMITS.message_chars), updated_at: now });
      await patchSourceStats(ctx, source, () => ({ last_poll_at: now }), now);
      return null;
    }
    const value = args.value;
    const plan = planMetric({ short_id: watch.short_id, name: watch.name, threshold: watch.threshold, direction: watch.direction, id: String(watch._id) }, value, args.at);
    const upserted = await upsertGroup(ctx, source, [plan], {}, now);
    await ctx.db.patch(watch._id, {
      points: appendMetricPoint(watch.points, { at: args.at, value }),
      state: plan.occurrence.ok === false ? "alert" : "ok",
      group_id: upserted.group_id,
      last_error: undefined,
      updated_at: now,
    });
    // A poll is not an ingested event, so the *_today counters stay the door's.
    await patchSourceStats(ctx, source, (st) => ({ groups_open: Math.max(0, (st.groups_open ?? 0) + upserted.open_delta), last_poll_at: now }), now);
    return { group_id: upserted.group_id, transitions: upserted.transitions };
  },
});

// ── History (metrics.loadHistory, `cast metrics backfill`) ──

export function backfillDays(days: number | undefined): number {
  if (days === undefined) return METRIC_WATCH_LIMITS.backfill_days_default;
  if (!Number.isFinite(days) || days <= 0) invalidScope("--days must be a positive number");
  return Math.min(days, METRIC_WATCH_LIMITS.backfill_days_max);
}

/**
 * `cast metrics backfill` and the Metrics tab's "Load history": every watch
 * in reach (one, a source's, or the workspace's) reads the past its source
 * can answer, `days` back, each in its own action. A new watch does this on
 * its own.
 */
export const loadHistory = mutation({
  args: { ...scopeArgs, source: v.optional(v.string()), watch: v.optional(v.string()), days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    let rows: Doc<"metric_watches">[];
    if (args.watch) rows = [await watchByRef(ctx, userId, args.watch)];
    else {
      const source = args.source ? await sourceByRef(ctx, userId, workspaceKey, args.source) : null;
      rows = await (source
        ? ctx.db.query("metric_watches").withIndex("by_source", (q) => q.eq("source_id", source._id))
        : ctx.db.query("metric_watches").withIndex("by_workspace", (q) => q.eq("workspace", workspaceKey))
      ).take(LIST_MAX);
      rows = rows.filter((r) => r.workspace === workspaceKey);
    }
    const days = backfillDays(args.days);
    const scheduled: string[] = [];
    const skipped: { watch: string; reason: string }[] = [];
    // One source's watches are read one after another (each read starts the
    // next), so a project is never asked several backfills at once.
    const queues = new Map<string, Id<"metric_watches">[]>();
    const now = Date.now();
    for (const row of rows) {
      const source = await ctx.db.get(row.source_id);
      if (source?.status !== "active") {
        skipped.push({ watch: row.short_id, reason: `${source?.name ?? "its source"} is ${source?.status ?? "removed"}` });
        continue;
      }
      const queue = queues.get(String(row.source_id)) ?? [];
      queues.set(String(row.source_id), [...queue, row._id]);
      await ctx.db.patch(row._id, { history: { at: now, added: 0, reading: true } });
      scheduled.push(row.short_id);
    }
    for (const [first, ...then] of queues.values()) {
      await ctx.scheduler.runAfter(0, internal.metrics.readHistory, { watch_id: first, days, ...(then.length ? { then } : {}) });
    }
    return { scheduled, skipped };
  },
});

export const historyInputs = internalQuery({
  args: { watch_id: v.id("metric_watches") },
  handler: async (ctx, args) => {
    const watch = await ctx.db.get(args.watch_id);
    return watch ? { query_kind: watch.query_kind, query: watch.query, source_id: watch.source_id, interval_ms: watch.interval_ms, oldest: watch.points[0]?.at ?? null } : null;
  },
});

/**
 * One watch's past values from its source, under its points: an insight's
 * own series, or a HogQL query read again at past instants through the
 * poll's read (sources/posthog fetchMetricHistory). History never announces
 * a transition and never moves the watch's state or group: those follow the
 * live polls alone.
 */
export const readHistory = internalAction({
  args: { watch_id: v.id("metric_watches"), days: v.optional(v.number()), then: v.optional(v.array(v.id("metric_watches"))) },
  handler: async (ctx, args): Promise<{ added?: number; note?: string } | null> => {
    try {
      return await readOneHistory(ctx, args);
    } finally {
      const [next, ...rest] = args.then ?? [];
      if (next) await ctx.scheduler.runAfter(0, internal.metrics.readHistory, { watch_id: next, days: args.days, ...(rest.length ? { then: rest } : {}) });
    }
  },
});

/** One watch's history read (readHistory without the queue). */
async function readOneHistory(ctx: ActionCtx, args: { watch_id: Id<"metric_watches">; days?: number }): Promise<{ added?: number; note?: string } | null> {
  const watch = await ctx.runQuery(internal.metrics.historyInputs, { watch_id: args.watch_id });
  if (!watch) return null;
  const source = await ctx.runQuery(internal.sources.posthog.sourceForPoll, { source_id: watch.source_id });
  if (!source || source.status !== "active") {
    const note = source ? `The source is ${source.status}` : "The source was removed";
    await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, note });
    return { note };
  }
  const conn = await connFor(ctx, source);
  const span = { now: Date.now(), oldest: watch.oldest, interval_ms: watch.interval_ms, days: args.days ?? METRIC_WATCH_LIMITS.backfill_days_default };
  const read = "error" in conn ? { ok: false as const, error: conn.error, lost: true } : await fetchMetricHistory(conn, watch, span);
  if (read.ok) {
    const added = await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, points: read.points, ...(read.note ? { note: read.note } : {}) });
    return { ...added, ...(read.note ? { note: read.note } : {}) };
  }
  await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, note: read.error });
  if ("lost" in read || isTokenRefusal(read.status)) {
    await ctx.runMutation(internal.ingest.sourceConnectionLost, { source_id: source.source_id, error: read.error });
  }
  return { note: read.error };
}

export const recordHistory = internalMutation({
  args: { watch_id: v.id("metric_watches"), points: v.optional(v.array(v.object({ at: v.number(), value: v.number() }))), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const watch = await ctx.db.get(args.watch_id);
    if (!watch) return null;
    const now = Date.now();
    if (!args.points) {
      await ctx.db.patch(watch._id, { history: { at: now, added: 0, note: (args.note ?? "No history").slice(0, INGEST_LIMITS.message_chars) }, updated_at: now });
      return { added: 0 };
    }
    const merged = mergeMetricHistory(watch.points, args.points);
    const note = args.note?.slice(0, INGEST_LIMITS.message_chars);
    await ctx.db.patch(watch._id, { points: merged.points, history: { at: now, added: merged.added, ...(note ? { note } : {}) }, updated_at: now });
    return { added: merged.added };
  },
});
