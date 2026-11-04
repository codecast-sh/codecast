import { describe, expect, test } from "bun:test";
import { GROUP_RULES } from "@codecast/shared/contracts/ingest";
import { HOUR_MS, addToDays, applyMirror, applyOccurrence, dayStart, seedDays, type GroupState } from "./ingestGroups";

const DAY = 24 * HOUR_MS;
const NOW = Date.UTC(2026, 9, 3, 12, 30);
const TODAY = dayStart(NOW);

const group = (over: Partial<GroupState> = {}): GroupState => ({ kind: "error", status: "open", count: 3, first_seen: NOW - 10 * DAY, last_seen: NOW - 2 * HOUR_MS, buckets: [], ...over });

describe("daily counts", () => {
  test("a group without days starts from its hours folded into days", () => {
    const buckets = [{ hour: TODAY - DAY + 3 * HOUR_MS, count: 2 }, { hour: TODAY - DAY + 5 * HOUR_MS, count: 1 }, { hour: TODAY + HOUR_MS, count: 4 }];
    expect(seedDays(buckets)).toEqual([{ day: TODAY - DAY, count: 3 }, { day: TODAY, count: 4 }]);
    expect(addToDays(undefined, buckets, NOW, 1, NOW)).toEqual([{ day: TODAY - DAY, count: 3 }, { day: TODAY, count: 5 }]);
  });

  test("days older than the window fall off, and an occurrence older than it is not placed", () => {
    const old = TODAY - GROUP_RULES.day_buckets * DAY;
    expect(addToDays([{ day: old, count: 9 }, { day: TODAY, count: 1 }], [], NOW, 1, NOW)).toEqual([{ day: TODAY, count: 2 }]);
    expect(addToDays([], [], old, 5, NOW)).toEqual([]);
  });

  test("every counted occurrence lands on its day; a passing check reading does not", () => {
    const err = applyOccurrence(group({ days: [{ day: TODAY - 3 * DAY, count: 2 }] }), { kind: "error", at: NOW - HOUR_MS }, NOW).next;
    expect(err.days).toEqual([{ day: TODAY - 3 * DAY, count: 2 }, { day: TODAY, count: 1 }]);
    const check = group({ kind: "check", meta: { ok: false }, days: [] });
    expect(applyOccurrence(check, { kind: "check", at: NOW, ok: false }, NOW).next.days).toEqual([{ day: TODAY, count: 1 }]);
    expect(applyOccurrence(check, { kind: "check", at: NOW, ok: true }, NOW).next.days).toEqual([]);
    expect(applyOccurrence(null, { kind: "error", at: NOW }, NOW).next.days).toEqual([{ day: TODAY, count: 1 }]);
  });

  test("a mirror's first read keeps the vendor's whole count off any one day; later reads add the new ones on the day last seen", () => {
    const snap = { kind: "error" as const, status: "open" as const, count: 500, first_seen: NOW - 60 * DAY, last_seen: NOW - HOUR_MS, hourly: [{ hour: TODAY + HOUR_MS, count: 7 }] };
    const first = applyMirror(null, snap, NOW, 0).next;
    expect(first.days).toEqual([{ day: TODAY, count: 7 }]);
    const later = applyMirror(first, { ...snap, count: 503, hourly: undefined }, NOW, 0).next;
    expect(later.days).toEqual([{ day: TODAY, count: 10 }]);
  });
});
