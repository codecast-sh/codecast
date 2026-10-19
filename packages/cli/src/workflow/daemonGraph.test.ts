// the-line.md L9: a run the sweep starts under a slug with no pushed
// workflows row still executes, because run-daemon resolves the shipped
// template by the run's name.
import { describe, expect, test } from "bun:test";
import { daemonRunGraph, graphForDaemonRun, publishDaemonGraph } from "./daemonGraph";

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

  test("a server-queued trial run reads the graph file it was pushed from on this machine, not the stale row", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "daemongraph-"));
    fs.mkdirSync(path.join(root, "line"));
    fs.writeFileSync(path.join(root, "line/look.md"), "Edited since the push.");
    fs.writeFileSync(path.join(root, "line/g.cast"), `digraph g { start [shape=Mdiamond]; look [prompt="@look.md"]; exit [shape=Msquare]; start -> look -> exit }`);
    const wf = { name: "g", nodes: [{ id: "start", type: "start" }, { id: "look", prompt: "As pushed." }, { id: "exit", type: "exit" }], edges: [], origin: { device_id: "dev-a", root, file: "line/g.cast" } };
    const run = { workflow_name: "g", project_path: root, fresh_branch: true };
    expect(graphForDaemonRun(run, wf, root, "dev-a")!.nodes.get("look")!.prompt).toBe("Edited since the push.");
    // Another machine, or a run that is not a server-queued trial run, keeps the row.
    expect(graphForDaemonRun(run, wf, root, "dev-b")!.nodes.get("look")!.prompt).toBe("As pushed.");
    expect(graphForDaemonRun({ ...run, fresh_branch: false }, wf, root, "dev-a")!.nodes.get("look")!.prompt).toBe("As pushed.");
    // A resume of any run pushed from that file continues on the file as it is, when the file still has its station.
    const resumed = graphForDaemonRun({ ...run, fresh_branch: false, current_node_id: "look" }, wf, root, "dev-a", true)!;
    expect(resumed.nodes.get("look")!.prompt).toBe("Edited since the push.");
    // The files it read, so its runner can tell when they change under it.
    expect(resumed.sources).toEqual([path.join(root, "line/g.cast"), path.join(root, "line/look.md")]);
    expect(graphForDaemonRun({ ...run, fresh_branch: false, current_node_id: "gone" }, wf, root, "dev-a", true)!.nodes.get("look")!.prompt).toBe("As pushed.");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("null when the run has no nodes and its name is not a shipped template", () => {
    expect(graphForDaemonRun({ workflow_name: "not-a-template", project_path: "/nonexistent/path" }, EMPTY)).toBeNull();
    expect(graphForDaemonRun({ workflow_name: undefined, project_path: "/nonexistent/path" }, EMPTY)).toBeNull();
  });
});

describe("publishDaemonGraph", () => {
  test("a run reading its graph file here publishes that file, with the file's goal, to the row it came from", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { spawnSync } = require("node:child_process");
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daemonpublish-")));
    spawnSync("git", ["init", "-q", root]);
    fs.mkdirSync(path.join(root, "line"));
    fs.writeFileSync(path.join(root, "line/present.md"), "Present the fix as it stands now.");
    const source = `digraph g { graph [goal="$task_title"]; start [shape=Mdiamond]; present [prompt="@present.md"]; exit [shape=Msquare]; start -> present -> exit }`;
    fs.writeFileSync(path.join(root, "line/g.cast"), source);
    const wf = { name: "Trial line", slug: "trial-line", nodes: [], edges: [], origin: { device_id: "dev-a", root, file: "line/g.cast" } };

    // Only a server-queued run or a resume on the machine that holds the file reads it, so only those publish.
    const at = (current_node_id: string, fresh_branch = false) => ({ workflow_name: "g", fresh_branch, current_node_id });
    const file = daemonRunGraph(at("present"), wf, root, "dev-a", true).file!;
    expect(file).toBe(path.join(root, "line/g.cast"));
    expect(daemonRunGraph(at("present"), wf, root, "dev-a", false).file).toBeNull();
    expect(daemonRunGraph(at("present", true), wf, root, "dev-b", false).file).toBeNull();
    expect(daemonRunGraph(at("present", true), { ...wf, origin: { ...wf.origin, file: "line/gone.cast" } }, root, "dev-a", false).file).toBeNull();
    // A resume standing at a station the file no longer has runs on the row's stations, so the file is not its to publish.
    expect(daemonRunGraph(at("plan_gate"), wf, root, "dev-a", true).file).toBeNull();

    const posts: Array<{ route: string; body: any }> = [];
    await publishDaemonGraph(file, wf, "dev-a", async (route, body) => { posts.push({ route, body }); return {}; });
    expect(posts).toHaveLength(1);
    const { route, body } = posts[0];
    expect(route).toBe("/cli/workflows/upsert");
    expect(body.slug).toBe("trial-line");
    expect(body.name).toBe("Trial line");
    expect(body.goal).toBe("$task_title");
    expect(body.source).toBe(source);
    expect(body.origin.file).toBe("line/g.cast");
    // The hashes a run records for this file are the hashes it publishes, so its waiting decision reads as current.
    const run = graphForDaemonRun({ workflow_name: "g", fresh_branch: false, current_node_id: "present", goal_override: "One problem's title" }, wf, root, "dev-a", true)!;
    const { graphNodeHashes } = require("./parser");
    expect(body.origin.nodes).toEqual(graphNodeHashes(run));
    fs.rmSync(root, { recursive: true, force: true });
  });
});
