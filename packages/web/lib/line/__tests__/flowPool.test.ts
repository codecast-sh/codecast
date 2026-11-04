import { describe, expect, test } from "bun:test";
import { appPool, CHANGE_FLOW_SLUG, defaultFlowOf } from "../flowPool";

const row = (over: Record<string, unknown>) => ({
  _id: String(over.slug), slug: "x", name: "x",
  nodes: [{ id: "start", label: "Start", type: "start", shape: "Mdiamond" }, { id: "review", label: "Review", type: "agent", shape: "box" }],
  edges: [{ from: "start", to: "review" }],
  ...over,
});

describe("appPool over pushed rows (flows.md FL2)", () => {
  test("a published flow joins, marked as the team's; a draft and a graph with no kind do not", () => {
    const pool = appPool([
      row({ slug: "review-pass", source: 'digraph a { graph [kind="segment", label="Review pass"] }', workspace: "team:t1" }),
      row({ slug: "mine", name: "mine", source: 'digraph b { graph [kind="line"] }', workspace: "user:u1" }),
      row({ slug: "half-done", source: 'digraph c { graph [kind="segment", draft="jx7abcd"] }', workspace: "user:u1" }),
      row({ slug: "probe", source: 'digraph d { graph [label="Probe"] }', workspace: "user:u1" }),
    ]).filter((f) => f.where !== "shipped");
    expect(pool.map((f) => [f.slug, f.where, f.label])).toEqual([["review-pass", "team", "Review pass"], ["mine", "pushed", "Mine"]]);
  });

  test("a slug listed twice keeps its first row, the viewer's own", () => {
    const pool = appPool([
      row({ _id: "own", slug: "review-pass", source: 'digraph a { graph [kind="segment"] }', workspace: "user:u1" }),
      row({ _id: "theirs", slug: "review-pass", source: 'digraph a { graph [kind="segment"] }', workspace: "team:t1" }),
    ]).filter((f) => f.where !== "shipped");
    expect(pool.map((f) => f.workflowId)).toEqual(["own"]);
  });
});

describe("defaultFlowOf (flows.md FL4)", () => {
  const pool = appPool([
    row({ slug: "fast-ship", source: 'digraph a { graph [kind="line", takes="branch"] }', workspace: "team:t1" }),
    row({ slug: "triage", source: 'digraph b { graph [kind="line", takes="task"] }', workspace: "team:t1" }),
  ]);
  test("the team's slug when it is in the pool and takes a session's change", () => {
    expect(defaultFlowOf(pool, "fast-ship")?.slug).toBe("fast-ship");
  });
  test("Change when the team set none, set one gone from the pool, or set one that cannot take a session's change", () => {
    expect(defaultFlowOf(pool, null)?.slug).toBe(CHANGE_FLOW_SLUG);
    expect(defaultFlowOf(pool, "deleted")?.slug).toBe(CHANGE_FLOW_SLUG);
    expect(defaultFlowOf(pool, "triage")?.slug).toBe(CHANGE_FLOW_SLUG);
  });
});
