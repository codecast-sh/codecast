// The metric model, third workflow round 2: missing data judged the same at
// every window and fold, the All window past stray values, suggested lines
// counted with the value read now, and reads counted through folds.
import { describe, expect, test } from "bun:test";
import { dataHoles } from "./metricModel";
import { allWindow } from "./metricEditing";
import { lineSuggestions, wouldCross } from "./metricEvents";
import { readCount } from "./metricSeries";

const H = 3600_000;
const D = 24 * H;

describe("missing data", () => {
  test("an outage just after a lone value is a hole, judged by the polls around that value, not the daily values before it", () => {
    const daily = [0, 24, 48].map((h) => ({ at: h * H, value: 120 }));
    const pts = [...daily, { at: 51.5 * H, value: 56 }, ...[82, 83, 84, 85].map((h) => ({ at: h * H, value: 20 }))];
    expect(dataHoles(pts, H, H)).toEqual([{ from: 51.5 * H, to: 82 * H, missed: 30 }]);
  });
  test("three daily values running into hourly polls are no hole, however few the window holds", () => {
    const pts = [0, 24, 48, 71].map((h) => ({ at: h * H, value: 100 })).concat([72, 73, 74, 75].map((h) => ({ at: h * H, value: 0 })));
    expect(dataHoles(pts, H, H)).toEqual([]);
  });
  test("the same outage is a hole whether the polls are drawn one by one or folded into 2h buckets", () => {
    const raw = [...Array.from({ length: 48 }, (_, i) => i), ...Array.from({ length: 48 }, (_, i) => 78 + i)].map((h) => ({ at: h * H, value: 1 }));
    const folded = raw.filter((_, i) => i % 2 === 0).map((p) => ({ at: p.at + H / 2, value: 1 }));
    const a = dataHoles(raw, H, H);
    const b = dataHoles(folded, 2 * H, H);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(Math.abs(a[0].from - b[0].from)).toBeLessThanOrEqual(H);
  });
});

describe("All", () => {
  test("a stray value weeks before the rest does not set the start; it is named instead", () => {
    const now = 60 * D;
    const pts = [{ at: 0, value: 1 }, ...Array.from({ length: 74 }, (_, i) => ({ at: now - 74 * H + i * H, value: 2 }))];
    const r = allWindow({ heldFrom: 0, firstAnnounced: null, firstSeen: null, points: pts, now, step: H });
    expect(r.win.from).toBeGreaterThan(now - 4 * D);
    expect(r.stray).toEqual({ at: 0, count: 1 });
    expect(r.gap).toBeNull();
  });
  test("alert history reaching back past the stray value keeps it in the window", () => {
    const now = 60 * D;
    const pts = [{ at: 5 * D, value: 1 }, ...Array.from({ length: 10 }, (_, i) => ({ at: now - 10 * H + i * H, value: 2 }))];
    const r = allWindow({ heldFrom: 5 * D, firstAnnounced: 2 * D, firstSeen: null, points: pts, now, step: H });
    expect(r.win.from).toBe(2 * D);
    expect(r.stray).toBeNull();
  });
});

describe("the New watch sheet's counts", () => {
  test("a suggested line counts the value read now, as the Now row does", () => {
    const series = Array.from({ length: 20 }, (_, i) => ({ at: i * H, value: i === 10 ? 30 : 10 + (i % 3) }));
    const live = { at: 21 * H, value: 35 };
    const drawn = [...series, live];
    for (const s of lineSuggestions(series, "above", drawn)) expect(s.crossings).toBe(wouldCross(drawn, s.value, "above"));
  });
});

test("reads are counted through folded points", () => {
  expect(readCount([{ at: 0, value: 1, n: 9 } as never, { at: 1, value: 2 }])).toBe(10);
});
