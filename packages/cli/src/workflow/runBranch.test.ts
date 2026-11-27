import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claimRunBranch, YOUNG_TREE_MS, type RunLiveness } from "./runBranch.js";
import { lineRunDir } from "./runner.js";
import { writeFrozenChange, writePlacedChange, type FrozenChange } from "./flowChangeFile.js";

// Real git: what matters is which worktree git says holds the branch, and that nothing on it or in it moves on a refusal.
let repo: string;
let savedDir: string | undefined;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const OURS = "change-ct-1";
const BRANCH = `codecast/${OURS}`;
const OTHER = "change-ct-2";
const treeOf = (name: string) => path.join(repo, ".codecast", "worktrees", name);
/** Runs live on this machine by tree, and the task runs the server holds as live. */
const live = (trees: Record<string, string> = {}, tasks: Record<string, string> = {}): RunLiveness => ({
  trees: async () => new Map(Object.entries(trees)),
  taskRun: async (task) => tasks[task] ?? null,
});
/** After a tree made now has stopped being young. */
const later = () => Date.now() + YOUNG_TREE_MS + 60_000;
const frozen = (tip: string): FrozenChange => ({ source: "session", base: git(repo, "rev-parse", "main"), tip, branch: BRANCH, worktree: OURS, paths: ["a.txt"], shared: [], held: [] });
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-branch-")));
  savedDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = path.join(repo, "host-state");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".codecast/\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  // The task's branch, holding a committed change.
  git(repo, "branch", BRANCH);
  git(repo, "worktree", "add", "-q", path.join(repo, "scratch"), BRANCH);
  fs.writeFileSync(path.join(repo, "scratch", "a.txt"), "the reviewed change\n");
  git(path.join(repo, "scratch"), "commit", "-qam", "the reviewed change");
  git(repo, "worktree", "remove", "--force", path.join(repo, "scratch"));
});

afterEach(() => {
  try { git(repo, "worktree", "prune"); } catch {}
  fs.rmSync(repo, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = savedDir;
});

/** A run's worktree `name` with `BRANCH` checked out, as `cast flow run --branch` makes it. */
async function runTreeOn(name: string): Promise<void> {
  const { acquireWorkspace } = await import("../workspace/lifecycle.js");
  await acquireWorkspace(repo, name, { branch: BRANCH, skipPool: true, skipSetup: true, skipHooks: true, noPorts: true });
  fs.mkdirSync(lineRunDir(repo, name), { recursive: true });
}

describe("another run's worktree holding the branch (ct-98893)", () => {
  test("a freeze refuses while a live run's worktree has the branch, and moves nothing", async () => {
    await runTreeOn(OTHER);
    const tip = git(repo, "rev-parse", BRANCH);
    await expect(claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, live: live({ [OTHER]: "paused" }), now: later() }))
      .rejects.toThrow(`${BRANCH} is checked out by worktree ${OTHER}, where a run is live (paused)`);
    expect(git(repo, "rev-parse", BRANCH)).toBe(tip);
    expect(fs.existsSync(treeOf(OTHER))).toBe(true);
  });

  test("so does a run of the branch as it stands, and a task not made yet", async () => {
    await runTreeOn(OTHER);
    await expect(claimRunBranch(repo, null, BRANCH, { rewrites: false, live: live({ [OTHER]: "running" }), now: later() }))
      .rejects.toThrow("where a run is live (running)");
  });

  // A second `cast flow run --branch` seconds after the first: its run may not be listed yet, pending or not made.
  test("a worktree made moments ago is taken for a run on its way, whatever the server lists", async () => {
    await runTreeOn(OTHER);
    await expect(claimRunBranch(repo, null, BRANCH, { rewrites: false, live: live() }))
      .rejects.toThrow("where a run is live (just made)");
    expect(fs.existsSync(treeOf(OTHER))).toBe(true);
  });

  test("when whether that run is live cannot be told, it refuses rather than guess", async () => {
    await runTreeOn(OTHER);
    const unread: RunLiveness = { trees: async () => null, taskRun: async () => null };
    await expect(claimRunBranch(repo, null, BRANCH, { rewrites: false, live: unread, now: later() })).rejects.toThrow("cannot be told");
  });

  test("an ended run's clean worktree is released, the branch left as it was, and the branch checks out again", async () => {
    await runTreeOn(OTHER);
    const tip = git(repo, "rev-parse", BRANCH);
    const notice = await quiet(() => claimRunBranch(repo, "change-ct-3", BRANCH, { task: "ct-3", rewrites: false, live: live(), now: later() }));
    expect(notice).toBe(`Released worktree ${OTHER}, which an ended run left holding ${BRANCH}`);
    expect(fs.existsSync(treeOf(OTHER))).toBe(false);
    expect(git(repo, "rev-parse", BRANCH)).toBe(tip);
    const { acquireWorkspace } = await import("../workspace/lifecycle.js");
    const ws = await acquireWorkspace(repo, "change-ct-3", { branch: BRANCH, skipPool: true, skipSetup: true, skipHooks: true, noPorts: true });
    expect(git(ws.workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
  }, 60_000);

  // H1: the leftovers were committed onto the branch and the tree trashed, then the freeze refused on that very commit.
  test("an ended run's worktree with uncommitted files refuses, naming them, and nothing moves: no commit, the tree kept", async () => {
    writeFrozenChange(lineRunDir(repo, OURS), frozen(git(repo, "rev-parse", BRANCH)));
    await runTreeOn(OTHER);
    fs.writeFileSync(path.join(treeOf(OTHER), "scratch-debug.log"), "junk\n");
    const tip = git(repo, "rev-parse", BRANCH);
    for (const rewrites of [true, false]) {
      await expect(claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites, live: live(), now: later() }))
        .rejects.toThrow(`${BRANCH} is checked out by worktree ${OTHER}, which an ended run left with uncommitted files (scratch-debug.log)`);
    }
    expect(git(repo, "rev-parse", BRANCH)).toBe(tip);
    expect(fs.readFileSync(path.join(treeOf(OTHER), "scratch-debug.log"), "utf8")).toBe("junk\n");
  });

  // ct-102477: the refusal said only "a process still works in it". It names each process and stops none: a detached
  // dev server or daemon there looks the same as one the run left behind.
  test("a process in an ended run's worktree refuses, named by pid, command and when it started, and nothing is stopped", async () => {
    await runTreeOn(OTHER);
    const runs = path.join(lineRunDir(repo, OTHER), "runs");
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, "r1.json"), "{}");
    const ended = fs.statSync(path.join(runs, "r1.json")).mtimeMs;
    const child = spawn("/bin/sh", ["-c", "sleep 60"], { cwd: treeOf(OTHER), stdio: "ignore" });
    const procs = [{ pid: child.pid!, command: "sleep 60", startedAt: ended - 1000 }, { pid: 4242, command: "/bin/zsh", startedAt: ended + 1000 }];
    try {
      await expect(claimRunBranch(repo, "change-ct-3", BRANCH, { task: "ct-3", rewrites: false, live: live(), now: later(), processes: async () => procs }))
        .rejects.toThrow(`${BRANCH} is checked out by worktree ${OTHER}, and 2 processes still work in it: pid ${child.pid} (sleep 60, started before the run ended); pid 4242 (/bin/zsh, started after the run ended). Stop them if they are not needed (kill ${child.pid} 4242), or release the worktree with cast ws destroy ${OTHER}, then run this again`);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(fs.existsSync(treeOf(OTHER))).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("the processes in a tree are read by pid and command", async () => {
    const { treeProcesses } = await import("./runBranch.js");
    const child = spawn("/bin/sleep", ["30"], { cwd: repo, stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const got = await treeProcesses(repo);
      expect(got?.find((p) => p.pid === child.pid)).toMatchObject({ command: "/bin/sleep 30" });
      expect(got?.find((p) => p.pid === child.pid)!.startedAt).toBeGreaterThan(Date.now() - 120_000);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  test("a freeze over foreign commits refuses before releasing the worktree that holds them", async () => {
    await runTreeOn(OTHER);
    await expect(claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, live: live(), now: later() }))
      .rejects.toThrow(`${BRANCH} holds commits no run of ct-1 froze`);
    expect(fs.existsSync(treeOf(OTHER))).toBe(true);
  });

  test("a worktree whose directory is gone holds nothing: it is pruned and the branch is free", async () => {
    git(repo, "worktree", "add", "-q", path.join(repo, "gone"), BRANCH);
    fs.rmSync(path.join(repo, "gone"), { recursive: true, force: true });
    expect(await claimRunBranch(repo, "change-ct-3", BRANCH, { task: "ct-3", rewrites: false, live: live() })).toBeNull();
    expect(git(repo, "worktree", "list")).not.toContain("gone");
  });
});

describe("a worktree no run made holding the branch (ct-102064)", () => {
  const mine = () => path.join(repo, "mine");
  const claim = (cwd: string, rewrites = false) => claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites, live: live(), now: later(), cwd });

  test("the caller's own clean one is detached at the same commit, the caller told, and the run's worktree then checks the branch out", async () => {
    git(repo, "worktree", "add", "-q", mine(), BRANCH);
    fs.mkdirSync(path.join(mine(), "sub"));
    const tip = git(repo, "rev-parse", BRANCH);
    const notice = await claim(path.join(mine(), "sub"));
    expect(notice).toBe(`Detached your worktree ${mine()} from ${BRANCH} at the same commit (it had nothing uncommitted) so the run can check the branch out: a commit made there now is on no branch, so push one with git push origin HEAD:refs/heads/${BRANCH}`);
    expect(git(mine(), "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(mine(), "rev-parse", "HEAD")).toBe(tip);
    expect(git(repo, "rev-parse", BRANCH)).toBe(tip);
    const { acquireWorkspace } = await import("../workspace/lifecycle.js");
    const ws = await acquireWorkspace(repo, OURS, { branch: BRANCH, skipPool: true, skipSetup: true, skipHooks: true, noPorts: true });
    expect(git(ws.workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
  }, 60_000);

  test("the caller's own with uncommitted files refuses, naming them, and stays on the branch with its files", async () => {
    git(repo, "worktree", "add", "-q", mine(), BRANCH);
    fs.writeFileSync(path.join(mine(), "a.txt"), "half done\n");
    fs.writeFileSync(path.join(mine(), "notes.md"), "todo\n");
    await expect(claim(mine())).rejects.toThrow(`${BRANCH} is checked out in your worktree ${mine()}, with uncommitted files (a.txt, notes.md)`);
    expect(git(mine(), "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(fs.readFileSync(path.join(mine(), "a.txt"), "utf8")).toBe("half done\n");
  });

  test("the main checkout is never switched off it, the caller's own included", async () => {
    git(repo, "switch", "-q", BRANCH);
    await expect(claim(repo)).rejects.toThrow(`${BRANCH} is checked out in the main checkout ${repo}`);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
  });

  // No process or session signal says nobody commits there next: a session with no id on its command line, one the
  // server does not list, one sharing the caller's id (a sibling subagent), or none at all, all look alike.
  test("anyone else's clean one refuses as it always did, whatever works in it, and stays on the branch", async () => {
    git(repo, "worktree", "add", "-q", mine(), BRANCH);
    for (const tail of [null, ": codex app-server", ": --session-id 0b5e55ed-0000-4000-8000-000000000001"]) {
      const agent = tail ? spawn("/bin/sh", ["-c", `sleep 60; ${tail}`], { cwd: mine(), stdio: "ignore" }) : null;
      try {
        await expect(claim(repo)).rejects.toThrow(`${BRANCH} is checked out in ${mine()}, which no run made: switch that worktree off it (git -C ${mine()} switch --detach)`);
        expect(git(mine(), "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
      } finally {
        agent?.kill("SIGKILL");
      }
    }
  });

  test("a freeze over foreign commits refuses before switching the caller's worktree off the branch", async () => {
    git(repo, "worktree", "add", "-q", mine(), BRANCH);
    await expect(claim(mine(), true)).rejects.toThrow(`${BRANCH} holds commits no run of ct-1 froze`);
    expect(git(mine(), "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
  });
});

describe("a run of the same task (ct-98893)", () => {
  // H2: a rerun while the run waited on its subject moved the branch and reset the live run's tree under it.
  test("a live one refuses before anything moves, and says the run reads the branch again itself", async () => {
    git(repo, "worktree", "add", "-q", treeOf(OURS), BRANCH);
    writeFrozenChange(lineRunDir(repo, OURS), frozen(git(repo, "rev-parse", BRANCH)));
    for (const state of ["paused", "pending", "running"]) {
      await expect(claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, live: live({}, { "ct-1": state }), now: later() }))
        .rejects.toThrow(`A run of ct-1 is live (${state}); it reads the branch again when you end your turn — don't start it again`);
    }
  });

  test("one whose tree was made moments ago and has not started yet is live too; once it has run, its tree is the rerun's", async () => {
    git(repo, "worktree", "add", "-q", treeOf(OURS), BRANCH);
    writeFrozenChange(lineRunDir(repo, OURS), frozen(git(repo, "rev-parse", BRANCH)));
    await expect(claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, live: live() })).rejects.toThrow("is live (starting)");
    fs.mkdirSync(path.join(lineRunDir(repo, OURS), "runs"), { recursive: true });
    fs.writeFileSync(path.join(lineRunDir(repo, OURS), "runs", "run1.json"), "{}");
    expect(await claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, live: live() })).toBeNull();
  });

  test("when whether it is live cannot be told, it refuses", async () => {
    const unread: RunLiveness = { trees: async () => new Map(), taskRun: async () => { throw new Error("offline"); } };
    await expect(claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, live: unread })).rejects.toThrow("cannot be told (offline)");
  });

  test("an ended one's own worktree is the rerun's to reuse", async () => {
    git(repo, "worktree", "add", "-q", treeOf(OURS), BRANCH);
    writeFrozenChange(lineRunDir(repo, OURS), frozen(git(repo, "rev-parse", BRANCH)));
    expect(await claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, live: live(), now: later() })).toBeNull();
  });
});

describe("a freeze onto the task's branch (ct-98893)", () => {
  test("refuses while the branch holds commits no freeze of this run made", async () => {
    await expect(claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, live: live() }))
      .rejects.toThrow(`${BRANCH} holds commits no run of ct-1 froze`);
  });

  test("goes ahead over its own earlier freeze, over a branch the checkout already holds, and with no branch yet", async () => {
    writeFrozenChange(lineRunDir(repo, OURS), frozen(git(repo, "rev-parse", BRANCH)));
    expect(await claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, live: live() })).toBeNull();
    git(repo, "branch", "codecast/change-ct-4", "main");
    expect(await claimRunBranch(repo, "change-ct-4", "codecast/change-ct-4", { task: "ct-4", rewrites: true, live: live() })).toBeNull();
    expect(await claimRunBranch(repo, "change-ct-5", "codecast/change-ct-5", { task: "ct-5", rewrites: true, live: live() })).toBeNull();
  });

  // H3: a placed run's freeze is recorded in placed-change.json, which the run here never reads as its own change.
  test("goes ahead over the freeze of a run placed on another machine, and over its refreeze", async () => {
    writePlacedChange(lineRunDir(repo, OURS), { ...frozen(git(repo, "rev-parse", BRANCH)), pushed: true });
    expect(await claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, live: live() })).toBeNull();
    // `cast flow refreeze <run>` moves the branch and records the new tip the same way (placedChange.ts refreezeRunCommand).
    git(repo, "worktree", "add", "-q", path.join(repo, "scratch"), BRANCH);
    fs.writeFileSync(path.join(repo, "scratch", "a.txt"), "the fix\n");
    git(path.join(repo, "scratch"), "commit", "-qam", "the fix");
    git(repo, "worktree", "remove", "--force", path.join(repo, "scratch"));
    await expect(claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, live: live() })).rejects.toThrow("holds commits no run of ct-1 froze");
    writePlacedChange(lineRunDir(repo, OURS), { ...frozen(git(repo, "rev-parse", BRANCH)), pushed: true });
    expect(await claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, live: live() })).toBeNull();
  });
});
