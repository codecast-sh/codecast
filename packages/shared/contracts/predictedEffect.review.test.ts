import { describe, expect, test } from "bun:test";
import { judgePrediction, parsePrediction } from "./predictedEffect";

const DAY = 86_400_000;
const pts = (vals: number[], start = 0) => vals.map((value, i) => ({ at: start + i * DAY, value }));
const up5pct = { direction: "up" as const, size: 5, relative: true };

describe("review probes: judge", () => {
  test("relative % on a zero baseline: any tiny move 'holds'", () => {
    const r = judgePrediction(up5pct, { before: pts([0, 0]), after: pts([0.001, 0.001]) });
    expect(r.verdict).toBe("held");
  });
  test("band uses per-point spread, not spread of the window mean: a 2.2-SE shift over 28 days reads not_shown", () => {
    const wobble = (base: number) => Array.from({ length: 28 }, (_, i) => base + (i % 2 ? 5 : -5));
    const r = judgePrediction({ direction: "up", size: 3, relative: false }, { before: pts(wobble(30)), after: pts(wobble(33)) });
    expect(r.verdict).toBe("not_shown");
    expect(r.band!).toBeGreaterThan(13);
  });
  test("a stated predicted size never enters the verdict when a band exists: +50% predicted, +1% seen = held", () => {
    const r = judgePrediction({ direction: "up", size: 50, relative: true }, { before: pts([100, 100, 100]), after: pts([101, 101, 101]), noise: "aa:0.1" });
    expect(r.verdict).toBe("held");
  });
  test("flat before window (sd 0) and a short after window: band 0, any move is outside noise", () => {
    const r = judgePrediction({ direction: "up", size: 10, relative: false }, { before: pts([30, 30, 30]), after: pts([30.01]) });
    expect(r).toMatchObject({ band: 0, within_noise: false, verdict: "held" });
  });
});

describe("review probes: parse", () => {
  test("impossible calendar dates", () => {
    const r = parsePrediction("in-9:k +5% by 2027-02-30 :: x", Date.parse("2026-11-17T00:00:00Z"));
    expect("prediction" in r ? new Date(r.prediction.read_at!).toISOString() : r.error).toBe("2027-03-02T00:00:00.000Z");
  });
  test("by-date reads at 00:00 UTC, i.e. the start of the stated day", () => {
    const r = parsePrediction("in-9:k +5% by 2026-12-15 :: x", Date.parse("2026-11-17T00:00:00Z"));
    expect("prediction" in r && new Date(r.prediction.read_at!).toISOString()).toBe("2026-12-15T00:00:00.000Z");
  });
  test("today is refused as a read date", () => {
    const r = parsePrediction("in-9:k +5% by 2026-11-17 :: x", Date.parse("2026-11-17T09:00:00Z"));
    expect("error" in r).toBe(true);
  });
});
