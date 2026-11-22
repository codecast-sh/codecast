// A variant's edits (pipeline.md PL3) checked against what the runner does with them, not only against the graph:
// each test writes a base and a variant to disk, parses the variant the way a run does, and runs it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parseWorkflowFile, validateWorkflow, parseWorkflowSource } from "./parser.js";
import { lineRunDir, runSlug, runWorkflow, type RunOptions } from "./runner.js";
import { branchChangePaths, frozenChangeContext, writeFrozenChange } from "./flowChangeFile.js";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
isolateCodecastDirEachTest("cast-wf-variant-");

let dir: string;
let log: string;
let origLog: typeof console.log;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "variant-e2e-")));
  log = path.join(dir, "log");
  origLog = console.log;
  console.log = () => {};
});
afterEach(() => {
  console.log = origLog;
  fs.rmSync(dir, { recursive: true, force: true });
});

const step = (id: string, more = "") => `${id} [shape=parallelogram, script="echo ${id} >> ${log}${more}"]`;
const flow = (base: string, variant: string) => {
  fs.writeFileSync(path.join(dir, "base.cast"), base);
  fs.writeFileSync(path.join(dir, "v.cast"), `digraph v {\n  graph [extends="base.cast"]\n  ${variant}\n}\n`);
  return () => parseWorkflowFile(path.join(dir, "v.cast"));
};
const ran = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);

const FAN = () => `digraph base {
  start [shape=Mdiamond]
  checks [shape=component]
  ${step("a")}
  ${step("b")}
  read [shape=tripleoctagon]
  ${step("after_read")}
  exit [shape=Msquare]
  start -> checks
  checks -> a
  checks -> b
  a -> read
  b -> read
  read -> after_read -> exit
}`;

describe("a fan-out", () => {
  test("an edit on a branch or the join is refused, naming the fan-out and where to put it instead", () => {
    expect(flow(FAN(), `lint [after="a", shape=parallelogram, script="exit 1"]`)).toThrow('a is a branch of the checks fan-out, which runs its branches side by side and goes on from read, so placing lint after it would not run as written; use the station before the fan-out (before="checks") or after the join (after="read")');
    expect(flow(FAN(), `lint [before="read", shape=parallelogram, script="true"]`)).toThrow('read is where the checks fan-out joins its side-by-side branches, so placing lint before it would not run as written; use the station before the fan-out (before="checks") or after the join (after="read")');
    expect(flow(FAN(), `lint [after="checks", shape=parallelogram, script="true"]`)).toThrow("checks is a fan-out, which runs its branches side by side");
    expect(flow(FAN(), `a [skip=true]`)).toThrow("a is a branch of the checks fan-out");
    expect(flow(FAN(), `a [when="nothing/**"]`)).toThrow("when= works on flows that take a branch");
    expect(flow(FAN().replace("digraph base {", `digraph base {\n  graph [takes="task,branch"]`), `a [when="nothing/**"]`)).toThrow("a is a branch of the checks fan-out");
  });

  test("a station after the join runs after both branches, and the run says so in order", async () => {
    const g = flow(FAN(), `lint [after="read", shape=parallelogram, script="echo lint >> ${log}"]`)();
    expect(validateWorkflow(g)).toEqual([]);
    expect(await runWorkflow(g, { cwd: dir })).toBe("completed");
    const order = ran();
    expect(order.slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(order.slice(2)).toEqual(["lint", "after_read"]);
  });

  test("validation names a branch that does not lead straight to the join", () => {
    const g = parseWorkflowSource(FAN().replace("a -> read", `a -> extra\n  extra -> read\n  ${step("extra")}`));
    expect(validateWorkflow(g)).toEqual(["checks's branch a goes on to extra, but a fan-out runs only its branches and goes on from read: lead a straight to read"]);
  });
});

const GATE = () => `digraph base {
  start [shape=Mdiamond]
  ${step("a")}
  fix [shape=parallelogram, script="echo fix >> ${log}", max_visits=2]
  ${step("done")}
  exit [shape=Msquare]
  start -> a
  a -> done [condition="outcome = success"]
  a -> fix [condition="outcome = failure", label="a failed"]
  fix -> a
  done -> exit
}`;

describe("a person's gate placed after a station", () => {
  let origFetch: typeof fetch;
  let answers: string[];
  let asked: Array<Array<{ key: string; target: string }>>;
  beforeEach(() => {
    origFetch = globalThis.fetch;
    asked = [];
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      const body = JSON.parse(init?.body || "{}");
      const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (route === "/cli/workflow-runs/gate") { asked.push(body.choices); return reply({ ok: true }); }
      if (route === "/cli/workflow-runs/poll-gate") return reply({ status: "running", gate_response: answers.shift() ?? "Y" });
      return reply({ ok: true });
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  test("offers going on and sending back, and each choice goes where it says", async () => {
    const g = flow(GATE(), `ask [after="a", label="Ask", shape=hexagon, prompt="Ship it?"]`)();
    expect(validateWorkflow(g)).toEqual([]);
    answers = ["N", "Y"];
    const opts = { cwd: dir, runId: `run-gate-${Date.now()}`, runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 } as RunOptions;
    expect(await runWorkflow(g, opts)).toBe("completed");
    expect(asked[0].map((c) => [c.key, c.target])).toEqual([["Y", "done"], ["N", "fix"]]);
    expect(g.edges.filter((e) => e.from === "ask").map((e) => e.label)).toEqual(["[Y] Go on :: Done", "[N] Send back :: Fix"]);
    // Send back went to Fix, which went back to a, which asked again; Go on went to done.
    expect(ran()).toEqual(["a", "fix", "a", "done"]);
  }, 30_000);
});

describe("a station after one that routes on exit codes", () => {
  const MERGE = () => `digraph base {
  start [shape=Mdiamond]
  merge [shape=parallelogram, script="echo merge >> ${log}", max_visits=4]
  ${step("retest")}
  ${step("conflict")}
  ${step("deploy")}
  fix [shape=parallelogram, script="echo fix >> ${log}", max_visits=2]
  exit [shape=Msquare]
  unmerged [shape=Msquare, stop="not merged"]
  start -> merge
  merge -> deploy [condition="outcome = success"]
  merge -> retest [condition="merge.exit_code = 3", label="main moved"]
  merge -> conflict [condition="merge.exit_code = 4", label="conflict"]
  merge -> unmerged
  retest -> merge
  conflict -> merge
  fix -> merge
  deploy -> exit
}`;

  test("is refused without fix=, which those routes cannot stand in for", () => {
    expect(flow(MERGE(), `lint [after="merge", shape=parallelogram, script="true"]`)).toThrow('merge routes on its exit codes or output (to retest, conflict), not on a failure, so none of them is lint\'s way back; name where a failure of lint goes with fix="<station>"');
  });

  test("with fix=, a failure goes there and the run comes back through it", async () => {
    const flag = path.join(dir, "linted-once");
    const g = flow(MERGE(), `lint [after="merge", fix="fix", shape=parallelogram, script="echo lint >> ${log}; [ -f ${flag} ] || { touch ${flag}; exit 1; }"]`)();
    expect(validateWorkflow(g)).toEqual([]);
    expect(await runWorkflow(g, { cwd: dir })).toBe("completed");
    expect(ran()).toEqual(["merge", "lint", "fix", "merge", "lint", "deploy"]);
  });
});

describe("skip", () => {
  const LINE = () => `digraph base {
  start [shape=Mdiamond]
  ${step("check")}
  ${step("review")}
  fix [shape=parallelogram, script="echo fix >> ${log}"]
  ${step("ship")}
  exit [shape=Msquare]
  start -> check
  check -> review [condition="outcome = success"]
  check -> fix [condition="outcome = failure"]
  fix -> check
  review -> ship -> exit
}`;

  test("a skip that would loop a station back to itself is refused", () => {
    expect(flow(LINE(), `fix [skip=true]`)).toThrow('fix [skip="true"]: check goes to fix when outcome = failure, and fix goes on to check, so skipping it would send check straight back to itself');
  });

  test("a skipped station does not run, and its neighbours join", async () => {
    const g = flow(LINE(), `review [skip=true]`)();
    expect(validateWorkflow(g)).toEqual([]);
    expect(await runWorkflow(g, { cwd: dir })).toBe("completed");
    expect(ran()).toEqual(["check", "ship"]);
  });

  test("start and the end cannot be skipped", () => {
    expect(flow(LINE(), `start [skip=true]`)).toThrow("start starts the flow, so it cannot be skipped");
    expect(flow(LINE(), `exit [skip=true]`)).toThrow("exit ends the flow, so it cannot be skipped");
  });
});

describe("when= on a branch run", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const CHANGE = () => `digraph base {
  graph [takes="task,branch"]
  start [shape=Mdiamond]
  ${step("check")}
  ${step("review")}
  exit [shape=Msquare]
  start -> check
  check -> review [condition="outcome = success"]
  review -> exit
}`;

  const runOnBranch = async (files: string[]) => {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    git(dir, "checkout", "-q", "-b", "feat");
    for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), "x"); }
    git(dir, "add", "-A");
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "change");
    git(dir, "checkout", "-q", "main");
    const paths = branchChangePaths(dir, "feat");
    const g = flow(CHANGE(), `e2e [after="check", when="landing/**", shape=parallelogram, script="echo e2e >> ${log}"]`)();
    const runDir = lineRunDir(dir, runSlug(g, { task_id: "ct-1" }, "run"));
    writeFrozenChange(runDir, { source: "branch", base: "x", tip: "x", branch: "feat", worktree: "w", paths, shared: [], held: [] });
    expect(await runWorkflow(g, { cwd: dir, taskId: "ct-1" })).toBe("completed");
    return { paths, ctx: frozenChangeContext(runDir) };
  };

  test("the branch's files are read from git, and a station gated on landing/** runs when it is touched", async () => {
    const { paths, ctx } = await runOnBranch(["landing/index.html", "src/a.ts"]);
    expect(paths.sort()).toEqual(["landing/index.html", "src/a.ts"]);
    expect(ctx.change_files).toBe("landing/index.html src/a.ts");
    expect(ran()).toEqual(["check", "e2e", "review"]);
  });

  test("and goes past it when the branch touches nothing it names", async () => {
    await runOnBranch(["src/a.ts"]);
    expect(ran()).toEqual(["check", "review"]);
  });

  test("a change whose files were not read leaves change_files unset, so the gated station runs", () => {
    const runDir = path.join(dir, "run");
    writeFrozenChange(runDir, { source: "branch", base: "x", tip: "x", branch: "feat", worktree: "w", paths: [], shared: [], held: [] });
    expect("change_files" in frozenChangeContext(runDir)).toBe(false);
  });
});

describe("the backbone's default way back (graph [fix=])", () => {
  const PR = () => `digraph base {
  graph [takes="task,branch", fix="brief"]
  start [shape=Mdiamond]
  pr [shape=parallelogram, script="echo pr >> ${log}", max_visits=3]
  ${step("ci")}
  brief [shape=parallelogram, script="echo brief >> ${log}", max_visits=2]
  exit [shape=Msquare]
  unpushed [shape=Msquare, stop="no pull request"]
  start -> pr
  pr -> ci [condition="outcome = success"]
  pr -> unpushed
  ci -> exit
  brief -> pr
}`;

  test("a station placed where its anchor has no way back fails to the station the backbone names, and the words say so", async () => {
    const flag = path.join(dir, "linted-once");
    const g = flow(PR(), `lint [after="pr", label="Lint", shape=parallelogram, script="echo lint >> ${log}; [ -f ${flag} ] || { touch ${flag}; exit 1; }"]`)();
    expect(validateWorkflow(g)).toEqual([]);
    expect(g.edges.filter((e) => e.from === "lint")).toEqual([
      { from: "lint", to: "ci", condition: "outcome = success" },
      { from: "lint", to: "brief", condition: "outcome = failure", label: "lint failed" },
    ]);
    expect(g.edits).toEqual([{ op: "add", station: "lint", label: "Lint", after: "pr", fix: "brief" }]);
    const { flowEditWords } = await import("@codecast/shared/contracts/flowEdit");
    expect(flowEditWords(g.edits![0], (id) => ({ pr: "PR", brief: "Brief" })[id] ?? id)).toBe("+ Lint after PR; a failure goes to Brief");
    expect(await runWorkflow(g, { cwd: dir })).toBe("completed");
    expect(ran()).toEqual(["pr", "lint", "brief", "pr", "lint", "ci"]);
  });

  test("the station's own fix= and the anchor's own way back still come first; a default naming no station is refused", () => {
    const own = flow(PR(), `lint [after="pr", fix="ci", shape=parallelogram, script="true"]`)();
    expect(own.edges.find((e) => e.from === "lint" && e.condition === "outcome = failure")?.to).toBe("ci");
    const withBack = PR().replace("pr -> unpushed", "pr -> unpushed\n  ci -> pr [condition=\"outcome = failure\"]");
    const g = flow(withBack, `late [after="ci", shape=parallelogram, script="true"]`)();
    expect(g.edges.find((e) => e.from === "late" && e.condition === "outcome = failure")?.to).toBe("pr");
    expect(flow(PR().replace('fix="brief"', 'fix="nowhere"'), `lint [after="pr", shape=parallelogram, script="true"]`)).toThrow('pr has no way back, and the flow\'s graph [fix="nowhere"] names no station to send lint\'s failure to');
  });
});
