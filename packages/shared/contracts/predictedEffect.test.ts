import { describe, expect, test } from "bun:test";
import { hitRateWords, judgePrediction, parsePrediction, predictionReadAt, predictionTally, predictionText, predictionWindows, realisedLine, type RealisedEffect } from "./predictedEffect";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-17T12:00:00Z");

describe("parsePrediction", () => {
  test("a relative move by a date, with its basis", () => {
    const r = parsePrediction("in-9:intros_a_week +5% by 2026-12-15 :: replay env +6 on L2", NOW);
    expect(r).toEqual({ prediction: { goal_ref: "in-9:intros_a_week", direction: "up", size: 5, relative: true, read_at: Date.parse("2026-12-15T00:00:00Z"), basis: "replay env +6 on L2", set_at: NOW } });
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
    ["intros_a_week +5% in 7d :: x", "not a goal metric ref"],
    ["in-9:intros_a_week +5% in 7d", "names its basis"],
    ["in-9:intros_a_week +5% in 7d ::  ", "names its basis"],
    ["in-9:intros_a_week +0 in 7d :: x", "more than 0"],
    ["in-9:intros_a_week +5% by 2026-11-01 :: x", "has passed"],
    ["in-9:intros_a_week 5% in 7d :: x", "A prediction reads"],
    ["in-9:intros_a_week +5%", "A prediction reads"],
    ["", "A prediction reads"],
  ])("refuses %p", (line, words) => {
    const r = parsePrediction(line, NOW);
    expect("error" in r && r.error).toContain(words);
  });
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
