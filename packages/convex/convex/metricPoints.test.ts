// A watch's full history (lib/metricPoints.ts) and its monitor
// (contracts/metricMonitor.ts) through the real mutations and queries on the
// fake db: every value lands in metric_points with an hourly rollup, a window
// reads raw or hourly and folds to the buckets asked, and the monitor's reads
// in a row, mute and missing data decide what the group hears.
import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { GROUP_RULES } from "@codecast/shared/contracts/ingest";
import { monitorProblem, nextMonitorState } from "@codecast/shared/contracts/metricMonitor";
import { createSource } from "./ingest";
import { createWatch, purgeWatchPoints, recordHistory, recordPoint, removeWatch, series, seriesMany, updateWatch } from "./metrics";
import { bucketize } from "./lib/metricPoints";

const h = (fn: any) => fn._handler;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function world() {
  const scheduled: Array<{ name: string; args: any }> = [];
  const db = makeFakeDb(
    {
      users: [{ _id: "u1", active_team_id: "team_1" }, { _id: "u2" }],
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      counters: [],
      projects: [],
      event_sources: [],
      event_groups: [],
      event_samples: [],
      external_events: [],
      agent_tasks: [],
      conversations: [],
      metric_watches: [],
      metric_points: [],
      metric_rollups: [],
      app_installations: [],
      replays: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  const as = (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db, scheduler }) as any;
  return { db: db as any, scheduled, as, internalCtx: { db, scheduler } as any };
}

const TEAM = { workspace: "team" as const, team_id: "team_1" as any };

async function watch(w: ReturnType<typeof world>, over: Record<string, unknown> = {}) {
  await h(createSource)(w.as("u1"), { ...TEAM, name: "product", provider: "posthog" });
  return (await h(createWatch)(w.as("u1"), { ...TEAM, source: "product", name: "Errors", query_kind: "hogql", query: "select 1", threshold: 10, direction: "above", ...over })).watch;
}

const point = (w: ReturnType<typeof world>, id: string, value: number, at = Date.now()) => h(recordPoint)(w.internalCtx, { watch_id: id, at, value });
const fail = (w: ReturnType<typeof world>, id: string) => h(recordPoint)(w.internalCtx, { watch_id: id, at: Date.now(), error: "PostHog answered 500" });
const alerts = (w: ReturnType<typeof world>) => w.db._tables.external_events.map((e: any) => e.kind);

describe("bucketize", () => {
  const e = (at: number, v: number) => ({ at, n: 1, sum: v, min: v, max: v });

  test("fewer values than buckets come back as read", () => {
    const out = bucketize([e(10, 1), e(20, 3)], 0, 100, 10);
    expect(out).toEqual({ points: [{ at: 10, value: 1, min: 1, max: 1 }, { at: 20, value: 3, min: 3, max: 3 }], step_ms: 0 });
  });

  test("more fold into equal buckets: weighted average, min and max, at the mean time", () => {
    const entries = Array.from({ length: 100 }, (_, i) => e(i, i));
    const out = bucketize(entries, 0, 100, 10);
    expect(out.step_ms).toBe(10);
    expect(out.points).toHaveLength(10);
    expect(out.points[0]).toEqual({ at: 5, value: 4.5, min: 0, max: 9 });
    // An hourly rollup weighs by its count.
    expect(bucketize([{ at: 0, n: 3, sum: 30, min: 5, max: 15 }, { at: 1, n: 1, sum: 2, min: 2, max: 2 }, e(50, 0), e(60, 0)], 0, 100, 2).points[0]).toMatchObject({ value: 8, min: 2, max: 15 });
  });

  test("values outside the window are left out", () => {
    expect(bucketize([e(-1, 1), e(5, 2), e(101, 3)], 0, 100, 10).points.map((p) => p.value)).toEqual([2]);
  });
});

describe("history in metric_points", () => {
  test("every poll lands in the table and its hour's rollup, past the row's cap", async () => {
    const w = world();
    const row = await watch(w, { threshold: undefined });
    const t0 = Date.now() - 5 * HOUR;
    const n = GROUP_RULES.metric_points + 20;
    for (let i = 0; i < n; i++) await point(w, row._id, i, t0 + i * 60_000);
    expect(w.db._tables.metric_watches[0].points).toHaveLength(GROUP_RULES.metric_points);
    expect(w.db._tables.metric_points).toHaveLength(n);
    const rollups = w.db._tables.metric_rollups;
    expect(rollups.reduce((s: number, r: any) => s + r.n, 0)).toBe(n);
    expect(rollups.reduce((s: number, r: any) => s + r.sum, 0)).toBe((n * (n - 1)) / 2);
  });

  test("a watch made before the table carries its row's values over on its first write", async () => {
    const w = world();
    const row = await watch(w);
    const old = [{ at: Date.now() - 3 * HOUR, value: 1 }, { at: Date.now() - 2 * HOUR, value: 2 }];
    await w.db.patch(row._id, { points: old });
    await point(w, row._id, 3);
    expect(w.db._tables.metric_points.map((p: any) => p.value).sort()).toEqual([1, 2, 3]);
  });

  test("a value read again at the same time replaces it and recounts the hour", async () => {
    const w = world();
    const row = await watch(w, { query_kind: "hogql" });
    const at = Date.now() - HOUR;
    await h(recordPoint)(w.internalCtx, { watch_id: row._id, at, value: 1, series: [{ at: at - 1000, value: 4 }, { at, value: 1 }] });
    await h(recordPoint)(w.internalCtx, { watch_id: row._id, at, value: 1, series: [{ at: at - 1000, value: 6 }, { at, value: 1 }] });
    expect(w.db._tables.metric_points).toHaveLength(2);
    expect(w.db._tables.metric_rollups.reduce((s: number, r: any) => s + r.sum, 0)).toBe(7);
  });

  test("history goes under what the watch holds and counts only what it added", async () => {
    const w = world();
    const row = await watch(w);
    const now = Date.now();
    await point(w, row._id, 5, now);
    const past = Array.from({ length: 200 }, (_, i) => ({ at: now - (i + 1) * HOUR, value: i }));
    const out = await h(recordHistory)(w.internalCtx, { watch_id: row._id, points: [...past, { at: now, value: 99 }] });
    expect(out.added).toBe(200);
    expect(w.db._tables.metric_points).toHaveLength(201);
    // The live read at `now` is not overwritten by the history's value there.
    expect(w.db._tables.metric_points.find((p: any) => p.at === now).value).toBe(5);
    expect(w.db._tables.metric_watches[0].history.added).toBe(200);
  });

  test("a short window reads raw values; a wide one reads hours, folded to the buckets", async () => {
    const w = world();
    const row = await watch(w);
    const now = Date.now();
    await point(w, row._id, 1, now);
    await h(recordHistory)(w.internalCtx, { watch_id: row._id, points: Array.from({ length: 24 * 20 }, (_, i) => ({ at: now - (i + 1) * HOUR, value: i % 7 })) });

    const day = await h(series)(w.as("u1"), { watch: row.short_id, span_ms: DAY });
    expect(day.resolution).toBe("raw");
    expect(day.points.length).toBeGreaterThanOrEqual(24);
    expect(day.held_from).toBe(now - 24 * 20 * HOUR);

    const month = await h(series)(w.as("u1"), { watch: row.short_id, span_ms: 30 * DAY, buckets: 50 });
    expect(month.resolution).toBe("hour");
    expect(month.points.length).toBeLessThanOrEqual(50);
    expect(month.step_ms).toBeGreaterThan(0);
    expect(month.points[0].at).toBeLessThan(now - 19 * DAY);
    expect(month.points.every((p: any) => p.min <= p.value && p.value <= p.max)).toBe(true);

    const all = await h(series)(w.as("u1"), { watch: row.short_id });
    expect(all.from).toBe(all.held_from);
  });

  test("another workspace's watch is not read, and the overview read leaves it out", async () => {
    const w = world();
    const row = await watch(w);
    await point(w, row._id, 1);
    await expect(h(series)(w.as("u2"), { watch: row.short_id, span_ms: DAY })).rejects.toThrow();
    expect(await h(seriesMany)(w.as("u2"), { watches: [row.short_id], span_ms: DAY })).toEqual([]);
    const mine = await h(seriesMany)(w.as("u1"), { watches: [row.short_id, "mw-999"], span_ms: DAY });
    expect(mine.map((s: any) => s.watch_id)).toEqual([row._id]);
  });

  test("removing a watch deletes its history in batches", async () => {
    const w = world();
    const row = await watch(w);
    await point(w, row._id, 1);
    await h(removeWatch)(w.as("u1"), { watch: row.short_id });
    expect(w.scheduled.map((s) => s.name)).toContain("metrics:purgeWatchPoints");
    await h(purgeWatchPoints)(w.internalCtx, { watch_id: row._id });
    expect(w.db._tables.metric_points).toHaveLength(0);
    expect(w.db._tables.metric_rollups).toHaveLength(0);
  });
});

describe("the monitor", () => {
  test("nextMonitorState flips only on k reads in a row", () => {
    const m = { threshold: 10, direction: "above" as const, eval_reads: 3 };
    expect(nextMonitorState("ok", [11, 12], m)).toBe("ok");
    expect(nextMonitorState("ok", [5, 11, 12], m)).toBe("ok");
    expect(nextMonitorState("ok", [11, 12, 13], m)).toBe("alert");
    expect(nextMonitorState("alert", [11, 2, 3], m)).toBe("alert");
    expect(nextMonitorState("alert", [1, 2, 3], m)).toBe("ok");
  });

  test("monitorProblem refuses a warning past the line, a warning with no line, and counts out of range", () => {
    expect(monitorProblem({ threshold: 10, direction: "above", warn: 12 })).toMatch(/under the alert line/);
    expect(monitorProblem({ threshold: 10, direction: "below", warn: 8 })).toMatch(/over the alert line/);
    expect(monitorProblem({ direction: "above", warn: 8 })).toMatch(/needs an alert line/);
    expect(monitorProblem({ threshold: 10, direction: "above", eval_reads: 0 })).toMatch(/Reads in a row/);
    expect(monitorProblem({ threshold: 10, direction: "above", no_data_after: 1.5 })).toMatch(/Missed reads/);
    expect(monitorProblem({ threshold: 10, direction: "above", warn: 8, eval_reads: 3, no_data_after: 4 })).toBeNull();
  });

  test("three reads in a row file the alert; one stray read does not", async () => {
    const w = world();
    const row = await watch(w, { eval_reads: 3 });
    await point(w, row._id, 20);
    await point(w, row._id, 5);
    await point(w, row._id, 20);
    await point(w, row._id, 20);
    expect(alerts(w)).toEqual([]);
    expect(w.db._tables.metric_watches[0].state).toBe("ok");
    await point(w, row._id, 20);
    expect(alerts(w)).toEqual(["metric_alert"]);
    expect(w.db._tables.metric_watches[0].state).toBe("alert");
  });

  test("a muted watch follows its values and announces nothing; unmuted, the next read does", async () => {
    const w = world();
    const row = await watch(w);
    await h(updateWatch)(w.as("u1"), { watch: row.short_id, muted_until: Date.now() + HOUR });
    await point(w, row._id, 50);
    expect(w.db._tables.metric_watches[0].state).toBe("alert");
    expect(alerts(w)).toEqual([]);
    await h(updateWatch)(w.as("u1"), { watch: row.short_id, muted_until: null });
    expect(w.db._tables.metric_watches[0].muted_until).toBeUndefined();
    await point(w, row._id, 50);
    expect(alerts(w)).toEqual(["metric_alert"]);
  });

  test("missing data alerts after no_data_after failed reads, and a value clears the count", async () => {
    const w = world();
    const row = await watch(w, { no_data_after: 2 });
    await point(w, row._id, 1);
    await fail(w, row._id);
    expect(alerts(w)).toEqual([]);
    await fail(w, row._id);
    expect(alerts(w)).toEqual(["metric_alert"]);
    expect(w.db._tables.metric_watches[0]).toMatchObject({ state: "alert", missed: 2 });
    await point(w, row._id, 1);
    expect(alerts(w)).toEqual(["metric_alert", "metric_recovered"]);
    expect(w.db._tables.metric_watches[0].missed).toBeUndefined();
  });

  test("taking the line off takes the warning level with it", async () => {
    const w = world();
    const row = await watch(w, { warn: 8 });
    expect(w.db._tables.metric_watches[0].warn).toBe(8);
    await h(updateWatch)(w.as("u1"), { watch: row.short_id, threshold: null });
    expect(w.db._tables.metric_watches[0].warn).toBeUndefined();
    await expect(h(updateWatch)(w.as("u1"), { watch: row.short_id, warn: 3 })).rejects.toThrow(/needs an alert line/);
  });
});

describe("the insight picker's rows", () => {
  test("a saved insight reads as id, short id, name and kind; anything else is dropped", async () => {
    const { insightRow } = await import("./sources/posthog");
    expect(insightRow({ id: 7, short_id: "abc", name: "", derived_name: "Pageviews", query: { source: { kind: "TrendsQuery" } } })).toEqual({ id: 7, short_id: "abc", name: "Pageviews", kind: "Trends" });
    expect(insightRow({ id: 8, short_id: "def", name: null, filters: { insight: "FUNNELS" } })).toEqual({ id: 8, short_id: "def", name: "Insight def", kind: "funnels" });
    expect(insightRow({ short_id: "x" })).toBeNull();
  });
});
