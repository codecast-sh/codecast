import { describe, expect, test } from "bun:test";
import { hoverAt, plotModel, splitAtLine, type PlotInput } from "./metricPlotModel";

const H = 3_600_000;
const T0 = 1_790_000_000_000;
const pts = (vals: (number | null)[]) => vals.flatMap((v, i) => (v === null ? [] : [{ at: T0 + i * H, value: v }]));
const base = (over: Partial<PlotInput> = {}): PlotInput => ({
  points: pts([10, 12, 50, 55, 20, 18]), win: { from: T0, to: T0 + 5 * H }, interval_ms: H, direction: "above", threshold: 40,
  full: true, loading: false, ...over,
});

describe("splitAtLine", () => {
  test("splits a run exactly where it crosses the line, both sides sharing the crossing", () => {
    const { safe, past } = splitAtLine([pts([10, 50, 10])], 30, "above");
    expect(past).toHaveLength(1);
    expect(safe).toHaveLength(2);
    expect(past[0][0]).toEqual({ at: T0 + H * 0.5, value: 30 });
    expect(past[0].at(-1)).toEqual({ at: T0 + H * 1.5, value: 30 });
    expect(safe[0].at(-1)).toEqual(past[0][0]);
  });
  test("below-line watches put the low stretch past the line", () => {
    const { past } = splitAtLine([pts([10, 2, 10])], 5, "below");
    expect(past[0].map(p => p.value)).toEqual([5, 2, 5]);
  });
  test("no line: everything is on the safe side", () => {
    const segs = [pts([1, 2, 3])];
    expect(splitAtLine(segs, undefined, "above")).toEqual({ safe: segs, past: [] });
  });
});

describe("plotModel", () => {
  test("bands the stretch past the line and fits the line in the y range", () => {
    const m = plotModel(base());
    expect(m.bands).toHaveLength(1);
    expect(m.bands[0].from).toBeLessThanOrEqual(T0 + 2 * H);
    expect(m.y[0]).toBeLessThanOrEqual(10);
    expect(m.y[1]).toBeGreaterThanOrEqual(55);
    expect(m.alerting).toBe(false);
  });
  test("a hole breaks the line into two runs and is listed", () => {
    const points = [...pts([10, 11, 12]), ...pts([null, null, null, null, null, null, null, null, null, null, 13, 14, 15])];
    const m = plotModel(base({ points, win: { from: T0, to: T0 + 12 * H }, threshold: undefined }));
    expect(m.holes.length).toBe(1);
    expect(m.segs.length).toBe(2);
  });
  test("loading draws nothing that could be read as the answer", () => {
    const m = plotModel(base({ loading: true }));
    expect(m.segs).toEqual([]);
    expect(m.last).toBeNull();
  });
  test("the tip reads the value and the band it falls in", () => {
    const input = base();
    const m = plotModel(input);
    const h = hoverAt(m, input, T0 + 3 * H);
    expect(h.pt?.value).toBe(55);
    expect(h.band).not.toBeNull();
  });
});
