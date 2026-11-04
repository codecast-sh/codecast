import { describe, expect, test } from "bun:test";
import { counterDays, eventCounter, pollLateAfter, sourceActivity, sourceCheckTally, sourceHealth, sourceWatchTally, todayVsNormal } from "./sourceHealth";
import type { OpsSource } from "./opsTypes";

const NOW = Date.UTC(2026, 10, 3, 12);
const H = 3600_000;
const D = 24 * H;
const src = (o: Partial<OpsSource> = {}): OpsSource => ({ _id: "s1", short_id: "src-1", workspace: "team:t", owner_user_id: "u", provider: "posthog", name: "union-posthog", keyed: false, promote: [], status: "active", created_at: NOW - 60 * D, updated_at: NOW, ...o } as OpsSource);
const none = { groups: [], replays: [], watches: [] };

describe("activity reads every trail a source leaves", () => {
  test("a poll source with no door counters is busy by its groups and replays", () => {
    const groups: any[] = [{ source_id: "s1", last_seen: NOW - H, buckets: [{ hour: NOW - 2 * H, count: 12 }] }];
    const replays: any[] = [{ source_id: "s1", started_at: NOW - 3 * H }, { source_id: "other", started_at: NOW }];
    const a = sourceActivity(src(), { groups, replays, watches: [] }, NOW);
    expect(a.lastAt).toBe(NOW - H);
    expect(a.today).toBe(12);
    expect(a.days[a.days.length - 1]).toBe(12);
  });

  test("the server's day series and the flow map fill the older days", () => {
    const a = sourceActivity(src({ days: [{ day: "2026-11-01", events: 30, dropped: 0 }] }), none, NOW, { days: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 0], lastAt: NOW - 2 * D });
    expect(a.days.slice(-3)).toEqual([30, 40, 0]);
    expect(a.lastAt).toBe(NOW - 2 * D);
  });
});

describe("one health per source", () => {
  const busy = { lastAt: NOW - H, today: 5, normal: 5, days: new Array(14).fill(5), dropped: 0 };
  test("a stalled import is never green", () => {
    const h = sourceHealth(src({ replay_backfill: { status: "running", window: "30d", until: NOW, listed: 930, imported: 570, skipped: 361, failed: 6, started_at: NOW - 9 * D, updated_at: NOW - 2 * D } as any }), busy, { now: NOW });
    expect([h.state, h.tone, h.fix]).toEqual(["failing", "warn", "resume_import"]);
  });

  test("a source silent 18 days is stopped, not active", () => {
    const h = sourceHealth(src({ provider: "sdk" }), { ...busy, lastAt: NOW - 18 * D, days: new Array(14).fill(0), today: 0 }, { now: NOW });
    expect(h.state).toBe("stopped");
    expect(h.tone).toBe("bad");
  });

  test("paused, a lost connection and an auth error each name their fix", () => {
    expect(sourceHealth(src({ status: "paused" }), busy, { now: NOW }).fix).toBe("resume");
    expect(sourceHealth(src(), busy, { now: NOW, connected: false }).state).toBe("auth");
    expect(sourceHealth(src({ status: "error", last_error: "PostHog answered 401" }), busy, { now: NOW }).fix).toBe("reconnect");
    expect(sourceHealth(src({ status: "error", last_error: "boom" }), busy, { now: NOW }).state).toBe("failing");
    expect(sourceHealth(src({ provider: "app", watch_state: [{ key: "jobs", polled_at: NOW, last_error: "500" }] }), busy, { now: NOW }).label).toBe("jobs check failing");
  });

  test("a reader watch starved by a failing reader is one problem, named once", () => {
    const w = (name: string, query: string) => ({ _id: name, source_id: "s1", name, query_kind: "reader", query, status: "active", last_error: "no answer in 15s" }) as any;
    const failures = [{ kind: "read" as const, name: "metrics.read", reason: "HTTP 502", reasons: [{ reason: "HTTP 502", count: 60 }, { reason: "Timed out", count: 34 }], count: 94, since: NOW - 3 * H }];
    const h = sourceHealth(src({ provider: "app" }), busy, { now: NOW, watches: [w("Dollars per intro", 'metrics.read {"key":"dpi"}')], appFailures: failures });
    // The headline is the Apps head's two counts: the watches, and the calls failing outside them.
    expect([h.state, h.label, h.fix, h.watches.text]).toEqual(["degraded", "1 of 1 watch failing · 1 call failing", "calls", "1 of 1 watch failing"]);
    expect(h.reason).toBe("metrics.read returns HTTP 502 or times out, 94× in the last 3h, so the Dollars per intro watch has no answer");
    // A failing reader is named as one even when no watch's latest read failed, so the reading holds from one load to the next.
    const ok = { ...w("Dollars per intro", 'metrics.read {"key":"dpi"}'), last_error: undefined, missed: 0 };
    const steady = sourceHealth(src({ provider: "app" }), busy, { now: NOW, watches: [ok], appFailures: failures });
    expect([steady.label, steady.starves?.watchIds, steady.starves?.feeds, steady.since]).toEqual(["1 call failing", [], ["Dollars per intro"], NOW - 3 * H]);
    expect(steady.reason).toBe("metrics.read returns HTTP 502 or times out, 94× in the last 3h");
    // An action failing is degraded, never Reader failing.
    const act = sourceHealth(src({ provider: "app" }), busy, { now: NOW, appFailures: [{ ...failures[0], kind: "do" as const, name: "jobs.retry" }] });
    expect([act.state, act.label, act.starves]).toEqual(["degraded", "1 call failing", undefined]);
  });

  test("a failing reader and a failing check are both named, never one hiding the other", () => {
    const w = { _id: "w1", source_id: "s1", name: "Dollars per intro", query_kind: "reader", query: 'metrics.read {"key":"dpi"}', status: "active" } as any;
    const failures = [{ kind: "read" as const, name: "metrics.read", reason: "Timed out", reasons: [{ reason: "Timed out", count: 98 }], count: 98, since: NOW - 5 * H }];
    const app = src({ provider: "app", watch_state: [{ key: "check:invariants", polled_at: NOW, last_error: "the response is over 256 KB" }] });
    const h = sourceHealth(app, busy, { now: NOW, watches: [w], appFailures: failures, checkName: (k) => (k === "check:invariants" ? "Invariants" : undefined) });
    expect([h.label, h.fix, h.starves?.reader.name]).toEqual(["Invariants check failing · 1 call failing", "calls", "metrics.read"]);
    // Checks and metric watches are separate nouns over separate sets: the metric watch is counted where Metrics counts it.
    expect([h.checks.text, h.watches.text]).toEqual(["Invariants check failing", "1 watch ok"]);
    expect(h.problems?.map((p) => [p.kind, p.name])).toEqual([["read", "metrics.read"], ["check", "Invariants"]]);
    expect(h.reason).toBe("metrics.read times out, 98× in the last 5h · Invariants: the response is over 256 KB");
    // Checks alone say how many of the checks fail.
    const two = sourceHealth(src({ provider: "app", watch_state: [{ key: "check:a", polled_at: NOW, last_error: "500" }, { key: "job:b", polled_at: NOW, last_error: "502" }] }), busy, { now: NOW });
    expect([two.label, two.reason, two.problems?.length]).toEqual(["2 of 2 checks failing", "a: 500 · b: 502", 2]);
  });

  test("a polled source whose poll is late is degraded, never flowing; a push source has no poll to be late", () => {
    const late = sourceHealth(src({ last_poll_at: NOW - 37 * 60_000 }), busy, { now: NOW });
    expect([late.state, late.label, late.level]).toEqual(["degraded", "Poll late", "degraded"]);
    expect(late.reason).toContain("37m");
    expect(sourceHealth(src({ last_poll_at: NOW - 5 * 60_000 }), busy, { now: NOW }).label).toBe("Flowing");
    expect(sourceHealth(src({ provider: "sdk", last_poll_at: NOW - 37 * 60_000 }), busy, { now: NOW }).label).toBe("Flowing");
    // A source that polls when its hourly watches do is late only past three of them.
    const hourly = [{ _id: "w", source_id: "s1", status: "active", interval_ms: 60 * 60_000 }] as any[];
    expect(pollLateAfter({ _id: "s1" }, hourly)).toBe(3 * 60 * 60_000);
    expect(sourceHealth(src({ last_poll_at: NOW - 37 * 60_000 }), busy, { now: NOW, watches: hourly }).label).toBe("Flowing");
  });

  test("down is what stops data arriving; a failing reader or import is degraded", () => {
    expect(sourceHealth(src({ status: "error", last_error: "boom" }), busy, { now: NOW }).level).toBe("down");
    expect(sourceHealth(src({ provider: "sdk" }), { ...busy, lastAt: NOW - 18 * D, days: new Array(14).fill(0), today: 0 }, { now: NOW }).level).toBe("down");
    const failures = [{ kind: "read" as const, name: "metrics.read", reason: "HTTP 502", count: 5 }];
    expect(sourceHealth(src({ provider: "app" }), busy, { now: NOW, appFailures: failures }).level).toBe("degraded");
    expect(sourceHealth(src(), busy, { now: NOW }).level).toBe("ok");
  });

  test("a watch whose own query fails leaves its source flowing: the home lists it as a watch error", () => {
    const timeout = { _id: "w", source_id: "s1", name: "Dollars per intro", query_kind: "hogql", query: "select 1", status: "active", last_error: "no answer in 15s" } as any;
    expect(sourceHealth(src(), busy, { now: NOW, watches: [timeout] }).state).toBe("flowing");
  });

  test("busy is flowing; a new source waits; an old one that never sent is stopped", () => {
    expect(sourceHealth(src(), busy, { now: NOW }).state).toBe("flowing");
    const idle = { lastAt: null, today: 0, normal: 0, days: new Array(14).fill(0), dropped: 0 };
    expect(sourceHealth(src({ created_at: NOW - H }), idle, { now: NOW }).state).toBe("waiting");
    expect(sourceHealth(src(), idle, { now: NOW }).label).toBe("Never sent");
  });

  test("today against normal", () => {
    expect(todayVsNormal(40, 10)).toBe("spike");
    expect(todayVsNormal(2, 10)).toBe("low");
    expect(todayVsNormal(9, 10)).toBe("normal");
    expect(todayVsNormal(9, 0)).toBeNull();
  });
});

describe("one counter for today and its usual day", () => {
  const day = (offset: number) => new Date(NOW - offset * D).toISOString().slice(0, 10);
  test("today and the baseline read the same day series, never another counter", () => {
    const days = [6, 5, 4, 3, 2, 1].map((o) => ({ day: day(o), events: 20, dropped: 0 })).concat([{ day: day(0), events: 30, dropped: 0 }]);
    const c = eventCounter(src({ days, events_today: 999 }), NOW);
    expect(c.today).toBe(30);
    expect(c.baseline).toBe(20);
    expect(c.vs).toBe("normal");
  });

  test("without three full days of history there is no usual day, and the first day is named", () => {
    const c = eventCounter(src({ days: [{ day: day(1), events: 5, dropped: 0 }, { day: day(0), events: 400, dropped: 0 }] }), NOW);
    expect(c.baseline).toBeNull();
    expect(c.vs).toBeNull();
    expect(c.since).toBe(day(1));
  });

  test("a spike is today alone past three usual days; days before the counter began are unknown", () => {
    const days = [5, 4, 3, 2, 1].map((o) => ({ day: day(o), events: 10, dropped: 0 })).concat([{ day: day(0), events: 31, dropped: 0 }]);
    expect(eventCounter(src({ days }), NOW).vs).toBe("spike");
    const bins = counterDays(src({ days }), NOW, 10);
    expect(bins.slice(0, 4).every((b) => b.events === null)).toBe(true);
    expect(bins.slice(4).map((b) => b.events)).toEqual([10, 10, 10, 10, 10, 31]);
  });
});

describe("health names what is wrong and the step that fixes it", () => {
  const busy = { lastAt: NOW - H, today: 5, normal: 5, days: new Array(14).fill(5), dropped: 0 };
  test("an app whose readers keep failing is degraded, with the reader named", () => {
    const h = sourceHealth(src({ provider: "app" }), busy, { now: NOW, appFailures: [{ kind: "read", name: "metrics.read", reason: "Timed out", count: 95 }] });
    expect([h.state, h.tone, h.fix]).toEqual(["degraded", "warn", "calls"]);
    expect(h.reason).toBe("metrics.read times out, 95×");
  });

  test("a stopped keyed source says since when and offers the test event", () => {
    const h = sourceHealth(src({ provider: "sdk", keyed: true } as any), { ...busy, lastAt: NOW - 18 * D, days: new Array(14).fill(0), today: 0, normal: 40 }, { now: NOW });
    expect(h.state).toBe("stopped");
    expect(h.fix).toBe("check");
    expect(h.reason).toContain("Nothing since");
    expect(h.reason).toContain("about 40 a day");
  });
});

test("checks and metric watches are counted apart, and a watch whose last read failed is retrying, the band's word", () => {
  const w = (id: string, over: Record<string, unknown> = {}) => ({ _id: id, source_id: "s1", name: id, query_kind: "series", query: "q", status: "active", last_value: 1, last_at: 1, ...over }) as any;
  const t = sourceWatchTally({ _id: "s1" }, [w("a", { last_error: "timed out", missed: 1 }), w("b")]);
  expect(t.text).toBe("1 of 2 watches retrying");
  const c = sourceCheckTally({ watch_state: [{ key: "check:invariants", polled_at: 1, last_error: "too big" }, { key: "job:x", polled_at: 1 }] } as any, () => "Invariants");
  expect([c.text, c.total]).toEqual(["Invariants check failing", 2]);
});
