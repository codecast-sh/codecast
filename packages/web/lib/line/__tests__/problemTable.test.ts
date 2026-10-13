// The Problems table (line-journeys.md LJ8.2): the nine statuses partition the
// problems, each chip counts the rows it opens, and the table groups, folds and
// sorts as the page draws it. The five-way status under them is the reading
// the older surfaces still use.
import { describe, expect, test } from "bun:test";
import { problemSources } from "../stepRuns";
import type { CauseHistory, HistoryAttempt } from "../causeHistory";
import type { LineIssue } from "../lineModel";
import { buildProblemRows, problemListName, filterProblems, problemNow, problemOrder, problemSections, problemStatus, rowTrend, shownOrder, statusCounts, waitingWhy } from "../problemTable";
import { fixOut, problemStand, STATUS_ORDER, type ProblemFacts, type StatusKey } from "../problemStatus";
import { overviewWindow } from "../problemsOverview";
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


// ── the nine-way partition ───────────────────────────────────────────────────

const task = (over: Record<string, unknown> = {}) => ({ status: "open", readiness: "ready", goal_ref: "g-1", assignee: null, workflow_run_id: null, cause: { signal_count: 2, first_seen: 0, last_seen: 0, fingerprints: [] }, ...over }) as ProblemFacts["task"];
const stand = (i: LineIssue, f: ProblemFacts = {}) => problemStand(i, f, NOW);
const merge = { sha: "abc1234", branch: "line/x", into: "main", at: NOW - 4 * DAY, prUrl: null, repository: null };
const shipped = (deploys: unknown[] = [], extra: Partial<CauseHistory> = {}): Partial<CauseHistory> => ({
  attempts: [attempt({ ended: "shipped", merge })],
  ships: [{ runId: "r1", at: NOW - 4 * DAY, merge, deploys, liveAt: NOW - 4 * DAY, basis: deploys.length ? "deploy" : "merge", words: "" }] as never,
  closes: [{ runId: "r1", n: 1, kind: "shipped", at: NOW - 4 * DAY, step: "watch", back: null, fold: null }],
  ...extra,
});
const deploy = { id: "d1", at: NOW - 3 * DAY, sha: "abc1234", target: "prod", version: null, source: "codecast", title: "", url: null, runId: "r1", how: "same commit" };

describe("problemStand: one status a problem, first match wins", () => {
  test("what the viewer can answer comes first, in the act's words", () => {
    const live = issue("a", { h: { attempts: [attempt({ live: true, end: null })] } });
    expect(stand(live, { need: { kind: "decision", mine: true } })).toEqual({ status: "you", phrase: "Fix to decide" });
    expect(stand(issue("a"), { need: { kind: "confirm", mine: true } }).phrase).toBe("New: is this real?");
    expect(stand(issue("a"), { need: { kind: "question", mine: true } }).phrase).toBe("Question for you");
    expect(stand(issue("a", { h: { attempts: [attempt({ ended: "parked" })] } }), { need: { kind: "question", mine: true } }).phrase).toBe("Question for you");
  });
  test("a decision open on the newest run that is not the viewer's waits on someone else", () => {
    const card = { decisionId: "d", ref: "sd-615", headline: null, change: null, wrong: null, recommend: null, status: "pending", answer: null, note: null, answeredAt: null } as never;
    expect(stand(issue("a", { h: { attempts: [attempt({ live: true, end: null, card })] } }))).toEqual({ status: "others", phrase: "Waiting on someone else" });
    expect(stand(issue("a"), { need: { kind: "decision", mine: false } }).status).toBe("others");
    // A finished run whose fix is with a reviewer is a person's turn too, never "not started".
    expect(stand(issue("a", { status: "in_review", h: { attempts: [attempt({})] } }), { task: task({ status: "in_review" }) })).toEqual({ status: "others", phrase: "In review" });
  });
  test("a need nobody can answer in place needs a new ask, and is never a failure", () => {
    expect(stand(issue("a"), { need: { kind: "lapsed", mine: true } })).toEqual({ status: "newask", phrase: "Asked, no answer" });
    expect(stand(issue("a"), { need: { kind: "stopped", mine: true, step: "Prove" }, failed: { key: "deadend:prove", label: "x", step: "Prove" } })).toEqual({ status: "newask", phrase: "Stopped at Prove: needs your yes" });
    expect(stand(issue("a"), { need: { kind: "reask", mine: true } }).phrase).toBe("Needs a new ask");
    // A live run paused for an answer nobody was asked is not "running".
    expect(stand(issue("a", { h: { attempts: [attempt({ live: true, end: null, outcome: { tone: "waiting", end: null, text: "" } as never })] } })).status).toBe("newask");
  });
  test("a failed run names its step and carries its cause; a silent run says how long", () => {
    expect(stand(issue("a"), { failed: { key: "check:prove", label: "Prove gave no result", step: "Prove" } })).toEqual({ status: "failed", phrase: "Failed at Prove", cause: { key: "check:prove", label: "Prove gave no result" } });
    expect(stand(issue("a", { h: { attempts: [attempt({ live: true, end: null })] } }), { silent: { since: NOW - 2 * 3_600_000 } }).phrase).toBe("No progress for 2h");
    // A run that handed the problem back with nothing to answer (ct-57459) is not "waiting on you": it says what it refused.
    const notes = [{ author: "Aivery", text: "Refine refused: the eviction guard tripped. 107 of 246 cluster members reject C119 (e.g. 3e986cf9), so the cluster is an umbrella. Nothing was written.", created_at: NOW - 4 * DAY + 1000 }];
    const handed = issue("a", { status: "in_review", h: { attempts: [attempt({ outcome: { tone: "waiting", end: null, text: "Handed to a person at Refine." } as never })] } });
    expect(stand(handed, { task: task({ status: "in_review" }), notes })).toEqual({ status: "failed", phrase: "Escalated at Refine: 107 of 246 findings reject the cause", cause: { key: "escalated:refine", label: "Refine handed it back" } });
  });
  test("a live run says the stage it is in", () => {
    const live = issue("a", { h: { attempts: [attempt({ live: true, end: null })] } });
    expect(stand(live, { stage: "build" })).toEqual({ status: "running", phrase: "Building" });
    expect(stand(live).phrase).toBe("Running");
  });
  test("only a fix a deploy carried is in production; merged is its own status", () => {
    const known = stand(issue("a", { h: shipped([], { coverage: { state: "known", targets: ["prod"], words: "" } }) }));
    expect(known.status).toBe("merged");
    expect(known.phrase).toMatch(/^Merged \w+ \d+, not in production$/);
    expect(stand(issue("a", { h: shipped() })).phrase).toMatch(/^Merged \w+ \d+$/);
    // Approved and never merged is not under Merged: nothing landed (ct-57509).
    const approved = { attempts: [attempt({ ended: "shipped" })], ships: [{ runId: "r1", at: NOW - 4 * DAY, merge: null, deploys: [], liveAt: null, basis: "ship", words: "" }] as never };
    const unmerged = stand(issue("a", { h: shipped([], approved) }));
    expect(unmerged.status).toBe("approved");
    expect(unmerged.phrase).toMatch(/^Approved \w+ \d+, not merged$/);
    const live = stand(issue("a", { status: "done", h: shipped([deploy]) }));
    expect(live.status).toBe("shipped");
    expect(live.quiet).toBe(true);
    expect(live.phrase).toMatch(/^In production \w+ \d+, quiet$/);
    const watching = stand(issue("a", { h: shipped([deploy], { watches: [{ runId: "r1", start: NOW - 3 * DAY, end: NOW + 4 * DAY, state: "watching", reopenedAt: null }] }) }));
    expect(watching.phrase).toMatch(/^In production \w+ \d+, watching until /);
    const back = stand(issue("a", { h: shipped([deploy], { regressed: true, regressions: [{ afterRunId: "r1", at: NOW - DAY, count: 2, basis: "deploy", liveAt: NOW - 3 * DAY, until: null, words: "", quote: null }] }) }));
    expect(back.status).toBe("shipped");
    expect(back.quiet).toBe(false);
    expect(back.phrase).toMatch(/^In production \w+ \d+, 2 since$/);
  });
  test("a run that only went on past an unanswered decision shipped nothing", () => {
    const h = { attempts: [attempt({ ended: "shipped", unapproved: true })], ships: [{ runId: "r1", at: NOW, merge: null, deploys: [], liveAt: NOW, basis: "ship", words: "" }] as never, closes: [{ runId: "r1", n: 1, kind: "shipped" as const, at: NOW, step: "watch", back: null, fold: null }] };
    expect(fixOut(history(h))).toBeNull();
  });
  test("closed without a fix is closed while it stays quiet; one that came back is not", () => {
    const closes = [{ runId: "r1", n: 1, kind: "dissolved" as const, at: NOW - 3 * DAY, step: "dissolve", back: null, fold: null }];
    expect(stand(issue("a", { status: "done", h: { closes } })).status).toBe("closed");
    expect(stand(issue("a", { status: "dropped" }))).toEqual({ status: "closed", phrase: "Closed" });
    expect(stand(issue("a", { status: "done", h: { closes, cameBack: true } }), { task: task({ status: "done" }) })).toEqual({ status: "notstarted", phrase: "Returned after it was closed", ready: false });
  });
  test("not started says ready or queued, or the one thing that blocks it", () => {
    expect(stand(issue("a"), { task: task() })).toEqual({ status: "notstarted", phrase: "Ready: no line set up", ready: true });
    expect(stand(issue("a"), { task: task(), lineOn: false }).phrase).toBe("Ready: line off");
    expect(stand(issue("a"), { task: task(), lineOn: true }).phrase).toBe("Queued");
    const blocked = (over: Record<string, unknown>, f: ProblemFacts = {}) => stand(issue("a"), { task: task(over), ...f });
    expect(blocked({ readiness: null })).toEqual({ status: "notstarted", phrase: "Not grounded yet", ready: false });
    expect(blocked({ readiness: "not_actionable" }).phrase).toBe("Nothing to change");
    expect(blocked({ goal_ref: "" }).phrase).toBe("Needs a goal");
    expect(blocked({ assignee: "u2" }, { assigneeName: "Dana" }).phrase).toBe("Assigned to Dana");
    expect(blocked({ readiness: "needs_context" }, { awaitsFindings: true }).phrase).toBe("Waiting for more findings (has 2)");
    expect(blocked({ workflow_run_id: "r0" }).phrase).toBe("Held by an earlier run");
    // A run parked it because main already carries the fix (ct-59687): one state, the park record's, everywhere.
    const parked = stand(issue("a", { h: { attempts: [attempt({ ended: "parked" })] } }), { task: task({ readiness: "not_actionable", workflow_run_id: "r1", readiness_note: "Already fixed on main by fc0d85ba65 (classifies both files); CI on it in progress" }) });
    expect(parked).toEqual({ status: "notstarted", phrase: "Already fixed on main (fc0d85b)", ready: false });
  });
});

describe("the table", () => {
  const win = overviewWindow("7d", NOW);
  const occ = (...daysAgo: number[]) => daysAgo.sort((a, b) => b - a).map((d) => ({ at: NOW - d * DAY - 60_000 })) as never;
  const issues = [
    issue("1", { title: "Sender changes mid-thread", h: { occurrences: occ(1, 2, 3), attempts: [attempt({ live: true, end: null })] } }),
    issue("2", { title: "Missed call saved as voicemail", h: { occurrences: occ(0.5, 9, 10, 11) } }),
    issue("3", { title: "Eval gate never runs", status: "dropped", h: { occurrences: occ(20) } }),
    issue("4", { title: "Broker notice goes to nobody", h: { occurrences: occ(2, 2) } }),
    issue("5", { title: "Analyze dies", h: { occurrences: occ(4) } }),
    issue("6", { title: "Analyze dies again", h: { occurrences: occ(5, 6) } }),
    issue("7", { title: "Ungrounded thing", h: { occurrences: occ(3) } }),
    issue("8", { title: "Fixed and live", status: "done", h: { ...shipped([deploy]), occurrences: occ(12) } }),
  ];
  const facts: Record<string, ProblemFacts> = {
    "2": { need: { kind: "decision", mine: true } },
    "4": { task: task() },
    "5": { failed: { key: "check:analyze", label: "Analyze ended with no result", step: "Analyze" } },
    "6": { failed: { key: "check:analyze", label: "Analyze ended with no result", step: "Analyze" } },
    "7": { task: task({ readiness: null }) },
  };
  const project: Record<string, string> = { "4": "p1", "7": "p1", "1": "p2" };
  const rows = buildProblemRows(issues, {
    win, now: NOW, facts: (id) => facts[id] ?? {}, projectOf: (id) => project[id] ?? null, projectName: (id) => (id === "p1" ? "Callers" : id === "p2" ? "Broker" : ""),
    sources: problemSources([{ task_id: "1", source: "AgentWatch", judge: "Quality" }]),
    overlaps: new Map([["6", { primary: "5", primaryRef: "ct-5", set: ["5", "6"], rule: null, defect: ["5", "6"] } as never]]),
  });
  const all = { status: null, quiet: false, q: "" };
  const name = (id: string | null) => (id === "p1" ? "Callers" : "");

  test("every problem has exactly one status, and the chips sum to All", () => {
    const c = statusCounts(rows);
    expect(c.all).toBe(issues.length);
    expect(STATUS_ORDER.reduce((n, s) => n + c.by[s], 0)).toBe(c.all);
    expect(c.by).toEqual({ you: 1, others: 0, newask: 0, failed: 2, running: 1, notstarted: 2, approved: 0, merged: 0, shipped: 1, closed: 1 });
    // A chip's count is the rows it opens.
    for (const s of STATUS_ORDER) expect(filterProblems(rows, { ...all, status: s })).toHaveLength(c.by[s]);
    expect(filterProblems(rows, { status: "shipped", quiet: true, q: "" }).map((r) => r.id)).toEqual(["8"]);
  });

  test("findings are the window's, with an arrow against the window before", () => {
    const by = new Map(rows.map((r) => [r.id, r]));
    expect([by.get("1")!.inWindow, by.get("1")!.before, rowTrend(by.get("1")!)]).toEqual([3, 0, "up"]);
    expect([by.get("2")!.inWindow, by.get("2")!.before, rowTrend(by.get("2")!)]).toEqual([1, 3, "down"]);
    expect(rowTrend(by.get("3")!)).toBeNull();
    // A series that does not reach back over the window before has nothing to compare with.
    const capped = buildProblemRows([issue("c", { h: { occurrences: occ(1), capped: true, since: NOW - 8 * DAY } })], { win, now: NOW, facts: () => ({}), projectOf: () => null, projectName: () => "" })[0];
    expect([capped.before, rowTrend(capped)]).toEqual([null, null]);
    expect(by.get("6")!.dupOf).toBe("ct-5");
  });

  test("under All the groups follow the chips; Failed is by cause; Not started and Closed fold to a heading", () => {
    const s = problemSections(rows, all, null, name);
    expect(s.map((x) => [x.status, x.n, x.folded])).toEqual([["you", 1, false], ["failed", 2, false], ["running", 1, false], ["notstarted", 2, true], ["shipped", 1, false], ["closed", 1, true]]);
    expect(s.reduce((n, x) => n + x.n, 0)).toBe(issues.length);
    const failed = s.find((x) => x.status === "failed")!;
    // One outage across two problems is one heading.
    expect(failed.subs!.map((b) => [b.label, b.rows.map((r) => r.id)])).toEqual([["Analyze ended with no result", ["6", "5"]]]);
    // Prev and next walk every row under the filter; J and K only the rows drawn.
    expect(problemOrder(s)).toEqual(["2", "6", "5", "1", "4", "7", "8", "3"]);
    expect(shownOrder(s)).toEqual(["2", "6", "5", "1", "8"]);
  });

  test("Not started is a page by project: ready plus blocked is the rows beneath", () => {
    const [s] = problemSections(rows, { ...all, status: "notstarted" }, null, name);
    expect(s.folded).toBe(false);
    expect(s.subs!.map((b) => [b.label, b.projectId, b.ready, b.blocked, b.rows.length])).toEqual([["Callers", "p1", 1, 1, 2]]);
    expect(s.subs!.every((b) => b.ready! + b.blocked! === b.rows.length)).toBe(true);
    expect(s.rows.map((r) => r.stand.phrase)).toEqual(["Ready: no line set up", "Not grounded yet"]);
  });

  test("a column sorts the whole list flat; the search matches the title, ref, project and source, and opens folded groups", () => {
    const flat = problemSections(rows, all, "findings", name);
    expect(flat).toHaveLength(1);
    expect(flat[0].status).toBeNull();
    expect(flat[0].rows.map((r) => r.id).slice(0, 3)).toEqual(["1", "4", "6"]);
    expect(problemSections(rows, all, "last", name)[0].rows[0].id).toBe("2");
    expect(filterProblems(rows, { ...all, q: "ct-4" }).map((r) => r.id)).toEqual(["4"]);
    expect(filterProblems(rows, { ...all, q: "agentwatch" }).map((r) => r.id)).toEqual(["1"]);
    expect(filterProblems(rows, { ...all, q: "callers" }).map((r) => r.id).sort()).toEqual(["4", "7"]);
    expect(statusCounts(rows, "analyze").by.failed).toBe(2);
    expect(problemSections(rows, { ...all, q: "eval gate" }, null, name).map((x) => [x.status, x.folded])).toEqual([["closed", false]]);
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
    expect(problemNow({ history: h })).toEqual(["#1", "merged", "not deployed", "card unanswered"]);
  });
  test("where no deploys are recorded at all, a merge is as live as it gets", () => {
    const a = attempt({ merge, ended: "shipped" });
    const h = history({ attempts: [a], ships: [ship] as never });
    expect(attemptVerdict(a, h)).toEqual({ word: "merged", tone: "ok" });
  });
});

describe("problemListName", () => {
  test("a written name wins over the title", () => {
    expect(problemListName({ title: "Not met: a long judge sentence ".repeat(5), name: "Grader scores calls off a gappy transcript" })).toBe("Grader scores calls off a gappy transcript");
  });
  test("a long title is cut at a whole sentence or clause, never mid-word, with id asides dropped", () => {
    const keith = "Not met: Call grader scored Keith Conrad's Zoom (call 0b30cb37) off a transcript missing 03:38-09:00, so it critiques an ask the caller did make, though the caller said so";
    const name = problemListName({ title: keith });
    expect(name).not.toContain("0b30cb37");
    expect(name.length).toBeLessThanOrEqual(91);
    expect(name).toBe("Call grader scored Keith Conrad's Zoom off a transcript missing 03:38-09:00…");
    const samvit = "Samvit's ruling (#team thread 1791598261.885089, Oct 10 04:35Z): the prompt lets the agent offer a fee range the policy forbids, and nobody caught it for a week";
    expect(problemListName({ title: samvit })).toBe("Samvit's ruling: the prompt lets the agent offer a fee range the policy forbids…");
    expect(problemListName({ title: "Analyze dies before it reads the call" })).toBe("Analyze dies before it reads the call");
    // An "e.g." inside an aside is no sentence end, and a cut never leaves an aside open.
    expect(problemListName({ title: "Revival call prep had Rob re-ask Lana Nieves things she had already answered (e.g. her budget and timing), and the card never showed it" })).toBe("Revival call prep had Rob re-ask Lana Nieves things she had already answered…");
    expect(problemListName({ title: "Call brief put a review-only name (Jeff Londis, from the expert's notes) into the caller's script, and Rob read it out" })).toBe("Call brief put a review-only name into the caller's script, and Rob read it out");
    expect(problemListName({ title: "Call grader scored Keith Conrad's Zoom off a transcript missing 03:38-09:00 (the live-feed dropped those minutes) and docked him" })).toBe("Call grader scored Keith Conrad's Zoom off a transcript missing 03:38-09:00 and docked him");
  });
});
