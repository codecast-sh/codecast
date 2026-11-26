// A repository's ship mode decides the library change flow's start before the run (startFacts.ts): read from its
// default branch as origin has it, never a working tree, and direct only when that branch says so and runs no CI on
// GitHub. A direct repository runs, reports and draws only its check, review and land path; every other one keeps the
// library's graph as it is, hash and all.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { graphHash, parseWorkflowFile, parseWorkflowSource, validateWorkflow } from "./parser";
import { repoFlowsReport } from "./repoFlowsReport";
import { decideStart, keepStart, pinDirectCommands, reviewNodeOf, runGraph, shipModeOf, startFacts, StartFactsError } from "./startFacts";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";
import { evalCondition } from "./condition";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
let tmp: string;
let root: string;
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV } }).trim();

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "start-facts-")));
  root = path.join(tmp, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", path.join(tmp, "origin.git")]);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git("remote", "add", "origin", path.join(tmp, "origin.git"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Commit these files on main and push it, so origin/main holds them. */
function onMain(files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  git("add", "-A");
  git("commit", "-qm", "main");
  git("push", "-q", "origin", "main");
}
const DIRECT = { ".codecast/workspace.toml": `[ship]\nmode = "direct"\n`, ".codecast/line.toml": `[line.commands]\ncheck = "make check"\nship = "scripts/ship.sh"\n` };
const change = () => parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change);

describe("shipModeOf: one rule for how a repository lands a change", () => {
  test("direct with no CI on GitHub lands straight to main", () => expect(shipModeOf("direct", false)).toBe("direct"));
  test("direct with CI workflows lands by pull request on green", () => expect(shipModeOf("direct", true)).toBe("pr"));
  test("pr, or nothing said, lands by pull request", () => {
    expect(shipModeOf("pr", false)).toBe("pr");
    expect(shipModeOf(undefined, false)).toBe("pr");
  });
});

describe("startFacts reads the default branch", () => {
  test("direct with no CI: the default branch's own check and ship commands come with it", () => {
    onMain(DIRECT);
    expect(startFacts(root)).toEqual({ ship_mode: "direct", land_check: "make check", land_ship: "scripts/ship.sh" });
  });

  test("a repository with CI workflows on its default branch is a pull request one, whatever its mode says", () => {
    onMain({ ...DIRECT, ".github/workflows/ci.yml": "on: push\n" });
    expect(startFacts(root)).toEqual({ ship_mode: "pr" });
  });

  test("a working tree's edits never pick the path: uncommitted, or committed on the change's branch", () => {
    onMain({ "a.txt": "base\n" });
    fs.mkdirSync(path.join(root, ".codecast"));
    fs.writeFileSync(path.join(root, ".codecast", "workspace.toml"), `[ship]\nmode = "direct"\n`);
    expect(startFacts(root)).toEqual({ ship_mode: "pr" });
    git("checkout", "-q", "-b", "feat");
    git("add", "-A");
    git("commit", "-qm", "go direct");
    expect(startFacts(root)).toEqual({ ship_mode: "pr" });
  });

  test("a direct run lands with the default branch's ship command, not one the change wrote", () => {
    onMain(DIRECT);
    fs.writeFileSync(path.join(root, ".codecast", "line.toml"), `[line.commands]\ncheck = "true"\nship = "git push origin HEAD:main"\n`);
    const ctx: Record<string, string> = { ...startFacts(root), "line.commands.check": "true", "line.commands.ship": "git push origin HEAD:main" };
    pinDirectCommands(ctx);
    expect(ctx["line.commands.ship"]).toBe("scripts/ship.sh");
    expect(ctx["line.commands.check"]).toBe("make check");
    // A pull request run keeps the profile as the working tree reads it.
    const pr: Record<string, string> = { ship_mode: "pr", "line.commands.ship": "x" };
    pinDirectCommands(pr);
    expect(pr["line.commands.ship"]).toBe("x");
  });

  test("no origin default branch reads as a pull request repository", () => {
    expect(startFacts(root)).toEqual({ ship_mode: "pr" });
  });

  test("a default branch whose workspace.toml does not parse stops the run, never falls back to a pull request", () => {
    onMain({ ".codecast/workspace.toml": `[ship]\nmode = "sideways"\n` });
    expect(() => startFacts(root)).toThrow(StartFactsError);
    expect(() => startFacts(root)).toThrow("ship.mode");
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
    const tops = [...new Set([...g.nodes.keys()].map((id) => id.split("__")[0]))].filter((id) => !g.nodes.get(id) || g.nodes.get(id)!.type !== "exit").sort();
    expect(tops).toEqual(["direct_check", "direct_ci_red", "direct_conflict", "direct_deploy", "direct_fix", "direct_review", "direct_revise", "land", "start"]);
    expect(g.edges.filter((e) => e.from === "start").map((e) => e.to)).toEqual(["direct_check"]);
    expect(g.edges.every((e) => g.nodes.has(e.from) && g.nodes.has(e.to))).toBe(true);
    expect(graphHash(decideStart(g, { ship_mode: "direct" }))).toBe(graphHash(g));
  });

  test("a start that also reads what only the run knows, or a fact's value it does not take, is left to the run", () => {
    const flow = (cond: string) => parseWorkflowSource(`digraph f {
      start [shape=Mdiamond]
      a [shape=parallelogram, script="true"]
      b [shape=parallelogram, script="true"]
      exit [shape=Msquare]
      start -> a [condition="${cond}"]
      start -> b
      a -> exit
      b -> exit
    }`);
    for (const cond of ["ship_mode = direct and task_status = open", "ship_mode = task_kind", "ship_mode contains dir", "ship_mode"]) {
      const g = flow(cond);
      expect(decideStart(g, { ship_mode: "direct" })).toBe(g);
    }
  });
});

describe("runGraph", () => {
  test("a resumed run keeps the start it took: a pull request run parked at a wait stays on the whole graph", () => {
    const g = change();
    expect(runGraph(g, { ship_mode: "direct" }, { resumeAt: "wait_main" })).toBe(g);
    expect(runGraph(g, { ship_mode: "direct" }, { resumeAt: "deploy__wait" })).toBe(g);
    // A direct run resumed where it stood, whatever the repository says now.
    const direct = runGraph(g, { ship_mode: "pr" }, { resumeAt: "land__ship" });
    expect(direct.nodes.has("pr")).toBe(false);
    expect(graphHash(direct)).toBe(graphHash(decideStart(g, { ship_mode: "direct" })));
    expect(keepStart(g, null)).toBe(g);
  });

  test("a variant's station hung only on the pull request path stops a direct run, naming it", () => {
    const dir = path.join(tmp, "flows");
    fs.mkdirSync(dir);
    const file = path.join(dir, "change.cast");
    fs.writeFileSync(file, `digraph change {\n  graph [extends="change"]\n  lint [after="pr", label="Lint", shape=parallelogram, script="true"]\n  review [guide="Also check X."]\n}\n`);
    const variant = parseWorkflowFile(file);
    expect(() => runGraph(variant, { ship_mode: "direct" })).toThrow("Lint (lint) hangs only on the pull request path");
    // A pull request repository runs it as written; a variant that only changes library stations runs direct.
    expect(runGraph(variant, { ship_mode: "pr" })).toBe(variant);
    fs.writeFileSync(file, `digraph change {\n  graph [extends="change"]\n  review [guide="Also check X."]\n}\n`);
    expect(runGraph(parseWorkflowFile(file), { ship_mode: "direct" }).nodes.has("pr")).toBe(false);
  });

  test("the review station is the path's own: Review on the pull request path, the direct path's in a direct run", () => {
    expect(reviewNodeOf(change())).toBe("review");
    const direct = runGraph(change(), { ship_mode: "direct" });
    expect(reviewNodeOf(direct)).toBe("direct_review");
    expect(direct.nodes.get("direct_review")).toMatchObject({ backend: "session", reviewer: true });
  });
});

describe("the direct path's ways back", () => {
  const g = decideStart(change(), { ship_mode: "direct" });
  const fired = (from: string, ctx: Record<string, string>) => {
    const out = g.edges.filter((e) => e.from === from);
    return (out.find((e) => e.condition && evalCondition(e.condition, ctx)) ?? out.find((e) => !e.condition))?.to;
  };
  const exitJson = (id: string, exit: string) => ({ [`${id}.json`]: JSON.stringify({ exit }) });

  test("a Land rebase conflict goes to the session to resolve; a ship command's exit 7 (CI red on main) goes back with its brief", () => {
    expect(fired("land__conflict", { outcome: "failure", change_conversation: "c", ...exitJson("land__conflict", "conflict") })).toBe("direct_conflict");
    expect(fired("land__unshipped", { outcome: "failure", change_conversation: "c", "land__ship.exit_code": "7", ...exitJson("land__unshipped", "unshipped") })).toBe("direct_ci_red");
    // Any other refusal stops at Land in the command's words.
    expect(fired("land__unshipped", { outcome: "failure", change_conversation: "c", "land__ship.exit_code": "1", ...exitJson("land__unshipped", "unshipped") })).toBeUndefined();
  });

  test("a repository that names no check command stops honestly, never passes unchecked or briefs the session", () => {
    expect(fired("direct_check__verify", { outcome: "failure", "line.commands.check": "", "direct_check__verify.exit_code": "1" })).toBe("direct_check__nocheck");
    expect(fired("direct_check__nocheck", { outcome: "failure", change_conversation: "c", ...exitJson("direct_check__nocheck", "nocheck") })).toBeUndefined();
    expect(fired("direct_check__verify", { outcome: "failure", "line.commands.check": "make check", "direct_check__verify.exit_code": "1" })).toBe("direct_check__failed");
  });

  test("the reviewer's verdict routes: approve lands, changes go to the session, reject and no verdict stop", () => {
    expect(fired("direct_review", { review_verdict: "approve" })).toBe("land");
    expect(fired("direct_review", { review_verdict: "changes", change_conversation: "c" })).toBe("direct_revise");
    expect(fired("direct_review", { review_verdict: "changes" })).toBe("direct_changes");
    expect(fired("direct_review", { review_verdict: "reject", change_conversation: "c" })).toBe("direct_rejected");
    expect(fired("direct_review", { review_verdict: "none" })).toBe("direct_unreviewed");
  });
});

describe("the picker's report", () => {
  test("a direct checkout reports the library change as its path alone, marked; a pull request checkout reports none", () => {
    const REMOTE = "git@github.com:acme/app.git";
    onMain({ "a.txt": "base\n" });
    expect(repoFlowsReport(root, REMOTE)!.flows.map((f) => f.slug)).toEqual([]);
    onMain(DIRECT);
    const [flow, ...more] = repoFlowsReport(root, REMOTE)!.flows;
    expect(more).toEqual([]);
    expect(flow).toMatchObject({ slug: "change", label: "Ship", decided_from: "change", facts: { ship_mode: "direct" } });
    const ids = flow.nodes.map((n) => n.id);
    expect(ids).toContain("land__shipped");
    expect(ids).not.toContain("pr");
    // The same read as a run: a working tree that says direct, on a default branch with CI, reports nothing.
    onMain({ ".github/workflows/ci.yaml": "on: push\n" });
    expect(repoFlowsReport(root, REMOTE)!.flows).toEqual([]);
  });
});
