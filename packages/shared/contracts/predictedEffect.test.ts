import { describe, expect, test } from "bun:test";
import { detectsWords, envMde, judgeEnvPrediction, predictionWords, readability, readMde, targetKind, unreadableWords, readingPeriodMs, hitRateWords, judgePrediction, parsePrediction, predictionReadAt, predictionTally, predictionText, predictionWindows, realisedLine, type RealisedEffect } from "./predictedEffect";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-17T12:00:00Z");

describe("parsePrediction", () => {
  test("a relative move by a date, with its basis", () => {
    const r = parsePrediction("in-9:intros_a_week +5% by 2026-12-15 :: replay env +6 on L2", NOW);
    expect(r).toEqual({ prediction: { goal_ref: "in-9:intros_a_week", direction: "up", size: 5, relative: true, read_at: Date.parse("2026-12-16T00:00:00Z"), basis: "replay env +6 on L2", set_at: NOW } });
  });
  test("an absolute drop read some days after ship", () => {
    const r = parsePrediction("in-9:dollars_per_intro -$40 in 3w :: sim arm vs base", NOW);
    expect("prediction" in r && r.prediction).toMatchObject({ direction: "down", size: 40, relative: false, read_days: 21 });
    expect("prediction" in r && r.prediction.read_at).toBeUndefined();
  });
  test("points on a rate are absolute", () => {
    const r = parsePrediction("in-3:reply_rate +0.2pt in 14d :: labelled set", NOW);
    expect("prediction" in r && r.prediction).toMatchObject({ size: 0.2, relative: false });
  });
  test("round trips through its own text", () => {
    for (const line of ["in-9:intros_a_week +5% by 2026-12-15 :: replay env", "in-9:dollars_per_intro -40 in 21d :: sim"]) {
      const r = parsePrediction(line, NOW);
      expect("prediction" in r && predictionText(r.prediction)).toBe(line);
    }
  });
  test.each([
    ["intros_a_week +5% in 7d :: x", "is not a place an effect is read"],
    ["env:notakey +0.02 :: x", "is not a place an effect is read"],
    ["in-9:intros_a_week +5% in 7d", "names its basis"],
    ["in-9:intros_a_week +5% in 7d ::  ", "names its basis"],
    ["in-9:intros_a_week +0 in 7d :: x", "more than 0"],
    ["in-9:intros_a_week +5% by 2026-11-01 :: x", "has passed"],
    ["in-9:intros_a_week +5% by 2026-11-16 :: x", "has passed"],
    ["in-9:intros_a_week +5% by 2027-02-30 :: x", "is not a date"],
    ["in-9:intros_a_week 5% in 7d :: x", "A prediction reads"],
    ["in-9:intros_a_week +5%", "names its basis"],
    ["", "A prediction reads"],
  ])("refuses %p", (line, words) => {
    const r = parsePrediction(line, NOW);
    expect("error" in r && r.error).toContain(words);
  });
});

test("a date reads once that whole day is over, and today still counts", () => {
  const r = parsePrediction("in-9:k +5% by 2026-11-17 :: x", NOW);
  expect("prediction" in r && new Date(r.prediction.read_at!).toISOString()).toBe("2026-11-18T00:00:00.000Z");
});

describe("when it is read", () => {
  const ship = NOW;
  test("a date after ship is the read", () => expect(predictionReadAt({ read_at: ship + 20 * DAY }, ship)).toBe(ship + 20 * DAY));
  test("days count from ship", () => expect(predictionReadAt({ read_days: 14 }, ship)).toBe(ship + 14 * DAY));
  test("a date that falls before ship waits the least window after it", () => expect(predictionReadAt({ read_at: ship - 5 * DAY }, ship)).toBe(ship + 3 * DAY));
  test("windows are equal on both sides of ship, capped at four weeks", () => {
    expect(predictionWindows(ship, ship + 10 * DAY)).toEqual({ before: [ship - 10 * DAY, ship], after: [ship, ship + 10 * DAY] });
    const long = predictionWindows(ship, ship + 60 * DAY);
    expect(long.after).toEqual([ship + 32 * DAY, ship + 60 * DAY]);
    expect(long.before).toEqual([ship - 28 * DAY, ship]);
  });
});

const pts = (values: number[], from = 0) => values.map((value, i) => ({ at: from + i * DAY, value }));

describe("judgePrediction", () => {
  const up = { direction: "up" as const, size: 5, relative: true };
  test("a move past the noise band in the predicted direction held", () => {
    const r = judgePrediction(up, { before: pts([30, 31, 29, 30]), after: pts([40, 41, 39, 40]) });
    expect(r.verdict).toBe("held");
    expect(r.delta).toBe(10);
    expect(r.within_noise).toBe(false);
  });
  test("the same move the other way is opposite", () => {
    expect(judgePrediction({ ...up, direction: "down" }, { before: pts([30, 31, 29, 30]), after: pts([40, 41, 39, 40]) }).verdict).toBe("opposite");
  });
  test("a move inside the spread before ship is not shown", () => {
    const r = judgePrediction(up, { before: pts([20, 40, 25, 35]), after: pts([33, 31]) });
    expect(r.verdict).toBe("not_shown");
    expect(r.within_noise).toBe(true);
  });
  test("a stated Poisson model sets the band: 37 to 43 a week is inside it", () => {
    const r = judgePrediction(up, { before: pts([37, 37]), after: pts([43, 43]), noise: "poisson" });
    expect(r.band).toBeCloseTo(1.96 * Math.sqrt(37 + 43), 6);
    expect(r.verdict).toBe("not_shown");
  });
  test("with no model and two points, half the predicted move is the bar", () => {
    expect(judgePrediction(up, { before: pts([100, 100]), after: pts([103]) }).verdict).toBe("held");
    const r = judgePrediction(up, { before: pts([100, 100]), after: pts([102]) });
    expect(r.verdict).toBe("not_shown");
    expect(r.within_noise).toBeNull();
  });
  test("a real move smaller than half the prediction is not shown: +50% predicted, +1% seen", () => {
    const r = judgePrediction({ direction: "up", size: 50, relative: true }, { before: pts([100, 100, 100]), after: pts([101, 101, 101]), noise: "aa:0.1" });
    expect(r).toMatchObject({ verdict: "not_shown", within_noise: false });
  });
  test("a flat window before ship gives no band, so the half-size bar decides", () => {
    const r = judgePrediction({ direction: "up", size: 10, relative: false }, { before: pts([30, 30, 30]), after: pts([30.01]) });
    expect(r).toMatchObject({ band: null, within_noise: null, verdict: "not_shown" });
  });
  test("a percent move against a value of 0 is unreadable", () => {
    expect(judgePrediction(up, { before: pts([0, 0]), after: pts([0.01]) })).toMatchObject({ verdict: "unreadable", note: expect.stringContaining("value of 0") });
  });
  test("a window of several independent readings narrows the band by their square root", () => {
    const wobble = (base: number) => Array.from({ length: 28 }, (_, i) => base + (i % 2 ? 5 : -5));
    const one = judgePrediction({ direction: "up", size: 3, relative: false }, { before: pts(wobble(30)), after: pts(wobble(33)) });
    const daily = judgePrediction({ direction: "up", size: 3, relative: false }, { before: pts(wobble(30)), after: pts(wobble(33)), independent: 28 });
    expect(daily.band!).toBeCloseTo(one.band! / Math.sqrt(28), 6);
    expect(one.verdict).toBe("not_shown");
    expect(daily.verdict).toBe("held");
  });
  test("one reading counts over the metric's own period: a week for intros a week, a day for a daily count", () => {
    expect(readingPeriodMs({ name: "Intros a week" }, "/week")).toBe(7 * DAY);
    expect(readingPeriodMs({ name: "Cold emails a day", window: "14d" }, null)).toBe(DAY);
    expect(readingPeriodMs({ name: "Dollars per intro" }, "$")).toBe(7 * DAY);
  });
  test("readings weigh by how many values each holds", () => {
    const r = judgePrediction(up, { before: [{ at: 0, value: 10, n: 3 }, { at: 1, value: 20, n: 1 }], after: pts([20]) });
    expect(r.value_before).toBe(12.5);
  });
  test("no reading on either side is unreadable", () => {
    expect(judgePrediction(up, { before: [], after: pts([1]) })).toMatchObject({ verdict: "unreadable", note: "The metric has no reading before ship" });
    expect(judgePrediction(up, { before: pts([1]), after: [] })).toMatchObject({ verdict: "unreadable", note: "The metric has no reading after ship" });
  });
});

describe("words", () => {
  const read = (verdict: RealisedEffect["verdict"]): RealisedEffect => ({ verdict, value_before: 37, value_after: 43, delta: 6, within_noise: false, band: 4, shipped_at: 0, from: 0, to: 0, read_at: 0, note: "" });
  test("a reading in the metric's unit", () => {
    expect(realisedLine({ direction: "up", size: 5, relative: true }, read("held"), "/week")).toBe("held: 37/week → 43/week (+6; predicted +5%), outside ±4");
  });
  test("an absolute move on a dollar metric reads in dollars", () => {
    const r = { ...read("not_shown"), value_before: 469, value_after: 452, delta: -17, within_noise: true, band: 38 };
    expect(realisedLine({ direction: "down", size: 40, relative: false }, r, "$")).toBe("not shown: $469 → $452 (-$17; predicted -$40), inside ±38");
  });
  test("an unreadable one says why", () => {
    expect(realisedLine({ direction: "up", size: 5, relative: true }, { ...read("unreadable"), value_before: null, note: "No reading" }, null)).toBe("unreadable: No reading");
  });
  test("the hit rate counts read predictions; open and unreadable are named apart", () => {
    const rows = [read("held"), read("held"), read("opposite"), read("not_shown"), read("unreadable"), null].map((realised) => ({ predicted: {}, realised }));
    const t = predictionTally([...rows, { predicted: undefined, realised: null }]);
    expect(t).toEqual({ open: 1, held: 2, not_shown: 1, opposite: 1, unreadable: 1 });
    expect(hitRateWords(t)).toBe("2 of 4 predictions held (1 opposite), 1 open, 1 unreadable");
    expect(hitRateWords(predictionTally([]))).toBe("");
  });
});

describe("targets", () => {
  test("a series and an env are places an effect is read; a metric or series without a time reads after four weeks, an env at its next attempt", () => {
    expect(targetKind("in-9:intros_a_week")).toBe("metric");
    expect(targetKind("mw-17")).toBe("series");
    expect(targetKind("env:union/second-side-replay")).toBe("env");
    const series = parsePrediction("mw-17 +3pt :: replay", NOW);
    expect("prediction" in series && series.prediction).toMatchObject({ goal_ref: "mw-17", size: 3, relative: false, read_days: 28 });
    const env = parsePrediction("env:union/second-side-replay +0.02 :: held-out run", NOW);
    expect("prediction" in env && env.prediction).toMatchObject({ goal_ref: "env:union/second-side-replay", size: 0.02, relative: false });
    expect("prediction" in env && env.prediction.read_days).toBeUndefined();
    expect("prediction" in env && predictionText(env.prediction)).toBe("env:union/second-side-replay +0.02 :: held-out run");
  });
});

describe("readability", () => {
  test("37 intros a week over a four-week read on each side detects about ±35%, so +3% is unreadable and +80% is readable", () => {
    const mde = readMde({ mean: 37, mde: null }, "poisson", 7 * DAY, 28 * DAY)!;
    expect(mde).toBeGreaterThan(0.3);
    expect(mde).toBeLessThan(0.4);
    // Overdispersed counts see less.
    expect(readMde({ mean: 37, mde: null }, "poisson:10", 7 * DAY, 28 * DAY)!).toBeGreaterThan(1);
    expect(readability({ goal_ref: "in-9:intros_a_week", size: 3, relative: true }, mde, 37)).toEqual({ readable: false, mde });
    expect(readability({ goal_ref: "in-9:intros_a_week", size: 80, relative: true }, mde, 37)).toEqual({ readable: true, mde });
  });
  test("a longer read sees a smaller change; a binomial with its n in a series rescales the band's own figure", () => {
    expect(readMde({ mean: 37, mde: null }, "poisson", 7 * DAY, 56 * DAY)!).toBeLessThan(readMde({ mean: 37, mde: null }, "poisson", 7 * DAY, 28 * DAY)!);
    // The band's four-week figure is a 50/50 over 4 weeks; a read of 2 weeks a side carries the same.
    expect(readMde({ mean: 15, mde: 0.4 }, "binomial:mw-15", 7 * DAY, 14 * DAY)).toBeCloseTo(0.4, 6);
    expect(readMde({ mean: 15, mde: 0.4 }, "binomial:mw-15", 7 * DAY, 56 * DAY)).toBeCloseTo(0.2, 6);
  });
  test("no noise model, no number, and no readability claimed", () => {
    expect(readMde({ mean: 37, mde: null }, undefined, 7 * DAY, 28 * DAY)).toBeNull();
    expect(readability({ goal_ref: "mw-17", size: 3, relative: false }, null, 15)).toEqual({});
  });
  test("an absolute move on a metric is taken as a share of its level", () => {
    expect(readability({ goal_ref: "mw-17", size: 3, relative: false }, 0.12, 15)).toEqual({ readable: true, mde: 0.12 });
    expect(readability({ goal_ref: "mw-17", size: 1, relative: false }, 0.12, 15)).toEqual({ readable: false, mde: 0.12 });
  });
  test("an env detects from its paired interval, else twice its A/A spread", () => {
    const paired = envMde({ paired_ci95: [-0.02, 0.02] })!;
    expect(paired).toBeCloseTo((0.02 / 1.96) * (1.959963984540054 + 0.8416212335729143), 6);
    expect(envMde({ noise: { aa_sd: 0.01 } })!).toBeCloseTo(0.01 * Math.SQRT2 * (1.959963984540054 + 0.8416212335729143), 6);
    expect(envMde({})).toBeNull();
    expect(readability({ goal_ref: "env:union/x", size: 0.05, relative: false }, paired, 0.7)).toEqual({ readable: true, mde: paired });
  });
  test("the words say where and how much it can see", () => {
    expect(unreadableWords({ goal_ref: "in-9:intros_a_week", readable: false, mde: 1.64 })).toBe("unreadable at this metric (detects ±164%)");
    expect(unreadableWords({ goal_ref: "env:union/x", readable: false, mde: 0.031 })).toBe("unreadable at this environment (detects ±0.031)");
    expect(unreadableWords({ goal_ref: "mw-17", readable: true, mde: 0.1 })).toBeNull();
    expect(detectsWords("series", 0.12)).toBe("±12%");
    const p = { goal_ref: "in-9:intros_a_week", direction: "up" as const, size: 3, relative: true, read_days: 28, basis: "b", set_at: NOW, readable: false, mde: 1.64 };
    expect(predictionWords(p, null, null).said).toBe("in-9:intros_a_week +3% in 28d after ship, unreadable at this metric (detects ±164%)");
  });
});

describe("judgeEnvPrediction", () => {
  const up = { direction: "up" as const, size: 0.02, relative: false };
  test("a paired gain past its interval and half the predicted size held", () => {
    expect(judgeEnvPrediction(up, { before: 0.70, after: 0.73, delta: 0.03, half: 0.01, note: "" })).toMatchObject({ verdict: "held", within_noise: false, band: 0.01 });
  });
  test("inside the interval is not shown; a drop past it is opposite", () => {
    expect(judgeEnvPrediction(up, { before: 0.70, after: 0.705, delta: 0.005, half: 0.01, note: "" }).verdict).toBe("not_shown");
    expect(judgeEnvPrediction(up, { before: 0.70, after: 0.68, delta: -0.02, half: 0.01, note: "" }).verdict).toBe("opposite");
  });
});

test("a reading too small for its place shows what it did and why it counts for nothing", () => {
  const p = { goal_ref: "in-9:intros_a_week", direction: "up" as const, size: 3, relative: true, readable: false, mde: 0.56 };
  const r: RealisedEffect = { verdict: "unreadable", value_before: 28, value_after: 29.1, delta: 1.1, within_noise: true, band: 4.2, shipped_at: 0, from: 0, to: 0, read_at: 0, note: "x" };
  expect(realisedLine(p, r, "/week")).toBe("unreadable: 28/week → 29.1/week (+1.1; predicted +3%), inside ±4.2; unreadable at this metric (detects ±56%)");
  expect(realisedLine(p, { ...r, value_before: null }, "/week")).toBe("unreadable: x");
});
