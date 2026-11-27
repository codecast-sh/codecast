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
    expect(rows.map((r) => [r.id, r.label])).toEqual([["x", "first"], ["y", "Y"]]);
  });

  // ct-102256 listed its end as "deploy__failed": the graph names it, and a status no graph names reads in words.
  test("the end a run reached reads by the graph's name, its start not at all, and no row by its id", () => {
    const g = { nodes: [{ id: "start", label: "start", type: "start" }, { id: "deploy", label: "Deploy", type: "conditional" }, { id: "deploy__failed", label: "Deploy failed", type: "exit" }, { id: "exit", label: "Live", type: "exit" }] };
    const run = { status: "failed", node_statuses: [{ node_id: "start", status: "completed" }, { node_id: "deploy", status: "completed" }, { node_id: "deploy__failed", status: "failed" }] };
    expect(runNodeRows(run, g).map((r) => [r.id, r.label, r.type])).toEqual([["deploy", "Deploy", "conditional"], ["deploy__failed", "Deploy failed", "exit"]]);
    expect(runNodeRows({ status: "failed", node_statuses: [{ node_id: "land__not_landed", status: "failed" }] }, null)[0].label).toBe("Land not landed");
  });

  test("a status the graph does not know is kept, never dropped, in the order it ran", () => {
    const run = { status: "running", node_statuses: [{ node_id: "retry-2", status: "running", label: "A (retry)" }] };
    expect(runNodeRows(run, workflow).map((r) => r.id)).toEqual(["retry-2", "a", "b", "c"]);
  });

  test("the stations in the order they ran, then the ones never reached in graph order (a change run's side routes)", () => {
    // The change flow lists Merge's side routes (Branch moved, Retest) and Why a person after Merge; this run took the
    // card route before Merge and never moved its branch.
    const g = { nodes: ["pr", "verdicts", "merge", "moved", "retest", "why", "decide", "landed"].map((id) => ({ id, label: id, type: "command" })) };
    const at = (node_id: string, t: number) => ({ node_id, status: "completed", started_at: t });
    const run = { status: "completed", node_statuses: [at("pr", 1), at("verdicts", 2), at("why", 3), at("decide", 4), at("merge", 5), at("landed", 6)] };
    expect(runNodeRows(run, g).map((r) => r.id)).toEqual(["pr", "verdicts", "why", "decide", "merge", "landed", "moved", "retest"]);
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
