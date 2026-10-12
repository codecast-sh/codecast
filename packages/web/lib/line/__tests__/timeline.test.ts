// The Timeline view's arithmetic (line-workspace.md LW1 Timeline): where a
// problem stands, the occurrences bucketed on the shared axis, the ticks under
// it and the window a range shows.
import { describe, expect, test } from "bun:test";
import type { CauseHistory, HistoryAttempt } from "../causeHistory";
import {
  DAY, HOUR, alignDown, attemptTone, bucketCounts, bucketStep, cameBackClose, closeWords, defaultRange, lowerBound, problemLine, problemRowSig, problemState, rangeDomain, regressionAt, sortProblems, sparkEnd, timeTicks,
} from "../timeline";
import type { LineIssue } from "../lineModel";

const NOW = new Date(2026, 9, 9, 15, 30).getTime();

const attempt = (over: Partial<HistoryAttempt>): HistoryAttempt => ({
  runId: "r1", n: 1, start: NOW - 5 * DAY, end: NOW - 4 * DAY, live: false, outcome: { tone: "calm", end: null, text: "" }, ended: null, superseded: false,
  endStep: null, unapproved: false, found: null, proposed: null, built: null, card: null, diff: null, merge: null, ...over,
} as HistoryAttempt);

const history = (over: Partial<CauseHistory>): CauseHistory => ({
  occurrences: [], occurrencesFrom: "history", since: null, capped: false, attempts: [], ships: [], deploys: [],
  coverage: { state: "none", targets: [], words: "" }, watches: [], regressions: [], closes: [], recurrences: [], regressed: false, cameBack: false, firstAt: null, lastActivity: 0, ...over,
} as CauseHistory);

const ship = { runId: "r1", at: NOW - 4 * DAY, merge: null, deploys: [], liveAt: NOW - 4 * DAY, basis: "ship" as const, words: "" };

describe("problemState", () => {
  test("regressed beats everything, a live attempt is being fixed", () => {
    expect(problemState(history({ regressed: true, attempts: [attempt({ live: true })] }), "open")).toBe("regressed");
    expect(problemState(history({ attempts: [attempt({ live: true, end: null })] }), "open")).toBe("fixing");
  });
  test("after a ship: watching while the watch runs, held once it ended quiet or the cause closed", () => {
    const shipped = { attempts: [attempt({ ended: "shipped" })], ships: [ship], closes: [{ runId: "r1", n: 1, kind: "shipped" as const, at: ship.liveAt, step: "watch" }] };
    expect(problemState(history({ ...shipped, watches: [{ runId: "r1", start: NOW - 4 * DAY, end: NOW + DAY, state: "watching", reopenedAt: null }] }), "done")).toBe("watching");
    expect(problemState(history({ ...shipped, watches: [{ runId: "r1", start: NOW - 4 * DAY, end: NOW - DAY, state: "quiet", reopenedAt: null }] }), "done")).toBe("held");
    expect(problemState(history(shipped), "done")).toBe("held");
    expect(problemState(history(shipped), "open")).toBe("watching");
  });
  test("no ship: closed when closed or dissolved and quiet, came back when it kept happening after the close", () => {
    expect(problemState(history({}), "dropped")).toBe("closed");
    const dissolved = { attempts: [attempt({ ended: "dissolved" })], closes: [{ runId: "r1", n: 1, kind: "dissolved" as const, at: NOW - 4 * DAY, step: "investigate" }] };
    expect(problemState(history(dissolved), "open")).toBe("closed");
    expect(problemState(history({ ...dissolved, cameBack: true }), "in_review")).toBe("cameback");
    // A run working it again outranks the comeback.
    expect(problemState(history({ ...dissolved, cameBack: true, attempts: [...dissolved.attempts, attempt({ runId: "r2", live: true, end: null })] }), "open")).toBe("fixing");
    expect(problemState(history({}), "open")).toBe("open");
  });
});

describe("problemLine", () => {
  test("after a close it says what the newest close did and how often it came back", () => {
    const h = history({
      attempts: [attempt({ ended: "dissolved", endStep: "investigate" })],
      closes: [{ runId: "r1", n: 1, kind: "dissolved", at: new Date(2026, 9, 7, 12).getTime(), step: "investigate" }],
      recurrences: [{ afterRunId: "r1", n: 1, kind: "dissolved", closedAt: 0, at: 1, count: 5, until: null, words: "" }],
      cameBack: true,
    });
    const issue = { where: { text: "Closed without a change at Investigate." }, history: h } as unknown as LineIssue;
    expect(problemLine(issue)).toBe("Dissolved at Investigate Oct 7, came back 5x since");
    expect(problemLine(issue, (id) => (id === "investigate" ? "Find why" : undefined))).toBe("Dissolved at Find why Oct 7, came back 5x since");
    const quiet = { ...issue, history: { ...h, recurrences: [], cameBack: false } } as LineIssue;
    expect(problemLine(quiet)).toBe("Dissolved at Investigate Oct 7, quiet since");
    expect(closeWords(h.closes[0])).toBe("Dissolved at Investigate Oct 7");
  });
});

describe("came back: the step whose close did not hold (learning-loop.md LL4)", () => {
  const dissolvedAt = (step: string, back: boolean, over: Partial<CauseHistory> = {}) => ({
    history: history({
      attempts: [attempt({ ended: "dissolved", endStep: step })],
      closes: [{ runId: `r-${step}`, n: 1, kind: "dissolved", at: NOW - 3 * DAY, step }],
      recurrences: back ? [{ afterRunId: `r-${step}`, n: 1, kind: "dissolved", closedAt: NOW - 3 * DAY, at: NOW - DAY, count: 2, until: null, words: "" }] : [],
      cameBack: back,
      ...over,
    }),
  });
  test("a dissolve that came back names its run and step; one that held, a fix, or a live attempt does not", () => {
    expect(cameBackClose(dissolvedAt("dissolve", true))).toMatchObject({ runId: "r-dissolve", step: "dissolve" });
    expect(cameBackClose(dissolvedAt("dissolve", false))).toBeNull();
    expect(cameBackClose(dissolvedAt("dissolve", true, { attempts: [attempt({ live: true, end: null })] }))).toBeNull();
    expect(cameBackClose({ history: history({ regressed: true, closes: [{ runId: "r1", n: 1, kind: "shipped", at: NOW - DAY, step: "watch" }] }) })).toBeNull();
  });
});

test("sortProblems puts the graph's worked problems first, regressed and came back first among them, then the newest activity", () => {
  const row = (id: string, state: "regressed" | "cameback" | "open", lastActivity: number, runs = ["r"]) => ({ issue: { id, runs, history: history({ lastActivity }) } as unknown as LineIssue, state });
  const out = sortProblems([row("a", "open", 30), row("b", "regressed", 10), row("c", "open", 50), row("d", "cameback", 20), row("e", "open", 90, [])]);
  expect(out.map((r) => r.issue.id)).toEqual(["d", "b", "c", "a", "e"]);
});

test("attemptTone follows how an attempt ended", () => {
  expect(attemptTone(attempt({ live: true }))).toBe("live");
  expect(attemptTone(attempt({ ended: "shipped" }))).toBe("ok");
  expect(attemptTone(attempt({ outcome: { tone: "failed", end: null, text: "" } }))).toBe("bad");
  expect(attemptTone(attempt({ outcome: { tone: "closed", end: "dissolved", text: "" }, ended: "dissolved" }))).toBe("closed");
  expect(attemptTone(attempt({ outcome: { tone: "calm", end: null, text: "" } }))).toBe("none");
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

describe("the list keeps what did not move", () => {
  const issue = (h: Partial<CauseHistory>, over: Partial<LineIssue> = {}) =>
    ({ id: "t1", title: "Intro sent twice", ref: "ct-1", where: { text: "Open" }, findings: 2, status: "open", runs: [], history: history(h), ...over }) as unknown as LineIssue;
  const occ = [{ at: NOW - 2 * DAY, reopened: false }, { at: NOW - DAY, reopened: false }];
  test("a row's signature holds across a rebuild and moves with anything the row draws", () => {
    const base = problemRowSig(issue({ occurrences: occ }), "open");
    expect(problemRowSig(issue({ occurrences: occ.map((o) => ({ ...o })) }), "open")).toBe(base);
    expect(problemRowSig(issue({ occurrences: [...occ, { at: NOW, reopened: false }] }), "open")).not.toBe(base);
    expect(problemRowSig(issue({ occurrences: occ }), "regressed")).not.toBe(base);
    expect(problemRowSig(issue({ occurrences: occ }, { where: { text: "Being fixed" } } as Partial<LineIssue>), "open")).not.toBe(base);
    expect(problemRowSig(issue({ occurrences: occ, attempts: [attempt({ live: true })] }), "open")).not.toBe(problemRowSig(issue({ occurrences: occ, attempts: [attempt({})] }), "open"));
    // An occurrence that came back after a fix draws red: the same times, another signature.
    const regs = [{ afterRunId: "r1", at: NOW - DAY, count: 1, basis: "ship" as const, liveAt: NOW - 1.5 * DAY, until: null, words: "" }];
    expect(problemRowSig(issue({ occurrences: occ, regressions: regs }), "open")).not.toBe(base);
  });
  test("a sparkline's window ends on the next whole hour, or the next local midnight for day-wide bars", () => {
    expect(sparkEnd(NOW, HOUR)).toBe(new Date(2026, 9, 9, 16, 0).getTime());
    expect(sparkEnd(NOW, DAY)).toBe(new Date(2026, 9, 10).getTime());
    expect(sparkEnd(NOW, 3 * DAY)).toBe(new Date(2026, 9, 10).getTime());
    expect(sparkEnd(NOW + 10 * 60_000, HOUR)).toBe(sparkEnd(NOW, HOUR));
  });
});
