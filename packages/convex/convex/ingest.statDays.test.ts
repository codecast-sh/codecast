import { describe, expect, test } from "bun:test";
import { SOURCE_STAT_DAYS, withDayCounters } from "./lib/sourceStats";
import { dueWatches, nextWatchAt } from "./sources/app";

const DAY = 86_400_000;
const at = Date.UTC(2026, 10, 3, 12);

describe("a source's day series", () => {
  test("today's counters replace today's entry and keep earlier days in order", () => {
    const days = withDayCounters({ events_today: 7, dropped_today: 1, days: [{ day: "2026-11-02", events: 4, dropped: 0 }, { day: "2026-11-03", events: 2, dropped: 0 }] }, at);
    expect(days).toEqual([{ day: "2026-11-02", events: 4, dropped: 0 }, { day: "2026-11-03", events: 7, dropped: 1 }]);
  });

  test("it keeps SOURCE_STAT_DAYS days", () => {
    const old = Array.from({ length: 40 }, (_, i) => ({ day: new Date(at - (40 - i) * DAY).toISOString().slice(0, 10), events: i, dropped: 0 }));
    const days = withDayCounters({ events_today: 1, days: old }, at);
    expect(days.length).toBe(SOURCE_STAT_DAYS);
    expect(days[days.length - 1]).toEqual({ day: "2026-11-03", events: 1, dropped: 0 });
  });
});

describe("a paused watch", () => {
  const manifest: any = { watches: [{ reader: "jobs", every: "5m", every_ms: 300_000, kind: "job", map: {} }, { reader: "checks", every: "5m", every_ms: 300_000, kind: "check", map: {} }] };
  test("is never due and never holds the next poll", () => {
    const keys = manifest.watches.map((w: any) => dueWatches({ watches: [w] } as any, [], at)[0]).filter(Boolean);
    expect(keys.length).toBe(2);
    const { watchKey } = require("@codecast/shared/contracts/appConnector");
    const state = [{ key: watchKey(manifest.watches[0]), polled_at: 0, paused: true }, { key: watchKey(manifest.watches[1]), polled_at: at }];
    expect(dueWatches(manifest, state as any, at).map((w) => w.reader)).toEqual([]);
    expect(nextWatchAt(manifest, state as any, at)).toBe(at + 300_000 - 60_000);
  });
});
