// A step page's rows (line-journeys.md LJ8.6): every problem under exactly one
// of Waiting, Failed or Passed, the counts the rows they open, failures grouped
// by cause, and a report read in words a person uses.
import { describe, expect, test } from "bun:test";
import type { StepDecision } from "../lineModel";
import { newestRuns, spendCapWords } from "../stepWork";
import { causeClass, causeHead, closedProblems, concludedText, defaultShow, evalFailWords, failCauseOf, handoffOutcome, outcomeLineInWords, plainOutcome, stallOf, reportRows, showLabels, stepWork, visitDecision, withoutMachinePaths } from "../stepWork";
import type { DecisionOutcome } from "../decisionOutcome";

const d = (id: string, over: Partial<{ status: StepDecision["status"]; outcome: string | null; caseId: string | null; words: string; at: number; superseded: boolean; reasoning: string | null }> = {}): StepDecision => ({
  id, runId: `run-${id}`, caseId: over.caseId === undefined ? `c-${id}` : over.caseId, caseRef: `ct-${id}`, caseTitle: `Problem ${id}`, at: over.at ?? 1000, durationMs: null, status: over.status ?? "done",
  received: { from: null, fromLabel: null, summary: "", said: false, sessionId: null, href: null },
  decided: { outcome: over.outcome ?? null, words: over.words ?? "Found why it happens", result: null, to: null, toLabel: null, toWords: null },
  reasoning: over.reasoning ?? null, label: null, labels: [], ...(over.superseded ? { superseded: true } : {}),
});

describe("a step's work", () => {
  const decisions = [
    d("1", { status: "waiting", at: 300 }), d("2", { status: "waiting", at: 100 }), d("3", { status: "live" }),
    d("4", { status: "failed", outcome: "failed", words: "could not write a test for the problem" }),
    d("5", { status: "failed", outcome: "failed", words: "could not write a test for the problem" }),
    d("6", { status: "failed", words: "failed" }), d("7", { outcome: "red" }), d("8", { outcome: "mechanism" }),
    d("9", { status: "waiting", superseded: true }),
    // An earlier run of problem 7 that failed: the step failed it once and then passed it, and both are rows.
    d("7b", { status: "failed", caseId: "c-7", words: "failed" }),
    d("10", { status: "failed", words: "failed" }),
  ];

  test("every problem sits under exactly one count, and each count is its rows", () => {
    const w = stepWork({ decisions }, { stopped: new Set(["run-10"]) });
    expect(w.counts).toEqual({ waiting: 4, failed: 4, passed: 2 });
    expect(w.waiting.length).toBe(w.counts.waiting);
    expect(w.failed.reduce((n, g) => n + g.rows.length, 0)).toBe(w.counts.failed);
    expect(w.passed.length).toBe(w.counts.passed);
    const keys = [...w.waiting, ...w.failed.flatMap((g) => g.rows), ...w.passed, ...w.replaced].map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(11);
  });

  test("what waits on a person leads, oldest first; a run that stopped needing a yes waits, it did not fail; a running one is last", () => {
    const w = stepWork({ decisions }, { stopped: new Set(["run-10"]) });
    expect(w.waiting.map((r) => [r.d.id, r.state])).toEqual([["2", "waiting"], ["1", "waiting"], ["10", "stopped"], ["3", "running"]]);
    expect(w.replaced.map((r) => r.d.id)).toEqual(["9"]);
  });

  test("a finished step's yes of a problem a newer run took up waits on nobody: it folds under Replaced", () => {
    // ct-57876: its Oct 8 Prove finished asking for a yes; its Oct 12 run went on and failed at Implement.
    const old = d("40", { status: "failed", caseId: "c-40", at: 100 });
    const w = stepWork({ decisions: [old] }, { stopped: new Set(["run-40"]), newest: new Map([["c-40", "run-41"]]), standing: new Map([["c-40", { now: "Failed at Implement" }]]) });
    expect(w.counts.waiting).toBe(0);
    expect(w.replaced.map((r) => [r.d.id, r.state, r.now])).toEqual([["40", "replaced", "Failed at Implement"]]);
    // The problem's newest run still waits on its yes.
    expect(stepWork({ decisions: [old] }, { stopped: new Set(["run-40"]), newest: new Map([["c-40", "run-40"]]) }).waiting.map((r) => r.state)).toEqual(["stopped"]);
  });

  test("failures are grouped by cause, the largest first, each cause in plain words", () => {
    const w = stepWork({ decisions });
    expect(w.failed.map((g) => [g.label, g.rows.length])).toEqual([["No reason recorded", 3], ["Could not write a test for the problem", 2]]);
    // The run's own reason, when it failed here, names the cause.
    const named = stepWork({ decisions }, { causes: new Map([["run-6", { key: "killed:prove", label: "out of time, 30m" }]]) });
    expect(named.failed.map((g) => g.label)).toContain("Out of time, 30m");
    // A dead end only says the run stopped: the step's own words for how it failed name the cause.
    const deadEnd = stepWork({ decisions: [d("11", { status: "failed", words: "Could not write a test for the problem" })] }, { causes: new Map([["run-11", { key: "deadend-failed:prove", label: "Prove gave no result" }]]) });
    expect(deadEnd.failed[0].label).toBe("Could not write a test for the problem");
  });

  test("the line's own label for a failed step is no reason: a dead end with no words reads as the step that left no report", () => {
    // Real ids are "<run>:<step>", so the step is known: "Could not write a test" is Prove's label, not what a run said.
    const visit = { ...d("12", { status: "failed", words: "Could not write a test for the problem" }), id: "run-12:prove" };
    const w = stepWork({ decisions: [visit] }, { causes: new Map([["run-12", { key: "deadend:prove", label: "Prove ended without a report" }]]) });
    expect(w.failed[0].label).toBe("Prove ended without a report");
    // failCauseOf keeps a ref as written (stepWork reads it as a class); a long one heads its group by its first line, kept whole beside it.
    expect(failCauseOf(d("13", { status: "failed", words: "ct-59231 has no findings: nothing to work from" })).label).toBe("ct-59231 has no findings: nothing to work from");
    expect(causeHead("checks failed\n/Users/x/src/app/a.ts(3,1): TS7006")).toBe("checks failed");
    // A printout that leads with what passed heads its group by the line that failed.
    expect(causeHead("1 ✓ backend: 0 errors (pass 29m old) ✓ landing: 0 errors (pass 2m old) ../backend/src/lib/apollo.ts(54,13): error TS7006: Parameter 'x' implicitly has an 'any' type."))
      .toBe("../backend/src/lib/apollo.ts(54,13): error TS7006: Parameter 'x' implicitly has an 'any' type.");
  });

  test("a cause is a class of failure: one problem's sentence never names the cause of the others (Problem step, ct-59231)", () => {
    const rows = ["59231", "59232", "59233", "59234"].map((n) => d(n, { status: "failed", words: `ct-${n} has no findings: nothing to work from` }));
    const w = stepWork({ decisions: rows });
    expect(w.failed.map((g) => [g.label, g.rows.length])).toEqual([["No findings: nothing to work from", 4]]);
    // A run's own reason that leads with a ref groups the same way; one with no ref is left as it is.
    expect(causeClass({ key: "other:ct-1 has no findings", label: "ct-1 has no findings" })).toEqual({ key: "other:no findings", label: "No findings" });
    const plain = { key: "killed:prove", label: "Out of time, 30m" };
    expect(causeClass(plain)).toBe(plain);
    // A long error stops at its own sentence end, before the runtime's trailer, rather than mid-word.
    expect(causeHead("SyntaxError: Export named 'requiredSelection' not found in module 'outreach/backend/src/lib/eval/selection.ts'. Bun v1.3.2 (macOS arm64) and a long trailer after it"))
      .toBe("SyntaxError: Export named 'requiredSelection' not found in module 'outreach/backend/src/lib/eval/selection.ts'.");
  });

  test("a failure of a problem closed since is history: out of Failed and its count, kept apart (ct-59231 dropped)", () => {
    const closed = closedProblems([{ _id: "c-20", status: "dropped" }, { _id: "c-21", status: "open" }, { _id: "c-22", status: "done" }]);
    expect([...closed]).toEqual(["c-20", "c-22"]);
    const w = stepWork({ decisions: [d("20", { status: "failed", words: "failed" }), d("21", { status: "failed", words: "failed" })] }, { closed });
    expect(w.counts.failed).toBe(1);
    expect(w.closed.map((r) => [r.d.id, r.problemClosed])).toEqual([["20", true]]);
  });

  test("a station that handed the problem back blocked failed by its handoff, never by the time limit that closed its session (ct-59385)", () => {
    const w = stepWork({ decisions: [d("30", { status: "failed", words: "Handed off blocked: stopped until a person unblocks it" })] }, { causes: new Map([["run-30", { key: "killed:build", label: "Out of time, 30m" }]]) });
    expect(w.failed.map((g) => g.label)).toEqual(["Handed back blocked: needs a person"]);
  });

  test("a problem that failed the same way twice is one row that says so", () => {
    const w = stepWork({ decisions: [d("14", { status: "failed", words: "Tests failed", at: 2 }), d("14b", { status: "failed", caseId: "c-14", words: "Tests failed", at: 1 })] });
    expect(w.counts.failed).toBe(1);
    expect(w.failed[0].rows[0].again?.map((x) => x.id)).toEqual(["14b"]);
  });

  test("at a person's step only an answer is Answered: lapsed and withdrawn decisions are No answer, under their own word", () => {
    const o = (state: DecisionOutcome["state"], words: string): DecisionOutcome => ({ state, verb: state === "answered" ? "Ship" : null, trial: false, words, ref: null, at: null, why: null });
    // The run went on past the card to ship: its visit "decided" Ship, yet nobody answered.
    const lapsed = { ...d("15", { outcome: "shipped" }), answer: o("lapsed", "Lapsed") };
    const withdrawn = { ...d("16", { words: "Asked; the card was withdrawn" }), answer: o("withdrawn", "Withdrawn") };
    const trial = { ...d("17", { outcome: "S" }), answer: o("answered", "Would ship · trial") };
    const w = stepWork({ decisions: [lapsed, withdrawn, trial] });
    expect(w.counts).toEqual({ waiting: 0, failed: 2, passed: 1 });
    expect(w.failed.map((g) => g.label).sort()).toEqual(["Lapsed", "Withdrawn"]);
    expect(w.passed[0].d.id).toBe("17");
  });

  test("a check runner's failure groups by the checks that failed, never by the step's generic label", () => {
    const visit = (id: string, steps: unknown) => ({ ...d(id, { status: "failed", words: "Checks failed" }), id: `run-${id}:verify`, decided: { outcome: "failure", words: "Checks failed", result: { ok: false, steps }, to: null, toLabel: null, toWords: null } });
    const w = stepWork({ decisions: [
      visit("20", [{ name: "typecheck", ok: true }, { name: "touched tests (967)", ok: false, detail: "exit 1" }]),
      visit("21", [{ name: "touched tests (12)", ok: false, detail: "exit 1" }]),
      visit("22", [{ name: "typecheck", ok: false }]),
    ] });
    expect(w.failed.map((g) => [g.label, g.rows.length])).toEqual([["Touched tests failed", 2], ["Typecheck failed", 1]]);
  });

  test("a check script's list of checks and its log folder are never read as fields of text", () => {
    expect(reportRows({ ok: false, steps: [{ name: "a", ok: false }], logs: "/Users/a/x" })).toEqual([]);
  });

  test("a problem's newest visit is keyed by the problem, its older ones by their run", () => {
    const w = stepWork({ decisions });
    expect(w.passed.find((r) => r.key === "c-7")!.d.id).toBe("7");
    expect(w.failed.flatMap((g) => g.rows).find((r) => r.key === "run:run-7b")!.d.id).toBe("7b");
  });

  test("a step opens on what waits on the viewer; with nothing on them, a person's step on its waits and any other on everything", () => {
    expect(defaultShow("person", { waiting: 2, failed: 0, passed: 4 })).toBe("waiting");
    expect(defaultShow("person", { waiting: 0, failed: 0, passed: 4 })).toBeNull();
    expect(defaultShow("agent", { waiting: 2, failed: 9, passed: 4 })).toBeNull();
    expect(defaultShow("agent", { waiting: 8, failed: 25, passed: 100 }, 6)).toBe("waiting");
    expect(showLabels("person").passed).toBe("Answered");
    expect(showLabels("agent").failed).toBe("Failed");
  });
});

describe("why a visit failed, from what it left", () => {
  const fail = (id: string, words: string, result: Record<string, unknown> | null = null) => {
    const x = d(id, { status: "failed", outcome: "failure", words });
    return { ...x, decided: { ...x.decided, result } };
  };
  test("an eval's result names the layer that could not run, the gate suite's exit, or the gate cases", () => {
    expect(evalFailWords({ gate: { infra: "layer 3 cannot run: L3_DATABASE_URL is not set (layer 3 needs a loopback Postgres); the eval command names no --l3-server" }, gates_failed: [] }))
      .toBe("Layer 3 cannot run: L3_DATABASE_URL is not set");
    expect(evalFailWords({ gate: { note: "red" }, gates_failed: ["gate: the suite exited 2 (layer 2 or 3, see gate.log)"] })).toBe("The gate suite exited 2");
    expect(evalFailWords({ gate: { note: "red" }, gates_failed: ["tipContext.working.uses-what-is-on-file"] })).toBe("Gate cases failed: tipContext.working.uses-what-is-on-file");
    expect(evalFailWords({ gate: { note: "red" }, gates_failed: [] })).toBeNull();
    expect(failCauseOf(fail("e", "Evals failed", { gate: { note: "red" }, gates_failed: ["gate: the suite exited 2 (x)"] }), undefined, "script").label).toBe("The gate suite exited 2");
  });
  test("an agent's step with no session never started; a script that printed nothing says what failed, thin", () => {
    expect(failCauseOf({ ...fail("a", "Failed"), id: "run-a:prove" }, undefined, "agent")).toEqual({ key: "nosession:prove", label: "Its session never started" });
    // A run that went on past a station that never started gives no run cause: the visit's own words file it the same way.
    expect(failCauseOf({ ...fail("b", "Never started: no session was opened"), id: "run-b:prove" }, undefined, "agent")).toEqual({ key: "nosession:prove", label: "Its session never started" });
    expect(failCauseOf({ ...fail("v", "Checks failed"), id: "run-v:verify" }, undefined, "script")).toMatchObject({ label: "Checks failed, output not kept", thin: true });
    expect(failCauseOf(fail("p", "Failed"), undefined, "script")).toMatchObject({ label: "Exited with an error, output not kept", thin: true });
    expect(failCauseOf(fail("n", "Failed"))).toMatchObject({ key: "none", thin: true });
  });
  test("runs that hit their limit together are one stall; a lone timeout or a spread is not", () => {
    const h = 3600_000;
    const ends = new Map([
      ["run-1", { at: 10 * h, device: "a", empty: true }], ["run-2", { at: 11 * h, device: "a", empty: true }],
      ["run-3", { at: 13 * h, device: "b", empty: true }], ["run-4", { at: 40 * h, device: "a", empty: false }],
    ]);
    const v = (ids: string[]) => ids.map((id) => ({ runId: `run-${id}` }));
    expect(stallOf(v(["1", "2", "3", "4"]), ends)).toEqual({ n: 3, from: 10 * h, to: 13 * h, machines: 2, empty: 3 });
    expect(stallOf(v(["1", "4"]), ends)).toBeNull();
    // Three together among eight failures is not the story of the group.
    expect(stallOf(v(["1", "2", "3", "4", "x", "y", "z", "w"]), ends)).toBeNull();
  });
});

describe("words a person uses", () => {
  test("an outcome key reads as what happened", () => {
    // A proof that reproduced the problem is a pass: never worded as a failure.
    expect(plainOutcome("red")).toBe("reproduced: its test fails without the fix");
    expect(plainOutcome("not_reproduced")).toBe("could not reproduce it");
    expect(plainOutcome("judge_defect")).toBe("the judge was wrong");
    expect(plainOutcome("Ship")).toBe("Ship");
    expect(failCauseOf(d("x", { status: "failed", outcome: "failed", words: "failed" })).label).toBe("No reason recorded");
  });

  test("a handoff's Outcome line reads in words; the rest stays as written", () => {
    // ct-59445's Build handoff opened "Outcome: strategy_fails." on /trial.
    expect(outcomeLineInWords("Outcome: strategy_fails. The proposed fix was built, measured, and reverted.")).toBe("Outcome: the approach did not work. The proposed fix was built, measured, and reverted.");
    expect(outcomeLineInWords("**Outcome:** not_reproduced\n\nnot_reproduced later")).toBe("**Outcome:** could not reproduce it\n\nnot_reproduced later");
    expect(outcomeLineInWords("No outcome line here")).toBe("No outcome line here");
  });

  test("a handoff's outcome key: what /trial offers a stopped run reads from it", () => {
    // ct-59445: Build built, measured and reverted; /trial offers a new approach, never the same rerun alone.
    expect(handoffOutcome("Outcome: strategy_fails. The proposed fix was built, measured, and reverted.")).toBe("strategy_fails");
    expect(handoffOutcome("**Outcome:** not_reproduced\n\nmore")).toBe("not_reproduced");
    expect(handoffOutcome("Built it; outcome unclear")).toBeNull();
    expect(handoffOutcome(null)).toBeNull();
  });

  test("a report's fields: plain names, whole values, no machine paths, no bookkeeping", () => {
    const rows = reportRows({
      rung: "unit", check: "cd backend && bun test tests/unit/repro-ct-59565.test.ts", red: 'OUTREACH status Expected: "failed" Received: "queued"; 0 pass 1 fail',
      evidence: "Fails because the filter is too narrow.", dir: "/Users/ec2-user/.codecast/worktrees/line-ct-59565", outcome: "red", summary: "x", reproduced: false,
      files: ["/Users/ec2-user/src/union/outreach/backend/tests/unit/repro.test.ts"],
    });
    expect(rows.map((r) => r.name)).toEqual(["Test level", "Command", "Test output", "Why", "Files"]);
    expect(rows.find((r) => r.name === "Files")!.value).toBe("outreach/backend/tests/unit/repro.test.ts");
    expect(rows.find((r) => r.name === "Command")!.mono).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("/Users/");
    // "Red: false" says nothing: a yes or no under a key that names printed text is left out.
    expect(reportRows({ red: false, rung: "unit" }).map((r) => r.name)).toEqual(["Test level"]);
  });

  test("what a step concluded is its words, never the JSON block beside them", () => {
    expect(concludedText('Proved it with a unit test.\n\n```json\n{"outcome":"red"}\n```')).toBe("Proved it with a unit test.");
    expect(concludedText('{"outcome":"red"}')).toBeNull();
    expect(concludedText("Wrote the test in /Users/ec2-user/src/union/outreach/backend/x.test.ts and ran it.")).toBe("Wrote the test in outreach/backend/x.test.ts and ran it.");
    expect(withoutMachinePaths("cd /tmp/line-123 && bun test")).toBe("cd && bun test");
  });
});

describe("the decision of one visit", () => {
  const cards = [
    { _id: "a", short_id: "sd-1", status: "answered", workflow_run_id: "r1", gate_node_id: "decide", created_at: 1 },
    { _id: "b", short_id: "sd-2", status: "pending", workflow_run_id: "r1", gate_node_id: "decide", created_at: 2 },
    { _id: "c", short_id: "sd-3", status: "pending", workflow_run_id: "r1", gate_node_id: "plan_gate", created_at: 3 },
    { _id: "e", short_id: "sd-4", status: "pending", workflow_run_id: "r2", created_at: 4 },
  ];
  test("the pending decision of that run at that step, never another step's", () => {
    expect(visitDecision(cards, "r1", "decide")?.short_id).toBe("sd-2");
    expect(visitDecision(cards, "r1", "plan_gate")?.short_id).toBe("sd-3");
    expect(visitDecision(cards, "r3", "decide")).toBeNull();
    // A card that names no step belongs to its run's one person step.
    expect(visitDecision(cards, "r2", "decide")?.short_id).toBe("sd-4");
  });
  test("an answered visit reads its newest decision, whatever its status", () => {
    expect(visitDecision(cards.slice(0, 1), "r1", "decide")).toBeNull();
    expect(visitDecision(cards.slice(0, 1), "r1", "decide", "any")?.short_id).toBe("sd-1");
  });
});

describe("a failure a newer run came after (ct-59509)", () => {
  test("a problem's failed run leaves the count once a newer run of it exists, wherever that run is now", () => {
    // Run 1 stalled at Prove; Run 2 stopped there waiting for a yes. The problem waits on the person, it is not a failure.
    const stall = d("1", { status: "failed", caseId: "c-x", at: 100 });
    const yes = { ...d("2", { status: "failed", caseId: "c-x", at: 200 }) };
    const newest = newestRuns([{ id: "run-1", caseId: "c-x", at: 100 }, { id: "run-2", caseId: "c-x", at: 200 }]);
    const w = stepWork({ decisions: [yes, stall] }, { stopped: new Set(["run-2"]), causes: new Map([["run-1", { key: "killed-empty:prove", label: "Never started" }]]), newest });
    expect(w.counts).toEqual({ waiting: 1, failed: 0, passed: 0 });
    expect(w.movedOn.map((r) => [r.d.runId, r.movedOn])).toEqual([["run-1", true]]);
    // The newest run is elsewhere (it failed at another step): this step's failure is history too.
    const later = newestRuns([{ id: "run-1", caseId: "c-x", at: 100 }, { id: "run-9", caseId: "c-x", at: 900 }]);
    expect(stepWork({ decisions: [stall] }, { newest: later }).counts.failed).toBe(0);
    // Its own newest run counts.
    expect(stepWork({ decisions: [stall] }, { newest: newestRuns([{ id: "run-1", caseId: "c-x", at: 100 }]) }).counts.failed).toBe(1);
  });
});

describe("a spend cap (ct-57829)", () => {
  test("says whose budget, how full, and when it runs again as a clock time, never the trigger's id", () => {
    const at = Date.UTC(2026, 9, 13, 9, 0);
    const words = "Prove for ct-57829 is written but couldn't run: every replay was refused because the `desk` budget wallet is red ($50.38 of its $50 24h cap). The rerun tr-1667 fires at about 20:30 UTC, after the window rolls.";
    const line = spendCapWords({ reasoning: words, decided: { outcome: null, words: "Failed", result: null, to: null, toLabel: null, toWords: null }, at, durationMs: 0 }, (t) => new Date(t).toISOString().slice(11, 16));
    expect(line).toBe("desk spend at $50.38 of its $50 24h limit; runs again about 20:30");
    expect(line).not.toContain("tr-1667");
    expect(spendCapWords({ reasoning: "Could not write a test", decided: { outcome: null, words: "Failed", result: null, to: null, toLabel: null, toWords: null }, at, durationMs: 0 }, String)).toBeNull();
  });
});

describe("a step counts a failure only where Problems files it (Union Prove 33 vs 29)", () => {
  test("a problem Problems lists elsewhere, or as failed at another step, moves out and says where it stands", () => {
    const here = { ...d("1", { status: "failed", caseId: "c-a", at: 100 }), id: "run-1:prove" };
    const nothing = { ...d("2", { status: "failed", caseId: "c-b", at: 100 }), id: "run-2:prove" };
    const later = { ...d("3", { status: "failed", caseId: "c-c", at: 100 }), id: "run-3:prove" };
    const causes = new Map([["run-1", { key: "nosession:prove", label: "Its session never started" }], ["run-2", { key: "nosession:prove", label: "Its session never started" }], ["run-3", { key: "nosession:prove", label: "Its session never started" }]]);
    const standing = new Map([
      ["c-a", { now: "Failed at Prove", failedAt: ["prove"] }],
      ["c-b", { now: "Found nothing to change" }],
      ["c-c", { now: "Failed at Ask you", failedAt: ["ask"] }],
    ]);
    const w = stepWork({ decisions: [here, nothing, later] }, { causes, standing });
    expect(w.counts.failed).toBe(1);
    expect(w.movedOn.map((r) => [r.d.caseId, r.now])).toEqual([["c-b", "Found nothing to change"], ["c-c", "Failed at Ask you"]]);
  });
});
