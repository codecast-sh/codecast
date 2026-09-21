import { describe, expect, test } from "bun:test";
import { runNodeCounts, runNodeGroups, runNodeRows } from "../workflowRun";

// Run: bun test lib/__tests__/workflowRun.test.ts

const workflow = {
  nodes: [
    { id: "start", label: "start", type: "start" },
    { id: "a", label: "A", type: "agent" },
    { id: "b", label: "B", type: "command" },
    { id: "c", label: "C", type: "agent" },
    { id: "exit", label: "exit", type: "exit" },
  ],
};

describe("runNodeRows", () => {
  test("graph order, start and exit hidden, the current node reads as running", () => {
    const run = { status: "running", current_node_id: "b", node_statuses: [{ node_id: "a", status: "completed" }] };
    const rows = runNodeRows(run, workflow);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rows[0].status).toBe("completed");
    expect(rows[1]).toMatchObject({ status: "running", current: true, type: "command" });
    expect(rows[2].status).toBe("pending");
  });

  test("a finished run has no current node, whatever current_node_id still says", () => {
    const run = { status: "completed", current_node_id: "c", node_statuses: [{ node_id: "a", status: "completed" }, { node_id: "c", status: "completed" }] };
    expect(runNodeRows(run, workflow).every((r) => !r.current)).toBe(true);
  });

  test("without a stored graph the statuses are the list, in write order, with their own labels", () => {
    const run = { status: "failed", node_statuses: [{ node_id: "x", status: "completed", label: "first" }, { node_id: "y", status: "failed" }] };
    const rows = runNodeRows(run, null);
    expect(rows.map((r) => [r.id, r.label])).toEqual([["x", "first"], ["y", "y"]]);
  });

  test("a status the graph does not know is appended, never dropped", () => {
    const run = { status: "running", node_statuses: [{ node_id: "retry-2", status: "running", label: "A (retry)" }] };
    expect(runNodeRows(run, workflow).map((r) => r.id)).toEqual(["a", "b", "c", "retry-2"]);
  });
});

describe("runNodeGroups", () => {
  test("declared phases group in declared order; agents outside them trail", () => {
    const run = {
      status: "running",
      phases: [{ title: "Review" }, { title: "Verify" }, { title: "Empty" }],
      node_statuses: [
        { node_id: "v1", status: "pending", phase: "Verify" },
        { node_id: "r1", status: "completed", phase: "Review" },
        { node_id: "loose", status: "completed" },
      ],
    };
    const groups = runNodeGroups(run);
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.id)])).toEqual([
      ["Review", ["r1"]],
      ["Verify", ["v1"]],
      [undefined, ["loose"]],
    ]);
  });

  test("a routine run is one unnamed group", () => {
    const groups = runNodeGroups({ status: "running", node_statuses: [{ node_id: "a", status: "completed" }] }, workflow);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBeUndefined();
  });
});

describe("runNodeCounts", () => {
  test("counts done, failed, running and rows that carry a session", () => {
    const run = {
      status: "running",
      current_node_id: "c",
      node_statuses: [
        { node_id: "a", status: "completed", session: { _id: "1" } },
        { node_id: "b", status: "failed", session_id: "sess-b" },
      ],
    };
    expect(runNodeCounts(runNodeRows(run, workflow))).toEqual({ total: 3, done: 1, failed: 1, running: 1, sessions: 2 });
  });
});
