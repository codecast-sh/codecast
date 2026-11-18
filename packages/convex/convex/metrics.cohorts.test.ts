// A reader that dates its own periods (Union's replied-to-need, by week of
// first reply) is read by those periods, never by poll samples; a definition
// change drops the older points; a person can remove a stale one. The numbers
// are the false pass that real use found on a goal's done-when (in-8, mw-16).
import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { createSource } from "./ingest";
import { createWatch, recordHistory, recordPoint, recountRollups, redefine, removePoints } from "./metrics";
import { seriesLookup } from "./lib/metricSeries";
import { metricLine, metricReadings } from "@codecast/shared/contracts/initiative";

const h = (fn: any) => fn._handler;
const D = (s: string) => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : `${s}Z`);
const NOW = D("2026-11-18T12:00:00");
const WS = "team:team_1";

/** mw-16's mature weeks as the reader sends them (week of first reply), and its value now (295 of 596). */
const MATURE = [
  { at: D("2026-10-05"), value: 53.3 },
  { at: D("2026-10-12"), value: 50.8 },
  { at: D("2026-10-19"), value: 49.3 },
  { at: D("2026-10-26"), value: 49.7 },
];
/** Replies a week in each of those weeks: the denominators the rate is pooled over. */
const REPLIES = [
  { at: D("2026-10-05"), value: 45 },
  { at: D("2026-10-12"), value: 130 },
  { at: D("2026-10-19"), value: 304 },
  { at: D("2026-10-26"), value: 292 },
];
const NEED = "Replied to explicit need";
const TRAJECTORY = "at least 51.2%@2026-11-16 53.1%@2026-11-30 56.6%@2026-12-14 59.1%@2026-12-28";

function world() {
  const scheduled: Array<{ name: string; args: any }> = [];
  const db = makeFakeDb(
    {
      users: [{ _id: "u1", active_team_id: "team_1" }, { _id: "u2", active_team_id: "team_1" }],
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }, { _id: "m2", user_id: "u2", team_id: "team_1", role: "member" }],
      counters: [], projects: [], event_sources: [], event_groups: [], event_samples: [], external_events: [], agent_tasks: [], conversations: [], metric_watches: [], app_installations: [], replays: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  const as = (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db, scheduler }) as any;
  return { db: db as any, scheduled, as, internal: { db, scheduler } as any };
}

async function watches(w: ReturnType<typeof world>) {
  await h(createSource)(w.as("u1"), { workspace: "team", team_id: "team_1", name: "union", provider: "posthog" });
  const mk = async (name: string, unit?: string) => (await h(createWatch)(w.as("u1"), { workspace: "team", team_id: "team_1", source: "union", name, query_kind: "hogql", query: "select 1", ...(unit ? { unit } : {}) })).watch;
  return { need: await mk(NEED, "%"), replies: await mk("Replies a week") };
}

const read = (w: ReturnType<typeof world>, id: string, at: number, value: number, series?: Array<{ at: number; value: number }>, version?: string) =>
  h(recordPoint)(w.internal, { watch_id: id, at, value, ...(series ? { series } : {}), ...(version ? { version } : {}) });

describe("a reader's cohort weeks", () => {
  test("a window reads the source's last cohort weeks, never a stale poll: not met, as the weeks say", async () => {
    const w = world();
    const { need } = await watches(w);
    // A poll under the metric's old definition, then today's reads with the reader's own series.
    await read(w, need._id, D("2026-11-11T12:31:00"), 62.87);
    for (let t = NOW - 6 * 3_600_000; t <= NOW; t += 1_200_000) await read(w, need._id, t, 49.5, [...MATURE, { at: t, value: 49.5 }]);
    const row = await w.db.get(need._id);
    expect(row.source_points).toEqual(MATURE);
    const metric = { key: "n", name: NEED, target: TRAJECTORY, series: need.short_id, window: "2w", noise: "binomial:300" };
    const [r] = metricReadings({ metrics: [metric] }, await seriesLookup(w.internal, WS, [{ metrics: [metric] }]));
    expect(r!.value).toBe("49.5%");
    expect(r!.band!.cohort).toBe(true);
    expect(r!.band!.read.map((p) => [new Date(p.from).toISOString().slice(0, 10), p.value])).toEqual([["2026-10-26", 49.7], ["2026-10-19", 49.3]]);
    expect(r!.band!.mean).toBeCloseTo(49.5, 10);
    // Judged against the target in force at the cohorts' end (51.2% before 11-16), the weeks hold it inside their band: within noise, never met.
    expect(r!.band!.against).toBe(51.2);
    expect(r!.standing).toBe("within_noise");
    expect(r!.trajectory!.final_standing).toBe("behind");
    expect(metricLine(r!, NOW)).toContain("over 2 cohort weeks (pooled total over total 49.5%");
    expect(metricLine(r!, NOW)).toContain("judged against 51.2% in force at the window's end");
  });

  test("pooled by the replies each week holds: 49.5% (295 of 596)", async () => {
    const w = world();
    const { need, replies } = await watches(w);
    await read(w, need._id, NOW, 49.5, [...MATURE, { at: NOW, value: 49.5 }]);
    await read(w, replies._id, NOW, 596, [...REPLIES, { at: NOW, value: 596 }]);
    const metric = { key: "n", name: NEED, target: "at least 51.2%", series: need.short_id, window: "2w", noise: `binomial:${replies.short_id}` };
    const [r] = metricReadings({ metrics: [metric] }, await seriesLookup(w.internal, WS, [{ metrics: [metric] }]));
    expect(r!.band!.read.map((p) => p.weight)).toEqual([292, 304]);
    expect(r!.band!.mean).toBeCloseTo((49.7 * 292 + 49.3 * 304) / 596, 10);
    expect(r!.standing).toBe("within_noise");
    // Four weeks pool all four mature weeks.
    const [four] = metricReadings({ metrics: [{ ...metric, window: "4w" }] }, await seriesLookup(w.internal, WS, [{ metrics: [{ ...metric, window: "4w" }] }]));
    expect(four!.band!.periods).toBe(4);
    expect(four!.band!.mean).toBeCloseTo((53.3 * 45 + 50.8 * 130 + 49.3 * 304 + 49.7 * 292) / 771, 10);
  });
});

describe("a definition change", () => {
  test("a new version starts the row and the reader series over and recounts every rollup under it", async () => {
    const w = world();
    const { need } = await watches(w);
    await read(w, need._id, D("2026-11-11T12:31:00"), 62.87);
    await read(w, need._id, NOW, 49.5, [...MATURE, { at: NOW, value: 49.5 }], "need-v2");
    const row = await w.db.get(need._id);
    expect(row.version).toBe("need-v2");
    expect(row.points.map((p: any) => p.value)).toEqual([53.3, 50.8, 49.3, 49.7, 49.5]);
    expect(w.scheduled.map((s) => s.name)).toContain("metrics:recountRollups");
    const stale = w.db._tables.metric_points.find((p: any) => p.at === D("2026-11-11T12:31:00"));
    expect(stale.version).toBeUndefined();
    expect(w.db._tables.metric_points.filter((p: any) => p.version === "need-v2")).toHaveLength(5);
    // The recount drops the older definition's hour from the chart.
    const hour = Math.floor(D("2026-11-11T12:31:00") / 3_600_000) * 3_600_000;
    expect(w.db._tables.metric_rollups.some((r: any) => r.hour === hour)).toBe(true);
    await h(recountRollups)(w.internal, { watch_id: need._id, after_hour: -1 });
    expect(w.db._tables.metric_rollups.some((r: any) => r.hour === hour)).toBe(false);
  });

  test("a window of polls leaves out values of an older definition, and says so", async () => {
    const w = world();
    const { need } = await watches(w);
    await read(w, need._id, NOW - 7 * 86_400_000, 62.87);
    await read(w, need._id, NOW, 49.5, undefined, "need-v2");
    const metric = { key: "n", name: NEED, target: "at least 51.2%", series: need.short_id, window: "2w", noise: "binomial:300" };
    const [r] = metricReadings({ metrics: [metric] }, await seriesLookup(w.internal, WS, [{ metrics: [metric] }]));
    expect(r!.band!.periods).toBe(1);
    expect(r!.band!.dropped).toBe(1);
    expect(metricLine(r!, NOW)).toContain("1 value of an older definition left out");
  });
});

describe("cast metrics points rm", () => {
  test("the creator removes a stale value at one minute; it leaves the history, the row and the chart, and is logged", async () => {
    const w = world();
    const { need } = await watches(w);
    const stale = D("2026-11-11T12:31:07");
    await read(w, need._id, stale, 62.87);
    await read(w, need._id, NOW, 49.5);
    await expect(h(removePoints)(w.as("u2"), { watch: need.short_id, at: D("2026-11-11T12:31:00"), to: D("2026-11-11T12:31:59.999") })).rejects.toThrow(/creator or a team admin/);
    const out = await h(removePoints)(w.as("u1"), { watch: need.short_id, at: D("2026-11-11T12:31:00"), to: D("2026-11-11T12:31:59.999"), reason: "recorded under the old definition" });
    expect(out.removed).toEqual([{ at: stale, value: 62.87 }]);
    const row = await w.db.get(need._id);
    expect(row.points.map((p: any) => p.value)).toEqual([49.5]);
    expect(row.point_removals).toEqual([{ at: stale, value: 62.87, reason: "recorded under the old definition", by: "u1", removed_at: expect.any(Number) }]);
    expect(w.db._tables.metric_points.some((p: any) => p.at === stale)).toBe(false);
    expect(w.db._tables.metric_rollups.some((r: any) => r.hour === Math.floor(stale / 3_600_000) * 3_600_000)).toBe(false);
    await expect(h(removePoints)(w.as("u1"), { watch: need.short_id, at: stale, to: stale })).rejects.toThrow(/holds no value/);
    await expect(h(removePoints)(w.as("u1"), { watch: need.short_id, at: stale, to: stale + 2 * 3_600_000 })).rejects.toThrow(/within one hour/);
  });
});

describe("an older definition read by polls (a reader that sends no version)", () => {
  /** The old definition polled every 10 minutes through 11-11, then the new one from 11-13 on. */
  async function polled(w: ReturnType<typeof world>) {
    const { need } = await watches(w);
    for (let t = D("2026-11-11T11:01:00"); t <= D("2026-11-11T14:01:00"); t += 600_000) await read(w, need._id, t, 62.87);
    for (let t = NOW - 3 * 3_600_000; t <= NOW; t += 600_000) await read(w, need._id, t, 49.5);
    return need;
  }
  const metric = (ref: string) => ({ key: "n", name: NEED, target: "at least 51.2%", series: ref, window: "2w", noise: "binomial:600" });
  const reading = async (w: ReturnType<typeof world>, ref: string) => (await metricReadings({ metrics: [metric(ref)] }, await seriesLookup(w.internal, WS, [{ metrics: [metric(ref)] }])))[0]!;

  test("removing one poll lets its neighbour of the same old definition take its slot", async () => {
    const w = world();
    const need = await polled(w);
    await h(removePoints)(w.as("u1"), { watch: need.short_id, at: D("2026-11-11T12:31:00"), to: D("2026-11-11T12:31:59.999") });
    const r = await reading(w, need.short_id);
    expect(r.band!.read.map((p) => p.value)).toEqual([49.5, 62.87]);
    expect(r.band!.read[1]!.to).not.toBe(D("2026-11-11T12:31:00"));
  });

  test("redefine leaves every older value out of the window and the chart, keeps them stored, and is the creator's or an admin's", async () => {
    const w = world();
    const need = await polled(w);
    await expect(h(redefine)(w.as("u2"), { watch: need.short_id, since: D("2026-11-13T00:00:00") })).rejects.toThrow(/creator or a team admin/);
    await expect(h(redefine)(w.as("u1"), { watch: need.short_id, since: Date.now() + 86_400_000 })).rejects.toThrow(/has passed/);
    const out = await h(redefine)(w.as("u1"), { watch: need.short_id, since: D("2026-11-13T00:00:00"), name: "need-v2", reason: "non-decline replies only (ct-93564)" });
    expect(out).toMatchObject({ watch: need.short_id, version: "need-v2" });
    const r = await reading(w, need.short_id);
    expect(r.band!.read.map((p) => p.value)).toEqual([49.5]);
    expect(r.band!.dropped).toBeGreaterThan(0);
    expect(metricLine(r, NOW)).toContain("of an older definition left out");
    expect(w.db._tables.metric_points.filter((p: any) => p.value === 62.87)).toHaveLength(19);
    await h(recountRollups)(w.internal, { watch_id: need._id, after_hour: -1 });
    expect(w.db._tables.metric_rollups.filter((x: any) => x.hour < D("2026-11-13T00:00:00"))).toHaveLength(0);
    expect(w.db._tables.metric_rollups.some((x: any) => x.hour >= Math.floor((NOW - 3 * 3_600_000) / 3_600_000) * 3_600_000)).toBe(true);
    // New polls (untagged: this reader sends no version) count under it.
    await read(w, need._id, NOW + 600_000, 49.6);
    expect((await w.db.get(need._id)).points.at(-1).value).toBe(49.6);
  });
});

describe("a removed value stays removed", () => {
  test("a reader re-sending a removed cohort week, or a backfill re-reading it, does not bring it back", async () => {
    const w = world();
    const { need } = await watches(w);
    await read(w, need._id, NOW, 49.5, [...MATURE, { at: NOW, value: 49.5 }]);
    await h(removePoints)(w.as("u1"), { watch: need.short_id, at: D("2026-10-19"), reason: "test" });
    await read(w, need._id, NOW + 600_000, 49.5, [...MATURE, { at: NOW + 600_000, value: 49.5 }]);
    const row = await w.db.get(need._id);
    expect(row.source_points.map((p: any) => p.value)).toEqual([53.3, 50.8, 49.7]);
    expect(w.db._tables.metric_points.some((p: any) => p.at === D("2026-10-19"))).toBe(false);
    await h(recordHistory)(w.internal, { watch_id: need._id, points: [{ at: D("2026-10-19"), value: 49.3 }, { at: D("2026-09-28"), value: 43.2 }] });
    expect(w.db._tables.metric_points.some((p: any) => p.at === D("2026-10-19"))).toBe(false);
    expect(w.db._tables.metric_points.some((p: any) => p.at === D("2026-09-28"))).toBe(true);
  });
});

describe("a window of polls while the source fails", () => {
  test("says it is read from polls and that the source fails, and never reads met on them", async () => {
    const w = world();
    const { need } = await watches(w);
    for (let t = NOW - 7 * 86_400_000; t <= NOW; t += 7 * 86_400_000) await read(w, need._id, t, 60);
    await h(recordPoint)(w.internal, { watch_id: need._id, at: NOW + 60_000, error: "no answer in 15s" });
    const m = { key: "n", name: NEED, target: "at least 51.2%", series: need.short_id, window: "2w", noise: "binomial:600" };
    const [r] = metricReadings({ metrics: [m] }, await seriesLookup(w.internal, WS, [{ metrics: [m] }]));
    expect(r!.band!.failing).toBe("no answer in 15s");
    expect(r!.band!.low!).toBeGreaterThan(51.2);
    expect(r!.standing).toBe("within_noise");
    expect(metricLine(r!, NOW)).toContain("read from stored polls while its source fails (no answer in 15s)");
  });
});
