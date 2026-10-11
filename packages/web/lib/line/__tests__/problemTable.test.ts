// The Problems table (line-workspace.md LW1 Problems): the five-way status a
// person acts on, sources counted from findings, and the filters and sorts.
import { describe, expect, test } from "bun:test";
import type { CauseHistory, HistoryAttempt } from "../causeHistory";
import type { LineIssue } from "../lineModel";
import { buildProblemRows, filterProblems, NO_FILTER, problemCounts, problemNow, problemStatus, sortProblemRows, waitingWhy } from "../problemTable";
import { attemptVerdict, problemState, shownWatches } from "../timeline";

const NOW = new Date(2026, 9, 9, 15, 30).getTime();
const DAY = 86_400_000;

const attempt = (over: Partial<HistoryAttempt>): HistoryAttempt => ({
  runId: "r1", n: 1, start: NOW - 5 * DAY, end: NOW - 4 * DAY, live: false, outcome: { tone: "calm", end: null, text: "" }, ended: null, superseded: false,
  endStep: null, unapproved: false, found: null, proposed: null, built: null, card: null, diff: null, merge: null, argued: null, ...over,
} as HistoryAttempt);

const history = (over: Partial<CauseHistory>): CauseHistory => ({
  occurrences: [], occurrencesFrom: "history", since: null, capped: false, attempts: [], ships: [], deploys: [],
  coverage: { state: "none", targets: [], words: "" }, watches: [], regressions: [], closes: [], recurrences: [], regressed: false, cameBack: false, firstAt: null, lastActivity: 0, ...over,
} as CauseHistory);

const issue = (id: string, over: Partial<LineIssue> & { h?: Partial<CauseHistory> } = {}): LineIssue => ({
  id, ref: `ct-${id}`, title: `Problem ${id}`, status: "open", findings: 1, quotes: [], runs: [], lastRunAt: 0,
  where: { tone: "calm", end: null, text: "" }, history: history(over.h ?? {}), ...over,
} as LineIssue);

const status = (i: LineIssue) => problemStatus(i, problemState(i.history, i.status));

describe("problemStatus", () => {
  test("a live attempt is running, even on a problem that regressed", () => {
    expect(status(issue("a", { h: { attempts: [attempt({ live: true, end: null })] } }))).toBe("running");
    expect(status(issue("a", { h: { regressed: true, attempts: [attempt({ live: true, end: null })] } }))).toBe("running");
  });
  test("a run stopped for a person, or a ship past an unanswered card, waits on you", () => {
    expect(status(issue("a", { h: { attempts: [attempt({ outcome: { tone: "waiting", end: null, text: "Waiting" } as any })] } }))).toBe("waiting");
    const ship = { runId: "r1", at: NOW - 4 * DAY, merge: null, deploys: [], liveAt: NOW - 4 * DAY, basis: "ship" as const, words: "" };
    const unapproved = { attempts: [attempt({ ended: "shipped", unapproved: true })], ships: [ship], closes: [{ runId: "r1", n: 1, kind: "shipped" as const, at: ship.liveAt, step: "watch", back: null, fold: null }] };
    expect(status(issue("a", { h: unapproved }))).toBe("waiting");
    expect(status(issue("a", { status: "in_review" }))).toBe("waiting");
    // Not started because the line is off is open, not the person's.
    expect(status(issue("a", { where: { tone: "waiting", end: null, text: "Not started: the line is off." } as any }))).toBe("open");
  });
  test("a shipped fix under watch is watching; once held or closed it is closed; otherwise open", () => {
    const ship = { runId: "r1", at: NOW - 4 * DAY, merge: null, deploys: [], liveAt: NOW - 4 * DAY, basis: "ship" as const, words: "" };
    const shipped = { attempts: [attempt({ ended: "shipped" })], ships: [ship], closes: [{ runId: "r1", n: 1, kind: "shipped" as const, at: ship.liveAt, step: "watch", back: null, fold: null }] };
    expect(status(issue("a", { h: { ...shipped, watches: [{ runId: "r1", start: NOW - 4 * DAY, end: NOW + DAY, state: "watching", reopenedAt: null }] } }))).toBe("watching");
    expect(status(issue("a", { status: "done", h: shipped }))).toBe("closed");
    expect(status(issue("a", { status: "dropped" }))).toBe("closed");
    expect(status(issue("a"))).toBe("open");
    expect(status(issue("a", { h: { regressed: true, attempts: [attempt({ ended: "shipped" })] } }))).toBe("open");
  });
});

test("waitingWhy names what the person opens: a card, a question, a review, a ship nobody approved", () => {
  const why = (i: LineIssue) => waitingWhy(i, status(i));
  const card = { decisionId: "d", ref: "sd-1", headline: null, change: null, wrong: null, recommend: null, status: "pending", answer: null, note: null, answeredAt: null };
  expect(why(issue("a", { h: { attempts: [attempt({ outcome: { tone: "waiting" } as any, card })] } }))).toBe("card");
  expect(why(issue("a", { h: { attempts: [attempt({ outcome: { tone: "waiting" } as any })] } }))).toBe("question");
  expect(why(issue("a", { status: "in_review" }))).toBe("in review");
  expect(why(issue("a"))).toBeNull();
});

describe("rows, filters and sorts", () => {
  const issues = [
    issue("1", { title: "Sender changes", findings: 4, h: { lastActivity: NOW - DAY, attempts: [attempt({ live: true, end: null })], occurrences: [{ at: NOW - 3 * DAY, reopened: false }, { at: NOW - 2 * DAY, reopened: false }], recurrences: [{ afterRunId: "r0", n: 1, kind: "dissolved", closedAt: NOW - 4 * DAY, at: NOW - 3 * DAY, count: 2, until: null } as any] } }),
    issue("2", { title: "Accounts drift", findings: 1, h: { lastActivity: NOW - 3 * DAY } }),
    issue("3", { title: "Old thing", status: "done", findings: 9, h: { lastActivity: NOW - 9 * DAY }, quotes: [{ text: "x", source: "person", ref: null }] }),
  ];
  const signals = [
    { task_id: "1", source: "agentwatch" }, { task_id: "1", source: "agentwatch" }, { task_id: "1", source: "sentry" },
    { task_id: "2", source: "sentry" },
  ];
  const rows = buildProblemRows(issues, signals, [{ _id: "1", project_id: "p1" }, { _id: "2", project_id: null }]);

  test("each row carries its sources most first, its project, its came-back count and findings", () => {
    expect(rows[0].sources.map((s) => [s.key, s.n])).toEqual([["agentwatch", 2], ["sentry", 1]]);
    expect(rows[0].sources[0].label).toBe("AgentWatch");
    expect(rows[0].projectId).toBe("p1");
    expect(rows[0].back).toBe(2);
    expect(rows[0].status).toBe("running");
    // A problem whose findings are not in view takes its sources from the quotes the model kept.
    expect(rows[2].sources.map((s) => s.key)).toEqual(["person"]);
    expect(rows[2].findings).toBe(9);
  });

  test("filters narrow by status, source, came back and words; counts say what a click shows", () => {
    expect(filterProblems(rows, { ...NO_FILTER, status: "closed" }).map((r) => r.id)).toEqual(["3"]);
    expect(filterProblems(rows, { ...NO_FILTER, source: "sentry" }).map((r) => r.id)).toEqual(["1", "2"]);
    expect(filterProblems(rows, { ...NO_FILTER, status: "active" }).map((r) => r.id)).toEqual(["1", "2"]);
    expect(filterProblems(rows, { ...NO_FILTER, back: true }).map((r) => r.id)).toEqual(["1"]);
    expect(filterProblems(rows, { ...NO_FILTER, query: "ct-2" }).map((r) => r.id)).toEqual(["2"]);
    expect(filterProblems(rows, { ...NO_FILTER, query: "agentw" }).map((r) => r.id)).toEqual(["1"]);
    const c = problemCounts(rows, { ...NO_FILTER, source: "sentry" });
    expect(c.status.get("all")).toBe(2);
    expect(c.status.get("closed")).toBeUndefined();
    // The source counts ignore the source filter itself.
    expect(c.sources.map((s) => [s.key, s.n])).toEqual([["agentwatch", 1], ["person", 1], ["sentry", 2]].sort((a, b) => (b[1] as number) - (a[1] as number) || String(a[0]).localeCompare(String(b[0]))) as any);
    expect(c.back).toBe(1);
  });

  test("sorts by a column, ties to the newest", () => {
    expect(sortProblemRows(rows, { key: "last", desc: true }).map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(sortProblemRows(rows, { key: "findings", desc: true }).map((r) => r.id)).toEqual(["3", "1", "2"]);
    expect(sortProblemRows(rows, { key: "title", desc: false }).map((r) => r.id)).toEqual(["2", "3", "1"]);
    expect(sortProblemRows(rows, { key: "status", desc: false }).map((r) => r.status)).toEqual(["running", "open", "closed"]);
    expect(sortProblemRows(rows, { key: "back", desc: true })[0].id).toBe("1");
  });
});

describe("one outcome for a run that built a fix", () => {
  const merge = { sha: "abc1234", into: "main", at: NOW - 4 * DAY, prUrl: null };
  const ship = { runId: "r1", at: NOW - 4 * DAY, merge, deploys: [], liveAt: NOW - 4 * DAY, basis: "merge", words: "" };
  test("merged with deploys recorded and none carrying it reads merged, not deployed, and its watch is not drawn", () => {
    const a = attempt({ merge, ended: null, outcome: { tone: "failed", end: null, text: "Stopped at Watch." }, unapproved: true, card: { status: "withdrawn" } as never });
    const h = history({ attempts: [a], ships: [ship] as never, coverage: { state: "known", targets: ["prod"], words: "" }, watches: [{ runId: "r1", start: NOW - 4 * DAY, end: NOW + 3 * DAY, state: "watching", reopenedAt: null }] });
    expect(attemptVerdict(a, h)).toEqual({ word: "merged, not deployed", tone: "warn" });
    expect(shownWatches(h)).toEqual([]);
    expect(problemNow({ history: h })).toEqual(["#1", "merged, not deployed", "unapproved"]);
  });
  test("where no deploys are recorded at all, a merge is as live as it gets", () => {
    const a = attempt({ merge, ended: "shipped" });
    const h = history({ attempts: [a], ships: [ship] as never });
    expect(attemptVerdict(a, h)).toEqual({ word: "merged", tone: "ok" });
  });
});

describe("a source key from Sources filters problems", () => {
  const issue = { id: "t1", ref: "ct-1", title: "x", status: "open", findings: 1, quotes: [], runs: [], lastRunAt: 0, where: { tone: "calm", end: null, text: "" }, history: history({}), ask: null } as unknown as LineIssue;
  const rows = buildProblemRows([issue], [{ task_id: "t1", source: "AgentWatch", judge: "Quality" }], []);
  test("by source in any case, and by a judge under it", () => {
    expect(filterProblems(rows, { ...NO_FILTER, source: "agentwatch" })).toHaveLength(1);
    expect(filterProblems(rows, { ...NO_FILTER, source: "agentwatch/quality" })).toHaveLength(1);
    expect(filterProblems(rows, { ...NO_FILTER, source: "agentwatch/comms" })).toHaveLength(0);
  });
});
