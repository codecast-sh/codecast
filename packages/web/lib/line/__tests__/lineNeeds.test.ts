import { describe, expect, test } from "bun:test";
import { buildLineInbox, inboxCount, type InboxGroup, type InboxRow } from "../lineInbox";
import { foldDuplicateNeeds, isPractice, goOnProof, lineNeeds, needCount, oneCaseClaim, proseAdvice, type LineNeed, needCounted, needForRef, needKind, needOfCase, stopAnswered, stoppedAsk, waitNote, yesNote, needsOfLine } from "../lineNeeds";
import { waitsForFindings } from "../lineInbox";
import { failCause } from "../runReport";
import type { LineAdmission, RollupRow } from "../../lineFlow";

const now = Date.UTC(2026, 9, 12, 12);
const H = 3_600_000;
const row = (kind: InboxRow["kind"], key: string, over: Partial<InboxRow> = {}): InboxRow => ({
  key: `${kind}:${key}`, kind, at: now - H, projectId: "p1", title: `Problem ${key}`, ref: `ct-${key}`, detail: null, caseId: key, runId: null, cardId: null, cardRef: null, ...over,
});
const group = (kind: InboxRow["kind"], rows: InboxRow[]): InboxGroup => ({ kind, label: kind, rows });

describe("what waits on the viewer (lineNeeds)", () => {
  // A deadend run with outcome success stopped needing a yes; one that failed at its step is a failure, not a need.
  const stopped = { key: "deadend:prove", step: "prove", label: "Prove: needs Cameron's yes before it ships", raw: "no outgoing edge from prove (outcome success)" };
  // A step that passed and said nothing about a person still stopped on the person: nothing failed, nowhere to go.
  const quiet = { key: "deadend:prove", step: "prove", label: "Prove finished", raw: "no outgoing edge from prove (outcome success)" };
  const failed = { key: "deadend-failed:prove", step: "prove", label: "Prove failed", raw: "no outgoing edge from prove (outcome failure)" };
  const groups: InboxGroup[] = [
    group("decide", [row("decide", "1", { cardId: "d1", cardRef: "sd-1", ask: "Ship the shorter close?", at: now - 2 * H }), row("decide", "2", { cardId: "d2", cardRef: "sd-2", at: now - 5 * H })]),
    group("question", [row("question", "3", { ask: "Has Quinn left, or is Riley wrong?", note: "Akash took the call. Has Quinn left, or is Riley wrong?" })]),
    group("unapproved", [row("unapproved", "4")]),
    group("confirm", [row("confirm", "5", { ask: "Is this a real problem?" })]),
    group("failed", [row("failed", "6", { runId: "r6", fail: stopped }), row("failed", "7", { runId: "r7", fail: failed }), row("failed", "13", { runId: "r13", fail: quiet })]),
    group("stalled", [row("stalled", "8", { runId: "r8" })]),
    group("watching", [row("watching", "9")]),
    group("proposal", [row("proposal", "10", { trial: true, cardRef: "tc-10", hold: "No session asked this card" })]),
    group("stuck", [row("stuck", "p1", { caseId: null, ref: null, waiting: 47, switchOff: true }), row("stuck", "p2", { caseId: null, ref: null, waiting: 3, switchOff: false })]),
  ];
  const needs = lineNeeds(groups, { row: (r) => (r.caseId === "1" ? "agentwatch" : "codecast-line") });

  test("counts only the decision a session presents at the end: what a station asked before it never waits on a person", () => {
    expect(needs.map((n) => [n.ref, n.kind, n.counted])).toEqual([
      ["sd-1", "decision", true], ["sd-2", "decision", true], ["ct-3", "question", false], ["ct-4", "lapsed", false],
      ["ct-5", "confirm", false], ["ct-6", "stopped", false], ["ct-13", "stopped", false], ["tc-10", "reask", false],
    ]);
    expect(needCount(needs)).toBe(2);
    // The old count and the new one are one reading.
    expect(inboxCount(groups)).toBe(needCount(needs));
  });

  test("a failed step, a silent run, a problem waiting for findings and a line that is off are never needs", () => {
    expect(needs.some((n) => ["ct-7", "ct-8", "ct-9"].includes(n.ref))).toBe(false);
  });

  test("For you lists the decisions only; the rest is never listed, and the list and the count are one set", () => {
    const listed = needs.filter((n) => n.counted);
    expect(listed.map((n) => n.ref)).toEqual(["sd-1", "sd-2"]);
    expect(listed.length).toBe(needCount(needs));
  });

  test("a need carries what its reader shows: the question whole, its process, the stopped step's words", () => {
    expect(needs[0]).toMatchObject({ ask: "Ship the shorter close?", process: "agentwatch", decisionRef: "sd-1", caseId: "1" });
    expect(needs[2]).toMatchObject({ ask: "Has Quinn left, or is Riley wrong?", note: "Akash took the call. Has Quinn left, or is Riley wrong?" });
    // A stopped run's row names its problem; its reader carries what the step said.
    expect(needs.find((n) => n.kind === "stopped")?.line).toBe("Problem 6");
    expect(needs.find((n) => n.kind === "stopped")).toMatchObject({ ask: "Prove finished: go on to Build?", runId: "r6" });
    expect(needs.find((n) => n.kind === "reask")).toMatchObject({ why: "No session asked this card", trial: true });
  });

  test("a list row says the question when it stands on its own, else the problem; a note cut inside its ask keeps the ask, marked cut", () => {
    const cut = `Two reports of the card name. ${"The card's name set is thin. ".repeat(12)}A person needs to confirm whether the card's name set came from truncated data or from the grader's own reading of the call summary and its four names.`.slice(0, 500);
    expect(cut.length).toBe(500);
    const [n] = lineNeeds([group("confirm", [row("confirm", "11", { title: "Card names come out cut", note: cut, ask: "Confirm whether ... from th" })])]);
    // The ask is the sentence that asks (ct-58683), never the statement before it.
    expect(n.ask.startsWith("Confirm whether the card's name set came from")).toBe(true);
    expect(n.ask.endsWith("…")).toBe(true);
    const [q] = lineNeeds([group("question", [row("question", "12", { title: "Eval gate fails", note: "Two causes fit. Choose which before work starts." })])]);
    expect(q.line).toBe("Eval gate fails");
    expect(q.ask).toBe("Choose which before work starts.");
  });

  test("a ref finds its need: the URL's own, an older link's decision or card, a problem", () => {
    expect(needForRef(needs, "sd-1")?.key).toBe("decide:1");
    expect(needForRef(needs, "d2")?.key).toBe("decide:2");
    expect(needForRef(needs, "tc-10")?.kind).toBe("reask");
    expect(needForRef(needs, "ct-3")?.kind).toBe("question");
    expect(needForRef(needs, "ct-404")).toBeNull();
    expect(needOfCase(needs, "4")?.kind).toBe("lapsed");
  });

  test("a trial card a session posted opens its decision; one nobody can answer is named by its card", () => {
    const off: LineAdmission = { role: { id: "r", handle: "lead", paused: false }, on: false, slots: 1, busy: null, hands: null, handsCap: null };
    const built = buildLineInbox({
      signals: [], runs: [], projects: [], rollups: [] as RollupRow[], admissions: new Map([["p1", off]]), now, decisions: [],
      tasks: [{ _id: "t1", short_id: "ct-1", title: "One", status: "open", project_id: "p1" }, { _id: "t2", short_id: "ct-2", title: "Two", status: "open", project_id: "p1" }] as never,
      trialCards: [
        { _id: "c1", short_id: "tc-1", project_id: "p1", task_id: "t1", run_id: "r1", kind: "card", question: "Ship?", options: [], status: "waiting", created_at: now - H, decision: { _id: "dd1", short_id: "sd-9", status: "pending" } },
        { _id: "c2", short_id: "tc-2", project_id: "p1", task_id: "t2", run_id: "r2", kind: "card", question: "Ship?", options: [], status: "waiting", created_at: now - H },
      ],
    });
    const n = lineNeeds(built);
    expect(n.map((x) => [x.ref, x.kind, x.counted, x.trial])).toEqual([["sd-9", "decision", true, true], ["tc-2", "reask", false, true]]);
  });
});

describe("stoppedAsk: the yes a stopped run waits on", () => {
  test("a step that finished with a report asks to go on to the next stage, and says what a yes records", () => {
    const ask = stoppedAsk({ key: "deadend:prove", step: "prove", label: "Prove: Showed the call grader still faulting Anna.", raw: "", check: null });
    expect(ask).toMatchObject({ step: "Prove", next: "Build", line: "Prove finished: go on to Build?" });
    expect(ask!.note).toBe("Yes: go on to Build with what Prove found (Showed the call grader still faulting Anna).");
  });
  test("a step that ended without a report has no yes to give, and is no need", () => {
    const silent = { key: "deadend-silent:build", step: "build", label: "Build ended without a report", raw: "", check: null };
    expect(stoppedAsk(silent)).toBeNull();
    expect(needKind({ kind: "failed", fail: silent })).toBeNull();
  });
});

describe("a yes or a wait given to a stopped step", () => {
  const fail = { key: "deadend:prove", step: "prove", label: "Prove: showed the grader still faulting Anna", raw: "" };
  test("is read off the problem's note: that stop waits on nobody, another stop still does", () => {
    const ask = stoppedAsk(fail)!;
    expect(stopAnswered(fail, yesNote(ask))).toBe(true);
    expect(stopAnswered(fail, "Confirmed by a person.")).toBe(false);
    expect(stopAnswered({ ...fail, key: "deadend:build", step: "build", label: "Build: built it" }, yesNote(ask))).toBe(false);
    expect(stopAnswered(fail, null)).toBe(false);
  });
  test("a wait parks it for more findings in words every surface reads as watched", () => {
    const ask = stoppedAsk({ ...fail, advice: { act: "wait", by: null, why: "It is still one case." } })!;
    expect(waitNote(ask)).toBe("Prove advised it waits for more findings: It is still one case.");
    expect(waitsForFindings(waitNote(ask))).toBe(true);
    expect(stopAnswered({ ...fail, advice: ask.advice }, waitNote(ask))).toBe(true);
  });
  test("a wait chosen where the step advised nothing never says the step advised it", () => {
    const ask = stoppedAsk(fail)!;
    expect(waitNote(ask)).toBe("After Prove, a person chose to wait for more findings.");
    expect(waitsForFindings(waitNote(ask))).toBe(true);
    expect(stopAnswered(fail, waitNote(ask))).toBe(true);
  });
});

describe("what a stopped step advised", () => {
  const run = (json: string) => ({
    fail_reason: "no outgoing edge from prove (outcome success, review_verdict none)", current_node_id: "prove",
    node_statuses: [{ node_id: "prove", status: "failed", label: "Prove", session: { _id: "s1", state: `Showed the miss on the base.\n\`\`\`json\n${json}\n\`\`\``, state_status: "done", message_count: 9 } }],
  });
  test("its routing JSON's next rides on the stop: wait with why, review with who", () => {
    expect(stoppedAsk(failCause(run('{"reproduced": true, "next": "wait", "why": "Still one case; size it in the daily audit."}')))?.advice).toEqual({ act: "wait", by: null, why: "Still one case; size it in the daily audit." });
    expect(stoppedAsk(failCause(run('{"reproduced": true, "next": "review", "by": "an engineer", "why": "It changes the shared runner."}')))?.advice).toEqual({ act: "review", by: "an engineer", why: "It changes the shared runner." });
    expect(stoppedAsk(failCause(run('{"reproduced": true, "next": "go"}')))?.advice).toEqual({ act: "go", by: null, why: null });
  });
  test("a step that advised nothing (or something unknown) carries no advice, so no answer leads", () => {
    expect(stoppedAsk(failCause(run('{"reproduced": true}')))?.advice).toBeNull();
    expect(stoppedAsk(failCause(run('{"reproduced": true, "next": "ship it"}')))?.advice).toBeNull();
  });
});

describe("a stop is a yes only when the step's own report says it finished (ct-59509, ct-57553, ct-59602)", () => {
  // The engine closed Prove at a turn end with `outcome success`; the session's own pinned word came later.
  const run = (state: string, status: string, result?: string) => ({
    fail_reason: "no outgoing edge from prove (outcome success, review_verdict none)", current_node_id: "prove",
    node_statuses: [{ node_id: "prove", status: "failed", label: "Prove", session: { _id: "s1", state, state_status: status, result, message_count: 62 } }],
  });
  test("a Prove that pinned itself blocked reads as blocked, with its words, and asks no yes", () => {
    const c = failCause(run("Miss reproduced on base (Anthony, Grayson and Adam each 0 of 5), but prove cannot finish: freeze.ts output is cut off, so the fix must land on main first.\n```json\n{\"reproduced\": true}\n```", "blocked", '{"reproduced": true}'));
    expect(c.key).toBe("deadend-failed-blocked:prove");
    expect(c.label).toMatch(/^Prove blocked: Miss reproduced on base/);
    expect(stoppedAsk(c)).toBeNull();
  });
  test("one waiting on a spend cap, or that found no miss, asks no yes either", () => {
    expect(stoppedAsk(failCause(run("Prove for ct-57553 is waiting on the desk wallet (over its $50/24h cap until ~19:00 UTC).", "dormant")))).toBeNull();
    const none = failCause(run("Not reproduced: the phone card's disposition form sends Spoke With Contact.\n```json\n{\"reproduced\": false}\n```", "done", '{"reproduced": false}'));
    expect(none.label).toMatch(/^Prove found no miss: /);
    expect(stoppedAsk(none)).toBeNull();
  });
  test("one that pinned done with the miss shown still asks to go on", () => {
    expect(stoppedAsk(failCause(run("Showed the miss on the base.\n```json\n{\"reproduced\": true}\n```", "done", '{"reproduced": true}')))?.line).toBe("Prove finished: go on to Build?");
  });
});

describe("a twin is asked once (foldDuplicateNeeds)", () => {
  // ct-59757 (Matching Engine) reads as ct-57470 (Agent Quality): both asked "is this real?" and both counted.
  const twins = (older: InboxRow | null) => lineNeeds([
    group("confirm", [...(older ? [older] : []), row("confirm", "59757", { projectId: "p2", findings: 3, at: now - H })]),
    group("decide", [row("decide", "59758", { cardId: "d9", cardRef: "sd-9" })]),
  ]);
  const twinOf = (id: string) => (id === "59757" || id === "59758" ? { caseId: "57470", ref: "ct-57470" } : null);

  test("a twin's confirm folds into the older problem's: one row, both findings, counted once, opened by either ref", () => {
    const needs = foldDuplicateNeeds(twins(row("confirm", "57470", { findings: 5, at: now - 120 * H })), twinOf);
    expect(needs.map((n) => [n.ref, n.kind])).toEqual([["ct-57470", "confirm"], ["sd-9", "decision"]]);
    expect(needCount(needs)).toBe(1);
    const older = needs[0];
    expect(older.findings).toBe(8);
    expect(older.dups).toEqual([{ ref: "ct-59757", caseId: "59757", projectId: "p2", findings: 3 }]);
    expect(needForRef(needs, "ct-59757")).toBe(older);
  });

  test("a twin whose older problem asks nothing waits on one act, merging it in, on Problems and never For you", () => {
    const needs = foldDuplicateNeeds(twins(null), twinOf);
    const dup = needs.find((n) => n.caseId === "59757")!;
    expect([dup.kind, dup.counted, dup.ask, dup.dupOf]).toEqual(["duplicate", false, "Same as ct-57470", { caseId: "57470", ref: "ct-57470" }]);
    expect(needs.filter((n) => n.counted).map((n) => n.kind)).toEqual(["decision"]);
  });

  test("a decision on a twin is about its own run: it stays its own", () => {
    const needs = foldDuplicateNeeds(twins(row("confirm", "57470")), twinOf);
    expect(needs.find((n) => n.ref === "sd-9")?.kind).toBe("decision");
  });
});

describe("a build no session presented is its run's to present, never a failure and never a person's to review", () => {
  test("its failure row is a review need nobody is asked: it needs a new ask", () => {
    const fail = { key: "review:implement", step: "implement", label: "Handed off for review", raw: "", review: { ask: "Needs a reviewer to confirm the outage guard.", gate: null } };
    expect(needKind({ kind: "failed", fail } as never)).toBe("review");
    expect(needCounted("review")).toBe(false);
    const [n] = lineNeeds([{ kind: "failed", rows: [{ key: "k", kind: "failed", fail, title: "Nudges dead-letter", ref: "ct-58682", caseId: "t1", projectId: null, runId: "r1", at: 1 }] }] as never);
    expect(n).toMatchObject({ kind: "review", counted: false, ask: "Needs a reviewer to confirm the outage guard.", line: "Nudges dead-letter" });
    expect(needCount([n])).toBe(0);
  });
});

describe("the proof a go-on run is checked by (ct-58847)", () => {
  test("a prompt cause is checked by a replay; Prove that wrote none is warned before the run is spent", () => {
    const said = "Shown red on main: #3850's classifier labels the trade needs \"personal\"; a unit test fails on that (committed, repro.sh), and no real moment could support a prompt freeze.";
    expect(goOnProof("prompt", said)).toEqual({ proof: "A replay of real moments (prompt cause)", warn: "Prove wrote no replay: Red sends it back" });
    expect(goOnProof("prompt", "I didn't write the prompt replay spec (prove.json); slackFocusTeamNeeds.test.ts fails on main").warn).toBe("Prove wrote no replay, only slackFocusTeamNeeds.test.ts: Red sends it back");
    expect(goOnProof("prompt", "Replayed 4 moments; each fails on the base").warn).toBeNull();
  });
  test("any other cause is checked by the test Prove writes", () => {
    expect(goOnProof("code", "the new test slackFocusTeamNeeds.test.ts fails on main")).toEqual({ proof: "slackFocusTeamNeeds.test.ts, the test Prove writes", warn: null });
    expect(goOnProof(null, null)).toEqual({ proof: "The test Prove writes", warn: null });
  });
});

describe("proseAdvice", () => {
  test("a closing review the step asks for before the build", () => {
    // ct-58694's Prove, which wrote no routing `next`.
    const a = proseAdvice("All three approved fixes got as far as the Ship card.\n\nNext: the plan on Union ship exit has three parts. Two of them change codecast's shared line graph and runner, so they need an engineer's safety review before they're built.");
    expect(a).toMatchObject({ act: "review", by: null });
    expect(a?.why).toBe("Two of them change codecast's shared line graph and runner, so they need an engineer's safety review before they're built.");
    expect(proseAdvice("Needs an engineer's safety review before merge (Ashot by default).")?.by).toBe("Ashot");
  });

  test("one case, or more cases first, is a wait", () => {
    // ct-57411's Prove.
    const a = proseAdvice("I posted the findings on the task and fixed nothing. This is still one case: the task asks that it be sized in the daily grader audit before anyone changes the prompt.");
    expect(a?.act).toBe("wait");
    expect(oneCaseClaim(a?.why)).toBe(true);
    expect(proseAdvice("The miss reproduced 5 of 5. Build it.")).toBeNull();
  });
});

describe("practice answers", () => {
  test("a trial's decision is in the team's count like any other; a judge fix is never practice", () => {
    const need = (ref: string, trial: boolean, publishes?: boolean) => ({ key: ref, ref, kind: "decision", counted: true, trial, publishes, since: now } as unknown as LineNeed);
    expect(needCount([need("sd-1", false), need("sd-2", true)])).toBe(2);
    expect(isPractice(need("sd-2", true))).toBe(true);
    expect(isPractice(need("sd-3", true, true))).toBe(false);
  });
});


describe("needsOfLine", () => {
  test("a line's needs, in its project when one is picked; no line keeps every need", () => {
    const n = (process: string | null, projectId: string | null) => ({ process, projectId });
    const all = [n("aw", "trial"), n("aw", "aw"), n("line", "cc"), n(null, null)];
    expect(needsOfLine(all, "aw")).toEqual([n("aw", "trial"), n("aw", "aw")]);
    expect(needsOfLine(all, "aw", "trial")).toEqual([n("aw", "trial")]);
    expect(needsOfLine(all, null)).toEqual(all);
  });
});
