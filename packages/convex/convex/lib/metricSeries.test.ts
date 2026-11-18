import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "../testDb";
import { cleanMetrics, requireSeries, seriesLookup } from "./metricSeries";
import { gatherGoalsBrief } from "../goals";
import { renderGoalsBrief } from "@codecast/shared/contracts/goalsBrief";
import { metricReadings } from "@codecast/shared/contracts/initiative";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const NOW = Date.UTC(2026, 10, 17, 12);
const WS = "team:t1";

/** A watch whose row holds its newest 60 six-hourly points (15 days) and whose metric_points hold 5 weeks; the weekly value is 20 + week index. */
function world(extra: Record<string, any[]> = {}) {
  const all: Array<{ at: number; value: number }> = [];
  for (let t = NOW - 5 * WEEK; t <= NOW; t += 6 * HOUR) all.push({ at: t, value: 20 + Math.round((t - (NOW - 5 * WEEK)) / WEEK) });
  const watch = { _id: "w14", short_id: "mw-14", workspace: WS, name: "Intros a week", unit: "/week", points: all.slice(-60) };
  const denom = { _id: "w17", short_id: "mw-17", workspace: WS, name: "Matches a week", unit: null, points: all.slice(-60).map((p) => ({ ...p, value: 70 })) };
  const other = { _id: "w99", short_id: "mw-99", workspace: "team:other", name: "Theirs", unit: null, points: [{ at: NOW, value: 1 }] };
  return makeFakeDb({
    metric_watches: [watch, denom, other],
    metric_points: [...all.map((p, i) => ({ _id: `p${i}`, watch_id: "w14", ...p })), ...all.map((p, i) => ({ _id: `q${i}`, watch_id: "w17", at: p.at, value: 70 }))],
    ...extra,
  });
}

const windowed = { key: "intros_a_week", name: "Intros a week", target: "at least 60", series: "mw-14", window: "4w", noise: "poisson" };

describe("metrics as a write gives them", () => {
  test("window and noise are kept, cleaned, and checked", () => {
    expect(cleanMetrics([{ name: "Intros a week", target: "at least 60", series: "MW-14", window: " 3W ", noise: "Poisson:1.75" }])).toEqual([
      { key: "intros_a_week", name: "Intros a week", target: "at least 60", series: "mw-14", window: "3w", noise: "poisson:1.75" },
    ]);
    expect(() => cleanMetrics([{ name: "A", target: "1", window: "3 weeks" }])).toThrow(/A: A window is whole weeks or days/);
    expect(() => cleanMetrics([{ name: "A", target: "1", noise: "normal" }])).toThrow(/A: A noise model is/);
    // A metric with neither reads exactly as before: no new keys.
    expect(cleanMetrics([{ name: "A", target: "1", window: null, noise: "" }])).toEqual([{ key: "a", name: "A", target: "1" }]);
  });

  test("a dated trajectory keeps its whole target; any other target keeps the short cap", () => {
    const trajectory = "at least 51.2%@2026-11-16 53.1%@2026-11-30 56.6%@2026-12-14 59.1%@2026-12-28";
    expect(cleanMetrics([{ name: "Replied to explicit need", target: trajectory }])[0]!.target).toBe(trajectory);
    expect(cleanMetrics([{ name: "Replied to explicit need", target: "51.2% wk of 11-16 rising to 59.1% by 12-28" }])[0]!.target).toBe("51.2% wk of 11-16 rising to 59.1% by 12-");
  });

  test("a binomial denominator series must be a watch in the workspace too", async () => {
    const ctx = { db: world() };
    await requireSeries(ctx, WS, [{ key: "r", name: "R", target: "50%", series: "mw-14", noise: "binomial:mw-17" }]);
    await expect(requireSeries(ctx, WS, [{ key: "r", name: "R", target: "50%", series: "mw-14", noise: "binomial:mw-99" }])).rejects.toThrow(/No metric watch mw-99/);
  });
});

describe("the series a windowed metric reads", () => {
  test("history fills the slots the row's 60 points do not reach, from metric_points", async () => {
    const ctx = { db: world() };
    const lookup = await seriesLookup(ctx, WS, [{ metrics: [windowed] }]);
    const s = lookup("mw-14")!;
    // Slots at now, -1w, -2w are inside the row's 15 days; -3w comes from metric_points.
    expect(s.history?.map((p) => p.at)).toEqual([NOW - 3 * WEEK]);
    const [r] = metricReadings({ metrics: [windowed] }, lookup);
    expect(r!.band?.periods).toBe(4);
    expect(r!.band?.mean).toBe((25 + 24 + 23 + 22) / 4);
    expect(r!.standing).toBe("behind");
  });

  test("a metric without a window reads no history", async () => {
    const ctx = { db: world() };
    const lookup = await seriesLookup(ctx, WS, [{ metrics: [{ ...windowed, window: undefined }] }]);
    expect(lookup("mw-14")!.history).toBeUndefined();
  });

  test("a binomial denominator gets the same slots", async () => {
    const ctx = { db: world() };
    const m = { key: "r", name: "Matched to opted in a week", target: "at least 10%", series: "mw-14", window: "4w", noise: "binomial:mw-17" };
    const lookup = await seriesLookup(ctx, WS, [{ metrics: [m] }]);
    expect(lookup("mw-17")!.history?.map((p) => p.at)).toEqual([NOW - 3 * WEEK]);
    expect(lookup("mw-99")).toBeUndefined();
  });
});

describe("a ratio's denominator", () => {
  test("is read where the metric's own values sit, not at the nominal slots", async () => {
    const off = NOW - WEEK - 1.5 * DAY;
    const db = makeFakeDb({
      metric_watches: [
        { _id: "c", short_id: "mw-13", workspace: WS, name: "Dollars per intro", unit: "$", points: [{ at: NOW, value: 400 }] },
        { _id: "n", short_id: "mw-14", workspace: WS, name: "Intros a week", unit: "/week", points: [{ at: NOW, value: 40 }] },
      ],
      metric_points: [
        { _id: "c1", watch_id: "c", at: off, value: 800 },
        { _id: "n1", watch_id: "n", at: off + HOUR, value: 20 },
        { _id: "n2", watch_id: "n", at: NOW - WEEK + 1.5 * DAY, value: 99 },
      ],
    });
    const m = { key: "d", name: "Dollars per intro", target: "under $250", series: "mw-13", window: "2w", noise: "ratio:mw-14" };
    const lookup = await seriesLookup({ db }, WS, [{ metrics: [m] }]);
    expect(lookup("mw-14")!.history).toEqual([{ at: off + HOUR, value: 20 }]);
    const [r] = metricReadings({ metrics: [m] }, lookup);
    expect(r!.band?.read.map((p) => p.weight)).toEqual([40, 20]);
    expect(r!.band?.mean).toBeCloseTo((400 * 40 + 800 * 20) / 60, 6);
  });
});

describe("Ground's goals brief", () => {
  test("a live @mw-N metric reads its series, not \"no reading yet\"", async () => {
    const initiative = { _id: "i9", short_id: "in-9", title: "Decrease cost per match", status: "active", workspace: WS, project_ids: [], health: "none", metrics: [windowed] };
    const ctx = { db: world({ initiatives: [initiative], teams: [] }) };
    const brief = await gatherGoalsBrief(ctx, { workspaceKey: WS, only: null, projectRows: [] });
    expect(Object.keys(brief.initiatives[0]!.series ?? {})).toEqual(["mw-14"]);
    const text = renderGoalsBrief(brief, { now: NOW });
    expect(text).not.toContain("no reading yet");
    expect(text).toMatch(/Intros a week: 25\/week of at least 60, behind over 4 weeks \(mean 23\.5\/week/);
  });
});
