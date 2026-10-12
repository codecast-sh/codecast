import { expect, test } from "bun:test";
import { buildOverview, conversationsByProblem, fixStand, inFocus, overviewWindow, TOP_PROBLEMS } from "../problemsOverview";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 12, 15, 30).getTime();

const history = (times: number[], extra: Record<string, unknown> = {}) => ({
  occurrences: times.sort((a, b) => a - b).map((at) => ({ at })), attempts: [], ships: [], closes: [], regressions: [], recurrences: [], watches: [], deploys: [], ...extra,
}) as never;
const issue = (id: string, times: number[], extra?: Record<string, unknown>) => ({ id, ref: `ct-${id}`, title: `Problem ${id}`, history: history(times, extra) });

test("the window ends on the next whole bucket and holds the range in whole buckets", () => {
  const w = overviewWindow("24h", NOW);
  expect(w.step).toBe(HOUR);
  expect(w.d1).toBe(new Date(2026, 9, 12, 16).getTime());
  expect(w.n).toBe(24);
  expect(overviewWindow("7d", NOW).n).toBe(56);
  expect(overviewWindow("30d", NOW).n).toBe(60);
});

test("the busiest problems get their own band, the rest share one; buckets add up", () => {
  const w = overviewWindow("24h", NOW);
  const issues = Array.from({ length: TOP_PROBLEMS + 2 }, (_, i) => issue(String(i), Array.from({ length: i + 1 }, (_, k) => NOW - k * HOUR - 60_000)));
  // One finding outside the window counts nowhere.
  issues.push(issue("old", [NOW - 3 * DAY]));
  const o = buildOverview(issues, w);
  expect(o.top.map((t) => t.id)).toEqual(["7", "6", "5", "4", "3", "2"]);
  expect(o.other).toEqual({ n: 1 + 2, problems: 2 });
  expect(o.total).toBe(o.buckets.reduce((n, b) => n + b.byTop.reduce((a, c) => a + c, 0) + b.other, 0));
  expect(o.total).toBe(Array.from({ length: TOP_PROBLEMS + 2 }, (_, i) => i + 1).reduce((a, b) => a + b, 0));
});

test("closes and shipped fixes in the window become markers; a span or a band narrows the list", () => {
  const w = overviewWindow("7d", NOW);
  const shipped = issue("a", [NOW - 2 * DAY], {
    attempts: [{ runId: "r1", n: 1 }], ships: [{ runId: "r1", at: NOW - DAY, deploys: [], merge: { at: NOW - DAY } }],
    closes: [{ kind: "dissolved", at: NOW - 3 * DAY, n: 2, runId: "r0" }],
  });
  const o = buildOverview([shipped], w);
  expect(o.markers.map((m) => [m.kind, m.words])).toEqual([["close", "run #2 closed it without a change (dissolved)"], ["ship", "fix from run #1 merged"]]);
  expect(inFocus(shipped, { kind: "range", from: NOW - 3 * DAY, to: NOW - DAY })).toBe(true);
  expect(inFocus(shipped, { kind: "range", from: NOW - DAY, to: NOW })).toBe(false);
  expect(inFocus(shipped, { kind: "problem", id: "b" })).toBe(false);
});

test("conversations count distinct ones in the window; the fix stands by what waits, runs or shipped", () => {
  const sig = (task_id: string, at: number, moment: string) => ({ _id: `${task_id}${at}`, task_id, observed_at: at, moment });
  const m = conversationsByProblem([sig("a", NOW - HOUR, "c1"), sig("a", NOW - 2 * HOUR, "c1"), sig("a", NOW - 3 * HOUR, "c2"), sig("a", NOW - 9 * DAY, "c3")], (s) => s.moment, NOW - DAY, NOW);
  expect(m.get("a")).toBe(2);
  expect(fixStand(issue("x", []), { ref: "sd-1", trial: false })).toBe("waiting");
  expect(fixStand(issue("x", [], { attempts: [{ live: true }] }), null)).toBe("building");
  expect(fixStand(issue("x", [], { ships: [{ runId: "r" }] }), null)).toBe("shipped");
  expect(fixStand(issue("x", [], { attempts: [{ card: { answer: "Ship" } }] }), null)).toBe("answered");
  expect(fixStand(issue("x", []), null)).toBe("none");
});
