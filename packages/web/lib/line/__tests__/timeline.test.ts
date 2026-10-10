// The Timeline view's arithmetic (line-workspace.md LW1 Timeline): where a
// problem stands, the occurrences bucketed on the shared axis, the ticks under
// it and the window a range shows.
import { describe, expect, test } from "bun:test";
import type { CauseHistory, HistoryAttempt } from "../causeHistory";
import {
  DAY, HOUR, alignDown, attemptTone, bucketCounts, bucketStep, defaultRange, lowerBound, problemState, rangeDomain, regressionAt, sortProblems, timeTicks,
} from "../timeline";
import type { LineIssue } from "../lineModel";

const NOW = new Date(2026, 9, 9, 15, 30).getTime();

const attempt = (over: Partial<HistoryAttempt>): HistoryAttempt => ({
  runId: "r1", n: 1, start: NOW - 5 * DAY, end: NOW - 4 * DAY, live: false, outcome: { tone: "calm", end: null, text: "" }, ended: null, superseded: false,
  found: null, proposed: null, built: null, card: null, diff: null, merge: null, ...over,
} as HistoryAttempt);

const history = (over: Partial<CauseHistory>): CauseHistory => ({
  occurrences: [], occurrencesFrom: "history", since: null, capped: false, attempts: [], ships: [], deploys: [],
  coverage: { state: "none", targets: [], words: "" }, watches: [], regressions: [], regressed: false, firstAt: null, lastActivity: 0, ...over,
} as CauseHistory);

const ship = { runId: "r1", at: NOW - 4 * DAY, merge: null, deploys: [], liveAt: NOW - 4 * DAY, basis: "ship" as const, words: "" };

describe("problemState", () => {
  test("regressed beats everything, a live attempt is being fixed", () => {
    expect(problemState(history({ regressed: true, attempts: [attempt({ live: true })] }), "open")).toBe("regressed");
    expect(problemState(history({ attempts: [attempt({ live: true, end: null })] }), "open")).toBe("fixing");
  });
  test("after a ship: watching while the watch runs, held once it ended quiet or the cause closed", () => {
    const shipped = { attempts: [attempt({ ended: "shipped" })], ships: [ship] };
    expect(problemState(history({ ...shipped, watches: [{ runId: "r1", start: NOW - 4 * DAY, end: NOW + DAY, state: "watching", reopenedAt: null }] }), "done")).toBe("watching");
    expect(problemState(history({ ...shipped, watches: [{ runId: "r1", start: NOW - 4 * DAY, end: NOW - DAY, state: "quiet", reopenedAt: null }] }), "done")).toBe("held");
    expect(problemState(history(shipped), "done")).toBe("held");
    expect(problemState(history(shipped), "open")).toBe("watching");
  });
  test("no ship: closed when closed, open otherwise", () => {
    expect(problemState(history({}), "dropped")).toBe("closed");
    expect(problemState(history({ attempts: [attempt({ ended: "dissolved" })] }), "open")).toBe("closed");
    // It happened again after the attempt closed it: open.
    expect(problemState(history({ attempts: [attempt({ ended: "dissolved" })], occurrences: [{ at: NOW - DAY, reopened: false }] }), "open")).toBe("open");
    expect(problemState(history({}), "open")).toBe("open");
  });
});

test("sortProblems puts regressed first, then the newest activity", () => {
  const row = (id: string, state: "regressed" | "open", lastActivity: number) => ({ issue: { id, history: history({ lastActivity }) } as unknown as LineIssue, state });
  const out = sortProblems([row("a", "open", 30), row("b", "regressed", 10), row("c", "open", 50), row("d", "regressed", 20)]);
  expect(out.map((r) => r.issue.id)).toEqual(["d", "b", "c", "a"]);
});

test("attemptTone follows how an attempt ended", () => {
  expect(attemptTone(attempt({ live: true }))).toBe("live");
  expect(attemptTone(attempt({ ended: "shipped" }))).toBe("ok");
  expect(attemptTone(attempt({ outcome: { tone: "failed", end: null, text: "" } }))).toBe("bad");
  expect(attemptTone(attempt({ outcome: { tone: "closed", end: "dissolved", text: "" }, ended: "dissolved" }))).toBe("none");
});

test("regressionAt: after a fix went live and before the next one did", () => {
  const regs = [
    { afterRunId: "r1", at: 15, count: 1, basis: "deploy" as const, liveAt: 10, until: 20, words: "" },
    { afterRunId: "r2", at: 25, count: 1, basis: "merge" as const, liveAt: 20, until: null, words: "" },
  ];
  expect(regressionAt(10, regs)).toBeNull();
  expect(regressionAt(12, regs)?.afterRunId).toBe("r1");
  expect(regressionAt(20, regs)).toBeNull();
  expect(regressionAt(9_999, regs)?.afterRunId).toBe("r2");
});

describe("buckets", () => {
  test("lowerBound and bucketCounts count each time once, in its bucket", () => {
    const times = [0, 5, 10, 10, 19, 20, 35];
    expect(lowerBound(times, 10)).toBe(2);
    expect(lowerBound(times, 36)).toBe(7);
    expect(bucketCounts(times, 5, 35, 10)).toEqual([3, 2, 0]);
    expect(bucketCounts(times, 0, 40, 10)).toEqual([2, 3, 1, 1]);
  });
  test("bucketStep keeps the bar count under the target", () => {
    expect(bucketStep(DAY, 72)).toBe(30 * 60_000);
    expect(bucketStep(30 * DAY, 72)).toBe(12 * HOUR);
    expect(bucketStep(180 * DAY, 72)).toBe(7 * DAY);
  });
  test("alignDown lands on local hours and midnights", () => {
    const t = new Date(2026, 9, 9, 15, 42).getTime();
    expect(new Date(alignDown(t, 3 * HOUR)).getHours()).toBe(15);
    expect(new Date(alignDown(t, 6 * HOUR)).getHours()).toBe(12);
    const day = new Date(alignDown(t, DAY));
    expect([day.getDate(), day.getHours()]).toEqual([9, 0]);
    expect(new Date(alignDown(t, 7 * DAY)).getDay()).toBe(1);
  });
});

describe("the axis", () => {
  test("ticks stay inside the domain and under the cap; midnights are major", () => {
    const d = [NOW - 7 * DAY, NOW] as const;
    const ticks = timeTicks(d, 8);
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.length).toBeLessThanOrEqual(8);
    for (const t of ticks) expect(t.at >= d[0] && t.at <= d[1]).toBe(true);
    expect(ticks.every((t) => t.major)).toBe(true);
    const hours = timeTicks([NOW - DAY, NOW], 12);
    expect(hours.some((t) => !t.major)).toBe(true);
  });
  test("a preset ends now; all frames the whole history", () => {
    const h = history({ occurrences: [{ at: NOW - 60 * DAY, reopened: false }, { at: NOW - DAY, reopened: false }], attempts: [attempt({ start: NOW - 50 * DAY, end: NOW - 49 * DAY })] });
    expect(rangeDomain("7d", h, NOW)).toEqual([NOW - 7 * DAY, NOW]);
    const [a, b] = rangeDomain("all", h, NOW);
    expect(a).toBeLessThan(NOW - 60 * DAY);
    expect(b).toBeGreaterThanOrEqual(NOW);
    expect(defaultRange(h, NOW)).toBe("all");
    expect(defaultRange(history({ occurrences: [{ at: NOW - 3 * DAY, reopened: false }] }), NOW)).toBe("7d");
    expect(defaultRange(history({ occurrences: [{ at: NOW - 20 * DAY, reopened: false }] }), NOW)).toBe("30d");
  });
});
