// End to end (flows.md FL4, ct-99118): on a branch, task or pull request run, what the session leaves in the run's
// worktree goes on the branch as origin has it now, through the real PR station's pushes, and nothing origin held
// is replayed.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultExec, type Exec } from "../lineMerge";
import { refreezeSessionChange, snapshotRunTree, writeFrozenChange } from "./flowChange";
import { readFrozenChange } from "./flowChangeFile";
import { prStation, rebasePr } from "./prStation";
import { ENV, git, sandbox, useSandbox, write } from "./carry.testkit";

useSandbox();

// git stamped with the time now: the reflog dates its entries by the committer date, which `git` sets an hour back.
const gitNow = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV } });

describe("a branch's carry", () => {
  /** Origin with main and `branch` at one base commit, this checkout's run worktree on `branch`, and another clone on it. */
  function originWorld(name: string, branch = "feat") {
    const origin = path.join(sandbox, `origin-${name}.git`);
    const here = path.join(sandbox, `here-${name}`);
    const there = path.join(sandbox, `there-${name}`);
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "--quiet", origin, here], { env: { ...process.env, ...ENV } });
    write(here, "a.txt", "a\n");
    write(here, "package.json", "{}\n");
    write(here, "bun.lock", "lock 1\n");
    git(here, "add", "-A");
    git(here, "commit", "--quiet", "-m", "base");
    git(here, "push", "--quiet", "origin", "HEAD:refs/heads/main", `HEAD:refs/heads/${branch}`);
    git(here, "fetch", "--quiet", "origin");
    git(here, "branch", branch, `origin/${branch}`);
    const worktree = path.join(sandbox, `run-wt-${name}`);
    git(here, "worktree", "add", "--quiet", worktree, branch);
    execFileSync("git", ["clone", "--quiet", "--branch", branch, origin, there], { env: { ...process.env, ...ENV } });
    const runDir = path.join(sandbox, `run-dir-${name}`);
    // The run starts on the branch as it stands: its recorded base is its head then, and origin's tip is that too.
    const start = () => {
      const tip = git(here, "rev-parse", branch);
      writeFrozenChange(runDir, { source: "task", session: "jx7aaaa", base: tip, tip, remote_tip: git(origin, "rev-parse", branch), branch, worktree: `run-wt-${name}`, paths: [], shared: [], held: [] } as any);
      return tip;
    };
    const push = (file: string, text: string, msg: string) => {
      write(there, file, text);
      git(there, "add", file);
      git(there, "commit", "--quiet", "-m", msg);
      git(there, "push", "--quiet", "origin", branch);
      return git(there, "rev-parse", "HEAD");
    };
    return { origin, here, there, worktree, runDir, start, push };
  }

  test("an edit left uncommitted in the run's worktree goes on a tip pushed from elsewhere, here only, and stays through the next fix pushed there; a conflict refuses (ct-99118)", async () => {
    const { origin, here, worktree, runDir, start, push } = originWorld("carry");
    start();
    await snapshotRunTree(worktree, runDir);
    write(worktree, "b.txt", "left here\n");
    const pushed = push("a.txt", "pushed there\n", "fix there");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(git(here, "rev-parse", `${change.tip}^`)).toBe(pushed);
    expect([git(here, "show", `${change.tip}:a.txt`), git(here, "show", `${change.tip}:b.txt`)]).toEqual(["pushed there", "left here"]);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(change.tip);
    // The refreeze pushes nothing: the run's PR station pushes the branch.
    expect(git(origin, "rev-parse", "feat")).toBe(pushed);

    // The next fix is pushed from elsewhere on origin's tip, which lacks the carry: the carry goes on top of it again.
    const again = push("a.txt", "fixed again there\n", "fix again there");
    await snapshotRunTree(worktree, runDir);
    const second = (await refreezeSessionChange(here, runDir, worktree)).change;
    expect(git(here, "rev-parse", `${second.tip}^`)).toBe(again);
    expect([git(here, "show", `${second.tip}:a.txt`), git(here, "show", `${second.tip}:b.txt`)]).toEqual(["fixed again there", "left here"]);
    expect(fs.readFileSync(path.join(worktree, "b.txt"), "utf-8")).toBe("left here\n");

    // Elsewhere b.txt is written otherwise and pushed, while another edit to it waits here: nothing moves.
    await snapshotRunTree(worktree, runDir);
    write(worktree, "b.txt", "left here again\n");
    const theirs = push("b.txt", "pushed b\n", "b there");
    await expect(refreezeSessionChange(here, runDir, worktree)).rejects.toThrow(/conflict with origin's feat/);
    expect(git(here, "rev-parse", "feat")).toBe(second.tip);
    expect(git(origin, "rev-parse", "feat")).toBe(theirs);
    expect(readFrozenChange(runDir)?.tip).toBe(second.tip);
    expect(fs.readFileSync(path.join(worktree, "b.txt"), "utf-8")).toBe("left here again\n");
  }, 180_000);

  test("another clone's push between rounds goes under the session's commit and carry (ct-99118)", async () => {
    const { origin, here, worktree, runDir, start, push } = originWorld("under");
    start();
    const theirs = push("y.txt", "another clone\n", "y there");
    await snapshotRunTree(worktree, runDir);
    // The session commits one fix in the worktree and leaves another uncommitted.
    write(worktree, "x.txt", "committed here\n");
    git(worktree, "add", "x.txt");
    git(worktree, "commit", "--quiet", "-m", "x here");
    write(worktree, "z.txt", "left here\n");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(git(here, "merge-base", "--is-ancestor", theirs, change.tip)).toBe("");
    expect(["x.txt", "y.txt", "z.txt"].map((f) => git(here, "show", `${change.tip}:${f}`))).toEqual(["committed here", "another clone", "left here"]);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(change.tip);
    expect(git(origin, "rev-parse", "feat")).toBe(theirs);
  }, 180_000);

  test("a commit a force-push took off origin is not brought back by the replay (ct-99118)", async () => {
    const { origin, here, there, worktree, runDir, start } = originWorld("force");
    // The branch held x.txt, here and on origin, when the run last froze it.
    write(worktree, "x.txt", "taken off later\n");
    git(worktree, "add", "x.txt");
    git(worktree, "commit", "--quiet", "-m", "x");
    git(worktree, "push", "--quiet", "origin", "feat");
    start();
    // Elsewhere the branch is rebuilt without it and force-pushed.
    git(there, "fetch", "--quiet", "origin");
    git(there, "reset", "--quiet", "--hard", "origin/main");
    write(there, "y.txt", "rebuilt\n");
    git(there, "add", "y.txt");
    git(there, "commit", "--quiet", "-m", "y");
    git(there, "push", "--quiet", "--force", "origin", "feat");
    const rebuilt = git(origin, "rev-parse", "feat");
    // Here the session commits one fix in the worktree and leaves another uncommitted.
    await snapshotRunTree(worktree, runDir);
    write(worktree, "w.txt", "committed here\n");
    git(worktree, "add", "w.txt");
    git(worktree, "commit", "--quiet", "-m", "w here");
    write(worktree, "z.txt", "left here\n");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(git(here, "merge-base", "--is-ancestor", rebuilt, change.tip)).toBe("");
    expect(git(here, "ls-tree", "--name-only", change.tip, "--", "x.txt")).toBe("");
    expect([git(here, "show", `${change.tip}:w.txt`), git(here, "show", `${change.tip}:z.txt`)]).toEqual(["committed here", "left here"]);
    expect(git(origin, "rev-parse", "feat")).toBe(rebuilt);
  }, 180_000);

  test("a file the session committed on a branch is its own push: the refreeze takes it with the carry, credential name or not (ct-99118)", async () => {
    const { here, worktree, runDir, start } = originWorld("own");
    start();
    await snapshotRunTree(worktree, runDir);
    write(worktree, ".env.local", "KEY=1\n");
    git(worktree, "add", ".env.local");
    git(worktree, "commit", "--quiet", "-m", "local env");
    write(worktree, "b.txt", "left here\n");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect([git(here, "show", `${change.tip}:.env.local`), git(here, "show", `${change.tip}:b.txt`)]).toEqual(["KEY=1", "left here"]);
  }, 180_000);

  test("a lockfile regenerated for the branch's own manifest edit, made before the run, is carried (ct-99118)", async () => {
    const { here, worktree, runDir, start } = originWorld("lock");
    write(worktree, "package.json", "{\"dependencies\":{\"y\":\"1\"}}\n");
    git(worktree, "commit", "--quiet", "-am", "add y");
    git(worktree, "push", "--quiet", "origin", "feat");
    start();
    await snapshotRunTree(worktree, runDir);
    write(worktree, "bun.lock", "lock 2\n");
    const { change, held } = await refreezeSessionChange(here, runDir, worktree);
    expect(held).toEqual([]);
    expect(git(here, "show", `${change.tip}:bun.lock`)).toBe("lock 2");
  }, 180_000);

  test("the session's own commits here, from earlier rounds or unpushed at the run's start, go on origin's new tip with the carry (ct-99118)", async () => {
    const { origin, here, worktree, runDir, start, push } = originWorld("own-earlier");
    // A commit here that origin never had when the run started.
    write(worktree, "u.txt", "unpushed at start\n");
    git(worktree, "add", "u.txt");
    git(worktree, "commit", "--quiet", "-m", "u");
    start();
    // Round one: the session commits x.txt in the worktree and leaves y.txt; origin is where it was.
    await snapshotRunTree(worktree, runDir);
    write(worktree, "x.txt", "committed here\n");
    git(worktree, "add", "x.txt");
    git(worktree, "commit", "--quiet", "-m", "x");
    write(worktree, "y.txt", "left here\n");
    await refreezeSessionChange(here, runDir, worktree);
    // Round two: a fix is pushed from elsewhere, and the session leaves z.txt.
    const theirs = push("a.txt", "fixed there\n", "fix there");
    await snapshotRunTree(worktree, runDir);
    write(worktree, "z.txt", "left again\n");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(git(here, "merge-base", "--is-ancestor", theirs, change.tip)).toBe("");
    expect(["a.txt", "u.txt", "x.txt", "y.txt", "z.txt"].map((f) => git(here, "show", `${change.tip}:${f}`))).toEqual(["fixed there", "unpushed at start", "committed here", "left here", "left again"]);
    expect(git(origin, "rev-parse", "feat")).toBe(theirs);
  }, 180_000);

  test("a branch rebased here off what origin held at the last freeze refuses once origin moves, and nothing moves (ct-99118)", async () => {
    const { here, there, worktree, runDir, start, push } = originWorld("rebased");
    // The branch's own commit, on origin too.
    write(worktree, "f.txt", "the branch's own\n");
    git(worktree, "add", "f.txt");
    git(worktree, "commit", "--quiet", "-m", "f");
    git(worktree, "push", "--quiet", "origin", "feat");
    git(there, "pull", "--quiet", "--ff-only");
    start();
    // Main moves on; the session rebases the branch onto it in the worktree and leaves an edit.
    git(here, "checkout", "--quiet", "--detach", "origin/main");
    write(here, "m.txt", "main moved\n");
    git(here, "add", "m.txt");
    git(here, "commit", "--quiet", "-m", "main moves");
    git(here, "push", "--quiet", "origin", "HEAD:main");
    git(worktree, "fetch", "--quiet", "origin");
    await snapshotRunTree(worktree, runDir);
    git(worktree, "rebase", "--quiet", "origin/main");
    write(worktree, "b.txt", "left here\n");
    const first = (await refreezeSessionChange(here, runDir, worktree)).change;
    expect(git(here, "show", `${first.tip}:m.txt`)).toBe("main moved");
    // Then a fix is pushed from elsewhere on origin's old branch.
    push("a.txt", "fixed there\n", "fix there");
    await snapshotRunTree(worktree, runDir);
    await expect(refreezeSessionChange(here, runDir, worktree)).rejects.toThrow(/sits on nothing origin is known to have held/);
    expect(git(here, "rev-parse", "feat")).toBe(first.tip);
    expect(readFrozenChange(runDir)?.tip).toBe(first.tip);
  }, 180_000);

  /** The change flow's PR station, run for real against origin, with a `gh` that knows one open pull request. */
  function prPush(here: string, runDir: string, branch = "feat") {
    const bin = path.join(sandbox, "fake-gh-bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho '[{"number":41,"url":"https://github.com/acme/app/pull/41"}]'\n`, { mode: 0o755 });
    const exec: Exec = (cmd, args, cwd, extra) => defaultExec(cmd, args, cwd, { PATH: `${bin}:${process.env.PATH}`, ...ENV, ...extra });
    const r = prStation({ cwd: here, dir: runDir, branch, base: "main", exec });
    if (!r.ok) throw new Error(r.reason);
    return { head: r.pr.head_sha, exec };
  }

  test("the PR station pushes a carry between two refreezes; a fix pushed on top of it from elsewhere comes back with no false conflict (ct-99118)", async () => {
    const { origin, here, there, worktree, runDir, start } = originWorld("pr-push");
    start();
    await snapshotRunTree(worktree, runDir);
    write(worktree, "a.txt", "carried\n");
    const first = (await refreezeSessionChange(here, runDir, worktree)).change;
    expect(prPush(here, runDir).head).toBe(first.tip);
    expect(git(origin, "rev-parse", "feat")).toBe(first.tip);
    // The session's next fix, pushed from elsewhere on top of what the PR station pushed, edits the same lines.
    git(there, "pull", "--quiet", "--ff-only");
    write(there, "a.txt", "fixed there on top\n");
    git(there, "commit", "--quiet", "-am", "fix there");
    git(there, "push", "--quiet", "origin", "feat");
    const theirs = git(there, "rev-parse", "HEAD");
    await snapshotRunTree(worktree, runDir);
    write(worktree, "b.txt", "carried again\n");
    const second = (await refreezeSessionChange(here, runDir, worktree)).change;
    expect(git(here, "rev-parse", `${second.tip}^`)).toBe(theirs);
    expect([git(here, "show", `${second.tip}:a.txt`), git(here, "show", `${second.tip}:b.txt`)]).toEqual(["fixed there on top", "carried again"]);
    // The next round's push goes up as a fast forward.
    expect(prPush(here, runDir).head).toBe(second.tip);
  }, 180_000);

  test("a carry the PR station pushed, rewound off origin elsewhere, stays off, and the next PR push does not send it again (ct-99118)", async () => {
    const { origin, here, there, worktree, runDir, start } = originWorld("pr-rewind");
    start();
    await snapshotRunTree(worktree, runDir);
    write(worktree, "debug.txt", "debug\n");
    const first = (await refreezeSessionChange(here, runDir, worktree)).change;
    prPush(here, runDir);
    expect(git(origin, "rev-parse", "feat")).toBe(first.tip);
    // Elsewhere: reset --hard HEAD~1 and force-push.
    git(there, "fetch", "--quiet", "origin");
    git(there, "reset", "--quiet", "--hard", "origin/feat~1");
    git(there, "push", "--quiet", "--force", "origin", "feat");
    const rewound = git(origin, "rev-parse", "feat");
    await snapshotRunTree(worktree, runDir);
    write(worktree, "z.txt", "left here\n");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(git(here, "rev-parse", `${change.tip}^`)).toBe(rewound);
    expect(git(here, "ls-tree", "--name-only", change.tip, "--", "debug.txt")).toBe("");
    expect(git(here, "show", `${change.tip}:z.txt`)).toBe("left here");
    prPush(here, runDir);
    expect(git(origin, "ls-tree", "--name-only", "feat", "--", "debug.txt")).toBe("");
  }, 180_000);

  test("commits origin already holds are not replayed: a fix pulled into the worktree and redone on top gives no false conflict (ct-99118)", async () => {
    const { here, worktree, runDir, start, push } = originWorld("held-twice");
    start();
    prPush(here, runDir);
    const f1 = push("a.txt", "v1\n", "f1 there");
    // The session pulls F1 into the worktree and redoes the next fix there, which elsewhere is pushed as G.
    git(worktree, "pull", "--quiet", "--ff-only", "origin", "feat");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(f1);
    const g = push("a.txt", "v2\n", "g there");
    await snapshotRunTree(worktree, runDir);
    write(worktree, "a.txt", "v2\n");
    git(worktree, "commit", "--quiet", "-am", "f2 here");
    write(worktree, "b.txt", "left here\n");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(git(here, "merge-base", "--is-ancestor", g, change.tip)).toBe("");
    expect([git(here, "show", `${change.tip}:a.txt`), git(here, "show", `${change.tip}:b.txt`)]).toEqual(["v2", "left here"]);
  }, 180_000);

  test("a commit the branch held at the run's start, rewound off origin before the run, stays: a fetch from before the last freeze is no news (ct-99118)", async () => {
    const { origin, here, there, worktree, runDir, start } = originWorld("before-run");
    write(worktree, "x.txt", "held at start\n");
    git(worktree, "add", "x.txt");
    git(worktree, "commit", "--quiet", "-m", "x");
    gitNow(worktree, "push", "--quiet", "origin", "feat");
    const x = git(here, "rev-parse", "feat");
    // Before the run, origin is rewound off it; this checkout fetched both.
    git(there, "fetch", "--quiet", "origin");
    git(there, "reset", "--quiet", "--hard", "origin/feat~1");
    git(there, "push", "--quiet", "--force", "origin", "feat");
    gitNow(here, "fetch", "--quiet", "origin");
    // The reflog stamps whole seconds: the run starts in a later one.
    await Bun.sleep(1_100);
    start();
    expect(readFrozenChange(runDir)?.remote_tip).toBe(git(origin, "rev-parse", "feat"));
    await snapshotRunTree(worktree, runDir);
    write(worktree, "z.txt", "left here\n");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(git(here, "rev-parse", `${change.tip}^`)).toBe(x);
    expect([git(here, "show", `${change.tip}:x.txt`), git(here, "show", `${change.tip}:z.txt`)]).toEqual(["held at start", "left here"]);
  }, 180_000);

  test("a commit pulled into the worktree, then force-pushed off origin, stays off (ct-99118)", async () => {
    const { here, there, worktree, runDir, start, push } = originWorld("pulled-away");
    const r0 = start();
    prPush(here, runDir);
    push("debug.txt", "debug\n", "debug there");
    gitNow(worktree, "pull", "--quiet", "--ff-only", "origin", "feat");
    // Elsewhere the debug commit is dropped and force-pushed.
    git(there, "reset", "--quiet", "--hard", r0);
    write(there, "clean.txt", "clean\n");
    git(there, "add", "clean.txt");
    git(there, "commit", "--quiet", "-m", "clean");
    git(there, "push", "--quiet", "--force", "origin", "feat");
    const clean = git(there, "rev-parse", "HEAD");
    await snapshotRunTree(worktree, runDir);
    write(worktree, "z.txt", "left here\n");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(git(here, "rev-parse", `${change.tip}^`)).toBe(clean);
    expect(git(here, "ls-tree", "--name-only", change.tip, "--", "debug.txt")).toBe("");
    expect(git(here, "show", `${change.tip}:z.txt`)).toBe("left here");
  }, 180_000);

  test("a commit unpushed at the run's start that the PR station pushed, then force-pushed away elsewhere, stays away (ct-99118)", async () => {
    const { here, there, worktree, runDir, start } = originWorld("pr-unpushed");
    const r0 = git(here, "rev-parse", "feat");
    write(worktree, "secret.txt", "oops\n");
    git(worktree, "add", "secret.txt");
    git(worktree, "commit", "--quiet", "-m", "u with secret");
    start();
    prPush(here, runDir);
    git(there, "fetch", "--quiet", "origin");
    git(there, "reset", "--quiet", "--hard", r0);
    write(there, "clean.txt", "clean\n");
    git(there, "add", "clean.txt");
    git(there, "commit", "--quiet", "-m", "clean rebuild");
    git(there, "push", "--quiet", "--force", "origin", "feat");
    const rebuilt = git(there, "rev-parse", "HEAD");
    await snapshotRunTree(worktree, runDir);
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(change.tip).toBe(rebuilt);
    expect(git(here, "ls-tree", "--name-only", change.tip, "--", "secret.txt")).toBe("");
  }, 180_000);

  test("an earlier carry the PR station pushed, then force-pushed away elsewhere, stays away (ct-99118)", async () => {
    const { here, there, worktree, runDir, start } = originWorld("pr-carry-away");
    const r0 = start();
    await snapshotRunTree(worktree, runDir);
    write(worktree, "debug.txt", "debug\n");
    await refreezeSessionChange(here, runDir, worktree);
    prPush(here, runDir);
    git(there, "fetch", "--quiet", "origin");
    git(there, "reset", "--quiet", "--hard", r0);
    write(there, "clean.txt", "clean\n");
    git(there, "add", "clean.txt");
    git(there, "commit", "--quiet", "-m", "clean rebuild");
    git(there, "push", "--quiet", "--force", "origin", "feat");
    await snapshotRunTree(worktree, runDir);
    write(worktree, "z.txt", "left here\n");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(git(here, "ls-tree", "--name-only", change.tip, "--", "debug.txt")).toBe("");
    expect(git(here, "show", `${change.tip}:z.txt`)).toBe("left here");
  }, 180_000);

  test("a branch local-only at the last freeze keeps its carry when the branch is then pushed from another clone (ct-99118)", async () => {
    const { origin, here, worktree, runDir } = originWorld("solo", "loc");
    git(worktree, "checkout", "--quiet", "-b", "solo");
    write(worktree, "u.txt", "u\n");
    git(worktree, "add", "u.txt");
    git(worktree, "commit", "--quiet", "-m", "u");
    const u = git(here, "rev-parse", "solo");
    writeFrozenChange(runDir, { source: "task", session: "jx7aaaa", base: u, tip: u, branch: "solo", worktree: "run-wt-solo", paths: [], shared: [], held: [] } as any);
    await snapshotRunTree(worktree, runDir);
    write(worktree, "c1.txt", "carried round 1\n");
    const first = (await refreezeSessionChange(here, runDir, worktree)).change;
    expect(first.remote_tip).toBeUndefined();
    const other = path.join(sandbox, "other-solo");
    execFileSync("git", ["clone", "--quiet", here, other], { env: { ...process.env, ...ENV } });
    git(other, "checkout", "--quiet", "-b", "solo", u);
    write(other, "f.txt", "f\n");
    git(other, "add", "f.txt");
    git(other, "commit", "--quiet", "-m", "f");
    git(other, "push", "--quiet", origin, "solo");
    await snapshotRunTree(worktree, runDir);
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect([git(here, "show", `${change.tip}:c1.txt`), git(here, "show", `${change.tip}:f.txt`)]).toEqual(["carried round 1", "f"]);
    expect(fs.existsSync(path.join(worktree, "c1.txt"))).toBe(true);
  }, 180_000);

  test("the run's own onto-main rebase, pushed by the PR station, is not replayed onto its rebased copy (ct-99118)", async () => {
    const { origin, here, there, worktree, runDir, start } = originWorld("pr-rebase");
    write(worktree, "a.txt", "b\n");
    git(worktree, "commit", "--quiet", "-am", "u1");
    write(worktree, "a.txt", "c\n");
    git(worktree, "commit", "--quiet", "-am", "u2");
    start();
    const { exec } = prPush(here, runDir);
    // Main moves, and the PR station rebases origin's branch onto it and pushes; the branch here lags.
    git(there, "fetch", "--quiet", "origin");
    git(there, "checkout", "--quiet", "-B", "m", "origin/main");
    write(there, "m.txt", "m\n");
    git(there, "add", "m.txt");
    git(there, "commit", "--quiet", "-m", "main moves");
    git(there, "push", "--quiet", "origin", "HEAD:main");
    const rebased = await rebasePr({ cwd: here, dir: runDir, base: "main", runId: "run-1", post: async () => ({}), exec });
    if (!rebased.ok) throw new Error(rebased.reason);
    expect(git(origin, "rev-parse", "feat")).toBe(rebased.pr.head_sha);
    await snapshotRunTree(worktree, runDir);
    write(worktree, "z.txt", "left here\n");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(git(here, "rev-parse", `${change.tip}^`)).toBe(rebased.pr.head_sha);
    expect([git(here, "show", `${change.tip}:a.txt`), git(here, "show", `${change.tip}:m.txt`), git(here, "show", `${change.tip}:z.txt`)]).toEqual(["c", "m", "left here"]);
  }, 180_000);

  test("a reset that fails partway says the worktree may be partly reset, and keeps the session's edits in a commit (ct-99118)", async () => {
    const { here, there, worktree, runDir, start } = originWorld("partial");
    write(worktree, "ro/k.txt", "k\n");
    git(worktree, "add", "ro/k.txt");
    git(worktree, "commit", "--quiet", "-m", "ro");
    git(worktree, "push", "--quiet", "origin", "feat");
    git(there, "pull", "--quiet", "--ff-only");
    const tip = start();
    write(there, "a.txt", "theirs a\n");
    write(there, "ro/k.txt", "k2\n");
    git(there, "commit", "--quiet", "-am", "theirs");
    git(there, "push", "--quiet", "origin", "feat");
    await snapshotRunTree(worktree, runDir);
    write(worktree, "b.txt", "mine\n");
    fs.chmodSync(path.join(worktree, "ro"), 0o555);
    let said = "";
    try { await refreezeSessionChange(here, runDir, worktree); } catch (err) { said = (err as Error).message; }
    fs.chmodSync(path.join(worktree, "ro"), 0o755);
    expect(said).toContain("The worktree may be partly reset");
    expect(said).not.toContain("nothing moved");
    expect(git(here, "rev-parse", "feat")).toBe(tip);
    expect(readFrozenChange(runDir)?.tip).toBe(tip);
    const kept = /kept in commit (\w+)/.exec(said)![1];
    expect(git(here, "show", `${kept}:b.txt`)).toBe("mine");
  }, 180_000);

  test("a run worktree taken off the change's branch refuses and is left as it is (ct-99118)", async () => {
    const { here, worktree, runDir, start } = originWorld("off");
    const tip = start();
    git(worktree, "checkout", "--quiet", "-b", "elsewhere");
    await expect(refreezeSessionChange(here, runDir, worktree)).rejects.toThrow(/not the change's branch feat/);
    expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("elsewhere");
    expect(git(here, "rev-parse", "feat")).toBe(tip);
  }, 180_000);

  // ct-102179: Union's PR station moved the run's worktree onto origin's rebased copy without a freeze, then the
  // session rebased and force-pushed again from its own checkout. The refreeze kept the worktree's stale copy, so the
  // next PR station found origin holding commits the run never had and stopped the run.
  test("a worktree moved onto origin's earlier tip follows origin when the session rewrites the branch again (ct-102179)", async () => {
    const { origin, here, there, worktree, runDir } = originWorld("rewritten-twice");
    write(worktree, "a.txt", "mine\n");
    git(worktree, "commit", "--quiet", "-am", "the change");
    git(worktree, "push", "--quiet", "origin", "feat");
    const tip = git(worktree, "rev-parse", "HEAD");
    writeFrozenChange(runDir, { source: "task", session: "jx7aaaa", base: tip, tip, remote_tip: tip, branch: "feat", worktree: "run-wt-rewritten-twice", paths: ["a.txt"], shared: [], held: [] } as any);
    const rewrite = (msg: string) => {
      git(there, "fetch", "--quiet", "origin");
      git(there, "reset", "--quiet", "--hard", "origin/feat");
      git(there, "commit", "--quiet", "--amend", "-m", msg);
      git(there, "push", "--quiet", "--force", "origin", "feat");
      return git(there, "rev-parse", "HEAD");
    };
    // The PR station's move: fetch origin's rewritten tip and stand the worktree on it; change.json still names `tip`.
    const first = rewrite("the change, rebased");
    gitNow(here, "fetch", "--quiet", "origin", "+refs/heads/feat:refs/remotes/origin/feat");
    git(worktree, "reset", "--quiet", "--keep", first);
    const second = rewrite("the change, rebased again");
    await snapshotRunTree(worktree, runDir);
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(change.tip).toBe(second);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(second);
    expect(git(origin, "rev-parse", "feat")).toBe(second);
  }, 180_000);

  // PR #303 review: a session that drops a commit already pushed (reset --hard HEAD~1) means it; origin's copy, which
  // still holds the dropped commit, must not bring it back.
  test("a worktree rewound off a commit origin holds stays rewound (ct-102179)", async () => {
    const { origin, here, worktree, runDir } = originWorld("rewound");
    const base = git(worktree, "rev-parse", "HEAD");
    write(worktree, "a.txt", "dropped later\n");
    git(worktree, "commit", "--quiet", "-am", "a commit the session drops");
    git(worktree, "push", "--quiet", "origin", "feat");
    const pushed = git(worktree, "rev-parse", "HEAD");
    writeFrozenChange(runDir, { source: "task", session: "jx7aaaa", base: pushed, tip: pushed, remote_tip: pushed, branch: "feat", worktree: "run-wt-rewound", paths: ["a.txt"], shared: [], held: [] } as any);
    git(worktree, "reset", "--quiet", "--hard", "HEAD~1");
    await snapshotRunTree(worktree, runDir);
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(change.tip).toBe(base);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(base);
    expect(git(origin, "rev-parse", "feat")).toBe(pushed);
  }, 180_000);

  test("a worktree rewritten here, which origin never held, stays the change though origin moved (ct-102179)", async () => {
    const { here, worktree, runDir, start, push } = originWorld("rewritten-here");
    start();
    push("a.txt", "pushed there\n", "fix there");
    write(worktree, "a.txt", "rewritten here\n");
    git(worktree, "commit", "--quiet", "--amend", "-am", "base, rewritten here");
    const mine = git(worktree, "rev-parse", "HEAD");
    await snapshotRunTree(worktree, runDir);
    expect((await refreezeSessionChange(here, runDir, worktree)).change.tip).toBe(mine);
  }, 180_000);
});
