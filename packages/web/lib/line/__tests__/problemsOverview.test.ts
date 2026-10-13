import { expect, test } from "bun:test";
import { bucketAt, buildOverview, changeWords, finderShifts, leadChange, overviewWindow, problemFigures, TIP_PROBLEMS } from "../problemsOverview";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 12, 15, 30).getTime();

const history = (times: number[], extra: Record<string, unknown> = {}) => ({
  occurrences: times.sort((a, b) => a - b).map((at) => ({ at })), attempts: [], ships: [], closes: [], regressions: [], recurrences: [], watches: [], deploys: [], ...extra,
}) as never;
const issue = (id: string, times: number[], extra?: Record<string, unknown>) => ({ id, ref: `ct-${id}`, title: `Problem ${id}`, history: history(times, extra) });

test("a bar is a day, or an hour of the last day; the window ends on the next whole bucket", () => {
  const w = overviewWindow("24h", NOW);
  expect(w.step).toBe(HOUR);
  expect(w.d1).toBe(new Date(2026, 9, 12, 16).getTime());
  expect(w.n).toBe(24);
  const week = overviewWindow("7d", NOW);
  expect([week.step, week.n, week.d1]).toEqual([DAY, 7, new Date(2026, 9, 13).getTime()]);
  expect(overviewWindow("30d", NOW).n).toBe(30);
});

test("each bar holds its findings and names its busiest problems; the rest are one count, and the bars add up", () => {
  const w = overviewWindow("24h", NOW);
  // Problem i has i+1 findings, all in the newest hour.
  const at = NOW - 60_000;
  const issues = Array.from({ length: TIP_PROBLEMS + 2 }, (_, i) => issue(String(i), Array.from({ length: i + 1 }, () => at)));
  // One finding outside the window counts nowhere.
  issues.push(issue("old", [NOW - 3 * DAY]));
  const o = buildOverview(issues, w);
  const last = o.buckets[o.buckets.length - 1];
  expect(last.top.map((t) => [t.id, t.n])).toEqual([["4", 5], ["3", 4], ["2", 3]]);
  expect(last.rest).toBe(1 + 2);
  expect(o.total).toBe(15);
  expect(o.total).toBe(o.buckets.reduce((n, b) => n + b.total, 0));
  expect(o.max).toBe(15);
});

test("a picked bar is read back only when it starts a bar of this window", () => {
  const w = overviewWindow("7d", NOW);
  expect(bucketAt(w, w.d0 + DAY)).toEqual({ from: w.d0 + DAY, to: w.d0 + 2 * DAY });
  expect(bucketAt(w, w.d0 + HOUR)).toBeNull();
  expect(bucketAt(w, w.d1)).toBeNull();
  expect(bucketAt(w, null)).toBeNull();
});

test("a fix is marked where it went out: in production when a deploy carried it, else merged; an unanswered ship is no fix", () => {
  const w = overviewWindow("7d", NOW);
  const ship = (runId: string, extra: Record<string, unknown>) => ({ runId, at: NOW - 2 * DAY, merge: null, deploys: [], ...extra });
  const o = buildOverview([
    issue("a", [], { ships: [ship("r1", { merge: { at: NOW - 2 * DAY }, deploys: [{ at: NOW - DAY }] })] }),
    issue("b", [], { ships: [ship("r2", { merge: { at: NOW - 3 * DAY } })] }),
    issue("c", [], { ships: [ship("r3", {})], attempts: [{ runId: "r3", unapproved: true, merge: null }] }),
    issue("d", [], { ships: [ship("r4", { merge: { at: NOW - 40 * DAY }, at: NOW - 40 * DAY })] }),
  ], w);
  expect(o.markers.map((m) => [m.problemId, m.kind])).toEqual([["b", "merged"], ["a", "production"]]);
});

test("the figures count the rows their filters open, and compare the window with the one before", () => {
  const row = (status: string, inWindow: number, before: number | null, quiet = false, series = true) => ({ stand: { status, quiet } as never, inWindow, before, series });
  const f = problemFigures([row("shipped", 2, 4, true), row("shipped", 3, 1), row("merged", 0, 2), row("running", 13, 15)]);
  expect(f).toEqual({ findings: 18, before: 22, problems: 3, problemsBefore: 4, fresh: 0, inProduction: 2, quiet: 1 });
  // A problem with no series (in no project) adds nothing: what the store holds of it changes between loads.
  expect(problemFigures([row("running", 13, 15), row("closed", 80, 40, false, false)])).toMatchObject({ findings: 13, before: 15 });
  expect(changeWords(f, "7d")).toEqual({ words: "18% fewer than the week before", tone: "better" });
  expect(changeWords({ findings: 30, before: 20 }, "24h")).toEqual({ words: "50% more than the day before", tone: "worse" });
  expect(changeWords({ findings: 5, before: 5 }, "30d")?.words).toBe("same as the 30 days before");
  // One series that does not reach back far enough, and there is nothing honest to compare with.
  expect(problemFigures([row("running", 3, 2), row("running", 1, null)]).before).toBeNull();
  expect(changeWords({ findings: 4, before: null }, "7d")).toBeNull();
  // None in the window says what came before, never "100% fewer"; none either side says nothing.
  expect(changeWords({ findings: 0, before: 12 }, "7d")).toEqual({ words: "12 the week before", tone: "better" });
  expect(changeWords({ findings: 0, before: 0 }, "7d")).toBeNull();
});

// Real shape (Union, Oct 13): 1067 findings in 7d read "144% more than the week before" in red while the bars fell
// ~10x after Oct 9, because the evals finder filed 293 by Oct 9 and none after, and AgentWatch comms stopped Oct 9.
test("a finder that stopped or ran far less is named from the bar it affects; the lead counts problems, not findings", () => {
  const now = Date.UTC(2026, 9, 13, 15);
  const win = overviewWindow("7d", now);
  const day = (i: number) => win.d0 + i * win.step + 3_600_000;
  const sig = (source: string, i: number, n: number, judge?: string) => Array.from({ length: n }, () => ({ source, judge, task_id: "t", created_at: day(i) }));
  const signals = [
    ...[36, 48, 205].flatMap((n, i) => sig("union.eval", i, n)),
    ...[32, 33, 2, 1, 1, 0, 0].flatMap((n, i) => sig("agentwatch", i, n, "comms")),
    ...[12, 19, 25, 29, 16, 12, 53].flatMap((n, i) => sig("union.escalation", i, n)),
  ];
  const s = finderShifts(signals, win);
  expect(s.map((f) => [f.key, f.kind, f.from, f.before])).toEqual([["union.eval", "stopped", 3, 289], ["agentwatch/comms", "less", 2, 65]]);
  // The steady finder is never named, and an hourly window names none.
  expect(finderShifts(signals, overviewWindow("24h", now))).toEqual([]);
  // One problem with 289 findings is one problem: the lead does not move with the volume.
  const row = (inWindow: number, before: number, first: number) => ({ stand: { status: "notstarted" } as never, inWindow, before, issue: { history: { occurrences: [{ at: first }] } } });
  expect(problemFigures([row(289, 0, day(0)), row(3, 2, win.d0 - 30 * win.step)], win)).toMatchObject({ findings: 292, problems: 2, problemsBefore: 1, fresh: 1 });
});

test("problems compare with the window before only when the finders filed alike; otherwise the words say how they filed", () => {
  // Real: 1067 findings against 440 the week before, 554 problems against 244: the finders, not the product.
  expect(leadChange({ problems: 554, problemsBefore: 244, findings: 1067, before: 440 }, "7d")).toEqual({ words: "finders filed 2.4x more than the week before", tone: "same" });
  expect(leadChange({ problems: 30, problemsBefore: 40, findings: 300, before: 280 }, "7d")).toEqual({ words: "25% fewer than the week before", tone: "better" });
  expect(leadChange({ problems: 3, problemsBefore: null, findings: 9, before: null }, "7d")).toBeNull();
});

test("the lead follows the bars when the window's own rate moved the other way (2.5x more than the week before over bars that fall ~10x)", () => {
  const at = new Date(2026, 9, 10).getTime();
  // Oct 7-9 about 300 a day, Oct 10-13 about 30 a day: more than the week before, far fewer lately.
  const halves = { early: 900, late: 120, earlyN: 3, lateN: 4, at, step: 86_400_000 };
  expect(leadChange({ problems: 554, problemsBefore: 244, findings: 1020, before: 408, halves }, "7d")).toEqual({ words: "finders filed 10x fewer a day from Oct 10 on", tone: "same" });
  // The window agrees with the comparison: the comparison stands.
  expect(leadChange({ problems: 554, problemsBefore: 244, findings: 1020, before: 408, halves: { ...halves, early: 300, late: 720 } }, "7d")?.words).toBe("finders filed 2.5x more than the week before");
});
