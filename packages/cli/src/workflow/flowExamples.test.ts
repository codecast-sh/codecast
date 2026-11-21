// The flows the agent guidance and `cast flow --help` show must run as written against the shipped library.
import { describe, expect, test } from "bun:test";
import { WORKFLOW_REFERENCE } from "@codecast/shared/contracts";
import { FLOW_HELP } from "../flowCommand";
import { emptySlots, parseWorkflowSource, validateWorkflow } from "./parser";

/** A graph that extends a library flow and fills its slot: it parses, and nothing is left empty. */
function runsAsWritten(src: string) {
  const graph = parseWorkflowSource(src);
  expect(validateWorkflow(graph)).toEqual([]);
  expect(emptySlots(graph)).toEqual([]);
  expect([...graph.nodes.keys()].some((id) => id.endsWith("prove"))).toBe(true);
}

describe("the flow examples people and agents copy", () => {
  test("the workflow reference's backbone example", () => {
    const example = /```dot\n(digraph flaky_fix \{[\s\S]*?\n\})\n```/.exec(WORKFLOW_REFERENCE)?.[1];
    expect(example).toBeDefined();
    runsAsWritten(example!);
  });

  test("cast flow --help's backbone example", () => {
    const example = /(digraph flaky_fix \{[\s\S]*?\n {2}\})/.exec(FLOW_HELP)?.[1];
    expect(example).toBeDefined();
    // The help aligns a note after the subgraph line; the graph is what precedes it.
    runsAsWritten(example!.replace(/\s{2,}steps that fill.*$/m, "").replace(/subgraph check \{ reproduce -> prove \}/, "subgraph check { reproduce [prompt=\"Reproduce it\"] prove [shape=parallelogram, script=\"true\"] reproduce -> prove }"));
  });
});
