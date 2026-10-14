// The Problems table (line-journeys.md LJ8.2): the nine statuses partition the
// problems, each chip counts the rows it opens, and the table groups, folds and
// sorts as the page draws it. The five-way status under them is the reading
// the older surfaces still use.
import { describe, expect, test } from "bun:test";
import { problemSources } from "../stepRuns";
import type { CauseHistory, HistoryAttempt } from "../causeHistory";
import type { LineIssue } from "../lineModel";
import { buildProblemRows, emptyWays, problemListName, errorWords, filterProblems, problemNow, problemOrder, problemSections, problemStatus, rowTrend, shownOrder, statusCounts, waitingWhy } from "../problemTable";
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
    expect(stand(issue("a"), { need: { kind: "confirm", mine: true } }).phrase).toBe("New, not confirmed");
    // What a station asked before its run reached a decision waits on nobody: the problem is not started.
    expect(stand(issue("a"), { need: { kind: "question", mine: true } }).status).toBe("notstarted");
    expect(stand(issue("a"), { need: { kind: "question", mine: true } }).phrase).toBe("Holds on an open question");
    expect(stand(issue("a", { h: { attempts: [attempt({ ended: "parked" })] } }), { need: { kind: "question", mine: true } }).phrase).toBe("Holds on an open question");
  });
  test("a decision open on the newest run that is not the viewer's waits on someone else", () => {
    const card = { decisionId: "d", ref: "sd-615", headline: null, change: null, wrong: null, recommend: null, status: "pending", answer: null, note: null, answeredAt: null } as never;
    expect(stand(issue("a", { h: { attempts: [attempt({ live: true, end: null, card })] } }))).toEqual({ status: "others", phrase: "Waiting on someone else" });
    expect(stand(issue("a"), { need: { kind: "decision", mine: false } }).status).toBe("others");
    // In review is someone else's only when a person holds it: named, with how long.
    const held = stand(issue("a", { status: "in_review", h: { attempts: [attempt({})] } }), { task: task({ status: "in_review", assignee: "u2" }), assigneeName: "Dana" });
    expect(held.status).toBe("others");
    expect(held.phrase).toMatch(/^In review · Dana · \d+[smhd]$/);
    // Nobody holds it: the run ended and nothing was asked, so it needs a new ask (ct-57368, ct-59561 ...).
    const unheld = stand(issue("a", { status: "in_review", h: { attempts: [attempt({})] } }), { task: task({ status: "in_review" }) });
    expect(unheld.status).toBe("newask");
    expect(unheld.phrase).toMatch(/^Run ended( \w+ \d+)?, nothing asked$/);
  });
  test("a need nobody can answer in place needs a new ask, and is never a failure", () => {
    expect(stand(issue("a"), { need: { kind: "lapsed", mine: true } })).toEqual({ status: "newask", phrase: "Fix asked, unanswered", act: "ask" });
    expect(stand(issue("a"), { need: { kind: "stopped", mine: true, step: "Prove", ask: "Prove finished: go on to Build?" }, failed: { key: "deadend:prove", label: "x", step: "Prove" } })).toEqual({ status: "newask", phrase: "Prove finished: go on to Build?", act: "ask" });
    // Its row says why a new ask is needed, never the group's own name; a card no session asked is asked again.
    expect(stand(issue("a"), { need: { kind: "reask", mine: true, why: "No session asked this card, so there is nobody to answer" } })).toMatchObject({ phrase: "Card has no session to answer", act: "ask" });
    expect(stand(issue("a"), { need: { kind: "reask", mine: true, why: "The step this run waits at was removed from the line" } }).phrase).toBe("Card's step was removed");
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
  test("a build no session presented needs a new ask, never under Failed and never waiting on the viewer", () => {
    expect(stand(issue("a"), { need: { kind: "review", mine: true, step: "Implement" } })).toEqual({ status: "newask", phrase: "Built, not presented", act: "ask" });
  });
  test("a failure no row names is headed by the station's handoff outcome when it gave one (ct-59445, ct-59385)", () => {
    const failed = issue("a", { h: { attempts: [attempt({ outcome: { tone: "failed", end: null, text: "Stopped: Build failed." } as never })] } });
    expect(stand(failed, { failedStep: "Build", handoff: "Outcome: strategy_fails. The proposed fix was built, measured, and reverted." }).cause).toEqual({ key: "outcome:strategy_fails:build", label: "The approach did not work at Build" });
    expect(stand(failed, { failedStep: "Propose", handoff: "Outcome: failed. The mechanism is real and the rewrite cuts it sharply, but the red check is still red.\n\nMore" }).cause?.label).toBe("Gave up at Propose: the red check is still red");
    // A handoff with no outcome line says nothing about why the run failed: the step stays the heading.
    expect(stand(failed, { failedStep: "Build", handoff: "Re-entry of Implement: nothing new committed." }).cause?.label).toBe("Build failed");
  });
  test("a failure no row names takes its step from the run's trace; one nothing names is a plain heading, never 'a step gave up'", () => {
    const failed = issue("a", { h: { attempts: [attempt({ outcome: { tone: "failed", end: null, text: "Not shipped: the ship step failed." } as never })] } });
    expect(stand(failed, { failedStep: "Ship" })).toEqual({ status: "failed", phrase: "Failed at Ship", cause: { key: "failed-at:ship", label: "Ship failed" } });
    // With no step on record the phrase is what the run's own record says (ct-58794), never "a step".
    expect(stand(failed)).toEqual({ status: "failed", phrase: "Not shipped: the ship step failed", cause: { key: "failed-at:a step", label: "Stopped without a reason recorded" } });
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
    expect(unmerged.phrase).toMatch(/^Approved \w+ \d+ \(\d+[mhd]\), not merged$/);
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
  test("an approved fix nothing landed is under Approved, not merged, whoever approved it, with its age and its act (ct-57458)", () => {
    const approved = { attempts: [attempt({ ended: "shipped", card: { ref: "sd-465", status: "answered", answer: "Ship", answeredAt: NOW - 6 * DAY } as never })], ships: [{ runId: "r1", at: NOW - 4 * DAY, merge: null, deploys: [], liveAt: null, basis: "ship", words: "" }] as never };
    const i = issue("a", { status: "done", h: shipped([], approved) });
    expect(stand(i)).toMatchObject({ status: "approved", act: "merge" });
    // For you lists it under its group of the same name (the unlanded need): the chip still holds it, so one name counts one set.
    const mine = stand(i, { need: { kind: "unlanded", mine: true } });
    expect(mine.status).toBe("approved");
    expect(mine.act).toBe("merge");
    expect(mine.phrase).toMatch(/^Approved \w+ \d+ \(6d\), not merged$/);
  });
  test("a fix in production whose own fault keeps failing the line did not hold (ct-58282)", () => {
    const fault = { runId: "r9", caseId: "x", caseRef: "ct-58056", step: "eval", stepLabel: "Eval", words: "Layer 3 cannot run: L3_DATABASE_URL is not set", at: NOW - 3600_000 };
    const held = stand(issue("a", { status: "done", h: shipped([deploy]), lineFaults: [fault] } as never));
    expect(held.status).toBe("newask");
    expect(held.act).toBe("reopen");
    expect(held.phrase).toMatch(/^Fix didn't hold: Eval failed on it once since \w+ \d+$/);
    // A fault from before it went live is the problem it fixed, not a recurrence.
    const before = stand(issue("a", { status: "done", h: shipped([deploy]), lineFaults: [{ ...fault, at: NOW - 5 * DAY }] } as never));
    expect(before).toMatchObject({ status: "shipped", quiet: true });
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
    // A trial whose dispatcher held says so in place of Queued and is blocked: nothing will start it (AgentWatch Trial,
    // "11 ready" over 11 rows all "Trial held"). A blocked one keeps its own reason.
    expect(stand(issue("a"), { task: task(), lineOn: true, idle: "Trial held" })).toMatchObject({ status: "notstarted", phrase: "Trial held", ready: false });
    expect(stand(issue("a"), { task: task({ readiness: null }), lineOn: true, idle: "Trial held" }).phrase).toBe("Not grounded yet");
    const blocked = (over: Record<string, unknown>, f: ProblemFacts = {}) => stand(issue("a"), { task: task(over), ...f });
    expect(blocked({ readiness: null })).toEqual({ status: "notstarted", phrase: "Not grounded yet", ready: false });
    // Grounding found nothing to change: it ended, so it is not "not started"; its act is a person's close (ct-57508).
    expect(blocked({ readiness: "not_actionable" })).toEqual({ status: "newask", phrase: "Found nothing to change", act: "close" });
    expect(blocked({ goal_ref: "" }).phrase).toBe("Needs a goal");
    expect(blocked({ assignee: "u2" }, { assigneeName: "Dana" }).phrase).toBe("Assigned to Dana");
    expect(blocked({ readiness: "needs_context" }, { awaitsFindings: true }).phrase).toBe("Waiting for more findings (has 2)");
    // A run holds a problem only while it is live, and is named; one that ended holds nothing (ct-59433), so a ready
    // one starts only by hand. What holds it says so before the run that last touched it (ct-57552: no goal).
    expect(blocked({ workflow_run_id: "r0" }).phrase).toBe("Last run ended: start by hand");
    // Nothing else starts it, so its row carries the start (ct-57552, ct-57644): the act, through the paced review.
    expect(stand(issue("a", { h: { attempts: [attempt({ runId: "r0", n: 2 })] } }), { task: task({ workflow_run_id: "r0" }) })).toEqual({ status: "notstarted", phrase: "Run 2 ended: start by hand", ready: false, act: "start" });
    expect(stand(issue("a", { h: { attempts: [attempt({ runId: "r0", n: 6 })] } }), { task: task({ workflow_run_id: "r0", goal_ref: "" }) }).phrase).toBe("Needs a goal");
    expect(blocked({ status: "in_progress" }).phrase).toBe("In progress outside the line");
    // A run parked it because main already carries the fix (ct-59687): one state, the park record's, everywhere.
    const parked = stand(issue("a", { h: { attempts: [attempt({ ended: "parked" })] } }), { task: task({ readiness: "not_actionable", workflow_run_id: "r1", readiness_note: "Already fixed on main by fc0d85ba65 (classifies both files); CI on it in progress" }) });
    // Closing it as fixed is the line's queue's, on its row: it never waits on you, and never sits under Not started.
    expect(parked).toEqual({ status: "newask", phrase: "Already fixed on main (fc0d85b)", ready: false, act: "fixed" });
  });
  test("a fact grounding needs is asked of the project's lead role, never the viewer", () => {
    const asks = (f: ProblemFacts) => stand(issue("a", { ask: "Has Quinn left?", findings: 3 }), { need: { kind: "question", mine: true }, task: task({ readiness: "needs_context" }), ...f });
    expect(asks({ lead: "union-lead" })).toEqual({ status: "others", phrase: "Holds on an open question · @union-lead" });
    // No role holds the project: it stays where it is, Not started, for the line's page to set one up.
    expect(asks({}).status).toBe("notstarted");
  });
  // Real: ct-57552, six runs each parked at ground in about a minute, "readiness ready, goal none ... test-only fix, no
  // project goal is threatened", read "Run 6 ended: start by hand" with Start again on its row: a seventh park.
  test("a run that parked it for serving no goal says so, and its act closes it rather than starting a run that parks again", () => {
    const runs = [1, 2, 3, 4, 5, 6].map((n) => attempt({ runId: `r${n}`, n, ended: "parked" }));
    const f = { task: task({ goal_ref: "none", workflow_run_id: "r6", readiness_note: "test-only fix, E2E is not a deploy gate and no project goal is threatened" }), lineOn: false };
    expect(stand(issue("a", { h: { attempts: runs } }), f)).toEqual({ status: "notstarted", phrase: "Parked 6x: serves no goal", ready: false, act: "nogoal" });
    expect(stand(issue("a", { h: { attempts: runs.slice(-1) } }), f).phrase).toBe("Parked: serves no goal");
    // A goal named and the last run simply ended: still a start by hand.
    expect(stand(issue("a", { h: { attempts: [attempt({ runId: "r6", n: 6 })] } }), { task: task({ workflow_run_id: "r6" }) }).act).toBe("start");
  });
});

// Real: ct-57817 "same as ct-57489", ct-57875 "same as ct-57458", ct-57812 "same as ct-57440", each listed "Ready: line
// off" under Not started and counted ready by Turn on.
describe("twins nothing has started fold under their older problem", () => {
  const win = overviewWindow("7d", NOW);
  const occ = (...daysAgo: number[]) => daysAgo.sort((a, b) => b - a).map((d) => ({ at: NOW - d * DAY - 60_000 })) as never;
  const issues = [
    issue("old", { title: "Rerouting cancels a pitched match", h: { occurrences: occ(3), attempts: [attempt({ ended: "parked" })] } }),
    issue("twin", { title: "Not met: Rerouting cancels a pitched match", h: { occurrences: occ(1, 2) } }),
    issue("ran", { title: "Not met: Rerouting cancels a pitched match too", h: { occurrences: occ(1), attempts: [attempt({ live: true, end: null })] } }),
  ];
  const overlap = { primary: "old", primaryRef: "ct-old", set: ["old", "twin", "ran"], rule: null, defect: [] } as never;
  const rows = buildProblemRows(issues, {
    win, now: NOW, projectOf: () => "p", projectName: () => "P",
    facts: (id) => (id === "old" ? { task: task({ readiness: "not_actionable", workflow_run_id: "r1" }) } : id === "twin" ? { task: task(), lineOn: false } : {}),
    overlaps: new Map([["twin", overlap], ["ran", overlap], ["old", overlap]]),
  });
  test("never a row, a count or ready of its own; its act merges it in; its ref finds the row it sits under", () => {
    const twin = rows.find((r) => r.id === "twin")!;
    expect([twin.foldedInto, twin.stand]).toEqual(["old", { status: "notstarted", phrase: "Same as ct-old", ready: false, act: "mergeinto" }]);
    expect(rows.find((r) => r.id === "old")!.twins?.map((t) => t.id)).toEqual(["twin"]);
    // A twin with a run of its own keeps its row.
    expect(rows.find((r) => r.id === "ran")!.foldedInto ?? null).toBeNull();
    const c = statusCounts(rows);
    // Two rows: the older problem (parked, Not started) and the one with a run; the twin counts nowhere.
    expect([c.all, c.by.notstarted]).toEqual([2, 1]);
    expect(problemSections(rows, { status: null, quiet: false, q: "" }, null, () => "P").flatMap((x) => x.rows.map((r) => r.id)).sort()).toEqual(["old", "ran"]);
    expect(filterProblems(rows, { status: null, quiet: false, q: "ct-twin" }).map((r) => r.id)).toEqual(["old"]);
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
    expect(c.by).toEqual({ you: 1, others: 0, newask: 0, failed: 2, running: 1, notstarted: 2, approved: 0, merged: 0, shipped: 1, trial: 0, closed: 1 });
    // A chip's count is the rows it opens.
    for (const s of STATUS_ORDER) expect(filterProblems(rows, { ...all, status: s })).toHaveLength(c.by[s]);
    expect(filterProblems(rows, { status: "shipped", quiet: true, q: "" }).map((r) => r.id)).toEqual(["8"]);
  });

  test("'N% more' and a picked bar each narrow the table to their problems, and the chips count what they keep", () => {
    const more = filterProblems(rows, { ...all, found: "more" });
    expect(more.map((r) => r.id).sort()).toEqual(rows.filter((r) => rowTrend(r) === "up").map((r) => r.id).sort());
    expect(more.length).toBeGreaterThan(0);
    expect(statusCounts(rows, "", "more").all).toBe(more.length);
    // The bar two days back: the problems with a finding that day, busiest that day first.
    const bar = { from: win.d1 - 3 * DAY, to: win.d1 - 2 * DAY };
    const day = problemSections(rows, { ...all, found: bar }, null, name).flatMap((x) => x.rows.map((r) => r.id));
    expect(day.sort()).toEqual(["1", "4"]);
    // Narrowed, nothing is folded: the rows a bar names are on the page.
    expect(problemSections(rows, { ...all, found: bar }, null, name).every((x) => !x.folded)).toBe(true);
  });

  test("a problem in no project counts in the table, never in the figures: its findings are whatever this load holds", () => {
    const unfiled = buildProblemRows([issue("u", { h: { occurrencesFrom: "recent", occurrences: occ(1) } })], { win, now: NOW, facts: () => ({}), projectOf: () => null, projectName: () => "" })[0];
    expect([unfiled.inWindow, unfiled.series]).toEqual([1, false]);
    expect(rows.find((r) => r.id === "1")!.series).toBe(true);
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

  test("a problem's short id or number opens that problem alone, though other rows' sources name it", () => {
    const naming = rows.map((r) => (r.id === "4" ? r : { ...r, hay: `${r.hay}\nunion:line-eval:ct-4` }));
    for (const q of ["ct-4", "4", "#4", " CT-4 "]) expect(filterProblems(naming, { ...all, q }).map((r) => r.id)).toEqual(["4"]);
    // A number no problem has is searched as words.
    expect(filterProblems(naming, { ...all, q: "ct-99" })).toEqual([]);
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
    // A judge's "Not met:" stays: it is what makes a rule's words name a miss.
    expect(name).toBe("Not met: Call grader scored Keith Conrad's Zoom off a transcript missing 03:38-09:00…");
    // A rule that ends by turning itself around keeps its turn (ct-59756): cut there, the name says the opposite.
    expect(problemListName({ title: "Not met: Having several introduction offers open with one contact is the designed pipeline, not a defect" }))
      .toBe("Not met: Having several introduction offers open with one contact is the designed pipeline, not a defect");
    expect(problemListName({ title: "Not met: An introduction email reaches both people and gives each what they need to act" })).toBe("Not met: An introduction email reaches both people and gives each what they need to act");
    const samvit = "Samvit's ruling (#team thread 1791598261.885089, Oct 10 04:35Z): the prompt lets the agent offer a fee range the policy forbids, and nobody caught it for a week";
    expect(problemListName({ title: samvit })).toBe("Samvit's ruling: the prompt lets the agent offer a fee range the policy forbids…");
    expect(problemListName({ title: "Analyze dies before it reads the call" })).toBe("Analyze dies before it reads the call");
    // An "e.g." inside an aside is no sentence end, and a cut never leaves an aside open.
    expect(problemListName({ title: "Revival call prep had Rob re-ask Lana Nieves things she had already answered (e.g. her budget and timing), and the card never showed it" })).toBe("Revival call prep had Rob re-ask Lana Nieves things she had already answered…");
    expect(problemListName({ title: "Call brief put a review-only name (Jeff Londis, from the expert's notes) into the caller's script, and Rob read it out" })).toBe("Call brief put a review-only name into the caller's script, and Rob read it out");
    expect(problemListName({ title: "Call grader scored Keith Conrad's Zoom off a transcript missing 03:38-09:00 (the live-feed dropped those minutes) and docked him" })).toBe("Call grader scored Keith Conrad's Zoom off a transcript missing 03:38-09:00 and docked him");
  });
});

describe("error-group names (ct-58610)", () => {
  const raw = "Email dispatch giving up after >24h of transient deferral: Rate limit exceeded. Retry after 1 seconds.: Rate limit exceeded. Retry after 1 seconds.";
  test("a title that says its error twice names what failed, once", () => {
    expect(problemListName({ title: raw })).toBe("Email dispatch giving up after >24h of transient deferral");
  });
  test("an ordinary title with a colon keeps its words", () => {
    expect(errorWords("Callers & Call Management: the gate reads the wrong address")).toBeNull();
    expect(errorWords("Callers & Call Management: the gate reads the wrong address", true)).toBe("Callers & Call Management");
  });
});

describe("problems_home round: held causes, returned closes, one heading per cause", () => {
  const win = overviewWindow("7d", NOW);
  const rowsOf = (issues: LineIssue[], facts: Record<string, ProblemFacts>) => buildProblemRows(issues, { win, now: NOW, facts: (id) => facts[id] ?? {}, projectOf: () => "p", projectName: () => "P" });
  const all = { status: null, quiet: false, q: "" };

  test("a problem with the line names the step its finder keys say", async () => {
    const { lineStepsOf } = await import("../problemTable");
    expect(lineStepsOf(["union:line:eval-gate-l3-database-url-unset", "union:line-eval:l3-database-url-unset-in-daemon-env"]).sort()).toEqual(["eval"]);
    expect(lineStepsOf(["union:line:ship-fails-when-branch-behind-main"])).toEqual(["ship"]);
    expect(lineStepsOf(["union:cluster:2c650158"])).toEqual([]);
  });

  test("runs that failed at a step an open problem with the line is about wait on that fix, never on a restart (ct-58282)", () => {
    const failedAt = (step: string): ProblemFacts => ({ failed: { key: "looped3:implement:empty", label: "Eval gave no result 3 times, Implement stopped retrying", step: "Implement", steps: ["implement", step] } });
    const infra = issue("infra", { status: "in_review" });
    const rows = rowsOf([issue("1"), issue("2"), infra], { "1": failedAt("eval"), "2": failedAt("eval"), infra: { task: task({ status: "in_review" }), aboutSteps: ["eval"] } });
    const failed = problemSections(rows, all, null, () => "P").find((s) => s.status === "failed")!;
    expect(failed.subs![0].heldBy!.map((r) => r.id)).toEqual(["infra"]);
    // Once its fix lands, the restart is the act again.
    const landed = rowsOf([issue("1"), issue("x", { status: "done", h: { closes: [{ runId: "r1", n: 1, kind: "dissolved", at: NOW - DAY, step: "dissolve", back: null, fold: null }] } })], { "1": failedAt("eval"), x: { aboutSteps: ["eval"] } });
    expect(problemSections(landed, all, null, () => "P").find((s) => s.status === "failed")!.subs![0].heldBy).toBeUndefined();
  });

  test("a heading is one cause key, whatever its runs' words; two causes that read alike stay two (Union Prove)", () => {
    const f = (key: string, label: string): ProblemFacts => ({ failed: { key, label, step: "Prove" } });
    const rows = rowsOf([issue("1"), issue("2"), issue("3"), issue("4")], {
      "1": f("killed:prove", "Out of time, 3h at Prove"), "2": f("killed:prove", "Out of time, 1.5h at Prove"),
      "3": f("looped3:implement:verify:empty", "Verify gave no result 3 times, Implement stopped retrying"), "4": f("looped3:implement:eval:empty", "Eval gave no result 3 times, Implement stopped retrying"),
    });
    const failed = problemSections(rows, all, null, () => "P").find((s) => s.status === "failed")!;
    expect(failed.subs!.map((s) => [s.key, s.label, s.rows.length])).toEqual([
      ["killed:prove", "Out of time at Prove", 2],
      ["looped3:implement:eval:empty", "Eval gave no result 3 times, Implement stopped retrying", 1],
      ["looped3:implement:verify:empty", "Verify gave no result 3 times, Implement stopped retrying", 1],
    ]);
  });

  test("closed as not a problem with findings since is one state on the list and the page (ct-57368)", () => {
    const closes = [{ runId: "r1", n: 1, kind: "dissolved" as const, at: NOW - 6 * DAY, step: "dissolve", back: null, fold: null }];
    const occurrences = [NOW - 8 * DAY, NOW - 2 * DAY, NOW - DAY].map((at) => ({ at, reopened: false }));
    const h = { closes, occurrences, attempts: [attempt({ runId: "r1", start: NOW - 7 * DAY, end: NOW - 6 * DAY, ended: "dissolved" })] };
    // The page takes off-topic comebacks out (cameBack false); the list does not (cameBack true): both read the same.
    for (const cameBack of [true, false]) {
      const s = stand(issue("a", { status: "in_review", h: { ...h, cameBack } }), { task: task({ status: "in_review" }) });
      expect(s.status).toBe("newask");
      expect(s.phrase).toMatch(/^Closed \w+ \d+ as not a problem, 2 findings since$/);
    }
  });
});

describe("findings since a close, and repeats", () => {
  test("grouped by what they say, repeats once, moving counts the whole key", async () => {
    const { sinceCloseGroups } = await import("../problemPage");
    const { repeatedFindings } = await import("../findingEvidence");
    const f = (id: string, at: number, title: string, fingerprint: string, detail = id) => ({ _id: id, title, fingerprint, created_at: at, observed_at: at, detail_md: detail, source: "agentwatch", subject: null });
    const rows = [
      f("old", NOW - 9 * DAY, "Not met: Cold email invents buyers", "k2"),
      f("a", NOW - 2 * DAY, "Not met: Broker says no intro", "k1", "same words\n\n3 findings in this AgentWatch cluster (match judge)."),
      f("a2", NOW - 2 * DAY + 60_000, "Not met: Broker says no intro", "k1", "same words\n\n4 findings in this AgentWatch cluster (match judge)."),
      f("b", NOW - DAY, "Not met: Cold email invents buyers", "k2"),
    ];
    expect([...repeatedFindings(rows)].map((r) => r._id)).toEqual(["a2"]);
    expect(sinceCloseGroups(rows, NOW - 6 * DAY)).toEqual([
      { says: "Broker says no intro", n: 1, signals: ["a"], moving: 2 },
      { says: "Cold email invents buyers", n: 1, signals: ["b"], moving: 2 },
    ]);
  });
});

describe("emptyWays: an empty table leads to where the search's matches are", () => {
  const by = (o: Partial<Record<StatusKey, number>>) => ({ ...Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])), ...o }) as Record<StatusKey, number>;
  test("a chip with no match offers the chips that hold it, never every problem (Failed, search 59687)", () => {
    expect(emptyWays({ all: 1, by: by({ you: 1 }) }, { status: "failed", q: "59687", found: null }, 1, 896)).toEqual([{ kind: "status", status: "you", n: 1 }]);
  });
  test("then every day's matches, then clearing the search, then every problem", () => {
    expect(emptyWays({ all: 0, by: by({}) }, { status: null, q: "x", found: "more" }, 3, 896)).toEqual([{ kind: "anyday", n: 3 }]);
    expect(emptyWays({ all: 0, by: by({}) }, { status: "failed", q: "nothing", found: null }, 0, 896)).toEqual([{ kind: "search" }]);
    expect(emptyWays({ all: 0, by: by({}) }, { status: "failed", q: "", found: null }, 896, 896)).toEqual([{ kind: "all", n: 896 }]);
  });
});
