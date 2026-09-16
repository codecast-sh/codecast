// the-line.md L9: a run the sweep starts under a slug with no pushed
// workflows row still executes, because run-daemon resolves the shipped
// template by the run's name.
import { describe, expect, test } from "bun:test";
import { graphForDaemonRun } from "./daemonGraph";

const EMPTY = { name: "workflow", goal: "Ship the thing", nodes: [], edges: [] };

describe("graphForDaemonRun", () => {
  test("a run with no pushed row resolves the shipped template named by workflow_name", () => {
    const graph = graphForDaemonRun({ workflow_name: "line", goal_override: "Ship the thing", project_path: "/nonexistent/path" }, EMPTY);
    expect(graph).not.toBeNull();
    expect(graph!.name).toBe("line");
    expect(graph!.goal).toBe("Ship the thing");
    expect([...graph!.nodes.keys()]).toContain("implement");
  });

  test("a pushed row's nodes win over the name", () => {
    const wf = { name: "Mine", goal: "g", nodes: [{ id: "start", type: "start" }, { id: "exit", type: "exit" }], edges: [{ from: "start", to: "exit" }] };
    const graph = graphForDaemonRun({ workflow_name: "line", goal_override: null, project_path: null }, wf);
    expect(graph!.name).toBe("Mine");
    expect(graph!.goal).toBe("g");
    expect([...graph!.nodes.keys()]).toEqual(["start", "exit"]);
    expect(graph!.edges).toEqual(wf.edges);
  });

  test("the graph stack (the-line.md L4) comes from the row, else from the stored source", () => {
    const nodes = [{ id: "start", type: "start" }, { id: "exit", type: "exit" }];
    const edges = [{ from: "start", to: "exit" }];
    const source = `digraph g { graph [stack="Release gates"]; start [shape=Mdiamond]; exit [shape=Msquare]; start -> exit }`;
    expect(graphForDaemonRun({ workflow_name: "x" }, { name: "x", nodes, edges, source })!.stack).toBe("Release gates");
    expect(graphForDaemonRun({ workflow_name: "x" }, { name: "x", nodes, edges, source, stack: "Row wins" })!.stack).toBe("Row wins");
    expect(graphForDaemonRun({ workflow_name: "x" }, { name: "x", nodes, edges })!.stack).toBeUndefined();
    expect(graphForDaemonRun({ workflow_name: "x" }, { name: "x", nodes, edges, source: "not dot at all {{" })!.stack).toBeUndefined();
  });

  test("null when the run has no nodes and its name is not a shipped template", () => {
    expect(graphForDaemonRun({ workflow_name: "not-a-template", project_path: "/nonexistent/path" }, EMPTY)).toBeNull();
    expect(graphForDaemonRun({ workflow_name: undefined, project_path: "/nonexistent/path" }, EMPTY)).toBeNull();
  });
});
