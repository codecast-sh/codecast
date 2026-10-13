import { expect, test } from "bun:test";
import { bucketAt, buildOverview, changeWords, overviewWindow, problemFigures, TIP_PROBLEMS } from "../problemsOverview";

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
  expect(f).toEqual({ findings: 18, before: 22, inProduction: 2, quiet: 1 });
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
