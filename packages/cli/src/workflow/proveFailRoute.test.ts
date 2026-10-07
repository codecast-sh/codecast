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

// A Prove leaves no usable proof when it fails outright, settles without
// writing prove.json, or writes one whose reproduced is neither true nor false.
const noProof: [string, Record<string, string>][] = [
  ["failed, no proof json", { outcome: "failure" }],
  ["settled, no proof json", { outcome: "success" }],
  ["reproduced missing", { outcome: "success", "prove.json": '{"tried":"x"}' }],
  ["reproduced unusable", { outcome: "success", "prove.json": '{"reproduced":"maybe"}' }],
  ["reproduced null", { outcome: "success", "prove.json": '{"reproduced":null}' }],
  ["proof json unreadable", { outcome: "success", "prove.json": "not json" }],
];

const fired = (id: string, context: Record<string, string>) =>
  graph.edges.filter((e) => e.from === id && (!e.condition || evalCondition(e.condition, context))).map((e) => e.to);

describe("a failed Prove has a route", () => {
  test("analyze leads to prove", () => expect(proveStations).toContain("prove"));

  test.each(proveStations.flatMap((id) => ["code", "line"].flatMap((category) => noProof.map(([how, ctx]) => [id, category, how, ctx] as const))))(
    "%s (category %s, %s) parks at unproven",
    (id, category, _how, ctx) => {
      expect(fired(id, { category, readiness: "ready", risk: "review", ...ctx })).toEqual(["unproven"]);
    },
  );

  // The park ends the run: a command station whose only way out is exit, so a
  // cause without its proof is never sent on to the builder or dissolved.
  test("unproven is a command station that ends the run", () => {
    expect(graph.nodes.get("unproven")?.type).toBe("command");
    expect(graph.edges.filter((e) => e.from === "unproven").map((e) => [e.to, e.condition ?? null])).toEqual([["exit", null]]);
  });
});
