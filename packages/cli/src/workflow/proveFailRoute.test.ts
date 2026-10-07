// ct-57659: a Prove station that fails outright leaves no prove.json, and the
// shipped line must still route it somewhere (park the cause with what Prove
// tried) instead of ending with "no outgoing edge from prove".
import { describe, expect, test } from "bun:test";
import { evalCondition } from "./condition";
import { parseWorkflowSource } from "./parser";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";

const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);
// Every station analyze hands a cause to is a Prove (prove, and prove_line for
// a change to the line itself once it lands), found from the graph so a new
// one is held to the same rule without a test edit.
const proveStations = [...new Set(graph.edges.filter((e) => e.from === "analyze").map((e) => e.to))];

describe("a failed Prove has a route", () => {
  test("analyze leads to prove", () => expect(proveStations).toContain("prove"));

  test.each(proveStations.flatMap((id) => ["code", "line"].map((category) => [id, category])))("%s (category %s) routes on failure with no proof json", (id, category) => {
    const context = { outcome: "failure", category, readiness: "ready", risk: "review" };
    const out = graph.edges.filter((e) => e.from === id);
    const taken = out.find((e) => !e.condition || evalCondition(e.condition, context));
    expect(taken?.to ?? `no outgoing edge from ${id}`).toBe("unproven");
  });
});
