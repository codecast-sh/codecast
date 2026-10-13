// The Line page's Steps table (line-journeys.md LJ8.5): steps in the line's
// order by phase, each count the count its step page opens on, a script no
// work reached left out, and the bar's figures the columns' sums with a
// person's unanswered decisions never counted as failures.
import { describe, expect, test } from "bun:test";
import type { LineStep, StepDecision } from "../lineModel";
import { runFactsByStep, stepFailures, stepTable, stepTableFigures } from "../stepTable";
import { readShow, showParam, stepWork } from "../stepWork";

const d = (id: string, status: StepDecision["status"], words = "Found why it happens"): StepDecision => ({
  id, runId: `run-${id}`, caseId: `c-${id}`, caseRef: `ct-${id}`, caseTitle: `Problem ${id}`, at: 1000, durationMs: null, status,
  received: { from: null, fromLabel: null, summary: "", said: false, sessionId: null, href: null },
  decided: { outcome: status === "failed" ? "failed" : null, words, result: null, to: null, toLabel: null, toWords: null },
  reasoning: null, label: null, labels: [],
});

const step = (id: string, kind: LineStep["kind"], stage: LineStep["stage"], decisions: StepDecision[]): LineStep => ({
  id, kind, label: id[0].toUpperCase() + id.slice(1), fileLabel: null, purpose: "", stage, half: "diagnose", prompt: null, outcomes: [], answers: [],
  decisions, tally: {} as LineStep["tally"], model: null, maxVisits: null, timeoutS: null,
});

describe("the Steps table", () => {
  const steps = {
    ground: step("ground", "agent", "understand", [d("g1", "done")]),
    prove: step("prove", "agent", "prove", [d("p1", "failed", "could not write a test"), d("p2", "failed", "could not write a test"), d("p3", "done")]),
    red: step("red", "script", "prove", []),
    implement: step("implement", "agent", "build", [d("i1", "failed", "typecheck red"), d("i2", "live")]),
    decide: step("decide", "person", "decide", [d("x1", "waiting"), d("x2", "waiting"), { ...d("x3", "failed"), answer: { state: "withdrawn", verb: null, trial: false, words: "Withdrawn", ref: "sd-3", at: 1000, why: null } }]),
    done: step("done", "end", "ship", []),
  };
  const model = { steps, order: ["ground", "prove", "red", "implement", "decide", "done"] };

  test("the line's order, by phase, whatever failed most; ends and unreached scripts are left out", () => {
    const rows = stepTable(model, new Map());
    expect(rows.map((r) => r.id)).toEqual(["ground", "prove", "implement", "decide"]);
    expect(rows.map((r) => r.stage)).toEqual(["understand", "prove", "build", "decide"]);
  });

  test("the bar's figures: on you is the viewer's own needs, a decision someone else holds is theirs, running apart", () => {
    // The viewer is asked x1; x2 waits on another person (held by them): not "on you".
    const rows = stepTable(model, new Map(), undefined, [{ runId: "run-x1", caseId: "c-x1" }]);
    const decide = rows.find((r) => r.id === "decide")!;
    expect(decide).toMatchObject({ onYou: 1, others: 1, running: 0, topCause: null });
    expect(decide.counts.failed).toBe(1);
    expect(rows.find((r) => r.id === "implement")).toMatchObject({ onYou: 0, others: 0, running: 1 });
    expect(stepTableFigures(rows)).toEqual({ onYou: 1, others: 1, running: 1, failed: 3, noAnswer: 1 });
    // With no need of the viewer's, nothing is on them.
    expect(stepTableFigures(stepTable(model, new Map()))).toMatchObject({ onYou: 0, others: 2 });
  });

  test("a step nothing reached is left out, whatever its kind", () => {
    const empty = { ...model, steps: { ...steps, prove_line: step("prove_line", "agent", "prove", []), ask: step("ask", "person", "build", []) }, order: [...model.order, "prove_line", "ask"] };
    expect(stepTable(empty, new Map()).map((r) => r.id)).toEqual(["ground", "prove", "implement", "decide"]);
  });

  test("a person's step names its counts in the address the way its page does", () => {
    expect(showParam("person", "failed")).toBe("noanswer");
    expect(showParam("agent", "failed")).toBe("failed");
    expect(readShow("noanswer")).toBe("failed");
    expect(readShow("answered")).toBe("passed");
    expect(readShow("failed")).toBe("failed");
    expect(readShow("nonsense")).toBeNull();
  });

  test("each count is the count the step page opens on, with the top cause in words", () => {
    const rows = stepTable(model, new Map());
    for (const r of rows) expect(r.counts).toEqual(stepWork(steps[r.id as keyof typeof steps]).counts);
    const prove = rows.find((r) => r.id === "prove")!;
    expect(prove.counts).toEqual({ waiting: 0, failed: 2, passed: 1 });
    expect(prove.topCause).toBe("Could not write a test");
    expect(prove.phase).toBe("Prove");
  });

  test("the Map draws the table's failed counts, and a closed problem's failure counts in neither", () => {
    const rows = stepTable(model, new Map(), new Set(["c-p1"]));
    expect(rows.find((r) => r.id === "prove")!.counts.failed).toBe(1);
    const failed = stepFailures(rows);
    expect(failed.get("prove")).toBe(1);
    // A person's step has no failures to draw: its unanswered decisions are No answer.
    expect(failed.get("decide")).toBe(0);
  });

  test("a run's failure is filed under the step it failed at, and every step page reads the same facts", () => {
    const facts = runFactsByStep([
      { _id: "run-p1", status: "failed", fail_reason: "timed out", current_node_id: "prove" },
      { _id: "run-ok", status: "completed", fail_reason: null, current_node_id: "prove" },
    ]);
    expect([...facts.keys()]).toEqual(["prove"]);
    const f = facts.get("prove")!;
    expect(f.causes.has("run-p1") || f.stopped.has("run-p1")).toBe(true);
    expect(f.causes.has("run-ok")).toBe(false);
  });
});
