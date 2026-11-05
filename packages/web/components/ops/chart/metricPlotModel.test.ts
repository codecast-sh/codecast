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

describe("plotModel, ported from the SVG chart's rules", () => {
  const P = pts([10, 15, 25, 30, 12, 14]);
  const W = { from: T0, to: T0 + 6 * H };
  const input = (over: Partial<PlotInput> = {}): PlotInput => ({ points: P, win: W, interval_ms: H, direction: "above", threshold: 20, full: true, loading: false, ...over });

  test("time past the line is one band from the crossing to the recovery, and the strip agrees", () => {
    const m = plotModel(input());
    expect(m.bands).toEqual([{ from: T0 + 2 * H, to: T0 + 4 * H }]);
    expect(m.strip).toEqual(m.bands);
  });

  test("a daily backfill joins at its own cadence with a dot per value, broken where the hourly polls begin; the tip names the cadence", () => {
    const D = 24 * H;
    const daily = [5, 4, 3, 2].map((d, i) => ({ at: T0 - d * D, value: 10 + i }));
    const hourly = [0, 1, 2, 3].map(h => ({ at: T0 + h * H, value: 12 }));
    const inp = input({ points: [...daily, ...hourly], win: { from: T0 - 5 * D, to: T0 + 4 * H }, threshold: undefined });
    const m = plotModel(inp);
    expect(m.segs).toHaveLength(2);
    expect(m.segs[0]).toHaveLength(4);
    expect(m.ticks).toHaveLength(0);
    expect(m.marked).toHaveLength(4);
    expect(hoverAt(m, inp, T0 - 2 * D).apart).toBe(D);
  });

  test("a daily series and its previous period are lines through their days; a lone value is a tick", () => {
    const D = 24 * H;
    const days = [135, 0, 15, 140].map((value, i) => ({ at: T0 + i * D, value }));
    const prior = [20, 30, 25, 10].map((value, i) => ({ at: T0 + i * D, value }));
    const m = plotModel(input({ points: days, compare: prior, interval_ms: D, win: { from: T0 - D / 2, to: T0 + 3.5 * D }, threshold: 100 }));
    expect(m.segs.map(s => s.length)).toEqual([4]);
    expect(m.prevSegs.map(s => s.length)).toEqual([4]);
    const lone = plotModel(input({ points: [{ at: T0 + 3 * H, value: 12 }], threshold: undefined }));
    expect(lone.segs).toHaveLength(0);
    expect(lone.ticks).toHaveLength(1);
  });

  test("a value held from before the window only carries the line to the edge, and the newest dot is inside the window", () => {
    const before = [{ at: T0 - 2 * H, value: 40 }, ...P, { at: T0 + 8 * H, value: 5 }];
    for (const full of [false, true]) {
      const m = plotModel(input({ points: before, full }));
      for (const x of m.segs.flat()) { expect(x.at).toBeGreaterThanOrEqual(W.from); expect(x.at).toBeLessThanOrEqual(W.to); }
      expect(m.last!.at).toBeLessThanOrEqual(W.to);
      // The value outside the window never stretches the y range.
      expect(m.y[1]).toBeLessThan(40);
    }
  });

  test("before the first value held, the announced episodes band the gap and the tip names their stretch", () => {
    const win = { from: T0 - 6 * H, to: T0 + 6 * H };
    const inp = input({ points: P.slice(4), win, gap: { from: win.from, to: T0 + 4 * H }, episodes: [{ from: T0 - 4 * H, to: T0 - 2 * H }] });
    const m = plotModel(inp);
    expect(m.bands).toHaveLength(1);
    expect(m.strip).toHaveLength(1);
    expect(hoverAt(m, inp, T0 - 3 * H).band).not.toBeNull();
  });

  test("a stretch with no values is a hole counting its missed polls, and no band runs across it", () => {
    const holed = [10, 25, 26].map((value, i) => ({ at: T0 + i * H, value })).concat([27, 28, 12].map((value, i) => ({ at: T0 + (32 + i) * H, value })));
    const inp = input({ points: holed, win: { from: T0, to: T0 + 36 * H }, poll_ms: H });
    const m = plotModel(inp);
    expect(m.holes).toHaveLength(1);
    expect(m.holes[0].missed).toBe(29);
    expect(m.bands).toHaveLength(2);
    for (const b of m.bands) expect(b.to <= T0 + 2 * H || b.from >= T0 + 32 * H).toBe(true);
    const h = hoverAt(m, inp, T0 + 17 * H);
    expect(h.pt).toBeNull();
    expect(h.hole).not.toBeNull();
  });

  test("a value read now sits past the series and is banded like any other", () => {
    const D = 24 * H;
    const daily = [5, 6, 7].map((value, i) => ({ at: T0 + i * D, value }));
    const live = { at: T0 + 2 * D + 10 * H, value: 30 };
    const m = plotModel(input({ points: daily, interval_ms: D, win: { from: T0, to: live.at }, live }));
    expect(m.live).toEqual(live);
    expect(m.last!.value).toBe(7);
    expect(m.bands.at(-1)!.to).toBe(live.at);
  });
});
