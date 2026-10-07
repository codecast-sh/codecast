// ct-57659: a Prove station that fails outright leaves no prove.json, and the
// shipped line must still route it somewhere (park the cause with what Prove
// tried) instead of ending with "no outgoing edge from prove".
import { describe, expect, test } from "bun:test";
import { evalCondition } from "./condition";
import { parseWorkflowSource } from "./parser";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";

const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);
const proveStations = [...graph.nodes.keys()].filter((id) => id === "prove" || id === "prove_line");

describe("a failed Prove has a route", () => {
  test.each(proveStations.map((id) => [id]))("%s routes on failure with no proof json", (id) => {
    const context = { outcome: "failure", category: id === "prove_line" ? "line" : "behavior", readiness: "ready", risk: "review" };
    const out = graph.edges.filter((e) => e.from === id);
    const taken = out.find((e) => !e.condition || evalCondition(e.condition, context));
    expect(taken?.to ?? `no outgoing edge from ${id}`).not.toBe(`no outgoing edge from ${id}`);
    expect(["red", "implement"]).not.toContain(taken!.to);
  });
});
