// The source view's one volume measure, its pace against a usual day, the
// work an overview issue row carries, the chart's deploy labels and a
// failing call's fix facts.
import { describe, expect, test } from "bun:test";
import { callFixFacts } from "./appsModel";
import { issueWorkItem, paceLabel, paceVsUsual, rolling24, rollingLabel, shortShas, volumeBins } from "./sourceViewModel";
import { endAnchored, mergeFacing } from "./volumeChartLayout";
import type { OpsGroup } from "./opsTypes";

const NOW = Date.UTC(2026, 10, 3, 12, 30);
const H = 3_600_000;

describe("volume", () => {
  test("24h reads the hour series, the same count as the day series", () => {
    const hour = Math.floor(NOW / H) * H;
    const bins = volumeBins({ hours: [{ hour, events: 4 }, { hour: hour - 23 * H, events: 2 }, { hour: hour - 30 * H, events: 9 }] }, NOW, "24h")!;
    expect(bins).toHaveLength(24);
    expect(bins.at(-1)!.total).toBe(4);
    expect(bins[0].total).toBe(2);
    expect(bins.reduce((n, b) => n + b.total, 0)).toBe(6);
  });

  test("a source with no hour series yet has no counted 24h; past it reads days", () => {
    expect(volumeBins({}, NOW, "24h")).toBeNull();
    const week = volumeBins({ days: [{ day: "2026-11-02", events: 7, dropped: 0 }] }, NOW, "7d")!;
    expect(week).toHaveLength(7);
    expect(week.at(-2)!.total).toBe(7);
    expect(week[0].unknown).toBe(true);
  });

  test("today against usual is a pace, quiet in the first hours of the day", () => {
    // 12.5 hours in: 52 so far is a 100-a-day pace.
    expect(paceVsUsual(52, 100, NOW)).toBe(0);
    expect(paceVsUsual(78, 100, NOW)).toBe(50);
    expect(paceVsUsual(10, null, NOW)).toBeNull();
    expect(paceVsUsual(10, 100, Date.UTC(2026, 10, 3, 1))).toBeNull();
    expect(paceLabel(50)).toBe("+50% vs usual");
    expect(paceLabel(-38)).toBe("−38% vs usual");
    expect(paceLabel(3)).toBe("as usual");
  });
});

test("full commit hashes in a title read as seven characters", () => {
  expect(shortShas("Deploy e5e60f42d4318d7ef47c170be8c1b0b4b4889502 for Sam on main")).toBe("Deploy e5e60f4 for Sam on main");
  expect(shortShas("abc1234 stays")).toBe("abc1234 stays");
});

test("an overview issue row carries its task and session the way the home's rows do", () => {
  const g = { _id: "g1", source_id: "s1", short_id: "eg-1", status: "open", title: "x", count: 3, last_seen: NOW, regressed_at: NOW, signal_task_id: "t1", fix_conversation_id: undefined } as unknown as OpsGroup;
  const item = issueWorkItem(g, { short_id: "ct-1", status: "open", assignee: null });
  expect(item).toMatchObject({ kind: "issue", state: "regressed", taskId: "t1", sessionId: null, sourceId: "s1" });
});

describe("deploy labels", () => {
  test("a label near the right edge hangs left", () => {
    expect(endAnchored(0.95, 1000)).toBe(true);
    expect(endAnchored(0.5, 1000)).toBe(false);
  });

  test("two labels growing toward each other merge into one", () => {
    const merged = mergeFacing([{ x: 0.8, marks: [{ at: 1 }, { at: 2 }] }, { x: 0.95, marks: [{ at: 3 }] }], 1000);
    expect(merged).toEqual([{ x: 0.95, marks: [{ at: 1 }, { at: 2 }, { at: 3 }] }]);
    expect(mergeFacing([{ x: 0.2, marks: [{ at: 1 }] }, { x: 0.95, marks: [{ at: 3 }] }], 1000)).toHaveLength(2);
  });
});

test("a failing call's fix names what failed, how often and the newest error", () => {
  const f = callFixFacts({ name: "union", short_id: "src-9" }, { kind: "read", name: "metrics.read", count: 95, oldest: NOW - H, latest: NOW, reasons: [{ reason: "Timed out", count: 94, error: "no answer in 15s" }, { reason: "HTTP 502", count: 1, error: null }] });
  expect(f.ref).toBe("src-9 metrics.read");
  expect(f.title).toContain("reader metrics.read");
  expect(f.failure).toContain("95 of the last 95 calls failed");
  expect(f.failure).toContain("Newest error: no answer in 15s");
});

describe("the last 24 hours against the 24 before", () => {
  const T = Date.UTC(2026, 10, 4, 5, 10);
  const H = 3600_000;
  const top = Math.floor(T / H) * H;
  const hours = [{ hour: top, events: 4 }, { hour: top - 3 * H, events: 343 }, { hour: top - 30 * H, events: 100 }, { hour: top - 47 * H, events: 50 }];
  test("reads the same hourly series the 24h chart draws, not the UTC day counter", () => {
    const r = rolling24({ hours, days: [{ day: "2026-10-01", events: 1, dropped: 0 }, { day: "2026-11-04", events: 2, dropped: 0 }] }, T)!;
    expect(r.last).toBe(347);
    expect(r.prev).toBe(150);
    expect(r.pct).toBe(131);
    expect(volumeBins({ hours, days: [] }, T, "24h")!.reduce((n, b) => n + b.total, 0)).toBe(r.last);
    expect(rollingLabel(r)).toBe("+131% vs prior 24h");
  });

  test("no comparison until the counter covered the whole earlier window", () => {
    const r = rolling24({ hours, days: [{ day: "2026-11-03", events: 5, dropped: 0 }] }, T)!;
    expect([r.prev, r.pct, r.vs]).toEqual([null, null, null]);
    expect(rollingLabel(r)).toBeNull();
    expect(rolling24({ days: [] }, T)).toBeNull();
  });
});
