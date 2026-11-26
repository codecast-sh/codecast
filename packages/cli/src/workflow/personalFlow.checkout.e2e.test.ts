// End to end (flows.md FL4): the personal flow's Check, which never leaves the change's tree, and the person's
// checkout: the session's own uncommitted edits, and a checkout that is a linked worktree. The harness is
// personalFlow.testkit.ts.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFrozenChange } from "./flowChangeFile";
import { parseWorkflowSource } from "./parser";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";
import { executeCommand } from "./commandStation";
import { commandDir, commandEscapes, runCheck } from "./personalCheck";
import {
  CONV, FAILED, FOUND, GONE, LIVE, SHIP, expectLanded, git, run, sandbox, server, usePersonalSandbox, world,
} from "./personalFlow.testkit";

usePersonalSandbox();

describe("the personal Check runs only in the change's tree, at the round's head", () => {
  test("a check command that would run outside the change's tree is refused, never run", async () => {
    const w = world({ find: { ...FOUND, commands: [{ run: `touch ${sandbox}/escaped && ./check.sh`, cwd: "../..", source: "README.md:3" }] }, review: [SHIP] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(fs.existsSync(path.join(sandbox, "escaped"))).toBe(false);
    expect(s.sent().at(-1).body).toContain("stopped at Check did not run");
    expect(s.sent().at(-1).body).toContain("not inside the change's tree");
    expect(s.ran("land")).toBe(0);
  }, 120_000);

  test("Check refuses a tree with changes of its own", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    w.onFind = () => fs.writeFileSync(path.join(w.wt, "stray.txt"), "x\n");
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.ran("land")).toBe(0);
    expect(s.sent().at(-1).body).toContain("stopped at Check did not run");
    expect(s.sent().at(-1).body).toContain("has changes of its own");
  }, 120_000);

  test("Check refuses a tree that is not at the round's head", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    w.onFind = () => git(w.wt, "commit", "-q", "--allow-empty", "-m", "a stray commit");
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.ran("land")).toBe(0);
    expect(s.sent().at(-1).body).toContain("stopped at Check did not run");
    expect(s.sent().at(-1).body).toContain("not the round's head");
  }, 120_000);
});

describe("the personal Check refuses what would leave the change's tree", () => {
  const tree = "/home/p/code/app/.codecast/worktrees/change-ct-9";
  const checkout = "/home/p/code/app";
  test("a directory outside the tree, by absolute path, ~ or .., is no directory to run in", () => {
    expect(commandDir(tree, ".")).toBe(tree);
    expect(commandDir(tree, "packages/cli")).toBe(`${tree}/packages/cli`);
    for (const cwd of [checkout, "/tmp", "~", "~/code/app", "..", "../..", "a/../../b"]) expect(commandDir(tree, cwd)).toBeNull();
  });
  test("a command that names the checkout or cds out of the tree is refused; one inside it is not", () => {
    expect(commandEscapes("bun test", tree, tree, checkout)).toBeNull();
    expect(commandEscapes(`bun test ${tree}/src`, tree, tree, checkout)).toBeNull();
    expect(commandEscapes("cd packages/cli && bun test", tree, tree, checkout)).toBeNull();
    expect(commandEscapes(`bash ${checkout}/check.sh`, tree, tree, checkout)).toContain("names the person's checkout");
    for (const run of ["cd .. && make", "cd /tmp; make", "cd && make", "cd ~/code/app && make", "pushd ../.. && make", "make; cd -"]) {
      expect(commandEscapes(run, tree, tree, checkout)).toContain("outside the change's tree");
    }
  });
  test("the home directory's spellings, a quoted cd, cd's flags and the checkout's path on its boundary", () => {
    // Under the real home directory, so ~ and $HOME name it.
    const home = os.homedir();
    const co = `${home}/code/app`;
    const t = `${co}/.codecast/worktrees/change-ct-9`;
    for (const run of [`"$HOME"/code/app/check.sh`, "${HOME}/code/app/check.sh", `cd "$HOME/code/app" && make`, `cd "\${HOME}/code/app"`, "bash ~/code/app/check.sh"]) {
      expect(commandEscapes(run, t, t, co)).toContain("names the person's checkout");
    }
    for (const run of [`bash -c "cd .. && make"`, `sh -c 'cd /tmp; make'`, "cd -- /tmp && make", "cd -P .. && make", "{ cd ..; make; }", "(cd ..; make)", "cd ..&&make", "cd\t..", "x=..; cd $x", "cd`echo ..`"]) {
      expect(commandEscapes(run, t, t, co)).toContain("outside the change's tree");
    }
    expect(commandEscapes(`bun test ${home}/code/app2/x`, t, t, co)).toBeNull();
    expect(commandEscapes(`cd ${t}/sub && make`, t, t, co)).toBeNull();
    expect(commandEscapes("cd -P sub && make", t, t, co)).toBeNull();
  });
  test("found with no command to run is an error, never Skipped; skipped stays Skipped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-check-"));
    try {
      expect(runCheck({ spec: JSON.stringify({ outcome: "found", note: "x", commands: [{ run: "  " }] }), tree: dir, dir })).toContain("named no command");
      expect(runCheck({ spec: JSON.stringify({ outcome: "skipped", note: "nothing documented", commands: [] }), tree: dir, dir })).toEqual({ outcome: "skipped", note: "nothing documented", results: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the session's own uncommitted edits, the Ship button's default", () => {
  test("are frozen onto origin's main, checked, reviewed, landed and deployed, and the checkout caught up", async () => {
    const w = world({ find: FOUND, review: [SHIP], own: true });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toEqual([]);
    expect(JSON.parse(s.result("land")!)).toMatchObject({ outcome: "landed", sha: w.originMain() });
    expect(s.sent().at(-1).body).toContain("is over: Live.");
    // The session's edit is on main and the checkout has nothing uncommitted left of it.
    expectLanded(w);
    expect(git(w.root, "status", "--porcelain", "--", "a.txt")).toBe("");
  }, 120_000);

  test("a red check goes back to the session, which fixes its own edits, and the fix lands", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], own: true, content: "bad\n" });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.ran("round")).toBe(2);
    expect(s.spawned("review")).toHaveLength(2);
    expectLanded(w);
  }, 120_000);

  test("a session that commits and pushes its edits to main itself stops the run: it landed and deployed nothing", async () => {
    const w = world({ find: FOUND, review: [SHIP], own: true, content: "bad\n" });
    w.fix = () => { w.edit("a.txt", "good\n"); w.pushMain(); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.ran("land")).toBe(0);
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(s.sent().at(-1).body).toContain(`stopped at Left the run: ${GONE}`);
  }, 120_000);

  test("a deploy fix outside the repository deploys the run's own landing again, after main moved", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [FAILED, LIVE], own: true });
    w.pushElsewhere();
    w.fix = () => {};
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.ran("round")).toBe(1);
    const [first, second] = s.spawned("deploy").map((d) => /The landed commit: ([0-9a-f]{40})/.exec(d.prompt)![1]);
    expect(second).toBe(first);
    expect(JSON.parse(s.result("after_fix")!)).toMatchObject({ next: "deploy" });
    expect(s.sent().at(-1).body).toContain("is over: Live.");
    expectLanded(w);
  }, 120_000);

  test("a session that reverts its own edits when briefed never reaches Deploy", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], own: true, content: "bad\n" });
    w.fix = () => w.edit("a.txt", "base\n");
    const s = server(w);
    const main = w.originMain();
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(w.originMain()).toBe(main);
    expect(s.sent().at(-1).body).toContain(`stopped at Left the run: ${GONE}`);
  }, 120_000);
});

describe("a person's checkout that is a linked worktree", () => {
  test("the run's baseline, its unpushed check and Land read that worktree, never the main one", async () => {
    const base = path.join(sandbox, "linked");
    const origin = path.join(base, "origin.git");
    const main = path.join(base, "main");
    const linked = path.join(base, "linked-wt");
    const state = path.join(base, "state");
    fs.mkdirSync(state, { recursive: true });
    process.env.FAKE_STATE = state;
    fs.writeFileSync(path.join(state, "calls.log"), "");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    fs.mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(main, "a.txt"), "base\n");
    fs.appendFileSync(path.join(main, ".git", "info", "exclude"), ".codecast/worktrees/\n");
    git(main, "add", "-A");
    git(main, "commit", "-qm", "base");
    git(main, "remote", "add", "origin", origin);
    git(main, "push", "-q", "-u", "origin", "main");
    // The person works in a linked worktree on its own branch; the run's tree hangs off it.
    git(main, "worktree", "add", "-q", "-b", "work", linked, "origin/main");
    git(main, "branch", "-q", "change", "origin/main");
    const wt = path.join(linked, ".codecast", "worktrees", "change-ct-9");
    git(main, "worktree", "add", "-q", wt, "change");
    fs.writeFileSync(path.join(wt, "a.txt"), "good\n");
    git(wt, "commit", "-qam", "the change");
    process.env.FAKE_WT = wt;
    const runDir = path.join(base, "run");
    fs.mkdirSync(runDir);
    writeFrozenChange(runDir, { source: "session", session: "s", conversation: CONV, base: "", tip: git(wt, "rev-parse", "HEAD"), branch: "change", worktree: "change-ct-9", paths: ["a.txt"], shared: [], held: [] });
    const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.personal);
    const ctx: Record<string, string> = { run_dir: runDir, run_id: "run-9", default_branch: "main", worktree: "change-ct-9", branch: "change" };
    const station = async (id: string) => {
      ctx["station_id"] = id;
      const log = console.log;
      console.log = () => {};
      try { return await executeCommand(graph.nodes.get(id)!, ctx, linked); } finally { console.log = log; }
    };
    expect(await station("round")).toBe("success");
    expect(fs.readFileSync(path.join(runDir, "checkout-run-9"), "utf-8").trim()).toBe(git(linked, "rev-parse", "HEAD"));
    // Land levels nothing in the main worktree and names the linked one, which is on its own branch.
    const mainHead = git(main, "rev-parse", "HEAD");
    expect(await station("land")).toBe("success");
    expect(JSON.parse(ctx["land.output"]).note).toContain(`${linked} is on work, not main`);
    expect(git(main, "rev-parse", "HEAD")).toBe(mainHead);
    // A commit the person's session makes in the linked worktree is what Fix not shipped counts; the main one's are not.
    fs.writeFileSync(path.join(main, "elsewhere.txt"), "x\n");
    git(main, "add", "elsewhere.txt");
    git(main, "commit", "-qm", "in the main worktree");
    ctx["last_error"] = "Could not freeze";
    expect(await station("committed")).toBe("failure");
    fs.writeFileSync(path.join(linked, "fix.txt"), "x\n");
    git(linked, "add", "fix.txt");
    git(linked, "commit", "-qm", "the session's fix");
    expect(await station("committed")).toBe("success");
    expect(JSON.parse(ctx["committed.output"])).toMatchObject({ next: "unpushed" });
    expect(JSON.parse(ctx["committed.output"]).note).toStartWith("1 commit(s) made in your checkout since this run began");
    expect(JSON.parse(ctx["committed.output"]).note).toContain(`(\`git reset --soft ${git(linked, "rev-parse", "HEAD~1").slice(0, 12)}\`)`);
    // With no baseline to name, the advice resets to origin's and says what else that uncommits.
    fs.rmSync(path.join(runDir, "checkout-run-9"));
    expect(await station("committed")).toBe("success");
    expect(JSON.parse(ctx["committed.output"]).note).toContain("(`git reset --soft origin/main`; this also uncommits any earlier unpushed commits)");
  }, 120_000);
});
