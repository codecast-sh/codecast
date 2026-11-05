import { describe, expect, test } from "bun:test";
import type { OpsEvent, OpsGroup } from "./opsTypes";
import {
  healthStrip,
  lifeMarks,
  yTicks,
  layoutChart,
  chartRangeFor,
  dailySeries,
  thinMarks,
} from "./issueChart";

const HOUR = 3600_000;
const DAY_MS = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 3, 12, 30);
const THIS_HOUR = Date.UTC(2026, 10, 3, 12);

let n = 0;
const g = (over: Partial<OpsGroup> = {}): OpsGroup => ({
  _id: `g${++n}`,
  workspace: "team:t",
  source_id: "s1",
  short_id: `eg-${n}`,
  kind: "error",
  fingerprint: "fp",
  title: "TypeError: x is undefined",
  status: "open",
  first_seen: NOW - 48 * HOUR,
  last_seen: NOW - HOUR,
  count: 10,
  buckets: [],
  updated_at: NOW,
  ...over,
});

describe("the occurrence chart", () => {
  test("places bars, ticks and the group's own marks and its source's deploys", () => {
    const row = g({ buckets: [{ hour: THIS_HOUR, count: 3 }] });
    const events: OpsEvent[] = [
      { _id: "1", workspace: "team:t", source: "sdk", kind: "deploy", title: "", source_id: "s1", data: { release: "v2" }, created_at: NOW - 6 * HOUR },
      { _id: "2", workspace: "team:t", source: "sdk", kind: "deploy", title: "", source_id: "other", created_at: NOW - 5 * HOUR },
      { _id: "3", workspace: "team:t", source: "sdk", kind: "error_regressed", title: "", group_id: row._id, data: { transition: "regressed" }, created_at: NOW - 2 * HOUR },
    ];
    const l = layoutChart(row, events, NOW, 24);
    expect(l.bars).toHaveLength(24);
    expect(l.bars[23]).toEqual({ at: THIS_HOUR, count: 3 });
    expect(l.max).toBe(3);
    // The deploy before the regression is the one it came back in: a full line.
    expect(l.marks.map((m) => m.tone)).toEqual(["release", "regressed"]);
    expect(l.deployTicks).toEqual([]);
    expect(l.lastDeploy).toBe(NOW - 6 * HOUR);
    expect(l.ticks.every((t) => t.x >= 0 && t.x <= 1)).toBe(true);
  });
});

describe("the y axis", () => {
  test("whole numbers, each once", () => {
    expect(yTicks(1).ticks.map((t) => t.value)).toEqual([1, 0]);
    expect(yTicks(0).ticks.map((t) => t.value)).toEqual([1, 0]);
    expect(yTicks(2).ticks.map((t) => t.value)).toEqual([2, 1, 0]);
    expect(yTicks(3).ticks.map((t) => t.value)).toEqual([3, 0]);
    expect(yTicks(7)).toEqual({ top: 10, ticks: [{ value: 10, y: 0 }, { value: 5, y: 0.5 }, { value: 0, y: 1 }] });
    expect(yTicks(130).top).toBe(200);
  });
});

describe("a check's state over time", () => {
  const ev = (row: OpsGroup, transition: string, at: number): OpsEvent => ({ _id: `${transition}${at}`, workspace: "team:t", source: "github", kind: transition, title: "", group_id: row._id, data: { transition: transition as any }, created_at: at });
  test("spans from flips, the current reading at the end, nothing before first seen", () => {
    const row = g({ kind: "check", first_seen: NOW - 20 * HOUR, meta: { ok: false } });
    const s = healthStrip(row, [ev(row, "check_failed", NOW - 20 * HOUR), ev(row, "check_recovered", NOW - 10 * HOUR), ev(row, "check_failed", NOW - 4 * HOUR)], NOW, 24);
    expect(s.spans.map((x) => x.state)).toEqual(["none", "failing", "passing", "failing"]);
    expect(s.failingSince).toBe(NOW - 4 * HOUR);
    expect(s.lastPass).toBe(NOW - 10 * HOUR);
    expect(s.failures).toBe(2);
    expect(Math.round(s.failingShare * 100)).toBe(70);
  });
  test("with no flips read, a failing check has failed since it was first seen", () => {
    const row = g({ kind: "check", first_seen: NOW - 30 * HOUR, meta: { ok: false } });
    const s = healthStrip(row, [], NOW, 24);
    expect(s.spans).toEqual([{ from: NOW - 24 * HOUR, to: NOW, state: "failing" }]);
    expect(s.failingSince).toBe(row.first_seen);
    expect(s.lastPass).toBeNull();
  });
  test("a passing check reads passing to now", () => {
    const row = g({ kind: "check", first_seen: NOW - 30 * HOUR, meta: { ok: true } });
    const s = healthStrip(row, [ev(row, "check_recovered", NOW - 2 * HOUR)], NOW, 24);
    expect(s.spans.map((x) => x.state)).toEqual(["failing", "passing"]);
    expect(s.failingSince).toBeNull();
  });
});

describe("an issue's life", () => {
  test("starts at first seen in its release and carries its flips and deploys", () => {
    const row = g({ first_seen: NOW - 10 * 24 * HOUR, first_release: "v1" });
    const events: OpsEvent[] = [
      { _id: "d", workspace: "team:t", source: "sdk", kind: "deploy", title: "", source_id: "s1", data: { release: "v2" }, created_at: NOW - 5 * 24 * HOUR },
      { _id: "r", workspace: "team:t", source: "sdk", kind: "error_resolved", title: "", group_id: row._id, data: { transition: "resolved" }, created_at: NOW - 4 * 24 * HOUR },
    ];
    const life = lifeMarks(row, events, NOW);
    expect(life.clipped).toBe(false);
    expect(life.marks.map((m) => m.label)).toEqual(["first seen in v1", "v2", "resolved"]);
    expect(life.marks[0].x).toBe(0);
    expect(lifeMarks(g({ first_seen: NOW - 200 * 24 * HOUR }), [], NOW).clipped).toBe(true);
  });
});

describe("the chart over days", () => {
  test("opens on the narrowest window holding the last occurrence", () => {
    expect(chartRangeFor(g({ last_seen: NOW - HOUR }), NOW)).toBe("24h");
    expect(chartRangeFor(g({ last_seen: NOW - 5 * DAY_MS }), NOW)).toBe("7d");
    expect(chartRangeFor(g({ last_seen: NOW - 20 * DAY_MS }), NOW)).toBe("30d");
    expect(chartRangeFor(g({ last_seen: NOW - 200 * DAY_MS }), NOW)).toBe("90d");
  });
  test("daily bars take the days and the hours, and days before the counts reach back are unknown", () => {
    const today = Date.UTC(2026, 10, 3);
    // A stored day older than the hourly window: the local day its middle falls in takes it.
    const row = g({ first_seen: NOW - 30 * DAY_MS, buckets: [{ hour: THIS_HOUR, count: 2 }], days: [{ day: today - 5 * DAY_MS, count: 5 }] });
    const bars = dailySeries(row, NOW, 7);
    expect(bars.map((b) => b.count)).toEqual([0, 5, 0, 0, 0, 0, 2]);
    expect(bars.map((b) => !!b.unknown)).toEqual([true, false, false, false, false, false, false]);
    const l = layoutChart(row, [], NOW, 7 * 24, { at: today - DAY_MS, label: "fix 9f2c1a0" });
    expect(l.bars).toHaveLength(7);
    expect(l.total).toBe(7);
    expect(l.marks.map((m) => m.tone)).toEqual(["fix"]);
  });
  test("marks too close to read both keep one label, a transition over a deploy", () => {
    const thinned = thinMarks([
      { x: 0.5, at: 1, label: "46fd25fd7", tone: "release" },
      { x: 0.52, at: 2, label: "238fc50", tone: "release" },
      { x: 0.55, at: 3, label: "regressed", tone: "regressed" },
      { x: 0.9, at: 4, label: "v3", tone: "release" },
    ]);
    expect(thinned.map((m) => m.label)).toEqual(["", "", "regressed", "v3"]);
  });
});
