// The Line page's Steps table (line-journeys.md LJ8.5): the step that fails
// most leads, each count is the count its step page opens on, and a script
// no work reached is left out.
import { describe, expect, test } from "bun:test";
import type { LineStep, StepDecision } from "../lineModel";
import { runFactsByStep, stepTable } from "../stepTable";
import { stepWork } from "../stepWork";

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
    implement: step("implement", "agent", "build", [d("i1", "failed", "typecheck red")]),
    decide: step("decide", "person", "decide", [d("x1", "waiting"), d("x2", "waiting")]),
    done: step("done", "end", "ship", []),
  };
  const model = { steps, order: ["ground", "prove", "red", "implement", "decide", "done"] };

  test("most failures first, then most waiting, then line order; ends and unreached scripts are left out", () => {
    const rows = stepTable(model, new Map());
    expect(rows.map((r) => r.id)).toEqual(["prove", "implement", "decide", "ground"]);
  });

  test("each count is the count the step page opens on, with the top cause in words", () => {
    const rows = stepTable(model, new Map());
    for (const r of rows) expect(r.counts).toEqual(stepWork(steps[r.id as keyof typeof steps]).counts);
    const prove = rows.find((r) => r.id === "prove")!;
    expect(prove.counts).toEqual({ waiting: 0, failed: 2, passed: 1 });
    expect(prove.topCause).toBe("Could not write a test");
    expect(prove.phase).toBe("Prove");
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
