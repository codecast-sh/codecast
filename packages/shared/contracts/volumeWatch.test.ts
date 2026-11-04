import { expect, test } from "bun:test";
import { CI_RUNS_KEPT, lastFullHour, parseVolumeQuery, volumeHistory, volumeLabel, volumeQueryText, volumeUnit, volumeValue, withCiRun } from "./volumeWatch";
import { watchProblem } from "./ingest";

const H = 3600_000;
const D = 24 * H;
const NOW = Date.UTC(2026, 10, 4, 15, 20);

test("the query grammar: the three series and a named event", () => {
  expect(parseVolumeQuery("events")).toEqual({ series: "events" });
  expect(parseVolumeQuery(" events:$exception ")).toEqual({ series: "events", event: "$exception" });
  expect(parseVolumeQuery("new_issues")).toEqual({ series: "new_issues" });
  expect("error" in parseVolumeQuery("events:")).toBe(true);
  expect("error" in parseVolumeQuery("SELECT 1")).toBe(true);
  expect(volumeQueryText({ series: "events", event: "signup" })).toBe("events:signup");
  expect(volumeLabel({ series: "new_issues" }, true)).toBe("New failures, 24h");
  expect(volumeLabel({ series: "events" }, false)).toBe("Events per hour");
});

test("error, SDK and CI sources take volume watches; the server and the form check the same query", () => {
  expect(watchProblem("sentry", "volume", "events", 50)).toBeNull();
  expect(watchProblem("github", "volume", "open_issues", undefined)).toBeNull();
  expect(watchProblem("sdk", "volume", "nonsense", undefined)).toContain("volume watch reads");
  expect(watchProblem("posthog", "volume", "events", undefined)).toContain("cannot watch a volume metric");
});

test("events per hour reads the last complete hour, never the half-counted one", () => {
  const h = lastFullHour(NOW);
  const hours = [{ hour: h - H, events: 4 }, { hour: h, events: 7 }, { hour: h + H, events: 2 }];
  expect(volumeValue({ series: "events" }, { now: NOW, hours })).toBe(7);
  const names = [{ name: "boom", buckets: [{ hour: h, count: 3 }] }];
  expect(volumeValue({ series: "events", event: "boom" }, { now: NOW, event_names: names })).toBe(3);
  // An hour the counter skipped reads zero in the history, from its first hour on.
  const past = volumeHistory({ series: "events" }, { now: NOW, hours: [{ hour: h - 2 * H, events: 5 }, { hour: h, events: 7 }] });
  expect(past).toEqual([{ at: h - H, value: 5 }, { at: h, value: 0 }, { at: h + H, value: 7 }]);
});

test("new issues are the ones first seen in the last day; open issues count the open ones", () => {
  const groups = [{ first_seen: NOW - H, status: "open" }, { first_seen: NOW - 2 * D, status: "open" }, { first_seen: NOW - 3 * H, status: "resolved" }];
  expect(volumeValue({ series: "new_issues" }, { now: NOW, groups })).toBe(2);
  expect(volumeValue({ series: "open_issues" }, { now: NOW, groups })).toBe(2);
  expect(volumeValue({ series: "open_issues" }, { now: NOW, groups_open: 9 })).toBe(9);
  const days = volumeHistory({ series: "new_issues" }, { now: NOW, groups }, 3);
  expect(days.map((d) => d.value)).toEqual([0, 1, 0]);
  expect(volumeHistory({ series: "open_issues" }, { now: NOW, groups })).toEqual([]);
});

test("a CI source's runs read as a failed share and run time percentiles over the trailing day", () => {
  const M = 60_000;
  const runs = [
    { at: NOW - 3 * D, ok: false, duration_ms: 50 * M },
    { at: NOW - 5 * H, ok: true, duration_ms: 4 * M },
    { at: NOW - 4 * H, ok: false, duration_ms: 6 * M },
    { at: NOW - 3 * H, ok: true, duration_ms: 5 * M },
    { at: NOW - 2 * H, ok: true },
  ];
  expect(parseVolumeQuery("ci_duration_p95")).toEqual({ series: "ci_duration_p95" });
  expect(volumeValue({ series: "ci_failure_rate" }, { now: NOW, ci_runs: runs })).toBe(25);
  // An untimed run counts toward the share but not the run time.
  expect(volumeValue({ series: "ci_duration_p50" }, { now: NOW, ci_runs: runs })).toBe(5);
  expect(volumeValue({ series: "ci_duration_p95" }, { now: NOW, ci_runs: runs })).toBe(6);
  expect(volumeValue({ series: "ci_failure_rate" }, { now: NOW, ci_runs: [] })).toBe(0);
  // One point per day the runs reach, none for a day with no runs.
  const past = volumeHistory({ series: "ci_failure_rate" }, { now: NOW, ci_runs: runs }, 30);
  expect(past.length).toBeGreaterThan(0);
  expect(past.every((p) => p.value === 100 || p.value === 25 || p.value === 0)).toBe(true);
  expect(volumeLabel({ series: "ci_duration_p50" }, true)).toBe("Run time p50, 24h");
  expect(volumeUnit({ series: "ci_failure_rate" })).toBe("%");
  expect(watchProblem("github", "volume", "ci_failure_rate", 20)).toBeNull();
  expect(watchProblem("sentry", "volume", "ci_failure_rate", 20)).toContain("CI source");
});

test("the kept runs stay in start order, inside 30 days and the cap", () => {
  const old = { at: NOW - 40 * D, ok: true };
  const kept = withCiRun([old, { at: NOW - H, ok: true }], { at: NOW - 2 * H, ok: false });
  expect(kept.map((r) => r.at)).toEqual([NOW - 2 * H, NOW - H]);
  const many = Array.from({ length: CI_RUNS_KEPT + 5 }, (_, i) => ({ at: NOW - (i + 1) * M1, ok: true }));
  expect(withCiRun(many, { at: NOW, ok: true })).toHaveLength(CI_RUNS_KEPT);
});
const M1 = 60_000;
