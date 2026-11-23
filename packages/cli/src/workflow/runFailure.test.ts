// What a failed station's output comes to on a task (ct-85594): a check's
// failing steps in one line, never its JSON; and a flow on the check segment sends a
// check the machine could not run to a stop of the machine's, not to the session.
import { describe, expect, test } from "bun:test";
import { evalCondition } from "./condition";
import { parseWorkflowSource } from "./parser";
import { outputSummary, taskStopCard } from "./runFailure";
import { SEGMENTED_FLOW } from "./segmentedFlow.testkit";
import type { WorkflowRunState } from "./types";

// The check output Jason's laptop printed on ct-85594 (Nov 13), trimmed.
const CT_85594 = {
  ok: false,
  steps: [
    { name: "typecheck", ok: true, detail: "no error from this change" },
    { name: "test database", ok: true, detail: "none: the Postgres at localhost:5432 answers, but the test schema could not be built (check-0.log: role \"postgres\" does not exist)", log: "" },
    { name: "touched tests (1372)", ok: false, detail: `exit 1; failed without a database: ${Array.from({ length: 20 }, (_, i) => `tests/unit/t${i}.test.ts`).join(", ")}`, log: "check-2.log" },
    { name: "prompt fidelity (eval-judge, ops-agent)", ok: true, detail: "passed" },
  ],
  logs: "/Users/someone/code/union-mobile/.git/worktrees/change-ct-85594/cast-line",
};

describe("outputSummary", () => {
  test("a check's JSON comes to its failing steps, each cut short, with no JSON in it", () => {
    const text = `${JSON.stringify(CT_85594)}\ncheck: touched tests (1372)\n Failed files:\n   tests/unit/t0.test.ts`;
    const said = outputSummary(text, CT_85594);
    expect(said.startsWith("touched tests (1372) (exit 1; failed without a database: tests/unit/t0.test.ts")).toBe(true);
    expect(said).not.toContain("{");
    expect(said).not.toContain("typecheck");
    expect(said.length).toBeLessThanOrEqual(400);
  });

  test("plain output comes to its last line that says what went wrong", () => {
    expect(outputSummary("building\nerror: a.txt says bad, expected good\ndone in 2s\n")).toBe("error: a.txt says bad, expected good");
    expect(outputSummary("all quiet\n")).toBe("all quiet");
  });
});

describe("a flow built on the shipped check segment routes a check the machine could not run to the machine's stop", () => {
  test("check's exits read through the flow's own routes", () => {
    const graph = parseWorkflowSource(SEGMENTED_FLOW);
    const route = (from: string, ctx: Record<string, string>) =>
      graph.edges.filter((e) => e.from === from && (!e.condition || evalCondition(e.condition, ctx))).map((e) => e.to);
    // The check's command: exit 2 is the machine's, any other failure is the change's.
    expect(route("check__verify", { outcome: "failure", "check__verify.exit_code": "2" })).toEqual(["check__unjudged"]);
    expect(route("check__verify", { outcome: "failure", "check__verify.exit_code": "1" })).toEqual(["check__failed"]);
    expect(route("check__unjudged", { outcome: "failure", "check__unjudged.json": JSON.stringify({ exit: "unjudged" }) })).toEqual(["unchecked"]);
    expect(route("check__failed", { outcome: "failure", "check__failed.json": JSON.stringify({ exit: "failed" }) })).toEqual(["fix_check"]);
    expect(graph.nodes.get("unchecked")?.machine).toBe(true);
    expect(graph.nodes.get("check__failed")?.stop).toContain("$check__verify.summary");
    expect(graph.nodes.get("check__unjudged")?.stop).toContain("$check__verify.summary");
  });
});

describe("taskStopCard", () => {
  test("a station's error the reason already carries is said once", () => {
    const graph = parseWorkflowSource(`digraph g { start [shape=Mdiamond] x [label="X"] start -> x }`);
    const err = "This run's change came from no session, so nobody can work on what the run found.";
    const state = { failReason: err, context: { last_error: err }, currentNodeId: "x", completed: [], visitCounts: {} } as unknown as WorkflowRunState;
    expect(taskStopCard(graph, state, "ct-1").body).toBe("");
  });
});
