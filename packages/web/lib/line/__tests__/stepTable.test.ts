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

// A loop's end read by the looped station's own last word (runReport loopEnd), from the real runs it was found on.
describe("a loop the station itself settled", () => {
  const session = (state: string, handoff?: { status: string; note?: string }) => ({ _id: "s", state, state_status: "done", ...(handoff ? { handoff } : {}) });
  // ct-58328: Prove reproduced, then Red (run on the fixed tip) said the miss did not show and sent Prove round twice.
  const sentBack = {
    _id: "run-p", status: "failed", current_node_id: "prove", fail_reason: "max_visits=2 exceeded on prove",
    node_statuses: [
      { node_id: "prove", status: "failed", session: session("On base the test fails 3/3 and passes on the branch.\n```json\n{\"reproduced\": true}\n```") },
      { node_id: "red", status: "completed", result_preview: "{\"red\": false, \"dir\": \"/w\", \"why\": \"repro.sh passes before any fix, so it does not show the miss\"}" },
    ],
  };
  // ct-57446: the builder handed off for review, verified 6/6; Verify stayed red on files the branch does not touch.
  const handedOff = {
    _id: "run-i", status: "failed", current_node_id: "implement", fail_reason: "max_visits=3 exceeded on implement",
    node_statuses: [
      { node_id: "implement", status: "failed", session: session("fix on branch, verified 6/6; waiting on engineer safety review", { status: "done", note: "Files: x.ts\n\nNeeds an engineer's safety review before merge, because a new card-mint rule is a mechanics change (Ashot by default).\n\nFiles: a.ts" }) },
      { node_id: "verify", status: "failed", result_preview: "{\"ok\":false,\"steps\":[{\"name\":\"typecheck\",\"ok\":false,\"detail\":\"exit 1\"}]}" },
    ],
  };
  // An eval that could not run on the line's machine, with a builder that did not hand off.
  const machine = {
    _id: "run-e", status: "failed", current_node_id: "implement", fail_reason: "max_visits=3 exceeded on implement",
    node_statuses: [
      { node_id: "implement", status: "failed", session: { _id: "s", state: "still working", state_status: "working" } },
      { node_id: "eval", status: "failed", result_preview: "{\"gate\":{\"infra\":\"layer 3 cannot run: L3_DATABASE_URL is not set (layer 3 needs a loopback Postgres); the eval command stops\"}}" },
    ],
  };

  test("a check that sent a finished Prove back is filed at the check; Prove's visit passes", () => {
    const { failCause } = require("../runReport");
    const c = failCause(sentBack);
    expect(c.key).toBe("sentback:red");
    expect(c.step).toBe("red");
    expect(c.label).toContain("repro.sh passes before any fix");
    const facts = runFactsByStep([sentBack] as any);
    expect(facts.get("prove")?.cleared.has("run-p")).toBe(true);
    const prove = { ...d("p", "failed"), id: "run-p-prove", runId: "run-p" };
    expect(stepWork(step("prove", "agent", "prove", [prove]), facts.get("prove")!).counts).toEqual({ waiting: 0, failed: 0, passed: 1 });
    const red = { ...d("p", "completed"), id: "run-p-red", runId: "run-p" };
    const w = stepWork(step("red", "script", "prove", [red]), facts.get("red")!);
    expect(w.counts.failed).toBe(1);
    expect(w.failed[0].key).toBe("sentback:red");
  });

  test("a builder that handed off for review waits on that review, never Failed", () => {
    const { failCause, stopWords } = require("../runReport");
    const c = failCause(handedOff);
    expect(c.key).toBe("review:implement");
    expect(c.review.ask).toBe("Needs an engineer's safety review before merge, because a new card-mint rule is a mechanics change (Ashot by default).");
    expect(c.review.gate).toContain("typecheck red");
    expect(stopWords(handedOff)).toMatch(/^Stopped at Implement: it handed its work off for review \(Needs an engineer's safety review/);
    const facts = runFactsByStep([handedOff] as any);
    const v = { ...d("i", "failed"), id: "run-i-implement", runId: "run-i" };
    const w = stepWork(step("implement", "agent", "build", [v]), facts.get("implement")!);
    expect(w.counts).toEqual({ waiting: 1, failed: 0, passed: 0 });
    expect(w.waiting[0].state).toBe("review");
    expect(w.waiting[0].review?.ask).toMatch(/^Needs an engineer's safety review/);
  });

  test("a fault of the line's machine is its own cause", () => {
    const { failCause } = require("../runReport");
    const c = failCause(machine);
    expect(c.key).toBe("infra:implement");
    expect(c.label).toBe("Line machine: layer 3 cannot run: L3_DATABASE_URL is not set");
  });
});
