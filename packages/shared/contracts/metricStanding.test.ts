import { describe, expect, test } from "bun:test";
import { initiativeStanding, metricLine, metricReading, metricReadings, type InitiativeMetric, type MetricSeries } from "./initiative";
import {
  doneWhenPredicate,
  gammaQuantile,
  isExecutableDoneWhen,
  metricPeriodMs,
  metricSpec,
  metricWindowNoiseError,
  minimumDetectableLift,
  noiseSd,
  parseMetricNoise,
  parseMetricSpec,
  parseMetricWindow,
  poissonBand,
  wilsonBand,
  windowSamples,
} from "./metricStanding";
import { metricDirection } from "./initiative";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const NOW = Date.UTC(2026, 10, 17, 12);

/** A rolling weekly count read every 6 hours for `weeks`, the week ending at each slot reading `weekly[i]` (oldest first). */
function weeklySeries(weekly: number[], ref = "mw-14", name = "Intros a week", unit: string | null = "/week"): MetricSeries {
  const points: Array<{ at: number; value: number }> = [];
  const start = NOW - (weekly.length - 1) * WEEK;
  for (let t = start - WEEK + 6 * 3600_000; t <= NOW; t += 6 * 3600_000) {
    const i = Math.min(weekly.length - 1, Math.max(0, Math.round((t - start) / WEEK)));
    points.push({ at: t, value: weekly[i]! });
  }
  return { short_id: ref, name, unit, points: points.slice(-60), history: points };
}

describe("the noise models' numbers against known values", () => {
  test("Garwood Poisson band at 80% (the 10th and 90th percentiles)", () => {
    expect(poissonBand(0).low).toBe(0);
    expect(poissonBand(0).high).toBeCloseTo(2.302585, 4);
    expect(poissonBand(10).low).toBeCloseTo(6.2213, 3);
    expect(poissonBand(10).high).toBeCloseTo(15.4066, 3);
    expect(poissonBand(1).low).toBeCloseTo(0.10536, 4);
    expect(poissonBand(1).high).toBeCloseTo(3.88972, 4);
    expect(gammaQuantile(0.5, 1)).toBeCloseTo(Math.LN2, 8);
  });

  test("Wilson band at 80%", () => {
    const w = wilsonBand(60, 100);
    expect(w.low).toBeCloseTo(0.53609, 4);
    expect(w.high).toBeCloseTo(0.66068, 4);
    expect(wilsonBand(0, 50).low).toBe(0);
    expect(wilsonBand(50, 50).high).toBe(1);
  });

  test("the smallest lift a 4 week 50/50 test detects matches the design's table", () => {
    // 37 intros a week: +52% in 4 weeks, +28% in 12.
    expect(minimumDetectableLift(37, { kind: "poisson" }, 4)!).toBeCloseTo(0.5167, 3);
    expect(minimumDetectableLift(37, { kind: "poisson" }, 12)!).toBeCloseTo(0.2842, 3);
    // ~20,000 cold emails a week at ~1.2% reply: +18%.
    expect(minimumDetectableLift(1.2, { kind: "binomial", n: 20_000 }, 4, { scale: 100 })!).toBeCloseTo(0.1879, 3);
    // Overdispersion widens it: phi 1.75 reads like 1/1.75 of the count.
    expect(minimumDetectableLift(37, { kind: "poisson", phi: 1.75 }, 4)!).toBeCloseTo(minimumDetectableLift(37 / 1.75, { kind: "poisson" }, 4)!, 10);
    expect(minimumDetectableLift(0, { kind: "poisson" }, 4)).toBeNull();
    expect(minimumDetectableLift(0.6, { kind: "binomial" }, 4)).toBeNull();
    // A/A: 2·z·sd / (√periods · level).
    expect(minimumDetectableLift(100, { kind: "aa", sd: 10 }, 4)!).toBeCloseTo((2.801585 * 2 * 10) / (2 * 100), 4);
  });

  test("one period's spread per model", () => {
    expect(noiseSd(36, "poisson")).toBe(6);
    expect(noiseSd(36, "poisson:1.75")).toBeCloseTo(Math.sqrt(63), 10);
    expect(noiseSd(60, "binomial:100")).toBeCloseTo(Math.sqrt(0.24 / 100) * 100, 10);
    expect(noiseSd(0.6, "binomial:100")).toBeCloseTo(Math.sqrt(0.24 / 100), 10);
    expect(noiseSd(60, "binomial:mw-18")).toBeNull();
    expect(noiseSd(60, "binomial:mw-18", 100)).toBeCloseTo(Math.sqrt(0.24 / 100) * 100, 10);
    expect(noiseSd(250, "aa:30")).toBe(30);
    expect(noiseSd(250, null)).toBeNull();
  });
});

describe("a metric as written", () => {
  test("windows and noise models parse, and bad ones say why", () => {
    expect(parseMetricWindow("3w")).toEqual({ count: 3, unit: "w", ms: 3 * WEEK });
    expect(parseMetricWindow("14d")?.ms).toBe(14 * DAY);
    for (const bad of ["3", "0w", "27w", "3m", "w3", ""]) expect(parseMetricWindow(bad)).toBeNull();
    expect(parseMetricNoise("Poisson")).toEqual({ kind: "poisson" });
    expect(parseMetricNoise("poisson:1.75")).toEqual({ kind: "poisson", phi: 1.75 });
    expect(parseMetricNoise("poisson:1")).toEqual({ kind: "poisson" });
    expect(parseMetricNoise("binomial:mw-15")).toEqual({ kind: "binomial", series: "mw-15" });
    expect(parseMetricNoise("binomial:20000")).toEqual({ kind: "binomial", n: 20000 });
    expect(parseMetricNoise("aa:4.2")).toEqual({ kind: "aa", sd: 4.2 });
    for (const bad of ["gaussian", "poisson:0.5", "binomial:", "binomial:0", "aa:0", "aa:-1", "binomial:mw-x"]) expect(parseMetricNoise(bad)).toBeNull();
    expect(metricWindowNoiseError("3w", "poisson")).toBeNull();
    expect(metricWindowNoiseError("3 weeks", null)).toMatch(/window/);
    expect(metricWindowNoiseError(null, "normal")).toMatch(/noise/);
  });

  test("the spec round-trips, and the old shapes read as they did", () => {
    const specs = [
      "Intros a week=at least 60 @mw-14 window 3w noise poisson:1.75",
      "Dollars per intro=under $250 @mw-13 window 4w noise aa:52",
      "Reply rate=at least 1.14% @mw-15 window 2w noise binomial:mw-11 guardrail",
      "Bounce rate=under 3% @mw-14 guardrail",
      "Weekly active teams=1000",
    ];
    for (const s of specs) expect(metricSpec(parseMetricSpec(s)!)).toBe(s);
    expect(parseMetricSpec("Intros a week=at least 60 noise poisson window 3w @mw-14")).toEqual({ name: "Intros a week", target: "at least 60", series: "mw-14", window: "3w", noise: "poisson" });
    expect(parseMetricSpec("Dollars per intro=under $250 @mw-12")).toEqual({ name: "Dollars per intro", target: "under $250", series: "mw-12" });
    expect(parseMetricSpec("Bounce rate=under 3% guardrail")).toEqual({ name: "Bounce rate", target: "under 3%", guardrail: true });
    expect(parseMetricSpec("no target")).toBeNull();
    expect(parseMetricSpec("x= window 3w")).toBeNull();
  });

  test("the period a value counts over", () => {
    const w3 = parseMetricWindow("3w")!, d14 = parseMetricWindow("14d")!;
    expect(metricPeriodMs("Intros a week", d14)).toBe(WEEK);
    expect(metricPeriodMs("Desktop app downloads (7d)", d14)).toBe(WEEK);
    expect(metricPeriodMs("Cold emails a day", w3)).toBe(DAY);
    expect(metricPeriodMs("Active app users (24h)", w3)).toBe(DAY);
    expect(metricPeriodMs("Dollars per intro", w3)).toBe(WEEK);
    expect(metricPeriodMs("Dollars per intro", d14)).toBe(DAY);
  });

  test("window samples are a period apart and never reuse a point", () => {
    const pts = [0, 1, 2].map((i) => ({ at: NOW - i * WEEK, value: 10 + i }));
    expect(windowSamples(pts, WEEK, 3).map((p) => p.value)).toEqual([10, 11, 12]);
    expect(windowSamples(pts, WEEK, 5)).toHaveLength(3);
    expect(windowSamples([{ at: NOW, value: 1 }, { at: NOW - DAY, value: 2 }], WEEK, 3)).toHaveLength(1);
  });
});

describe("standing over a window", () => {
  const intros = (target: string, noise = "poisson"): InitiativeMetric => ({ key: "intros_a_week", name: "Intros a week", target, series: "mw-14", window: "3w", noise });

  test("met only when the lower bound clears; within noise when the band holds the target; behind when it all misses", () => {
    const s = weeklySeries([20, 30, 37, 37]);
    // 3 weeks of 30, 37, 37: 104 events, band about 30.4 to 39.1 a week.
    const r = metricReading(intros("at least 28"), null, s);
    expect(r.band?.periods).toBe(3);
    expect(r.band?.mean).toBeCloseTo(104 / 3, 6);
    expect(r.band!.low!).toBeCloseTo(poissonBand(104).low / 3, 6);
    expect(r.standing).toBe("met");
    expect(metricReading(intros("at least 35"), null, s).standing).toBe("within_noise");
    expect(metricReading(intros("at least 60"), null, s).standing).toBe("behind");
    // The old reading of the same value would have called 35 met: the latest week is 37.
    expect(metricReading({ ...intros("at least 35"), window: undefined, noise: undefined }, null, s).standing).toBe("met");
  });

  test("a target to stay under reads the upper bound", () => {
    const s = weeklySeries([400, 300, 310, 290], "mw-13", "Dollars per intro", "$");
    const m = (target: string): InitiativeMetric => ({ key: "dpi", name: "Dollars per intro", target, series: "mw-13", window: "3w", noise: "aa:40" });
    // mean 300, half band 1.2816 · 40 / √3 ≈ 29.6.
    expect(metricReading(m("under $340"), null, s).standing).toBe("met");
    expect(metricReading(m("under $310"), null, s).standing).toBe("within_noise");
    expect(metricReading(m("under $250"), null, s).standing).toBe("behind");
  });

  test("overdispersion widens the band", () => {
    const s = weeklySeries([20, 30, 37, 37]);
    const plain = metricReading(intros("at least 28"), null, s).band!;
    const wide = metricReading(intros("at least 28", "poisson:1.75"), null, s).band!;
    expect(wide.low!).toBeLessThan(plain.low!);
    expect(wide.high!).toBeGreaterThan(plain.high!);
    expect(wide.mde!).toBeGreaterThan(plain.mde!);
    expect(metricReading(intros("at least 30", "poisson:1.75"), null, s).standing).toBe("within_noise");
  });

  test("a rate with a denominator series pools the window's counts", () => {
    const rate = weeklySeries([60, 60, 60, 60], "mw-18", "Matched to opted in", "%");
    const n = weeklySeries([70, 70, 70, 70], "mw-17", "Matches a week", null);
    const m: InitiativeMetric = { key: "opt", name: "Matched to opted in", target: "at least 50%", series: "mw-18", window: "3w", noise: "binomial:mw-17" };
    const r = metricReading(m, null, rate, (ref) => (ref === "mw-17" ? n : ref === "mw-18" ? rate : undefined));
    const w = wilsonBand(126, 210);
    expect(r.band!.low!).toBeCloseTo(w.low * 100, 6);
    expect(r.standing).toBe("met");
    // Without the denominator the declared model cannot run: unknown, never met on the mean alone.
    const alone = metricReading(m, null, rate, () => undefined);
    expect(alone.band?.low).toBeNull();
    expect(alone.standing).toBe("unknown");
    expect(alone.band?.note).toMatch(/denominator mw-17/);
  });

  test("a young series reads fewer periods and says so", () => {
    const s = weeklySeries([37]);
    s.history = undefined;
    s.points = s.points.slice(-8);
    const r = metricReading(intros("at least 28"), null, s);
    expect(r.band?.periods).toBe(1);
    expect(r.band?.of).toBe(3);
    expect(metricLine(r, NOW)).toContain("over 1 of 3 weeks");
  });

  test("a reported value is one period", () => {
    const m: InitiativeMetric = { key: "deals", name: "Deals a week", target: "at least 5", window: "4w", noise: "poisson" };
    const r = metricReading(m, { value: "12", observed_at: NOW, source: "x" });
    expect(r.band?.periods).toBe(1);
    // One lucky period never passes: met needs the whole window.
    expect(r.standing).toBe("within_noise");
    expect(r.band?.note).toBe("met needs all 4 weeks read");
    expect(metricReading({ ...m, target: "at least 30" }, { value: "12", observed_at: NOW, source: "x" }).standing).toBe("behind");
    expect(metricReading(m, null).standing).toBe("unknown");
  });

  test("the line names the band and what it can detect", () => {
    const r = metricReading(intros("at least 35"), null, weeklySeries([20, 30, 37, 37]));
    expect(metricLine(r, NOW)).toMatch(/^Intros a week: 37\/week of at least 35, within noise over 3 weeks \(mean 34\.7\/week, 80% band 30\.4\/week to 39\.4\/week, detects ±54% in 4 weeks\) \(live mw-14, today\)$/);
  });

  test("the goal's word: within noise only when nothing is behind and something is not yet met", () => {
    const rd = (standing: any) => ({ standing }) as any;
    expect(initiativeStanding([rd("met"), rd("within_noise")])).toBe("within_noise");
    expect(initiativeStanding([rd("behind"), rd("within_noise")])).toBe("behind");
    expect(initiativeStanding([rd("met"), rd("met")])).toBe("met");
    expect(initiativeStanding([rd("within_noise"), rd("unknown")])).toBe("unknown");
  });
});

describe("the executable done-when", () => {
  test("only when every climbed number names a window and a noise model", () => {
    expect(isExecutableDoneWhen([{ window: "3w", noise: "poisson" }, { guardrail: true }])).toBe(true);
    expect(isExecutableDoneWhen([{ window: "3w", noise: "poisson" }, { window: "3w" }])).toBe(false);
    expect(isExecutableDoneWhen([{ guardrail: true, window: "3w", noise: "poisson" }])).toBe(false);
    expect(isExecutableDoneWhen([])).toBe(false);
  });

  test("its verdict follows its clauses", () => {
    const s = weeklySeries([20, 30, 37, 37]);
    const row = { metrics: [
      { key: "a", name: "Intros a week", target: "at least 28", series: "mw-14", window: "3w", noise: "poisson" },
      { key: "g", name: "Bounce", target: "under 3%", guardrail: true },
    ] as InitiativeMetric[] };
    const say = (_r: unknown, n: number) => n.toFixed(1);
    const p = doneWhenPredicate(metricReadings(row, () => s), metricDirection, say)!;
    expect(p.verdict).toBe("met");
    expect(p.clauses).toHaveLength(1);
    expect(p.clauses[0]!.text).toMatch(/^Intros a week at least 28, at the lower edge of its 80% band over 3w, noise poisson: met \(lower bound now 30\.\d\)$/);
    row.metrics[0]!.target = "at least 35";
    expect(doneWhenPredicate(metricReadings(row, () => s), metricDirection, say)!.verdict).toBe("within_noise");
    row.metrics[0]!.window = undefined;
    expect(doneWhenPredicate(metricReadings(row, () => s), metricDirection, say)).toBeNull();
  });
});

describe("what the review tried to break", () => {
  const weekly = (vals: number[], unit: string | null, name = "Reply rate a week"): MetricSeries => ({ short_id: "mw-1", name, unit, points: vals.map((value, i) => ({ at: NOW - (vals.length - 1 - i) * WEEK, value })) });
  const read = (m: Partial<InitiativeMetric>, s: MetricSeries) => metricReading({ key: "k", name: s.name, target: "", series: "mw-1", window: "3w", ...m } as InitiativeMetric, null, s);

  test("a rate on a 0 to 100 scale with no % sign reads as percent", () => {
    const r = read({ target: "at least 50", noise: "binomial:200" }, weekly([60, 60, 60], null));
    expect(r.standing).toBe("met");
    expect(r.band!.low!).toBeCloseTo(wilsonBand(360, 600).low * 100, 6);
    expect(noiseSd(60, "binomial:200")).toBeCloseTo(Math.sqrt(0.24 / 200) * 100, 10);
  });

  test("a share above 100% is not a binomial rate: unknown, not clamped", () => {
    const r = read({ target: "at least 120%", noise: "binomial:200" }, weekly([130, 130, 130], "%"));
    expect(r.standing).toBe("unknown");
    expect(r.band?.note).toMatch(/above 100%/);
  });

  test("negative values under a count model read unknown", () => {
    const r = read({ target: "at most -10", noise: "poisson" }, weekly([-20, -20, -20], null, "Net adds a week"));
    expect(r.standing).toBe("unknown");
    expect(read({ target: "at most -10", noise: "aa:3" }, weekly([-20, -20, -20], null, "Net adds a week")).standing).toBe("met");
  });

  test("a target at the model's edge is met by the window itself", () => {
    const zeros = { short_id: "mw-1", name: "Incidents a day", unit: null, points: Array.from({ length: 21 }, (_, i) => ({ at: NOW - (20 - i) * DAY, value: 0 })) };
    expect(metricReading({ key: "i", name: "Incidents a day", target: "at most 0", series: "mw-1", window: "21d", noise: "poisson" }, null, zeros).standing).toBe("met");
    const one = { ...zeros, points: zeros.points.map((p, i) => (i === 20 ? { ...p, value: 1 } : p)) };
    expect(metricReading({ key: "i", name: "Incidents a day", target: "at most 0", series: "mw-1", window: "21d", noise: "poisson" }, null, one).standing).toBe("behind");
    expect(read({ target: "at least 100%", noise: "binomial:50" }, weekly([100, 100, 100], "%")).standing).toBe("met");
  });

  test("a rolling 30 day value is read one month apart, never as overlapping weeks", () => {
    expect(metricPeriodMs("Signups (30d)", parseMetricWindow("12w")!)).toBe(30 * DAY);
    expect(metricPeriodMs("Verified deals 30d (28d)", parseMetricWindow("12w")!)).toBe(28 * DAY);
    expect(metricPeriodMs("Revenue a month", parseMetricWindow("12w")!)).toBe(30 * DAY);
    const pts = Array.from({ length: 85 }, (_, i) => ({ at: NOW - (84 - i) * DAY, value: 110 }));
    const r = metricReading({ key: "s", name: "Signups (30d)", target: "at least 100", series: "mw-1", window: "12w", noise: "poisson" }, null, { short_id: "mw-1", name: "Signups (30d)", unit: null, points: pts });
    expect(r.band?.of).toBe(3);
    expect(r.band?.period).toBe("month");
  });

  test("window and noise are trailing words with values; a target that says them keeps them", () => {
    expect(parseMetricSpec("Complaints=at most 3 noise complaints")).toEqual({ name: "Complaints", target: "at most 3 noise complaints" });
    expect(parseMetricSpec("Uptime=99.9% in any window of 30d")).toEqual({ name: "Uptime", target: "99.9% in any window of 30d" });
    expect(parseMetricSpec("Intros=at least 60 guardrail noise poisson window 3w")).toEqual({ name: "Intros", target: "at least 60", window: "3w", noise: "poisson", guardrail: true });
  });

  test("non-finite values are dropped", () => {
    const r = read({ target: "at least 10", noise: "poisson" }, weekly([NaN, 20, Infinity], null, "Intros a week"));
    expect(r.band?.periods).toBe(1);
  });
});
