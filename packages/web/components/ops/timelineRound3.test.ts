import { describe, expect, test } from "bun:test";
import { hourlyVolumeBins, parseTimelineQuery, stackKeys, streamGroups } from "./timelineModel";
import { laneGutter, NO_SOURCE_LANE, spanText } from "./timelineTabModel";
import type { OpsGroup } from "./opsTypes";

const H = 3600_000;
const T = Date.UTC(2026, 10, 3, 0);
const g = (o: Partial<OpsGroup> & { kind: OpsGroup["kind"]; n: number; hour?: number }): OpsGroup =>
  ({ _id: `g${o.kind}${o.n}`, short_id: `eg-${o.n}`, source_id: o.source_id ?? "s1", level: o.level, kind: o.kind, buckets: [{ hour: o.hour ?? T + 2 * H, count: o.n }] }) as unknown as OpsGroup;

describe("the chart's hourly bars and the list's kept-of-N read one group filter", () => {
  const groups = [g({ kind: "error", level: "error", n: 40 }), g({ kind: "metric", n: 68 }), g({ kind: "error", level: "warning", n: 7, source_id: "s2" })];
  const range = { from: T, to: T + 10 * H };
  const sum = (f: string) => hourlyVolumeBins(groups, null, parseTimelineQuery(f), range).reduce((n, b) => n + b.total, 0);

  test("metric readings stay out of both until the Kind facet names them", () => {
    expect(sum("")).toBe(47);
    expect(stackKeys(hourlyVolumeBins(groups, null, parseTimelineQuery(""), range))).not.toContain("metric");
    expect(sum("kind:metric")).toBe(68);
    expect(streamGroups(groups, new Set(["s2"]), parseTimelineQuery("")).map((x) => x.short_id)).toEqual(["eg-7"]);
  });

  test("one edge rule: a bucket whose middle falls past the window's end counts in neither", () => {
    const late = [g({ kind: "error", n: 5, hour: T + 10 * H - H / 4 })];
    expect(hourlyVolumeBins(late, null, parseTimelineQuery(""), range).reduce((n, b) => n + b.total, 0)).toBe(0);
  });
});

describe("a window's length", () => {
  test("a preset reads as its key, a held window to the hour", () => {
    expect(spanText(3 * 24 * H, "72h")).toBe("72h");
    expect(spanText(2 * 24 * H + 13 * H + 29 * 60_000)).toBe("2d 13h");
    expect(spanText(5 * H + 20 * 60_000)).toBe("5h 20m");
    expect(spanText(45 * 60_000)).toBe("45m");
    expect(spanText(30 * 24 * H)).toBe("30d");
  });
});

describe("the lanes' name column", () => {
  test("fits the longest name and count, 140 to 190px", () => {
    expect(laneGutter([])).toBe(140);
    expect(laneGutter(["ci"])).toBe(140);
    const wide = laneGutter([...Array(481).fill("union-errors"), ...Array(175).fill("union-posthog")]);
    expect(wide).toBeGreaterThan(140);
    expect(wide).toBeLessThanOrEqual(190);
    expect(laneGutter(["a-very-long-source-name-for-a-lane"])).toBe(190);
    expect(NO_SOURCE_LANE).toBe("no source");
  });
});
