// The Issues surface, third workflow: daily bars are the viewer's calendar
// days, Firing means burning now, a reported runway dates the zero, a
// recovered check's Seen is its last failure, and counts keep their unit.
import { afterAll, describe, expect, test } from "bun:test";
import type { OpsGroup } from "./opsTypes";
import { countWords, dailySeries, issueLane, lastFailedAt, layoutChart, readingTemplate, trendZero } from "./issuesModel";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// The zone in force, not the variable: bun runs tests in UTC with TZ unset, and unsetting it later falls back to the machine's zone.
const priorTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
process.env.TZ = "America/New_York";
afterAll(() => {
  process.env.TZ = priorTz;
});

// 9:30 PM Eastern on Nov 4 is 02:30 UTC on Nov 5.
const NOW = Date.UTC(2026, 10, 5, 2, 30);
const g = (over: Partial<OpsGroup> = {}): OpsGroup =>
  ({ _id: "g1", short_id: "eg-1", source_id: "s1", kind: "error", title: "x", status: "open", count: 1, first_seen: NOW - 20 * DAY, last_seen: NOW - HOUR, buckets: [], ...over }) as OpsGroup;

describe("daily bars in the viewer's own days", () => {
  test("after 7 PM Eastern the last bar is today, and an afternoon failure sits in it", () => {
    // 2:37 PM Eastern on Nov 4.
    const at = Date.UTC(2026, 10, 4, 19, 37);
    const row = g({ count: 1, first_seen: at, last_seen: at, buckets: [{ hour: Math.floor(at / HOUR) * HOUR, count: 1 }] });
    const bars = dailySeries(row, NOW, 7);
    const last = new Date(bars[6].at);
    expect([last.getMonth(), last.getDate(), last.getHours()]).toEqual([10, 4, 0]);
    expect(bars[6].count).toBe(1);
    expect(new Date(bars[0].at).getDate()).toBe(29);
    const l = layoutChart(row, [], NOW, 7 * 24);
    // Ticks name each local midnight, today last.
    expect(l.ticks.map((t) => new Date(t.at).getDate())).toEqual([29, 30, 31, 1, 2, 3, 4]);
    expect(l.ticks[6].x).toBeCloseTo(6 / 7);
  });
  test("a late-evening hour counts on its own local day, not the UTC day after", () => {
    // 10 PM Eastern on Nov 1 is 03:00 UTC on Nov 2.
    const at = Date.UTC(2026, 10, 2, 3);
    const bars = dailySeries(g({ buckets: [{ hour: at, count: 4 }] }), NOW, 7);
    const hit = bars.find((b) => b.count === 4)!;
    expect(new Date(hit.at).getDate()).toBe(1);
  });
});

describe("Firing means burning now", () => {
  const THIS_HOUR = Math.floor(NOW / HOUR) * HOUR;
  const hours = (base: number, day: number[]) => [
    ...Array.from({ length: 48 }, (_, i) => ({ hour: THIS_HOUR - (71 - i) * HOUR, count: base })),
    ...day.map((count, i) => ({ hour: THIS_HOUR - (day.length - 1 - i) * HOUR, count })),
  ];
  test("a steady flood still going is firing", () => {
    expect(issueLane(g({ buckets: hours(10, Array(24).fill(10)) }), NOW)).toBe("firing");
  });
  test("a spike that passed is not, though its day adds past the firing count", () => {
    // Peak 300/h, now 1/h against a usual 23/h: the page reads Spike passed.
    const passed = g({ buckets: hours(23, [...Array(10).fill(20), 300, 300, 200, ...Array(11).fill(1)]) });
    expect(issueLane(passed, NOW)).toBe("ongoing");
  });
  test("a flood fallen under half its usual rate is not firing", () => {
    expect(issueLane(g({ buckets: hours(10, [...Array(21).fill(10), 2, 2, 2]) }), NOW)).toBe("ongoing");
  });
});

describe("a reported runway dates the zero", () => {
  const say = (credit: number, days: string, burn: number) => `OpenRouter credit $${credit}, ${days} days at $${burn}/day: past the 1-day / $250 level.`;
  test("the newest reading's days, not the fall between the last two readings", () => {
    const rows = [
      { id: "a", at: NOW - 3 * HOUR, text: say(170, "2.4", 70) },
      { id: "b", at: NOW - HOUR, text: say(159, "2.3", 70) },
      { id: "c", at: NOW, text: say(158, "2.2", 70) },
    ];
    const t = readingTemplate([...rows].reverse())!;
    expect(t.cols.map((c) => c.label).slice(0, 2)).toEqual(["credit", "days"]);
    expect(trendZero(t, rows, 0)).toBe(NOW + 2.2 * DAY);
  });
});

describe("the list's Seen and Count", () => {
  test("a recovered check's Seen is when it last failed, not its last passing read", () => {
    const check = g({ kind: "check", meta: { ok: true }, resolved_at: NOW - 5 * DAY, last_seen: NOW - 30 * 60_000 });
    expect(lastFailedAt(check)).toBe(NOW - 5 * DAY);
    expect(lastFailedAt(g({ kind: "check", meta: { ok: false }, last_seen: NOW - HOUR }))).toBe(NOW - HOUR);
  });
  test("readings and runs keep a unit at narrow widths; events stay bare", () => {
    expect(countWords("metric", 391).tiny).toBe("rd");
    expect(countWords("check", 3).tiny).toBe("rd");
    expect(countWords("job", 1).tiny).toBe("run");
    expect(countWords("error", 2915).tiny).toBe(null);
  });
});
