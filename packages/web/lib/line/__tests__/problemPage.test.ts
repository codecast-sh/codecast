// The problem page's derivations (line-journeys.md LJ8.3): one band state per
// problem, the one state line, the run rows, a finding's own words, the
// stage track. Over hand-built histories shaped like the real rows of
// ct-58282 (a built fix nobody answered), ct-59561 (a decision held by
// someone else), ct-58311 (a question), ct-57509 (merged, not in production)
// and ct-57442 (closed).
import { describe, expect, test } from "bun:test";
import type { CauseHistory, HistoryAttempt } from "../causeHistory";
import type { LineIssue, LineRunModel, LineVisit } from "../lineModel";
import { askedAbout, askShape, dissolvedOutcome, bandLine, escalationFinding, escalationWords, eventFinding, eventFindingWords, evidenceLinkWords, findingBlocks, findingCut, findingCutWords, findingLeads, quoteCarriesNoClaim, misfiledAsks, movedOut, problemBand, problemHeading, problemNow, runMovedTo, saysSame, wholeSentences, workRows, type BandInput } from "../problemPage";
import { fixMerges } from "../fixMerges";
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
    // The card was taken back unanswered: "Withdrawn", the decision's own word, and the track's line is the only place it is said.
    expect(bandLine(b).text).toBe(`Fix withdrawn ${new Date(NOW - 20 * H).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, unanswered`);
  });
  test("an open decision in nobody's queue is still shown, and says it waits on someone else (ct-59561)", () => {
    const b = problemBand(input({ decision: { ref: "sd-615", since: NOW - H, mine: false }, run: run([visit("decide", "waiting")], { live: false }) }));
    expect(b).toEqual({ kind: "decision", ref: "sd-615", since: NOW - H, mine: false });
    expect(bandLine(b)).toEqual({ text: "Waiting on someone else", tone: "none" });
    // One in the viewer's own queue waits on them, whatever process or workspace the needs list was read under (ct-59338, sd-600).
    expect(bandLine(problemBand(input({ decision: { ref: "sd-600", since: null, mine: true } }))).text).toBe("Fix to decide");
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
    expect(bandLine(b)).toEqual({ text: "Prove finished: go on to Build?", tone: "warn" });
    // Nobody is asked mid-run: the Problems list files it under Needs a new ask, where a new run goes on.
    expect(problemNow(b).status).toBe("newask");
  });
  test("a step that ended without a report is no yes: the band says what happened", () => {
    const b = problemBand(input({ run: run([visit("build", "failed")]), row: { kind: "failed", at: NOW - H, detail: null, fail: { key: "deadend-silent:build", step: "build", label: "Build ended without a report", raw: "" } } }));
    expect(b).toMatchObject({ kind: "failed", silent: true });
    expect(bandLine(b).text).toBe("Build ended without a report");
  });
  test("a step stopped by a spend limit with no failed visit is named by its label, never its node id (ct-57836)", () => {
    const b = problemBand(input({ run: run([visit("prove", "done")]), row: { kind: "failed", at: NOW - H, detail: null, fail: { key: "budget:prove", step: "prove", label: "Stopped by a spend limit", raw: "" } } }));
    expect(b).toMatchObject({ kind: "failed", step: "Prove", cap: true });
  });
  test("a failed run reads at the step that failed first, not the one that received nothing", () => {
    const r = run([visit("analyze", "failed", { durationMs: 2000, why: "Analyze ended with no result" }), visit("prove", "failed")]);
    const b = problemBand(input({ run: r, row: { kind: "failed", at: NOW - H, detail: null, fail: { key: "deadend-failed:prove", step: "prove", label: "Prove gave no result", raw: "" } } }));
    expect(b.kind).toBe("failed");
    expect(bandLine(b).text).toBe("Failed at Analyze");
    expect(b).toMatchObject({ after: 2000 });
    expect(firstFailedVisit(r)?.node).toBe("analyze");
  });
  test("a run that ended on a graph's end step failed at the step before it, never at the end step (ct-59231 Run 3 read 'Failed at Failed')", () => {
    const r = run([visit("bind", "failed"), visit("failed_at_bind", "done", { label: "Failed", kind: "end" }), visit("exit", "done")]);
    expect(firstFailedVisit(r)?.node).toBe("bind");
  });
  test("a failure the graph routed out through a step that records it fails at the step before (ct-58794: Eval, then Unscored, then Exit)", () => {
    const r = run([visit("verify", "done"), visit("eval", "failed", { kind: "script" }), visit("unscored", "done", { kind: "script" }), visit("exit", "done", { kind: "end" })]);
    expect(firstFailedVisit(r)?.node).toBe("eval");
    const b = problemBand(input({ run: r, row: { kind: "failed", at: NOW - H, detail: null, fail: { key: "failed:eval", step: "eval", label: "Eval could not score", raw: "" } } }));
    expect(bandLine(b).text).toBe("Failed at Eval");
    // An agent's step after a failure is work the run went on to, never skipped.
    expect(firstFailedVisit(run([visit("eval", "failed"), visit("implement", "done", { kind: "agent" }), visit("exit", "done", { kind: "end" })]))).toBeNull();
  });
  test("with no step on record the band says what the run's record does, never 'a step'", () => {
    const ended = problemBand(input({ history: hist({ attempts: [attempt({ outcome: { tone: "failed", end: null, text: "Stopped: the evals could not score the change." } })] }), row: { kind: "failed", at: NOW - H, detail: null, fail: null as never } }));
    expect(ended).toMatchObject({ kind: "failed", step: "a step", node: null });
    expect(bandLine(ended).text).toBe("Stopped: the evals could not score the change");
    const none = problemBand(input({ row: { kind: "failed", at: NOW - H, detail: null, fail: null as never } }));
    expect(bandLine(none).text).toBe("Failed before any step ran");
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
    expect(bandLine(problemBand(input({ lineOn: false, task: { status: "open", goal_ref: "in-1", readiness: "ready" } }))).text).toBe("Ready: flow off");
    expect(bandLine(problemBand(input({ lineOn: null, task: { status: "open", goal_ref: "in-1", readiness: "ready" } }))).text).toBe("Ready: no flow set up");
    // The one blocker, in the words the Problems row says (notStartedWhy).
    expect(problemBand(input({ task: { status: "open" } }))).toMatchObject({ kind: "notstarted", reason: "Not grounded yet" });
  });
});

describe("workRows", () => {
  test("newest first; a lapsed fix whose card was taken back reads 'Withdrawn, no answer' and its proof comes from red and green", () => {
    const h = hist({ attempts: [
      attempt({ runId: "r1", n: 1, outcome: { tone: "failed", end: null, text: "" } }),
      attempt({ runId: "r2", n: 2, unapproved: true, ended: "shipped", diff: { files: 5, added: 175, removed: 8, pr: null }, card: { decisionId: "d", ref: "sd-557", headline: "Let fixes reach the tests", change: null, wrong: null, recommend: null, status: "withdrawn", answer: null, note: null, answeredAt: null } }),
    ] });
    const runs = [run([visit("analyze", "failed")], { id: "r1" }), run([visit("red", "done", { decided: { outcome: "success", words: "", result: { red: true }, to: null, toLabel: null, toWords: null } }), visit("green", "done")], { id: "r2" })];
    const rows = workRows(h, runs);
    expect(rows.map((r) => r.n)).toEqual([2, 1]);
    expect(rows[0]).toMatchObject({ headline: "Let fixes reach the tests", outcome: "Withdrawn, no answer", proof: { before: true, after: true }, answer: { ref: "sd-557", words: "No answer" } });
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
  test("a label line with its quote under it is one quote, captioned by where it was said (ct-59557)", () => {
    expect(findingBlocks({ source: "person", title: "t", detail_md: "Calls 04:53Z onward have 0 call_transcripts rows.\n\nWhat they wrote in Slack (data):\n> <@U06T0M62Y04> call tips aren't working\n> on this call are they down?" })).toEqual([
      { kind: "text", text: "Calls 04:53Z onward have 0 call_transcripts rows." },
      { kind: "quote", text: "<@U06T0M62Y04> call tips aren't working\non this call are they down?", from: "In Slack" },
    ]);
  });
  test("a finder's appended excerpt that is another message from the thread is left out (ct-58682)", () => {
    const blocks = findingBlocks({
      source: "person",
      title: "A reply to a contact that fails because the email provider is down (e.g. sendkit auth outage) is marked failed and never re-sent or re-woken, so the contact's question goes unanswered.",
      detail_md: "Evidence (read Oct 12 ~15:00Z): 3 outbound replies since Oct 1 have status 'failed' with error \"Provider sendkit unavailable (auth)\". Case: Sergio's fee question went unanswered.\n\nWhat they wrote in Slack (data):\n> <@U06T0M62Y04> how are you doing on your goals that you made for yourself a couple of weeks ago? Any status update or blockers?",
    });
    expect(blocks.map((b) => b.kind)).toEqual(["text"]);
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
    // ct-58683's title: one sentence stored cut at 200 still reads as cut.
    const cut = `Call grader faulted Eric S for not naming 'the one person on your card' (Jeff Londis) on Carmit Solash call 94373d15, when 4 names had been sent and Carmit said up front she hadn't read the email and…`;
    expect(wholeSentences(cut, 200)).toBe(cut);
  });
});

describe("a quote is shown only when it carries the claim (ct-58311)", () => {
  test("a pleasantry or a sign-off block supports nothing and is left out; a sender named in a line is kept", () => {
    for (const q of ["Good speaking today.", "Thanks!", "Best regards", "Reese\nSenior Associate, Union Agency", "Rob\nSenior Associate, Union Agency\nrob@unionagency.co"]) expect(quoteCarriesNoClaim(q)).toBe(true);
    for (const q of ["it's Jamie from Union", "Morgan Lee <morgan@unionstaffhq.com>", "Quick update on the note I sent Monday", "Good speaking today, I've moved you to Riley who takes over your account"]) expect(quoteCarriesNoClaim(q)).toBe(false);
  });
  test("sg-1383's signature leaves the finding's words, which name who sent what", () => {
    const blocks = findingBlocks({ title: "Not met: one rep", detail_md: "Florine's conversation was handled by Reese and then by Mary-Alexis.\n\n> Reese\n> Senior Associate, Union Agency\n\nBreaks expectation `ex-1`." } as any);
    expect(blocks.filter((b) => b.kind === "quote")).toEqual([]);
    expect(blocks[0]).toEqual({ kind: "text", text: "Florine's conversation was handled by Reese and then by Mary-Alexis." });
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
    // "In production: No" is measured against the project's last recorded deploy, or says none is recorded (ct-58282).
    const b = problemBand(input({ issue: issue({ history: h }), history: h }));
    expect(b).toMatchObject({ kind: "merged", recorded: "known", lastDeploy: null });
    const deployed = hist({ ...h, deploys: [{ at: NOW - 30 * H, url: "https://x/d1" }, { at: NOW - 2 * H, url: null }] as never });
    expect(problemBand(input({ issue: issue({ history: deployed }), history: deployed }))).toMatchObject({ kind: "merged", lastDeploy: { at: NOW - 2 * H, url: null } });
     // The project's own deploys, which carried other changes, are what the fix missed: its history holds only deploys
    // that carried its fixes, so the newest one comes from the coverage (ct-58282 read "no deploy recorded yet").
    const project = hist({ ...h, coverage: { state: "known", targets: ["backend"], words: "", last: { at: NOW - 3 * H, url: "https://x/d2" } } });
    expect(problemBand(input({ issue: issue({ history: project }), history: project }))).toMatchObject({ kind: "merged", lastDeploy: { at: NOW - 3 * H, url: "https://x/d2" } });
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

// ── round 3: one state, real text (ct-57459, ct-57442, ct-58022, ct-59687) ──

const EXPECT = "A message to a contact leads with the result, the recommendation or one actionable question; it does not narrate Union's effort, apologize for ordinary delay, or send activity that means nothing to the contact.";
const CUT = `${EXPECT.slice(0, 199)}…`;
const judged = (body: string) => ({ title: "A message to a contact leads with the result, the recommendation or one actionable question", source: "agentwatch/comms", detail_md: `**${EXPECT}** (severity 5/10, ex-agent-quality-3)\n\n${body}\n\n> Just tried you — no luck.\n\nBreaks expectation \`ex-agent-quality-3\`.\n\n32 findings in this AgentWatch cluster (comms judge).` });

describe("one state per problem, shared by its row and its page", () => {
  const card = (o: Record<string, unknown>) => ({ decisionId: "d", ref: "sd-615", headline: "Lead with the result", change: null, wrong: null, recommend: { verdict: "drop", why: null }, status: "withdrawn", answer: null, note: null, answeredAt: NOW - 10 * H, ...o }) as never;
  test("a fix withdrawn unanswered while every run has ended: nothing holds it, it says so, and Drop or Ask again move it (ct-59433)", () => {
    const h = hist({ attempts: [
      attempt({ runId: "r1", n: 1, outcome: { tone: "failed", end: null, text: "Stopped: Build failed." } as never, superseded: true }),
      attempt({ runId: "r2", n: 2, start: NOW - 12 * H, end: NOW - 10 * H, card: card({}), built: "built it" }),
    ] });
    const b = problemBand(input({ history: h, task: { status: "open", goal_ref: "g", readiness: "ready", workflow_run_id: "r2" } as never, lineOn: false }));
    expect(b).toMatchObject({ kind: "unanswered", ref: "sd-615", withdrawn: true, recommend: "drop", built: true, runId: "r2" });
    const day = new Date(NOW - 10 * H).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    expect(problemNow(b)).toEqual({ status: "newask", phrase: `Fix withdrawn ${day}, unanswered` });
    expect(JSON.stringify(b)).not.toContain("Held");
  });
  test("a trial's card answered Ship is the trial's end, not In review under someone else (ct-59229)", () => {
    const h = hist({ attempts: [attempt({ runId: "r4", n: 4, outcome: { tone: "calm", end: null, text: "Stopped at Would ship" } as never, card: card({ status: "answered", answer: "Ship", answeredAt: NOW - 3 * H }) })] });
    const b = problemBand(input({ issue: issue({ status: "in_review" }), history: h, task: { status: "in_review", goal_ref: "g", readiness: "ready" }, trial: true }));
    expect(b).toMatchObject({ kind: "trial", verb: "Ship", ref: "sd-615", runId: "r4" });
    // Never counted with the real fixes that wait on a merge: a trial ships nothing.
    expect(problemNow(b)).toEqual({ status: "trial", phrase: "Trial: you would ship" });
    // Its run row says what was chosen, in plain words.
    expect(workRows(h, [], { trial: (id) => id === "r4" })[0]).toMatchObject({ outcome: "Trial: you would ship", answer: { words: "Would ship · trial" } });
    // The same answer outside a trial is not a trial's end.
    expect(problemBand(input({ issue: issue({ status: "in_review" }), history: h, task: { status: "in_review", goal_ref: "g", readiness: "ready" } })).kind).not.toBe("trial");
  });
  test("a run that handed the problem back with nothing to answer reads as escalated, with the count it refused on (ct-57459)", () => {
    const notes = [{ author: "Aivery", text: "Refine refused: the eviction guard tripped. 107 of 246 cluster members reject C119 (e.g. 3e986cf9 is a vague cancellation notice), so the cluster is an umbrella. Nothing was written.", created_at: NOW - 30 * H }];
    const h = hist({ attempts: [attempt({ runId: "r2", start: NOW - 31 * H, end: NOW - 30 * H, outcome: { tone: "waiting", end: null, text: "Handed to a person at Refine." } as never })] });
    const b = problemBand(input({ issue: issue({ status: "in_review" }), history: h, task: { status: "in_review", goal_ref: "g", readiness: "ready" }, notes }));
    expect(b).toMatchObject({ kind: "escalated", step: "Refine", rejects: { n: 107, of: 246 } });
    expect(problemNow(b)).toEqual({ status: "failed", phrase: "Escalated at Refine: 107 of 246 findings reject the cause" });
    // Its Work row never says "Waiting on you": nothing on the page can be answered.
    expect(workRows(h, [])[0]).toMatchObject({ outcome: "Escalated at Refine", tone: "warn" });
  });
  test("a run that parked it because main already has the fix says so, with the commit (ct-59687)", () => {
    const h = hist({ attempts: [attempt({ ended: "parked" })] });
    const note = "Already fixed on main by fc0d85ba65 (classifies workspacePurge + slackRosterPrivatize in networkMutationAudit); CI on it in progress";
    const b = problemBand(input({ history: h, task: { status: "open", goal_ref: "g", readiness: "not_actionable", readiness_note: note } }));
    expect(b).toMatchObject({ kind: "parked", fixedSha: "fc0d85ba65" });
    expect(bandLine(b).text).toBe("Already fixed on main (fc0d85b)");
    expect(workRows(h, [], { parked: bandLine(b).text })[0].outcome).toBe("Already fixed on main (fc0d85b)");
  });
  test("a run whose finding was moved to another problem after it ran belongs to that problem (ct-57459 run 1 -> ct-58022)", () => {
    const moves = movedOut([{ author: "line", text: "Moved 1 signal (union:cluster:dca71abf-fbac-4e37-8ae4-762854df836e) to ct-58022: a different mechanism from this cause.", created_at: NOW }]);
    expect(moves).toEqual([{ to: "ct-58022", at: NOW, keys: ["union:cluster:dca71abf-fbac-4e37-8ae4-762854df836e"] }]);
    const run1 = attempt({ start: NOW - 10 * H, proposed: "Held revival call cards can be dialed outside the contact's calling hours because the dial checks only the card's stored start time" });
    const run2 = attempt({ start: NOW - 8 * H, found: "Refine of the effort-narration cluster against C119 refused" });
    const title = (ref: string) => (ref === "ct-58022" ? "Held revival call cards can be dialed outside the contact's calling hours" : null);
    expect(runMovedTo(run1, moves, title)).toBe("ct-58022");
    expect(runMovedTo(run2, moves, title)).toBeNull();
    // A run that started after the move is this problem's own.
    expect(runMovedTo({ ...run1, start: NOW + H }, moves, title)).toBeNull();
    expect(movedOut([{ author: "line", text: "Moves: 3 out\nOut: 2 to ct-1 (new), 1 to ct-2", created_at: NOW }]).map((m) => m.to)).toEqual(["ct-1", "ct-2"]);
  });
});

describe("findings say what happened, never the expectation again", () => {
  test("a title cut at its cap heads the page whole, from the expectation its findings restate", () => {
    expect(problemHeading(CUT, [judged("M7 led with counts.")])).toBe(EXPECT);
    // With no finding to read it from, it ends on a whole word, never mid-word.
    expect(problemHeading(CUT, [])).toMatch(/means nothing to…$/);
  });
  test("a finding's row and body leave out the bold expectation line, whatever its stored title was cut to", () => {
    const blocks = findingBlocks(judged("M2, M3 and M4 narrated missed call attempts."), EXPECT);
    expect(blocks[0]).toEqual({ kind: "text", text: "M2, M3 and M4 narrated missed call attempts." });
    expect(blocks.some((b) => b.text.startsWith("A message to a contact"))).toBe(false);
  });
  test("an escalation reads as the contact, the ask and what woke it; its body is the agent's reason, quoted (ct-57442)", () => {
    const s = { title: "Brokers keep asking a person to call: email ceiling and no text thread, human call next", source: "union.escalation", subject: "call_attempt_failed",
      detail_md: "1 escalation and difficulty notes under this fingerprint in the last 7 days.\nAsk: Call, for the problem \"email ceiling and no text thread, human call next\".\nThis one: a escalation from broker woken by `call_attempt_failed`, 2026-10-09T18:17:18.128Z.\nLane: Stays open until the record is fixed — use \"Record fixed, resume\".\n\nThe agent's reason (data, its own words):\n```\nCaitlin Jones has reached the 6-email ceiling (unanswered since June 3). Two call attempts just failed (voicemail).\n```" };
    const e = escalationFinding(s)!;
    expect(escalationWords(e)).toBe("Caitlin Jones · Call: Email ceiling and no text thread, human call next · after a failed call");
    const blocks = findingBlocks(s);
    expect(blocks).toEqual([{ kind: "quote", text: "Caitlin Jones has reached the 6-email ceiling (unanswered since June 3). Two call attempts just failed (voicemail)." }]);
    expect(escalationWords(escalationFinding({ ...s, subject: "proactive", detail_md: s.detail_md.replace("call_attempt_failed", "proactive").replace("Caitlin Jones has", "Steffen Trabert (SVP Sales APAC) has") })!)).toBe("Steffen Trabert · Call: Email ceiling and no text thread, human call next");
  });
});

test("a need an earlier run raised is over once a newer run moved on (ct-57509: Run 2 stopped at Prove, Run 3 approved)", () => {
  const h = hist({ attempts: [attempt({ runId: "r2", start: NOW - 80 * H, end: NOW - 79 * H }), attempt({ runId: "r3", n: 2, start: NOW - 20 * H, end: NOW - 18 * H, ended: "shipped", card: { decisionId: "d", ref: "sd-583", headline: null, change: null, wrong: null, recommend: null, status: "answered", answer: "Ship", note: null, answeredAt: NOW - 19 * H } })] });
  const b = problemBand(input({ history: h, need: { kind: "stopped", since: null, fail: null, runId: "r2" } }));
  expect(b.kind).toBe("approved");
  expect(problemBand(input({ history: h, need: { kind: "stopped", since: null, fail: null, runId: "r3" } })).kind).toBe("need");
});


describe("findingLeads", () => {
  // ct-58311: eight AgentWatch findings, each titled with the expectation the problem heads with.
  const title = "A contact deals with one consistent Union representative, and a rep who has left stops signing Union's emails";
  const f = (body: string) => ({ title: `Not met: ${title}`, source: "agentwatch", detail_md: `**${title}**\n\n${body}` });
  test("findings that restate the heading lead with what each says, never the heading", () => {
    const rows = [f("Gabe heard from Quinn, then Shea Gomez, then Riley."), f("Dana got a Monday note signed by Quinn after Quinn left.")];
    const lead = findingLeads(rows, title);
    expect(rows.map(lead)).toEqual(["Gabe heard from Quinn, then Shea Gomez, then Riley.", "Dana got a Monday note signed by Quinn after Quinn left."]);
  });
  test("a finding with its own title keeps it; a judge's moment keeps its title", () => {
    const lead = findingLeads([{ title: "Rep re-rolled the persona", source: "agentwatch", detail_md: "x" }], title);
    expect(lead({ title: "Rep re-rolled the persona", source: "agentwatch", detail_md: "x" })).toBeNull();
    expect(findingLeads([f("a"), f("b")], title)({ ...f("a"), moment: {} })).toBeNull();
  });
});

describe("askedAbout", () => {
  const f = (id: string, detail: string) => ({ title: "Not met: A contact deals with one consistent Union representative", detail_md: detail, source: "agentwatch", id });
  const rows = [
    f("gabe", "Gabe heard from Quinn (M2, M3, M5), then Shea Gomez, then Riley."),
    f("luis", "Luis dealt with Blake, then Reese, Jordan and Blake again."),
    f("akash", "Akash had been dealing with Quinn. The follow-ups after the call came from Riley."),
  ];
  test("points a question at the finding that names the most of its people", () => {
    const ask = "Has Quinn actually left, or is Quinn still active?\nAkash dealt with Quinn but the post-call follow-ups were signed Riley.";
    expect(askedAbout(ask, rows).map((r) => r.id)).toEqual(["akash"]);
  });
  test("a question that names nobody, or names everyone alike, points at none", () => {
    expect(askedAbout("Is this a real problem?", rows)).toEqual([]);
    expect(askedAbout("Does Union keep one representative?", rows)).toEqual([]);
  });
});

describe("a problem's words as a person reads them", () => {
  test("agent reports lose their bookkeeping and the cause ids nobody can open", async () => {
    const { personWords } = await import("../problemPage");
    expect(personWords("Proposed fix for C120: tighten the grader")).toBe("Proposed fix: tighten the grader");
    expect(personWords("Proved C120: on 89 of 154 calls")).toBe("Proved: on 89 of 154 calls");
    expect(personWords("[the broker · matching layer] Done: I proved cause C116.")).toBe("I proved the cause.");
    expect(personWords("Fix the CSS for C-level calls")).toBe("Fix the CSS for C-level calls");
  });
  test("a title stored cut and never named heads by its first whole clause, with the filed report whole beneath (ct-59687)", async () => {
    const { clauseHeading } = await import("../../lineFlow");
    const { problemStatement } = await import("../problemPage");
    const cut = "Main CI red at ac5c98b: networkMutationAudit.test.ts fails because the new Slack files lib/slack/workspacePurge.ts and lib/backfill/slackRosterPrivatize.ts (commit 72590565, Slack private roster/purg…";
    expect(clauseHeading(cut)).toBe("Main CI red at ac5c98b: networkMutationAudit.test.ts fails");
    expect(clauseHeading("A whole title")).toBeNull();
    const desc = "Opened by a bug report from person.\n\nAbout: outreach/backend/tests/unit/networkMutationAudit.test.ts\n\nCI run 38315407325 on main ac5c98b2af. Failing test: 'network mutation audit'.";
    expect(problemStatement(cut, desc, [])).toBe("CI run 38315407325 on main ac5c98b2af. Failing test: 'network mutation audit'.");
    expect(problemStatement("A whole title", desc, [])).toBe("A whole title");
  });
});

describe("saysSame", () => {
  test("a statement that only adds a closing period repeats its heading (ct-59561)", () => {
    const h = "When a phone call ends with no transcript, it is saved as voicemail even after the answering-machine check said a human picked up";
    expect(saysSame(`${h}.`, h)).toBe(true);
    expect(saysSame(`${h}. Then the follow-up is a voicemail one.`, h)).toBe(false);
  });
});

test("dropMessageRefs: a judge's message labels leave the finding's words, the words around them stay", async () => {
  const { dropMessageRefs } = await import("../problemPage");
  expect(dropMessageRefs("Gabe heard from Quinn (M2, M3, M5), then Shea")).toBe("Gabe heard from Quinn, then Shea");
  expect(dropMessageRefs("mail signed Reese (M4), Jordan (M5) and Blake again (M6).")).toBe("mail signed Reese, Jordan and Blake again.");
  expect(dropMessageRefs("handled by Reese (B-M1, a reply about the drafts) and then by Mary-Alexis (B-M2, B-M3), who")).toBe("handled by Reese (a reply about the drafts) and then by Mary-Alexis, who");
  expect(dropMessageRefs("a MacBook (M2) and (MacBook M2)")).toBe("a MacBook and (MacBook M2)");
});

test("statementAdds: a problem filed from one report does not print that report twice (ct-59687)", async () => {
  const { statementAdds } = await import("../problemPage");
  const report = "CI run 38315407325 on main ac5c98b2af. Failing test: 'network mutation audit'. 7533 pass / 1 fail otherwise.";
  expect(statementAdds(report, "Main CI red at ac5c98b", [{ detail_md: report }])).toBe(false);
  expect(statementAdds(report, "Main CI red at ac5c98b", [{ detail_md: report }, { detail_md: "another" }])).toBe(true);
  expect(statementAdds("Main CI red at ac5c98b.", "Main CI red at ac5c98b", [])).toBe(false);
});

describe("fixMerges", () => {
  test("only a merged pull request on the problem's own line branch, linked to it", () => {
    const prs = [
      { state: "merged", merged_at: 5, head_ref: "codecast/line-ct-58282", task_ids: ["t1", "t2"], repository: "u/m", number: 3859 },
      { state: "open", head_ref: "codecast/line-ct-1", task_ids: ["t3"], repository: "u/m", number: 1 },
      { state: "merged", merged_at: 6, head_ref: "feature/x", task_ids: ["t1"], repository: "u/m", number: 2 },
    ];
    const ref = (id: string) => ({ t1: "ct-58282", t2: "ct-58281", t3: "ct-1" } as Record<string, string>)[id];
    expect([...fixMerges(prs, ref)]).toEqual([["t1", { at: 5, url: "https://github.com/u/m/pull/3859", branch: "codecast/line-ct-58282", into: null }]]);
  });

  test("a commit naming the problem that landed on main is its merge; a merged pull request of its branch says more and wins (ct-57458)", () => {
    const landed = (id: string) => ({ _id: id, landed: { sha: "0af8b0b8ab", at: 4, url: "https://github.com/u/m/commit/0af8b0b8ab", branch: "main" } });
    const prs = [{ state: "merged", merged_at: 5, head_ref: "codecast/line-ct-58282", task_ids: ["t1"], repository: "u/m", number: 3859 }];
    const ref = (id: string) => ({ t1: "ct-58282", t4: "ct-57458" } as Record<string, string>)[id];
    expect(new Map(fixMerges(prs, ref, [landed("t1"), landed("t4"), { _id: "t5" }]))).toEqual(new Map([
      ["t1", { at: 5, url: "https://github.com/u/m/pull/3859", branch: "codecast/line-ct-58282", into: null }],
      ["t4", { at: 4, url: "https://github.com/u/m/commit/0af8b0b8ab", sha: "0af8b0b8ab", into: "main" }],
    ]));
  });
});

describe("misfiledAsks (ct-58847)", () => {
  const ask = { source: "union.escalation", subject: "proactive", detail_md: "Ask: Decide, for the problem \"consent pitches\".\nThis one: a escalation from broker woken by `proactive`.\n\n```\nFIFTH escalation. ASK (decide by Oct 15)\n```" };
  const judge = { source: "agentwatch", subject: null, detail_md: "The classifier filed a company need as a person's need." };
  test("an escalation ask on a problem about something else sits apart", () => {
    expect([...misfiledAsks([judge, ask])]).toEqual([ask]);
  });
  test("a problem whose findings are all escalations keeps them", () => {
    expect(misfiledAsks([ask, { ...ask }]).size).toBe(0);
  });
});

describe("findingCut: an opened finding that ends cut says so", () => {
  const url = "https://admin.unionmatching.com/admin/agent-runs?run=b95c0739";
  const head = "You never asked what else he ne…";
  test("a whole the sender clipped names who cut it and where", () => {
    const cut = findingCut(head, { data: `${"x".repeat(1499)}…`, error: false });
    expect(cut).toEqual({ kind: "sender", at: 1500 });
    expect(findingCutWords(cut!, url)).toBe("Cut by Union at 1,500 characters");
    expect(findingCutWords(cut!, null)).toBe("Cut by its sender at 1,500 characters");
  });
  test("a head shown while the whole has not arrived, or could not be read, is never shown as whole", () => {
    expect(findingCut(head, { data: undefined, error: false })).toEqual({ kind: "loading" });
    expect(findingCut(head, { data: undefined, error: true })).toEqual({ kind: "failed" });
    expect(findingCut(head, { data: null, error: false })).toEqual({ kind: "failed" });
    expect(findingCutWords({ kind: "failed" }, url)).toBe("Cut here: the rest did not load");
  });
  test("an uncut feed, or a whole that arrived whole, has no cut line", () => {
    expect(findingCut("All of it.", { data: undefined, error: false })).toBeNull();
    expect(findingCut(head, { data: "All of it, whole.", error: false })).toBeNull();
  });
});

describe("a commit a finding names as merged that is not this fix's (ct-57509)", () => {
  test("is found, newest first, and never the fix's own merge", async () => {
    const { citedMerge } = await import("../problemPage");
    const rows = [
      { title: "request_call refuses calls", detail_md: "Restart of existing cause ct-57509 (ship blocked; gate fix merged 9e85377773).", created_at: NOW - 6 * H },
      { title: "older", detail_md: "merged 1234567abc", created_at: NOW - 60 * H },
    ];
    expect(citedMerge(rows, null, null)).toEqual({ sha: "9e85377773", at: NOW - 6 * H });
    expect(citedMerge(rows, null, "9e8537777326f5872c")).toEqual({ sha: "1234567abc", at: NOW - 60 * H });
    expect(citedMerge([{ title: "nothing merged here", created_at: NOW }], null, null)).toBeNull();
  });
});

describe("a run that closed without a change says why, by what its close argued", () => {
  test("ct-59338 Run 1: a fix another problem owns is not 'not a problem'", () => {
    expect(dissolvedOutcome({ kind: "in_flight", into: "ct-57467" })).toEqual({ words: "Already being fixed in ct-57467", ref: "ct-57467" });
    expect(dissolvedOutcome({ kind: "known_cause", into: "ct-59229" })).toEqual({ words: "The same problem as ct-59229", ref: "ct-59229" });
    expect(dissolvedOutcome({ kind: "already_fixed", into: "4a97f88c01" })).toEqual({ words: "Already fixed by 4a97f88", ref: null });
    expect(dissolvedOutcome({ kind: "judge_defect", into: null })).toEqual({ words: "The judge was wrong", ref: null });
    expect(dissolvedOutcome(null)).toEqual({ words: "Turned out not to be a problem", ref: null });
  });
});

describe("a trial's practice decision", () => {
  test("files under Trial on Problems, never Waiting on you", () => {
    expect(problemNow({ kind: "need", need: "decision", since: null, step: null, askedAt: null, trial: true }).status).toBe("trial");
    expect(problemNow({ kind: "need", need: "decision", since: null, step: null, askedAt: null }).status).toBe("you");
  });
});
