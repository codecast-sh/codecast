import { describe, expect, test } from "bun:test";
import { runNodeCounts, runNodeGroups, runNodeRows } from "../workflowRun";
import { runPath } from "../line/runReport";

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
    // The report (web RunPathView, the phone's run screen) keeps that end as a step too.
    expect(runPath(run as any, g)[0].steps.map((s) => s.label)).toContain("Deploy failed");
  });

  // ct-102366 listed Live twice: the change flow's deploy__live step and its plain exit, also named Live.
  test("the plain exit a finished run reaches is not a second step", () => {
    const g = { nodes: [{ id: "deploy__live", label: "Live", type: "command" }, { id: "exit", label: "Live", type: "exit" }] };
    const run = { status: "completed", node_statuses: [{ node_id: "deploy__live", status: "completed" }, { node_id: "exit", status: "completed" }] };
    expect(runNodeRows(run, g).map((r) => r.id)).toEqual(["deploy__live"]);
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

describe("a decision card's answer is the way the run went (pl-1077 polish 3)", () => {
  // ct-102479's run: answered Revise, the session fixed it, a second card answered Approve, and it went Live.
  const graph = {
    nodes: [
      { id: "start", label: "start", type: "start" },
      { id: "ci_card", label: "Why a person", type: "command" },
      { id: "decide", label: "Decide", type: "conditional", segment: "decide", segment_entry: true },
      { id: "decide__decide", label: "Decide", type: "human", segment: "decide" },
      { id: "decide__ship", label: "Approved", type: "command", segment: "decide", segment_exit: "done" },
      { id: "decide__revise", label: "Revise", type: "command", segment: "decide", segment_exit: "stop" },
      { id: "brief", label: "Fix findings", type: "agent" },
      { id: "merge", label: "Merge", type: "command" },
      { id: "exit", label: "Live", type: "exit" },
    ],
  };
  const statuses = [
    { node_id: "ci_card", status: "completed", started_at: 1, completed_at: 2 },
    { node_id: "decide", status: "completed", started_at: 20, completed_at: 20 },
    { node_id: "decide__decide", status: "completed", started_at: 21, completed_at: 25, outcome: "s" },
    { node_id: "decide__revise", status: "failed", started_at: 5, completed_at: 5, outcome: "failure", result_preview: '{"exit": "revise"}' },
    { node_id: "brief", status: "completed", started_at: 6, completed_at: 10 },
    { node_id: "decide__ship", status: "completed", started_at: 26, completed_at: 26, result_preview: '{"exit": "ship"}' },
    { node_id: "merge", status: "completed", started_at: 27, completed_at: 30 },
    { node_id: "exit", status: "completed", started_at: 31, completed_at: 31 },
  ];
  const run = { status: "completed", current_node_id: "exit", node_statuses: statuses };

  test("Revise reads as the route taken, never a failed step; the segment's own Decide is not listed twice", () => {
    const rows = runNodeRows(run, graph);
    const revise = rows.find((r) => r.id === "decide__revise")!;
    expect(revise).toMatchObject({ status: "completed", route: true });
    expect(rows.filter((r) => r.label === "Decide").map((r) => r.id)).toEqual(["decide__decide"]);
    expect(runNodeCounts(rows).failed).toBe(0);
    // Without a stored graph, its output naming the exit says the same.
    expect(runNodeRows(run).find((r) => r.id === "decide__revise")).toMatchObject({ status: "completed", route: true });
    // The phone's path reads it as noted, in words.
    const step = runPath(run as any, graph as any)[0].steps.find((x) => x.id === "decide__revise");
    expect(step).toMatchObject({ state: "noted", result: "Route taken" });
  });

  test("a stop the run ended on stays a failure", () => {
    const ended = { status: "failed", current_node_id: "decide__revise", node_statuses: statuses.filter((n) => ["ci_card", "decide", "decide__decide", "decide__revise"].includes(n.node_id)).map((n) => (n.node_id === "decide__revise" ? { ...n, started_at: 30, completed_at: 30 } : n)) };
    expect(runNodeRows(ended, graph).find((r) => r.id === "decide__revise")).toMatchObject({ status: "failed" });
    expect(runNodeRows(ended, graph).find((r) => r.id === "decide__revise")?.route).toBeUndefined();
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
