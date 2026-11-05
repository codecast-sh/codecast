// Round 3 of the third Metrics pass: the strip names one mean per window, the
// reads behind announced transitions sit on the drawn line, a stretch after
// daily backfill reads as missing data, and one failed read is Retrying.
import { describe, expect, test } from "bun:test";
import { dataHoles, healthCounts, HOUR, DAY, watchHealth, yDomain } from "./metricModel";
import { stripMean, withAnnouncedReads, type WindowDelta } from "./metricSeries";

const change: WindowDelta = { change: -0.3, pct: -0.003, base: 94.7, now: 94.4, vs: "prior", since: 0 };

describe("stripMean", () => {
  test("a named range shows the change's current mean, so the strip says one number", () => {
    expect(stripMean(94.7, change, "7d", false)).toBe(94.4);
    expect(stripMean(94.7, change, "30d", false)).toBe(94.4);
  });
  test("All and a zoom keep the mean of what the chart draws", () => {
    expect(stripMean(94.7, change, "all", false)).toBe(94.7);
    expect(stripMean(94.7, change, "7d", true)).toBe(94.7);
  });
  test("with no change yet, the drawn mean; with neither, nothing", () => {
    expect(stripMean(94.7, null, "7d", false)).toBe(94.7);
    expect(stripMean(null, null, "7d", false)).toBeNull();
    expect(stripMean(94.7, { ...change, vs: "first" }, "7d", false)).toBe(94.7);
  });
});

describe("withAnnouncedReads", () => {
  const T0 = Date.UTC(2026, 9, 25, 11, 30);
  // Daily backfill to Oct 31 11:30, then hourly polls from Nov 1 11:00.
  const daily = Array.from({ length: 7 }, (_, i) => ({ at: T0 + i * DAY, value: 50 + i }));
  const lastDaily = daily[daily.length - 1].at;
  const hourlyFrom = lastDaily + 23.5 * HOUR;
  const hourly = Array.from({ length: 24 }, (_, i) => ({ at: hourlyFrom + i * HOUR, value: 20 }));
  const points = [...daily, ...hourly];
  const recovery = { at: lastDaily + 3.45 * HOUR, kind: "recovered" as const, value: 15 };

  test("the recovery's read goes onto the line where no value stands near it", () => {
    const out = withAnnouncedReads(points, [recovery], HOUR);
    expect(out).toHaveLength(points.length + 1);
    expect(out.find((p) => p.at === recovery.at)?.value).toBe(15);
    expect(out.map((p) => p.at)).toEqual([...out.map((p) => p.at)].sort((a, b) => a - b));
  });

  test("without it the empty day reads as one more daily step; with it, as missing data", () => {
    expect(dataHoles(points, HOUR, HOUR).some((h) => h.from === lastDaily)).toBe(false);
    const holes = dataHoles(withAnnouncedReads(points, [recovery], HOUR), HOUR, HOUR);
    const hole = holes.find((h) => h.from === recovery.at);
    expect(hole?.to).toBe(hourlyFrom);
    expect(hole!.missed).toBeGreaterThan(15);
  });

  test("a transition inside a held value's step, an inferred one, one without a value or outside the series adds nothing", () => {
    const inside = { at: hourly[3].at + 20 * 60_000, kind: "crossed" as const, value: 99 };
    expect(withAnnouncedReads(points, [inside], HOUR)).toHaveLength(points.length);
    expect(withAnnouncedReads(points, [{ ...recovery, inferred: true }], HOUR)).toHaveLength(points.length);
    expect(withAnnouncedReads(points, [{ ...recovery, value: null }], HOUR)).toHaveLength(points.length);
    expect(withAnnouncedReads(points, [{ ...recovery, at: T0 - DAY }], HOUR)).toHaveLength(points.length);
    expect(withAnnouncedReads([], [recovery], HOUR)).toEqual([]);
  });
});

describe("Retrying", () => {
  const base = { status: "active" as const, state: "ok" as const, last_value: 95, threshold: undefined, last_error: "metrics.read: answered 502", missed: 1 };
  test("a failing reader is one state on every surface: the chips count it where the table and the page pill name it", () => {
    expect(watchHealth(base)).toBe("retrying");
    const counts = healthCounts([base, { ...base, missed: 2 }, { ...base, last_error: undefined }]);
    expect(counts.retrying).toBe(1);
    expect(counts.error).toBe(1);
    expect(counts.series).toBe(1);
  });
  test("alerting and paused still win over a missed read", () => {
    expect(watchHealth({ ...base, threshold: 10, state: "alert" })).toBe("alert");
    expect(watchHealth({ ...base, status: "paused" })).toBe("paused");
  });
});

describe("the y axis of a percent", () => {
  test("a 1.4-point move in a success rate fills the plot", () => {
    const [lo, hi] = yDomain([[{ at: 0, value: 94.7 }, { at: 1, value: 96.1 }]], undefined, "%");
    expect(lo).toBeGreaterThan(94);
    expect(hi).toBeLessThan(97);
  });
  test("a tiny percent wobble still spans a point; other units keep the tenth-of-the-value floor", () => {
    const [lo, hi] = yDomain([[{ at: 0, value: 95 }, { at: 1, value: 95.1 }]], undefined, "%");
    expect(hi - lo).toBeGreaterThanOrEqual(1);
    const [a, b] = yDomain([[{ at: 0, value: 94.7 }, { at: 1, value: 96.1 }]]);
    expect(b - a).toBeGreaterThan(9);
  });
});
