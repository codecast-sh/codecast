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

  test("a run that recorded library versions runs them, whatever the checkout's file says, on any machine (ct-70169)", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "daemongraph-"));
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "daemongraph-cache-"));
    fs.mkdirSync(path.join(root, "line"));
    fs.writeFileSync(path.join(root, "line/look.md"), "The checkout's uncommitted edit.");
    fs.writeFileSync(path.join(root, "line/g.cast"), `digraph g { start [shape=Mdiamond]; look [prompt="@look.md"]; exit [shape=Msquare]; start -> look -> exit }`);
    // The variant extends the base; the base's current version is written after it, so its stations read the base's text.
    const base = { workflow_id: "w1", version_id: "v1b", snapshot: { name: "g", source: `digraph g { start [shape=Mdiamond]; look [prompt="@look.md"]; exit [shape=Msquare]; start -> look -> exit }`, nodes: [{ id: "look", prompt: "Base, current." }], file: "line/g.cast", files: [{ node: "look", prompt: "line/look.md" }] } };
    const variant = { workflow_id: "w2", version_id: "v2a", snapshot: { name: "g_sys", source: `digraph g_sys { graph [extends="g.cast"]; fix [prompt="@sys/fix.md"]; look -> fix -> exit }`, nodes: [{ id: "look", prompt: "Base, as the variant was saved." }, { id: "fix", prompt: "System fix." }], file: "line/g-sys.cast", files: [{ node: "look", prompt: "line/look.md" }, { node: "fix", prompt: "line/sys/fix.md" }] } };
    const wf = { name: "g_sys", nodes: [], edges: [], origin: { device_id: "dev-a", root, file: "line/g-sys.cast" }, library: { versions: [variant, base] } };
    const run = { workflow_name: "g_sys", project_path: root, fresh_branch: true, goal_override: "Fix ct-1" };
    const { materializeLibraryRun } = require("./daemonGraph");
    const entry = materializeLibraryRun(wf.library.versions, cache);
    expect(fs.readFileSync(path.join(path.dirname(entry), "look.md"), "utf-8")).toBe("Base, current.");
    for (const device of ["dev-a", "dev-b"]) {
      const { graph, file } = daemonRunGraph(run, wf, root, device, false);
      expect(file).toBeNull();
      expect(graph!.name).toBe("g_sys");
      expect(graph!.goal).toBe("Fix ct-1");
      expect(graph!.nodes.get("look")!.prompt).toBe("Base, current.");
      expect(graph!.nodes.get("fix")!.prompt).toBe("System fix.");
      expect(graph!.edges.filter((e: any) => e.from === "look").map((e: any) => e.to)).toEqual(["fix"]);
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
  });

  test("a segment the run recorded a version of reads that version, whatever this machine's index and checkouts hold; a run that recorded none resolves it here, as before", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "daemongraph-seg-"));
    const saved = { dir: process.env.CODECAST_DIR, cache: process.env.CODECAST_FLOWS_CACHE };
    process.env.CODECAST_DIR = path.join(home, ".codecast");
    delete process.env.CODECAST_FLOWS_CACHE;
    try {
      const cache = path.join(home, ".codecast", "flows");
      fs.mkdirSync(cache, { recursive: true });
      const land = (says: string) => `digraph land { graph [kind="segment"]; start [shape=Mdiamond]; merge [prompt="${says}"]; exit [shape=Msquare]; start -> merge -> exit }`;
      // The host's checkout carries its own land.cast.
      const checkout = path.join(home, "repo");
      fs.mkdirSync(path.join(checkout, ".codecast", "flows"), { recursive: true });
      fs.writeFileSync(path.join(checkout, ".codecast", "flows", "land.cast"), land("The checkout's land."));
      const onefix = { workflow_id: "w1", version_id: "v30", slug: "onefix", snapshot: { name: "onefix", source: `digraph onefix { start [shape=Mdiamond]; fix [prompt="Fix."]; land [flow="land"]; exit [shape=Msquare]; start -> fix -> land -> exit }`, nodes: [], file: "outreach/line/onefix.cast", files: [] } };
      const recorded = { workflow_id: "w9", version_id: "v4", slug: "land", snapshot: { name: "land", source: land("The recorded land."), nodes: [], file: ".codecast/flows/land.cast", files: [] } };
      const run = { workflow_name: "onefix", project_path: checkout };
      const merge = (versions: any[]) => daemonRunGraph(run, { name: "onefix", nodes: [], edges: [], library: { versions } }, checkout, "dev-b").graph!.nodes.get("land__merge")!.prompt;

      // This machine's index lacks land, and a hand-placed copy sits where the walk up from the library reaches.
      fs.writeFileSync(path.join(cache, "land.cast"), land("The host's copy."));
      expect(fs.existsSync(path.join(cache, "index.json"))).toBe(false);
      expect(merge([onefix, recorded])).toBe("The recorded land.");

      // A version saved before segments were pinned: the hand-placed copy, as today.
      expect(merge([onefix])).toBe("The host's copy.");
      // Without it, the team flow this machine last indexed.
      fs.rmSync(path.join(cache, "land.cast"));
      const team = path.join(cache, "k57land", "land.cast");
      fs.mkdirSync(path.dirname(team), { recursive: true });
      fs.writeFileSync(team, land("The indexed land."));
      fs.writeFileSync(path.join(cache, "index.json"), JSON.stringify({ land: team }));
      expect(merge([onefix])).toBe("The indexed land.");
      expect(merge([onefix, recorded])).toBe("The recorded land.");
    } finally {
      for (const [k, v] of [["CODECAST_DIR", saved.dir], ["CODECAST_FLOWS_CACHE", saved.cache]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a run with more versions than fit a directory's name writes them under a hash of them all", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { materializeLibraryRun } = require("./daemonGraph");
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "daemongraph-long-"));
    const version = (id: string) => ({ workflow_id: "w", version_id: id, slug: id, snapshot: { name: id, source: `digraph ${id} { start [shape=Mdiamond]; exit [shape=Msquare]; start -> exit }`, nodes: [], file: `${id}.cast`, files: [] } });
    const ids = (tail: string) => [..."abcdefg"].map((c) => `${c.repeat(31)}${tail}`);
    const a = materializeLibraryRun(ids("1").map(version), cache);
    const b = materializeLibraryRun([...ids("1").slice(0, 6), "z".repeat(32)].map(version), cache);
    expect(path.basename(path.dirname(a))).toMatch(/^v-h[0-9a-f]{40}$/);
    expect(path.dirname(a)).not.toBe(path.dirname(b));
    fs.rmSync(cache, { recursive: true, force: true });
  });

  test("a row pushed from another repo's checkout on this machine never answers a run in this one", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { spawnSync } = require("node:child_process");
    const { BUILTIN_WORKFLOW_TEMPLATES } = require("./templates");
    const checkout = (flow?: string) => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daemongraph-team-")));
      spawnSync("git", ["init", "-q", root]);
      if (flow) {
        fs.mkdirSync(path.join(root, ".codecast/flows"), { recursive: true });
        fs.writeFileSync(path.join(root, ".codecast/flows/change.cast"), flow);
      }
      return root;
    };
    // Team A's checkout names its own `change`; team B's has none, so the shipped one is B's.
    const teamA = checkout(`digraph change { start [shape=Mdiamond]; a_pr [script="bun outreach/backend/scripts/line.ts pr"]; review [prompt="A's review"]; exit [shape=Msquare]; start -> a_pr -> review -> exit }`);
    const teamB = checkout();
    const aRow = { origin: { device_id: "dev-a", root: teamA, file: ".codecast/flows/change.cast" } };
    const run = { workflow_name: "change", project_path: teamB, goal_override: "B's change" };
    const stations = (wf: any, r: any = run, cwd = teamB, resume = false) => [...daemonRunGraph(r, wf, cwd, "dev-a", resume).graph!.nodes.keys()];
    // B pushed the shipped graph over the row A had pushed from its file: the row still says where A's file is.
    const shippedOverA = { ...aRow, name: "change", slug: "change", source: BUILTIN_WORKFLOW_TEMPLATES.change, nodes: [], edges: [] };
    expect(stations(shippedOverA)).toContain("verdicts");
    expect(stations(shippedOverA)).not.toContain("a_pr");
    // A pushed last: B's run, started or resumed at a station both flows have, still runs B's flow.
    const aOverB = { ...aRow, name: "change", slug: "change", source: fs.readFileSync(path.join(teamA, ".codecast/flows/change.cast"), "utf-8"), nodes: [{ id: "start", type: "start" }, { id: "a_pr" }, { id: "review" }, { id: "exit", type: "exit" }], edges: [] };
    expect(stations(aOverB)).not.toContain("a_pr");
    expect(stations(aOverB, { ...run, current_node_id: "review" }, teamB, true)).not.toContain("a_pr");
    expect(daemonRunGraph(run, aOverB, teamB, "dev-a").graph!.goal).toBe("B's change");
    // B's checkout names its own `change`: that one answers.
    fs.mkdirSync(path.join(teamB, ".codecast/flows"), { recursive: true });
    fs.writeFileSync(path.join(teamB, ".codecast/flows/change.cast"), `digraph change { start [shape=Mdiamond]; b_only; exit [shape=Msquare]; start -> b_only -> exit }`);
    expect(stations(aOverB)).toEqual(["start", "b_only", "exit"]);
    // A's own runs keep reading A's file.
    expect(stations(aOverB, { ...run, project_path: teamA, current_node_id: "review" }, teamA, true)).toContain("a_pr");
    for (const root of [teamA, teamB]) fs.rmSync(root, { recursive: true, force: true });
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
