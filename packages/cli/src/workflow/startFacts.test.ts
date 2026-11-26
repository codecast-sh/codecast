// A checkout's ship mode decides the library change flow's start before the run (startFacts.ts): a repository that
// ships straight to its default branch runs, reports and draws only its check, review and land path; every other
// repository keeps the library's graph as it is, hash and all.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { graphHash, parseWorkflowSource, validateWorkflow } from "./parser";
import { repoFlowsReport } from "./repoFlowsReport";
import { decideStart, startFacts } from "./startFacts";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "start-facts-"));
  fs.writeFileSync(path.join(root, ".git"), "gitdir: elsewhere\n");
  fs.mkdirSync(path.join(root, ".codecast"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const manifest = (text: string) => fs.writeFileSync(path.join(root, ".codecast", "workspace.toml"), text);
const change = () => parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change);

describe("startFacts", () => {
  test("reads the repository's own [ship] mode, from any directory inside it", () => {
    manifest(`[ship]\nmode = "direct"\n`);
    fs.mkdirSync(path.join(root, "src"));
    expect(startFacts(path.join(root, "src"))).toEqual({ ship_mode: "direct" });
  });

  test("a repository that says nothing, or cannot be read, ships through a pull request", () => {
    expect(startFacts(root)).toEqual({ ship_mode: "pr" });
    manifest(`[ship]\nflow = "change"\n`);
    expect(startFacts(root)).toEqual({ ship_mode: "pr" });
    manifest(`[ship]\nmode = "sideways"\n`);
    expect(startFacts(root)).toEqual({ ship_mode: "pr" });
  });
});

describe("decideStart", () => {
  test("a pull request repository keeps the library's change graph itself", () => {
    const g = change();
    expect(decideStart(g, { ship_mode: "pr" })).toBe(g);
    expect(decideStart(g, {})).toBe(g);
  });

  test("a direct repository's change is check, review, fix and land, then deploy: no pull request, CI or merge", () => {
    const g = decideStart(change(), { ship_mode: "direct" });
    expect(validateWorkflow(g)).toEqual([]);
    const tops = [...new Set([...g.nodes.keys()].map((id) => id.split("__")[0]))].sort();
    expect(tops).toEqual(["direct_check", "direct_deploy", "direct_fix", "direct_review", "exit", "land", "start"]);
    expect(g.edges.filter((e) => e.from === "start").map((e) => e.to)).toEqual(["direct_check"]);
    // Every edge joins two stations the graph still has, and the decided graph is decided already.
    expect(g.edges.every((e) => g.nodes.has(e.from) && g.nodes.has(e.to))).toBe(true);
    expect(graphHash(decideStart(g, { ship_mode: "direct" }))).toBe(graphHash(g));
  });

  test("a start that also reads what only the run knows is left to the run", () => {
    const src = `digraph f {
      start [shape=Mdiamond]
      a [shape=parallelogram, script="true"]
      b [shape=parallelogram, script="true"]
      exit [shape=Msquare]
      start -> a [condition="ship_mode = direct and task_status = open"]
      start -> b
      a -> exit
      b -> exit
    }`;
    const g = parseWorkflowSource(src);
    expect(decideStart(g, { ship_mode: "direct" })).toBe(g);
  });
});

describe("the picker's report", () => {
  test("a direct checkout reports the library change as its path alone; a pull request checkout reports none", () => {
    const REMOTE = "git@github.com:acme/app.git";
    expect(repoFlowsReport(root, REMOTE)!.flows.map((f) => f.slug)).toEqual([]);
    manifest(`[ship]\nmode = "direct"\n`);
    const [flow, ...more] = repoFlowsReport(root, REMOTE)!.flows;
    expect(more).toEqual([]);
    expect(flow).toMatchObject({ slug: "change", label: "Ship" });
    const ids = flow.nodes.map((n) => n.id);
    expect(ids).toContain("land__shipped");
    expect(ids).not.toContain("pr");
    expect(ids).not.toContain("merge");
  });
});
