// The problem page's derivations (line-journeys.md LJ8.3): one band state per
// problem, the one state line, the run rows, a finding's own words, the
// stage track. Over hand-built histories shaped like the real rows of
// ct-58282 (a built fix nobody answered), ct-59561 (a decision held by
// someone else), ct-58311 (a question), ct-57509 (merged, not in production)
// and ct-57442 (closed).
import { describe, expect, test } from "bun:test";
import type { CauseHistory, HistoryAttempt } from "../causeHistory";
import type { LineIssue, LineRunModel, LineVisit } from "../lineModel";
import { askShape, bandLine, eventFinding, eventFindingWords, evidenceLinkWords, findingBlocks, problemBand, wholeSentences, workRows, type BandInput } from "../problemPage";
import { firstFailedVisit, stageTrack } from "../stageTrack";

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 12, 20);

const hist = (o: Partial<CauseHistory> = {}): CauseHistory => ({
  occurrences: [], occurrencesFrom: "history", since: null, capped: false, attempts: [], ships: [], deploys: [], coverage: { state: "unread", targets: [], words: "" },
  watches: [], regressions: [], closes: [], recurrences: [], regressed: false, cameBack: false, firstAt: null, lastActivity: 0, ...o,
});
const attempt = (o: Partial<HistoryAttempt> = {}): HistoryAttempt => ({
  runId: "run1", n: 1, start: NOW - 30 * H, end: NOW - 20 * H, live: false, outcome: { tone: "calm", end: null, text: "" }, ended: null, endStep: null,
  unapproved: false, superseded: false, found: null, argued: null, proposed: null, built: null, card: null, diff: null, merge: null, ...o,
});
const issue = (o: Partial<LineIssue> = {}): LineIssue => ({
  id: "t1", ref: "ct-1", title: "A problem", status: "open", findings: 3, quotes: [], runs: [], lastRunAt: 0, where: { tone: "calm", end: null, text: "" }, history: hist(),
  ask: null, dissolvedWhy: null, dissolvedFixedAt: null, ...o,
});
const visit = (node: string, status: LineVisit["status"], o: Partial<LineVisit> = {}): LineVisit => ({
  index: 0, node, label: node.charAt(0).toUpperCase() + node.slice(1), kind: "session", at: NOW, startedAt: NOW, completedAt: NOW, durationMs: 60_000, status, inferred: false,
  received: { from: null, fromLabel: null, summary: "", said: false, sessionId: null, href: null }, decided: { outcome: null, words: "", result: null, to: null, toLabel: null, toWords: null }, why: null, sessionId: null, ...o,
});
const run = (visits: LineVisit[], o: Partial<LineRunModel> = {}): LineRunModel => ({
  id: "run1", caseId: "t1", caseRef: "ct-1", caseTitle: "A problem", status: "completed", live: false, outcome: { tone: "calm", end: null, text: "" }, at: NOW - 30 * H, updatedAt: NOW - 20 * H,
  durationMs: 10 * H, at_node: null, graphHash: null, visits, ...o,
});
const input = (o: Partial<BandInput>): BandInput => ({ issue: issue(), history: hist(), run: null, need: null, decision: null, row: null, task: { status: "open", goal_ref: "in-1" }, lineOn: true, now: NOW, ...o });

describe("problemBand: one state per problem", () => {
  test("a need leads, whatever else is true (ct-58282: a built fix nobody answered)", () => {
    const h = hist({ attempts: [attempt({ unapproved: true, card: { decisionId: "d", ref: "sd-557", headline: "Let fixes reach the tests", change: null, wrong: null, recommend: null, status: "withdrawn", answer: null, note: null, answeredAt: null } })] });
    const b = problemBand(input({ history: h, need: { kind: "lapsed", since: NOW - 40 * H, fail: null } }));
    expect(b.kind).toBe("need");
    expect(bandLine(b).text).toBe(`Asked ${new Date(NOW - 20 * H).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, no answer`);
  });
  test("an open decision in nobody's queue is still shown, and says it waits on someone else (ct-59561)", () => {
    const b = problemBand(input({ decision: { ref: "sd-615", since: NOW - H, mine: false }, run: run([visit("decide", "waiting")], { live: false }) }));
    expect(b).toEqual({ kind: "decision", ref: "sd-615", since: NOW - H, mine: false });
    expect(bandLine(b)).toEqual({ text: "Waiting on someone else", tone: "none" });
    // One in the viewer's own queue waits on them, whatever process or workspace the needs list was read under (ct-59338, sd-600).
    expect(bandLine(problemBand(input({ decision: { ref: "sd-600", since: null, mine: true } }))).text).toBe("Waiting on you");
    expect(bandLine(problemBand(input({ decision: { ref: "sd-600", since: null, mine: null } }))).text).toBe("Waiting on an answer");
  });
  test("a question with no need row still gets the Ask block, and a note cut at its cap ends at a sentence (ct-58311)", () => {
    const note = `${"Akash dealt with Quinn but the follow-ups were signed Riley. ".repeat(8)}It can't be worked yet because nothing says whether Quinn has left or is still active (so the swi`;
    const b = problemBand(input({ issue: issue({ ask: note.slice(0, 500) }) }));
    expect(b.kind).toBe("ask");
    if (b.kind === "ask") { expect(b.note.endsWith(".")).toBe(true); expect(b.required).toBe(true); }
  });
  test("a stopped run that needs a yes is a need, never a failure", () => {
    const b = problemBand(input({ need: { kind: "stopped", since: NOW, fail: { key: "deadend:prove", step: "prove", label: "Prove: needs Cameron's yes", raw: "" } }, run: run([visit("prove", "done")]) }));
    expect(bandLine(b)).toEqual({ text: "Stopped at Prove: needs your yes", tone: "warn" });
  });
  test("a failed run reads at the step that failed first, not the one that received nothing", () => {
    const r = run([visit("analyze", "failed", { durationMs: 2000, why: "Analyze ended with no result" }), visit("prove", "failed")]);
    const b = problemBand(input({ run: r, row: { kind: "failed", at: NOW - H, detail: null, fail: { key: "deadend-failed:prove", step: "prove", label: "Prove gave no result", raw: "" } } }));
    expect(b.kind).toBe("failed");
    expect(bandLine(b).text).toBe("Failed at Analyze after 2s");
    expect(firstFailedVisit(r)?.node).toBe("analyze");
  });
  test("merged where deploys are recorded and none carried it: not in production, no watch (ct-57509)", () => {
    const merge = { sha: "abc1234def", branch: "line/ct-57509", into: "main", at: NOW - 30 * H, prUrl: "https://github.com/x/y/pull/9", repository: null };
    const h = hist({
      attempts: [attempt({ ended: "shipped", merge })], ships: [{ runId: "run1", at: NOW - 30 * H, merge, deploys: [], liveAt: NOW - 30 * H, basis: "merge" as never, words: "" }],
      coverage: { state: "known", targets: ["backend"], words: "Deploys to backend are recorded" }, closes: [{ runId: "run1", n: 1, kind: "shipped", at: NOW - 30 * H, step: null, back: null, fold: null }],
      watches: [{ runId: "run1", start: NOW - 30 * H, end: NOW + 100 * H, state: "watching", reopenedAt: null }],
    });
    const b = problemBand(input({ issue: issue({ status: "done", history: h }), history: h }));
    expect(b.kind).toBe("merged");
    expect(bandLine(b).text).toMatch(/^Merged .+, not in production$/);
  });
  test("closed says when; dropped says how (ct-57442)", () => {
    const b = problemBand(input({ issue: issue({ status: "dropped" }), task: { status: "dropped", closed_at: NOW - 72 * H } }));
    expect(b).toMatchObject({ kind: "closed", at: NOW - 72 * H, how: "Dropped" });
  });
  test("not started with the line off says so; with no goal says why", () => {
    expect(bandLine(problemBand(input({ lineOn: false }))).text).toBe("Not started: line off");
    const b = problemBand(input({ task: { status: "open" } }));
    expect(b).toMatchObject({ kind: "notstarted", reason: "Needs a goal before it can start" });
  });
});

describe("workRows", () => {
  test("newest first; a lapsed fix reads 'Asked you, no answer' and its proof comes from red and green", () => {
    const h = hist({ attempts: [
      attempt({ runId: "r1", n: 1, outcome: { tone: "failed", end: null, text: "" } }),
      attempt({ runId: "r2", n: 2, unapproved: true, ended: "shipped", diff: { files: 5, added: 175, removed: 8, pr: null }, card: { decisionId: "d", ref: "sd-557", headline: "Let fixes reach the tests", change: null, wrong: null, recommend: null, status: "withdrawn", answer: null, note: null, answeredAt: null } }),
    ] });
    const runs = [run([visit("analyze", "failed")], { id: "r1" }), run([visit("red", "done", { decided: { outcome: "success", words: "", result: { red: true }, to: null, toLabel: null, toWords: null } }), visit("green", "done")], { id: "r2" })];
    const rows = workRows(h, runs);
    expect(rows.map((r) => r.n)).toEqual([2, 1]);
    expect(rows[0]).toMatchObject({ headline: "Let fixes reach the tests", outcome: "Asked you, no answer", proof: { before: true, after: true }, answer: { ref: "sd-557", words: "No answer" } });
    expect(rows[0].change).toMatchObject({ files: 5, added: 175, removed: 8 });
    expect(rows[1].outcome).toBe("Failed at Analyze");
  });
});

describe("findings", () => {
  test("a finding's own words, whole, without the restated title and the finder's bookkeeping", () => {
    const blocks = findingBlocks({
      source: "agentwatch", title: "Not met: A contact deals with one consistent Union representative",
      detail_md: "**A contact deals with one consistent Union representative.** (severity 6/10, ex-broker-private-2)\n\nGabe heard from Quinn, then Riley.\n\n> Quick update on the note I sent Monday\n\nBreaks expectation `ex-broker-private-2`.\n\n128 findings in this AgentWatch cluster (comms judge).",
    });
    expect(blocks).toEqual([{ kind: "text", text: "Gabe heard from Quinn, then Riley." }, { kind: "quote", text: "Quick update on the note I sent Monday" }]);
  });
  test("raw output stays raw", () => {
    expect(findingBlocks({ source: "union.escalation", title: "t", detail_md: "The reason:\n```\nline one\nline two\n```" })).toEqual([{ kind: "text", text: "The reason:" }, { kind: "code", text: "line one\nline two" }]);
  });
  test("the evidence link is named for where it goes", () => {
    expect(evidenceLinkWords("https://admin.unionmatching.com/admin/agent-runs?run=3a3b")).toBe("Open the agent run in Union");
    expect(evidenceLinkWords("https://admin.unionmatching.com/admin/agent-watch?cluster=1&finding=2")).toBe("Open the finding in Union");
    expect(evidenceLinkWords("https://union-app.slack.com/archives/C0/p1")).toBe("Open in Slack");
  });
  test("a note cut at its cap ends at its last full sentence", () => {
    expect(wholeSentences(`${"One whole sentence here. ".repeat(20)}and then it stops mid wo`.slice(0, 500))).toMatch(/here\.$/);
    expect(wholeSentences("Short and whole.")).toBe("Short and whole.");
  });
});

describe("stageTrack", () => {
  test("six stages read from the run; Ship is drawn only once Present is done", () => {
    const r = run([visit("ground", "done"), visit("prove", "done"), visit("implement", "done"), visit("verify", "done"), visit("decide", "waiting")]);
    const st = stageTrack(r, undefined, { waiting: true });
    expect(st.map((s) => `${s.label}:${s.mark}`)).toEqual(["Investigate:done", "Prove:done", "Build:done", "Verify:done", "Present:current"]);
    const shipped = stageTrack(run([visit("ground", "done"), visit("decide", "done"), visit("ship", "done")]));
    expect(shipped.map((s) => s.label)).toContain("Ship");
  });
  test("a failure marks the stage it happened in", () => {
    const st = stageTrack(run([visit("ground", "done"), visit("analyze", "failed"), visit("prove", "failed")]));
    expect(st.find((s) => s.mark === "failed")?.label).toBe("Investigate");
    expect(st.find((s) => s.key === "prove")?.mark).toBe("none");
  });
});

describe("stageTrack at a stage", () => {
  test("a fix asked and never answered stands at Present, though Ship ran after it (ct-58282)", () => {
    const r = run([visit("ground", "done"), visit("prove", "done"), visit("implement", "done"), visit("verify", "done"), visit("decide", "failed"), visit("ship", "done")]);
    const st = stageTrack(r, undefined, { at: "decide", failed: false });
    expect(st.map((s) => `${s.label}:${s.mark}`)).toEqual(["Investigate:done", "Prove:done", "Build:done", "Verify:done", "Present:current"]);
  });
});

describe("workRows on a paused run", () => {
  test("a run paused at the decision reads as waiting, never running (ct-59561)", () => {
    const h = hist({ attempts: [attempt({ live: true, end: null })] });
    const rows = workRows(h, [run([visit("verify", "done"), visit("decide", "waiting")], { status: "paused", live: true })]);
    expect(rows[0]).toMatchObject({ outcome: "Waiting on an answer", tone: "you" });
  });
});

describe("a merge recorded only on its run", () => {
  test("a done problem whose newest run merged reads as merged, not closed (ct-57509)", () => {
    const merge = { sha: "9e85377773aa", branch: "line/ct-57509", into: "main", at: NOW - 8 * H, prUrl: null, repository: null };
    const h = hist({ attempts: [attempt({ ended: "shipped", merge })], coverage: { state: "none", targets: [], words: "No deploys recorded for this project" } });
    const b = problemBand(input({ issue: issue({ status: "done", history: h }), history: h, task: { status: "done", closed_at: NOW - 7 * H } }));
    expect(b).toMatchObject({ kind: "merged", recorded: "none", sha: "9e85377773aa" });
    expect(bandLine(b).text).toMatch(/^Merged \w+ \d+$/);
  });
});

describe("approved, never merged", () => {
  test("an answered Ship whose ship step did not merge says so with the step's reason (ct-57509)", () => {
    const card = { decisionId: "d", ref: "sd-583", headline: "Stop the auto-reply blocking calls", change: null, wrong: null, recommend: null, status: "answered", answer: "Ship", note: null, answeredAt: NOW - 9 * H };
    const h = hist({ attempts: [attempt({ ended: "shipped", card })] });
    const words = "ship: no Requested-by on the branch\nnot merged: merge is off for this line; a person turns it on with cast role line --merge on\nok Comment added";
    const r = run([visit("decide", "done"), visit("ship", "done")]);
    const b = problemBand(input({ issue: issue({ status: "done", history: h }), history: h, run: r, task: { status: "done", closed_at: NOW - 8 * H }, shipOutput: words }));
    // The ship step's reason is a fact (the merge step is off), never its terminal sentence.
    expect(b).toMatchObject({ kind: "approved", ref: "sd-583", mergeOff: true });
    expect(JSON.stringify(b)).not.toMatch(/cast role/);
    expect(bandLine(b).text).toMatch(/^Approved \w+ \d+, not merged$/);
    expect(workRows(h, [r])[0].outcome).toMatch(/^Approved \w+ \d+, not merged$/);
  });
});

describe("a run row's fix words come from the merge facts the band reads", () => {
  const card = { decisionId: "d", ref: "sd-583", headline: "Stop the auto-reply blocking calls", change: null, wrong: null, recommend: null, status: "answered", answer: "Ship", note: null, answeredAt: NOW - 9 * H };
  const day = new Date(NOW - 9 * H).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  test("a 'merged, not deployed' verdict with no merge record reads as the band does: approved, not merged (ct-57509 Run 3)", () => {
    // A ship row with neither a merge nor a deploy, and deploys recorded for the project: the verdict alone would say merged.
    const h = hist({ attempts: [attempt({ ended: "shipped", card })], ships: [{ runId: "run1", at: NOW - 9 * H, merge: null, deploys: [], liveAt: null, basis: "merge" as never, words: "" }], coverage: { state: "known", targets: ["backend"], words: "" } });
    const row = workRows(h, [run([visit("decide", "done"), visit("ship", "done")])])[0];
    expect(row.outcome).toBe(`Approved ${day}, not merged`);
    expect(row.tone).toBe("warn");
    const b = problemBand(input({ issue: issue({ status: "done", history: h }), history: h, task: { status: "done" } }));
    expect(bandLine(b).text).toBe(`Approved ${day}, not merged`);
  });
  test("with a merge record it reads merged, and not in production where deploys are recorded", () => {
    const merge = { sha: "abc1234def", branch: "line/ct-57509", into: "main", at: NOW - 8 * H, prUrl: null, repository: null };
    const h = hist({ attempts: [attempt({ ended: "shipped", card, merge })], coverage: { state: "known", targets: ["backend"], words: "" } });
    expect(workRows(h, [])[0].outcome).toMatch(/^Merged/);
  });
});

describe("eventFinding (ct-56770)", () => {
  const detail = (t: string, n: number, rel: string) => `${t} in sdk:e2e-sdk, group eg-3 (error).\nCulprit: charge@src/charge.ts\nSeen ${n} times, last in ${rel}.\nRead it with \`cast events show eg-3\`.`;
  test("reads the group, the transition and the counts; the row says them, never the CLI line", () => {
    const e = eventFinding({ detail_md: detail("regressed", 7, "e2e@1.3.0"), subject: "eg-3" });
    expect(e).toEqual({ group: "eg-3", transition: "Regressed", count: 7, release: "e2e@1.3.0", culprit: "charge@src/charge.ts" });
    expect(eventFindingWords(e!)).toBe("Regressed in e2e@1.3.0 · 7 times");
    expect(eventFindingWords(eventFinding({ detail_md: detail("new", 1, "e2e-1.0.0"), subject: null })!)).toBe("New in e2e-1.0.0 · 1 time");
  });
  test("any other finding is not one", () => {
    expect(eventFinding({ detail_md: "Gabe heard from Quinn", subject: null })).toBeNull();
  });
});

describe("askShape (ct-56635)", () => {
  test("a question that names parts asks for each, and a bare yes cannot answer it", () => {
    expect(askShape("Say whether it is a real request and what snoozing should do (duration, who sees it, whether it hides the cause from review) before work starts.")).toEqual({
      required: true, parts: ["Duration", "Who sees it", "Whether it hides the cause from review"],
    });
  });
  test("a yes or no question asks for nothing more", () => {
    expect(askShape("Is this a real problem?")).toEqual({ required: false, parts: [] });
    expect(askShape("Say whether Quinn has left (so Riley is correct) or is still active.")).toEqual({ required: false, parts: [] });
  });
  test("a what question with no list asks for an answer", () => {
    expect(askShape("Which call is the one Akash meant?")).toEqual({ required: true, parts: [] });
  });
});
