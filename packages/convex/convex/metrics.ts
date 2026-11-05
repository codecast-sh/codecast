// Watched metrics (docs/architecture/external-data.md X7, X3). A watch names
// one number a source can answer (a PostHog HogQL query or saved insight, or
// an app connector's metric reader), a line and a direction, and how often to
// look. A watch with no line is a plain series: a goal's live number
// (contracts/initiative InitiativeMetric.series) that keeps its points and
// never opens a group. The poll keeps the last
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
import { scopeArgs, scopeOf, sourceByRef } from "./ingest";
import { upsertGroup } from "./lib/groupWrite";
import { patchSourceStats } from "./lib/sourceStats";
import { rowByRef } from "./lib/rowByRef";
import { workspaceGrantsAccess } from "./lib/access";
import { planMetric } from "./lib/ingestGroups";
import { appendMetricPoint, mergeMetricHistory, mergeReaderSeries } from "./lib/watchSeries";
import { connFor, fetchMetricHistory, fetchMetricValue } from "./sources/posthog";
import { readAppMetric } from "./sources/appMetrics";
import { isTokenRefusal } from "./lib/sourceHealth";
import { INGEST_LIMITS, INGEST_SHORT_ID_PREFIX, METRIC_WATCH_LIMITS, WATCH_KINDS_BY_PROVIDER, watchProblem } from "@codecast/shared/contracts/ingest";
import { watchDirectionValidator as directionValidator, watchKindValidator } from "./ingestSchema";
import { METRIC_SERIES, holdsPoints, oldestHeld, purgePoints, readSeries, writePoints } from "./lib/metricPoints";
import { MONITOR_LIMITS, isMuted, monitorProblem, nextMonitorState, normalizeNotify, notifyProblem, promoteFor, renotifyDue } from "@codecast/shared/contracts/metricMonitor";
import { deliverWatchAlert } from "./metricAlerts";
import { parseVolumeQuery, volumeHistory, volumeValue, type VolumeInput } from "@codecast/shared/contracts/volumeWatch";

// The watch check is the contract's, shared with the web form.
export { WATCH_KINDS_BY_PROVIDER, watchProblem };

const UNIT_CHARS = 12;
const cleanUnit = (unit: string | null | undefined): string | undefined => unit?.trim().slice(0, UNIT_CHARS) || undefined;

/** How many due watches one claim takes; a full page claims the next at once. */
const POLL_CLAIM_MAX = 50;
const LIST_MAX = 200;

export function clampInterval(ms: number | undefined): number {
  if (ms === undefined) return METRIC_WATCH_LIMITS.interval_default_ms;
  if (!Number.isFinite(ms)) invalidScope("The interval must be a number of milliseconds");
  return Math.min(Math.max(Math.round(ms), METRIC_WATCH_LIMITS.interval_min_ms), METRIC_WATCH_LIMITS.interval_max_ms);
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
    /** Absent: a series with no alert line. */
    threshold: v.optional(v.number()),
    direction: v.optional(directionValidator),
    unit: v.optional(v.string()),
    interval_ms: v.optional(v.number()),
    /** The monitor (contracts/metricMonitor.ts). */
    eval_reads: v.optional(v.number()),
    warn: v.optional(v.number()),
    no_data_after: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const source = await sourceByRef(ctx, userId, workspaceKey, args.source);
    const name = args.name.trim();
    if (!name || name.length > INGEST_LIMITS.name_chars) invalidScope("A watch needs a name");
    const problem = watchProblem(source.provider, args.query_kind, args.query, args.threshold)
      ?? monitorProblem({ threshold: args.threshold, direction: args.direction ?? "below", eval_reads: args.eval_reads, warn: args.warn, no_data_after: args.no_data_after });
    if (problem) invalidScope(problem);
    const now = Date.now();
    const id = await ctx.db.insert("metric_watches", {
      ...(args.eval_reads !== undefined && args.eval_reads > 1 ? { eval_reads: args.eval_reads } : {}),
      ...(args.warn !== undefined ? { warn: args.warn } : {}),
      ...(args.no_data_after !== undefined ? { no_data_after: args.no_data_after } : {}),
      workspace: source.workspace,
      team_id: source.team_id,
      source_id: source._id,
      short_id: await nextShortId(ctx.db, INGEST_SHORT_ID_PREFIX.metric_watch),
      created_by: userId,
      name,
      query_kind: args.query_kind,
      query: args.query.trim(),
      ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
      direction: args.direction ?? "below",
      ...(cleanUnit(args.unit) ? { unit: cleanUnit(args.unit) } : {}),
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
    /** null takes the alert line off: the watch becomes a plain series. */
    threshold: v.optional(v.union(v.number(), v.null())),
    direction: v.optional(directionValidator),
    unit: v.optional(v.union(v.string(), v.null())),
    interval_ms: v.optional(v.number()),
    status: v.optional(v.union(v.literal("active"), v.literal("paused"))),
    /** The monitor (contracts/metricMonitor.ts); null takes a setting off. */
    eval_reads: v.optional(v.union(v.number(), v.null())),
    warn: v.optional(v.union(v.number(), v.null())),
    no_data_after: v.optional(v.union(v.number(), v.null())),
    /** Until when transitions are held back; null unmutes. */
    muted_until: v.optional(v.union(v.number(), v.null())),
    /** What its alert does: a problem task, or the timeline only; null goes back to the source's rule. */
    on_alert: v.optional(v.union(v.literal("task"), v.literal("timeline"), v.null())),
    /** Who else the alert reaches and what more it does (contracts/metricMonitor AlertNotify); null clears it. The caller becomes its `by`. */
    notify: v.optional(v.union(v.null(), v.object({
      users: v.optional(v.array(v.id("users"))),
      roles: v.optional(v.array(v.id("org_roles"))),
      channel: v.optional(v.id("chat_channels")),
      fix: v.optional(v.boolean()),
      renotify_ms: v.optional(v.number()),
      recovery: v.optional(v.boolean()),
    }))),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await watchByRef(ctx, userId, args.watch);
    if (args.notify !== undefined) {
      const problem = notifyProblem(args.notify);
      if (problem) invalidScope(problem);
      for (const uid of args.notify?.users ?? []) {
        if (!(await workspaceGrantsAccess(ctx, uid, row.workspace))) invalidScope("Someone named is not in this workspace");
      }
      for (const rid of args.notify?.roles ?? []) {
        const role = await ctx.db.get(rid);
        if (!role || (role.team_id ? `team:${role.team_id}` : `user:${role.scope_user_id}`) !== row.workspace) invalidScope("A role named is not in this workspace");
      }
      if (args.notify?.channel) {
        const channel = await ctx.db.get(args.notify.channel);
        if (!channel || `team:${channel.team_id}` !== row.workspace) invalidScope("The channel is not in this workspace");
      }
    }
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
    if (args.threshold !== undefined) patch.threshold = args.threshold ?? undefined;
    if (args.direction) patch.direction = args.direction;
    if (args.unit !== undefined) patch.unit = cleanUnit(args.unit);
    if (args.interval_ms !== undefined) patch.interval_ms = clampInterval(args.interval_ms);
    if (args.eval_reads !== undefined) patch.eval_reads = args.eval_reads === null || args.eval_reads <= 1 ? undefined : args.eval_reads;
    if (args.warn !== undefined) patch.warn = args.warn ?? undefined;
    if (args.no_data_after !== undefined) patch.no_data_after = args.no_data_after ?? undefined;
    if (args.on_alert !== undefined) patch.on_alert = args.on_alert ?? undefined;
    if (args.notify !== undefined) patch.notify = normalizeNotify(args.notify as any, String(userId)) as Doc<"metric_watches">["notify"];
    if (args.muted_until !== undefined) patch.muted_until = args.muted_until === null || args.muted_until <= now ? undefined : Math.min(args.muted_until, now + MONITOR_LIMITS.mute_max_ms);
    // A warning level needs a line: taking the line off takes it too.
    if ("threshold" in patch && patch.threshold === undefined) patch.warn = undefined;
    const threshold = "threshold" in patch ? patch.threshold : row.threshold;
    const problem = watchProblem(source!.provider, row.query_kind, patch.query ?? row.query, threshold)
      ?? monitorProblem({
        threshold,
        direction: patch.direction ?? row.direction,
        eval_reads: "eval_reads" in patch ? patch.eval_reads : row.eval_reads,
        warn: "warn" in patch ? patch.warn : row.warn,
        no_data_after: "no_data_after" in patch ? patch.no_data_after : row.no_data_after,
      });
    if (problem) invalidScope(problem);
    if (args.status) {
      patch.status = args.status;
      // A paused watch leaves the poll index; resuming makes it due at once.
      patch.next_check_at = args.status === "active" ? now : undefined;
      if (args.status === "active") patch.last_error = undefined;
    } else if (row.status === "active" && (patch.query !== undefined || patch.interval_ms !== undefined || "threshold" in patch || patch.direction !== undefined)) {
      // A moved line or side is judged on a fresh read within the minute, not a full interval later.
      patch.next_check_at = now;
    }
    // A watch with no line is a plain series, which never alerts.
    if ("threshold" in patch && patch.threshold === undefined) patch.state = "ok";
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
    await ctx.scheduler.runAfter(0, internal.metrics.purgeWatchPoints, { watch_id: row._id });
    return { removed: row.short_id };
  },
});

/** A removed watch's history (metric_points, metric_rollups), a batch at a time. */
export const purgeWatchPoints = internalMutation({
  args: { watch_id: v.id("metric_watches") },
  handler: async (ctx, args) => {
    if (await purgePoints(ctx, args.watch_id)) await ctx.scheduler.runAfter(0, internal.metrics.purgeWatchPoints, args);
  },
});

/**
 * One watch's values over a window, folded to at most `buckets` points
 * (lib/metricPoints readSeries): the watch page's chart. `span_ms` ends the
 * window now; `from` and `to` name one exactly (a zoom); neither reads all it
 * holds. Reruns whenever a value lands.
 */
export const series = query({
  args: {
    ...scopeArgs, watch: v.string(), from: v.optional(v.number()), to: v.optional(v.number()), span_ms: v.optional(v.number()), buckets: v.optional(v.number()),
    /** With span_ms: the window ends this long before now (the previous period beside a "last 7d" view). */
    offset_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await watchByRef(ctx, userId, args.watch);
    const to = args.to ?? Date.now() - Math.max(0, args.offset_ms ?? 0);
    const from = args.from ?? (args.span_ms ? to - args.span_ms : null);
    return { watch_id: row._id, ...(await readSeries(ctx, row, from, to, args.buckets ?? METRIC_SERIES.buckets_default)) };
  },
});

/** Several watches' values over the same window ending now, for the overview's cards; a ref the caller cannot read is left out. */
export const seriesMany = query({
  args: {
    ...scopeArgs, watches: v.array(v.string()), span_ms: v.optional(v.number()), buckets: v.optional(v.number()),
    /** The window ends this long before now: the period before a range (the overview's change against it). */
    offset_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const to = Date.now() - Math.max(0, args.offset_ms ?? 0);
    const out = [];
    for (const ref of args.watches.slice(0, METRIC_SERIES.many_max)) {
      let row: Doc<"metric_watches">;
      try {
        row = await watchByRef(ctx, userId, ref);
      } catch {
        continue;
      }
      out.push({ watch_id: row._id, ...(await readSeries(ctx, row, args.span_ms ? to - args.span_ms : null, to, args.buckets ?? 80, METRIC_SERIES.many_rollup_max)) });
    }
    return out;
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
    const source = watch ? await ctx.db.get(watch.source_id) : null;
    return watch && watch.status === "active" && source ? { query_kind: watch.query_kind, query: watch.query, source_id: watch.source_id, provider: source.provider } : null;
  },
});

/** Groups a volume read takes at most: a source's issues seen in the last 30 days. */
const VOLUME_GROUPS_MAX = 2000;
const VOLUME_DAYS = 30;

/**
 * What a volume watch reads (contracts/volumeWatch): its source's hour
 * counters and the groups it saw in the last 30 days, from codecast's own
 * tables. `history` adds the past those reach.
 */
export const volumeRead = internalQuery({
  args: { watch_id: v.id("metric_watches"), history: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ value?: number; points?: Array<{ at: number; value: number }>; error?: string } | null> => {
    const watch = await ctx.db.get(args.watch_id);
    if (!watch || watch.query_kind !== "volume") return null;
    const q = parseVolumeQuery(watch.query);
    if ("error" in q) return { error: q.error };
    const now = Date.now();
    const stats = await ctx.db.query("event_source_stats").withIndex("by_source", (x) => x.eq("source_id", watch.source_id)).first();
    const input: VolumeInput = { now, hours: stats?.hours, event_names: stats?.event_names, groups_open: stats?.groups_open, ci_runs: stats?.ci_runs };
    if (q.series === "new_issues" || q.series === "open_issues") {
      // first_seen inside the window means last_seen is too, so the last_seen index reads a superset.
      const groups = await ctx.db.query("event_groups").withIndex("by_source_last_seen", (x) => x.eq("source_id", watch.source_id).gte("last_seen", now - VOLUME_DAYS * 86_400_000)).take(VOLUME_GROUPS_MAX);
      // A watch's own alerts are not the source's issues.
      input.groups = groups.filter((g) => g.kind !== "metric").map((g) => ({ first_seen: g.first_seen, status: g.status }));
    }
    return { value: volumeValue(q, input), ...(args.history ? { points: volumeHistory(q, input, VOLUME_DAYS) } : {}) };
  },
});

/** Read one watch's value from its source and record it. */
export const pollWatch = internalAction({
  args: { watch_id: v.id("metric_watches") },
  handler: async (ctx, args): Promise<{ value?: number; error?: string } | null> => {
    const watch = await ctx.runQuery(internal.metrics.pollInputs, args);
    if (!watch) return null;
    if (watch.query_kind === "volume") {
      const at = Date.now();
      const read = await ctx.runQuery(internal.metrics.volumeRead, { watch_id: args.watch_id });
      if (!read) return null;
      const result = read.value === undefined ? { error: read.error ?? "No value" } : { value: read.value };
      await ctx.runMutation(internal.metrics.recordPoint, { watch_id: args.watch_id, at, ...result });
      return result;
    }
    if (watch.query_kind === "reader") {
      const at = Date.now();
      const read = await readAppMetric(ctx, watch.source_id, watch.query, fetch);
      const result = read.ok
        ? read.value === null ? { error: "The reader has no value yet" } : { value: read.value, ...(read.unit ? { unit: read.unit } : {}), ...(read.points.length ? { series: read.points } : {}) }
        : { error: read.error };
      await ctx.runMutation(internal.metrics.recordPoint, { watch_id: args.watch_id, at, ...result });
      if (!read.ok && read.lost) await ctx.runMutation(internal.ingest.sourceConnectionLost, { source_id: watch.source_id, error: read.error });
      return result;
    }
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
  args: {
    watch_id: v.id("metric_watches"), at: v.number(), value: v.optional(v.number()), error: v.optional(v.string()), unit: v.optional(v.string()),
    /** A metric reader's own dated series (mergeReaderSeries): kept as it answers it, in place of one point for this read. */
    series: v.optional(v.array(v.object({ at: v.number(), value: v.number() }))),
  },
  handler: async (ctx, args) => {
    const watch = await ctx.db.get(args.watch_id);
    if (!watch || watch.status !== "active") return null;
    const source = await ctx.db.get(watch.source_id);
    if (!source || source.status !== "active") return null;
    const now = Date.now();
    const muted = isMuted(watch, now);
    // The group upsert files a problem task by the source's promote rule; a watch that chose its own route reads it here.
    const routed = watch.on_alert ? { ...source, promote: promoteFor(watch.on_alert, source.promote) } : source;
    const planFor = (threshold: number, value: number, opts: { ok?: boolean; message?: string }) =>
      planMetric({ short_id: watch.short_id, name: watch.name, threshold, direction: watch.direction, id: String(watch._id) }, value, args.at, opts);
    if (args.value === undefined || !Number.isFinite(args.value)) {
      const error = (args.error ?? "No value").slice(0, INGEST_LIMITS.message_chars);
      const missed = (watch.missed ?? 0) + 1;
      // Missing data alerts once it has run no_data_after reads, through the
      // same group a crossing opens. Short of that, a failed read is not a
      // value: the state and the group stay where they were.
      if (watch.threshold === undefined || watch.no_data_after === undefined || missed < watch.no_data_after || muted) {
        await ctx.db.patch(watch._id, { last_error: error, missed, updated_at: now });
        await patchSourceStats(ctx, source, () => ({ last_poll_at: now }), now);
        return null;
      }
      const last = watch.points[watch.points.length - 1]?.value ?? watch.threshold;
      const plan = planFor(watch.threshold, last, { ok: false, message: `${watch.name}: no value for ${missed} reads (${error})` });
      const upserted = await upsertGroup(ctx, routed, [plan], {}, now);
      await ctx.db.patch(watch._id, { last_error: error, missed, state: "alert", group_id: upserted.group_id, updated_at: now });
      await patchSourceStats(ctx, source, (st) => ({ groups_open: Math.max(0, (st.groups_open ?? 0) + upserted.open_delta), last_poll_at: now }), now);
      await tellAlert(ctx, watch, source, watch.state, "alert", null, args.at, upserted.group_id, now, true);
      return { group_id: upserted.group_id, transitions: upserted.transitions };
    }
    const value = args.value;
    // The unit the source names, until a person sets one.
    const unit = watch.unit ?? cleanUnit(args.unit);
    // Every value goes into the watch's history; a watch made before the
    // table carries its row's values over with its first write.
    if (!(await holdsPoints(ctx, watch._id))) await writePoints(ctx, watch._id, watch.points);
    await writePoints(ctx, watch._id, args.series?.length ? args.series : [{ at: args.at, value }]);
    const points = args.series?.length ? mergeReaderSeries(watch.points, args.series) : appendMetricPoint(watch.points, { at: args.at, value });
    const read = { points, last_error: undefined, missed: undefined, ...(unit ? { unit } : {}), updated_at: now };
    if (watch.threshold === undefined) {
      // A plain series: the point is kept, and nothing is announced.
      await ctx.db.patch(watch._id, { ...read, state: "ok" });
      await patchSourceStats(ctx, source, () => ({ last_poll_at: now }), now);
      return { group_id: null, transitions: [] };
    }
    const state = nextMonitorState(watch.state, points.map((p) => p.value), { threshold: watch.threshold, direction: watch.direction, eval_reads: watch.eval_reads });
    if (muted) {
      // Muted: the state follows the values, and nothing is announced until the mute ends.
      await ctx.db.patch(watch._id, { ...read, state });
      await patchSourceStats(ctx, source, () => ({ last_poll_at: now }), now);
      return { group_id: watch.group_id ?? null, transitions: [] };
    }
    const plan = planFor(watch.threshold, value, { ok: state === "ok" });
    const upserted = await upsertGroup(ctx, routed, [plan], {}, now);
    await ctx.db.patch(watch._id, {
      ...read,
      state,
      group_id: upserted.group_id,
    });
    // A poll is not an ingested event, so the *_today counters stay the door's.
    await patchSourceStats(ctx, source, (st) => ({ groups_open: Math.max(0, (st.groups_open ?? 0) + upserted.open_delta), last_poll_at: now }), now);
    await tellAlert(ctx, watch, source, watch.state, state, value, args.at, upserted.group_id, now);
    return { group_id: upserted.group_id, transitions: upserted.transitions };
  },
});

/**
 * The people, roles, channel and fix a watch names (metricAlerts.ts), told
 * what this read did: it crossed, it recovered, or it is still past the line
 * and its renotify interval has passed. Muted reads never reach here.
 */
async function tellAlert(ctx: any, watch: Doc<"metric_watches">, source: Doc<"event_sources">, prev: "ok" | "alert", next: "ok" | "alert", value: number | null, at: number, groupId: Id<"event_groups"> | null, now: number, noData = false) {
  if (!watch.notify && !watch.alert_episode) return;
  const kind = prev !== "alert" && next === "alert" ? "crossed" : prev === "alert" && next === "ok" ? "recovered" : next === "alert" && renotifyDue(watch.notify, watch.alert_episode?.notified_at, now) ? "still" : null;
  if (kind) await deliverWatchAlert(ctx, watch, source, { kind, value, at, group_id: groupId, noData });
}

// ── Read now (the Metrics views' Read now on a failing watch) ──

/** How many watches one Read now press takes. */
const READ_NOW_MAX = 30;

/**
 * Poll watches now instead of at their next check: each active one on an
 * active source has its next check moved a full interval out (so the cron
 * does not read it again at once) and its poll scheduled. Refs the caller
 * cannot read are skipped.
 */
export const readNow = mutation({
  args: { ...scopeArgs, watches: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const now = Date.now();
    const scheduled: string[] = [];
    for (const ref of args.watches.slice(0, READ_NOW_MAX)) {
      let row: Doc<"metric_watches">;
      try {
        row = await watchByRef(ctx, userId, ref);
      } catch {
        continue;
      }
      if (row.status !== "active") continue;
      const source = await ctx.db.get(row.source_id);
      if (source?.status !== "active") continue;
      await ctx.db.patch(row._id, { next_check_at: now + row.interval_ms });
      await ctx.scheduler.runAfter(0, internal.metrics.pollWatch, { watch_id: row._id });
      scheduled.push(row.short_id);
    }
    return { scheduled };
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
    return watch ? { query_kind: watch.query_kind, query: watch.query, source_id: watch.source_id, interval_ms: watch.interval_ms, oldest: await oldestHeld(ctx, watch) } : null;
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
  if (watch.query_kind === "volume") {
    // The counters reach back as far as they keep (48 hours of events, 30 days of issues); open issues has no past.
    const read = await ctx.runQuery(internal.metrics.volumeRead, { watch_id: args.watch_id, history: true });
    if (!read?.points?.length) {
      const note = read?.error ?? "Its source keeps no past for this series; the history is its polls";
      await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, note });
      return { note };
    }
    return await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, points: read.points });
  }
  if (watch.query_kind === "reader") {
    // The reader answers its own series with every read; `days` asks for more when it takes one.
    const read = await readAppMetric(ctx, watch.source_id, watch.query, fetch, { days: args.days ?? METRIC_WATCH_LIMITS.backfill_days_default });
    if (!read.ok) {
      await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, note: read.error });
      return { note: read.error };
    }
    if (!read.points.length) {
      const note = "The reader answers no dated points; the history is its polls";
      await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, note });
      return { note };
    }
    return await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, points: read.points });
  }
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
    // History goes under what the watch holds, never over a value it read itself.
    if (!(await holdsPoints(ctx, watch._id))) await writePoints(ctx, watch._id, watch.points);
    const oldest = await oldestHeld(ctx, watch);
    const added = await writePoints(ctx, watch._id, args.points.filter((p) => oldest === null || p.at < oldest));
    const merged = mergeMetricHistory(watch.points, args.points);
    const note = args.note?.slice(0, INGEST_LIMITS.message_chars);
    await ctx.db.patch(watch._id, { points: merged.points, history: { at: now, added, ...(note ? { note } : {}) }, updated_at: now });
    return { added };
  },
});
