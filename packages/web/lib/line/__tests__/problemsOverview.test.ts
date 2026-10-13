import { expect, test } from "bun:test";
import { buildOverview, changeWords, overviewWindow, problemFigures, TOP_PROBLEMS } from "../problemsOverview";

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

test("the five busiest problems get their own band, the rest share one; buckets add up", () => {
  const w = overviewWindow("24h", NOW);
  const issues = Array.from({ length: TOP_PROBLEMS + 2 }, (_, i) => issue(String(i), Array.from({ length: i + 1 }, (_, k) => NOW - k * HOUR - 60_000)));
  // One finding outside the window counts nowhere.
  issues.push(issue("old", [NOW - 3 * DAY]));
  const o = buildOverview(issues, w);
  expect(o.top.map((t) => t.id)).toEqual(["6", "5", "4", "3", "2"]);
  expect(o.other).toEqual({ n: 1 + 2, problems: 2 });
  expect(o.total).toBe(Array.from({ length: TOP_PROBLEMS + 2 }, (_, i) => i + 1).reduce((a, b) => a + b, 0));
  expect(o.total).toBe(o.buckets.reduce((n, b) => n + b.byTop.reduce((a, c) => a + c, 0) + b.other, 0));
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
  const row = (status: string, inWindow: number, before: number | null, quiet = false) => ({ stand: { status, quiet } as never, inWindow, before });
  const f = problemFigures([row("shipped", 2, 4, true), row("shipped", 3, 1), row("merged", 0, 2), row("running", 13, 15)]);
  expect(f).toEqual({ findings: 18, before: 22, inProduction: 2, quiet: 1, merged: 1 });
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
