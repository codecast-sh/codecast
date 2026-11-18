// `cast climb experiment` sizes a production test from the reading every
// surface shows (metricReadings over the goal's live series), never from a
// copy of the level logic. The row below has the shape `/cli/initiatives/get`
// serves for a goal like Union's in-9 (`cast goal show in-9 --json`): a ratio
// metric pooled over a count's series, a count with a dispersion, live series
// with cohort weeks and polled points, and a failing source. The numbers are
// synthetic: this repository is public.
import { describe, expect, test } from "bun:test";
import { detectableAt, experimentWeeks } from "@codecast/shared/contracts/climb";
import { metricReadings } from "@codecast/shared/contracts/initiative";
import { liveSeries } from "../initiativeCommand";
import { experimentLine } from "../climbCommand";

const WEEK = 7 * 24 * 3600 * 1000;
const monday = Date.UTC(2026, 8, 7);
const now = monday + 10 * WEEK + 3 * 24 * 3600 * 1000;
const cohorts = (values: number[]) => values.map((value, i) => ({ at: monday + i * WEEK, value }));
const points = (value: (i: number) => number) => Array.from({ length: 60 }, (_, i) => ({ at: now - (60 - i) * 20 * 60 * 1000, value: value(i) }));

const ROW = {
  short_id: "in-9",
  title: "Cost per intro",
  metrics: [
    { key: "dollars_per_intro", name: "Dollars per intro", noise: "ratio:mw-14", series: "mw-13", target: "under $250", window: "4w" },
    { guardrail: true, key: "intros_a_week", name: "Intros a week", noise: "poisson:1.75", series: "mw-14", target: "at least 16", window: "3w" },
  ],
  series: {
    "mw-13": { short_id: "mw-13", name: "Dollars per intro", unit: "$", last_error: "no answer in 15s", cohorts: cohorts([640, 1250, 900, 700, 980, 860, 1020, 790]), points: points((i) => 450 + (i % 3)) },
    "mw-14": { short_id: "mw-14", name: "Intros a week", unit: "/week", last_error: "no answer in 15s", cohorts: cohorts([30, 17, 22, 19, 25, 16, 21, 18]), points: points(() => 38) },
  },
};

const post = async (url: string) => (url === "/cli/initiatives/get" ? ROW : null);

describe("cast climb experiment", () => {
  test("each metric of the row as served is sized from its own reading", async () => {
    const readings = metricReadings(ROW as any, liveSeries(ROW as any));
    expect(readings.find((r) => r.key === "intros_a_week")!.band?.mde ?? null).not.toBeNull();
    for (const r of readings) {
      if (r.band?.mde == null) {
        // A tree whose readings cannot read this metric's noise model says so, never "no reading".
        await expect(experimentLine(post, "in-9", r.key, 0.15)).rejects.toThrow(/no detectable change|without a window/);
        continue;
      }
      const line = await experimentLine(post, "in-9", r.key, 0.15);
      expect(line).not.toContain("no reading");
      expect(line).toContain(r.key);
      const weeks = experimentWeeks(r.band!.mde, r.noise, 0.15);
      expect(line).toContain(weeks === null ? "cannot detect 15% within 26 weeks" : `detects 15% in ${weeks} week`);
    }
  });

  test("a lift the reading can see within its own four weeks needs at most four, and a larger lift never needs more", async () => {
    const r = metricReadings(ROW as any, liveSeries(ROW as any)).find((x) => x.key === "intros_a_week")!;
    const mde = r.band!.mde!;
    expect(experimentWeeks(mde, r.noise, mde)).toBeLessThanOrEqual(4);
    expect(experimentWeeks(mde, r.noise, mde * 2)!).toBeLessThanOrEqual(experimentWeeks(mde, r.noise, mde)!);
    expect(detectableAt(mde, r.noise, 4)!).toBeCloseTo(mde, 3);
    expect(await experimentLine(post, "in-9", "Intros a week", mde * 1.01)).toContain("in 4 weeks");
  });

  test("a metric read without a window says what to set, and an unknown key names the goal's keys", async () => {
    const bare = { ...ROW, metrics: [{ key: "intros_a_week", name: "Intros a week", series: "mw-14", target: "at least 16" }] };
    await expect(experimentLine(async () => bare, "in-9", "intros_a_week", 0.2)).rejects.toThrow("without a window and a noise model");
    await expect(experimentLine(post, "in-9", "nope", 0.2)).rejects.toThrow("dollars_per_intro, intros_a_week");
  });
});
