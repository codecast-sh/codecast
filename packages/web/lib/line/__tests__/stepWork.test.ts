// A step page's rows (line-journeys.md LJ8.6): every problem under exactly one
// of Waiting, Failed or Passed, the counts the rows they open, failures grouped
// by cause, and a report read in words a person uses.
import { describe, expect, test } from "bun:test";
import type { StepDecision } from "../lineModel";
import { concludedText, defaultShow, failCauseOf, plainOutcome, reportRows, showLabels, stepWork, visitDecision, withoutMachinePaths } from "../stepWork";

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

  test("failures are grouped by cause, the largest first, each cause in plain words", () => {
    const w = stepWork({ decisions });
    expect(w.failed.map((g) => [g.label, g.rows.length])).toEqual([["Ended with no reason recorded", 3], ["Could not write a test for the problem", 2]]);
    // The run's own reason, when it failed here, names the cause.
    const named = stepWork({ decisions }, { causes: new Map([["run-6", { key: "killed:prove", label: "out of time, 30m" }]]) });
    expect(named.failed.map((g) => g.label)).toContain("Out of time, 30m");
    // A dead end only says the run stopped: the step's own words for how it failed name the cause.
    const deadEnd = stepWork({ decisions: [d("11", { status: "failed", words: "Could not write a test for the problem" })] }, { causes: new Map([["run-11", { key: "deadend-failed:prove", label: "Prove gave no result" }]]) });
    expect(deadEnd.failed[0].label).toBe("Could not write a test for the problem");
  });

  test("a problem's newest visit is keyed by the problem, its older ones by their run", () => {
    const w = stepWork({ decisions });
    expect(w.passed.find((r) => r.key === "c-7")!.d.id).toBe("7");
    expect(w.failed.flatMap((g) => g.rows).find((r) => r.key === "run:run-7b")!.d.id).toBe("7b");
  });

  test("a person's step opens on what waits; any other step on everything", () => {
    expect(defaultShow("person", { waiting: 2, failed: 0, passed: 4 })).toBe("waiting");
    expect(defaultShow("person", { waiting: 0, failed: 0, passed: 4 })).toBeNull();
    expect(defaultShow("agent", { waiting: 2, failed: 9, passed: 4 })).toBeNull();
    expect(showLabels("person").passed).toBe("Answered");
    expect(showLabels("agent").failed).toBe("Failed");
  });
});

describe("words a person uses", () => {
  test("an outcome key reads as what happened", () => {
    expect(plainOutcome("red")).toBe("failed its test");
    expect(plainOutcome("not_reproduced")).toBe("could not reproduce it");
    expect(plainOutcome("judge_defect")).toBe("the judge was wrong");
    expect(plainOutcome("Ship")).toBe("Ship");
    expect(failCauseOf(d("x", { status: "failed", outcome: "failed", words: "failed" })).label).toBe("Ended with no reason recorded");
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
