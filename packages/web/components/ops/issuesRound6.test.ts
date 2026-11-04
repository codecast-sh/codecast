import { describe, expect, test } from "bun:test";
import type { OpsEvent, OpsGroup } from "./opsTypes";
import { layoutChart } from "./issuesModel";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 4, 15, 37);
const g = (over: Partial<OpsGroup> = {}): OpsGroup =>
  ({ _id: "g1", short_id: "eg-1", source_id: "s1", kind: "error", title: "x", status: "open", count: 1, first_seen: NOW - 9 * DAY, last_seen: NOW - 9 * DAY, buckets: [], ...over }) as OpsGroup;
const deploy = (at: number, release: string): OpsEvent => ({ _id: `d${at}`, workspace: "team:t", source: "sdk", kind: "deploy", title: "", source_id: "s1", data: { release }, created_at: at }) as OpsEvent;

describe("deploys on the event chart", () => {
  // Three deploys a day for the whole month, as Union ships.
  const deploys = Array.from({ length: 90 }, (_, i) => deploy(NOW - 30 * DAY + i * 8 * HOUR + HOUR, `r${i}`));

  test("only the release the issue first appeared in draws a full line; the rest are ticks bunched with a count, never more than 15", () => {
    const first = deploys.filter((d) => d.created_at <= NOW - 9 * DAY).at(-1)!;
    const l = layoutChart(g(), deploys, NOW, 30 * 24);
    expect(l.marks.filter((m) => m.tone === "release").map((m) => m.at)).toEqual([first.created_at]);
    expect(l.deployTicks.length).toBeLessThanOrEqual(15);
    expect(l.deployTicks.reduce((a, t) => a + t.n, 0)).toBe(deploys.filter((d) => d.created_at >= l.start).length - 1);
    expect(l.deployTicks.some((t) => t.n >= 3)).toBe(true);
    // Ticks sit in order, centred on their bucket, so no two share a spot.
    expect(new Set(l.deployTicks.map((t) => t.x)).size).toBe(l.deployTicks.length);
  });

  test("a named first release wins over the deploy that came before first seen", () => {
    const l = layoutChart(g({ first_release: "r40" }), deploys, NOW, 30 * 24);
    expect(l.marks.filter((m) => m.tone === "release").map((m) => m.label)).toEqual(["r40"]);
  });

  test("the deploy just before a spike draws a full line", () => {
    const today = Math.floor(NOW / DAY) * DAY;
    const days = Array.from({ length: 30 }, (_, i) => ({ day: today - (29 - i) * DAY, count: i === 25 ? 40 : 1 }));
    const l = layoutChart(g({ first_seen: NOW - 40 * DAY, count: 69, days }), deploys, NOW, 30 * 24);
    const lines = l.marks.filter((m) => m.tone === "release");
    expect(lines).toHaveLength(1);
    expect(lines[0].at).toBeLessThan(today - 4 * DAY + DAY);
    expect(lines[0].at).toBeGreaterThanOrEqual(today - 6 * DAY);
  });
});

describe("the event count over a window", () => {
  test("a window that holds the issue's whole life counts it exactly, and places a lone event on its day", () => {
    const l = layoutChart(g(), [], NOW, 30 * 24);
    expect(l.exact).toBe(true);
    expect(l.total).toBe(1);
    expect(l.bars.some((b) => b.unknown)).toBe(false);
    const hot = l.bars.filter((b) => b.count > 0);
    expect(hot).toHaveLength(1);
    expect(hot[0].at).toBe(Math.floor((NOW - 9 * DAY) / DAY) * DAY);
  });

  test("leftover events that cannot be placed keep the days unknown but the total exact", () => {
    const l = layoutChart(g({ count: 12, last_seen: NOW - 5 * DAY }), [], NOW, 30 * 24);
    expect(l.exact).toBe(true);
    expect(l.total).toBe(12);
    expect(l.bars.some((b) => b.unknown)).toBe(true);
  });

  test("a window shorter than the issue's life is no exact total", () => {
    const l = layoutChart(g({ count: 50, first_seen: NOW - 60 * DAY }), [], NOW, 7 * 24);
    expect(l.exact).toBe(false);
  });
});

describe("the lane bar", () => {
  test("every open issue lands in one lane, a flapper failing now with Firing, so the lanes sum to Open; Flapping still lists it", async () => {
    const { statusCounts, queryAdmits, DEFAULT_QUERY } = await import("./issuesModel");
    const ctx = { taskStatus: () => undefined };
    const flapper = g({ kind: "metric", count: 40, first_seen: NOW - 6 * DAY, last_seen: NOW - 10 * 60_000, failed_at: [NOW - 3 * DAY, NOW - 2 * DAY, NOW - DAY, NOW - 2 * HOUR] });
    const rows = [flapper, g({ _id: "g2", first_seen: NOW - 30 * DAY, last_seen: NOW - HOUR, count: 5 }), g({ _id: "g3", first_seen: NOW - 40 * DAY, last_seen: NOW - 20 * DAY })];
    const c = statusCounts(rows, DEFAULT_QUERY, ctx, NOW);
    expect(c.regressed + c.escalating + c.new + c.firing + c.ongoing + c.quiet).toBe(c.open);
    expect(c.flapping).toBe(1);
    expect(queryAdmits({ status: "open", lane: "flapping" }, flapper, NOW)).toBe(true);
    expect(queryAdmits({ status: "open", lane: "firing" }, flapper, NOW)).toBe(true);
    expect(queryAdmits({ status: "open", lane: "attention" }, flapper, NOW)).toBe(true);
    // One passing between its flips waits in Ongoing, out of Needs attention.
    const passing = { ...flapper, meta: { ok: true } } as typeof flapper;
    expect(queryAdmits({ status: "open", lane: "ongoing" }, passing, NOW)).toBe(true);
    expect(queryAdmits({ status: "open", lane: "attention" }, passing, NOW)).toBe(false);
  });
});
