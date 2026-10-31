import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorktreeLegacy, execFileSyncToFile, execFileToFile } from "./worktreeLegacy.js";
import { acquireWorkspace, healWorkspace } from "./workspace/lifecycle.js";
import { readState } from "./workspace/contract.js";

// A post-checkout hook that backgrounds a job without redirecting it (`npm run
// build:watch &`) leaves the job holding git's stdout and stderr. Every worktree
// add must return when git does, not when the job lets go of those: a sync one
// stops the daemon's event loop for as long as the job lives, an async one never
// resolves and keeps the repo-wide add lock.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-hookjob-")));
const pids = path.join(root, "job-pids");
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

afterAll(() => {
  for (const pid of fs.existsSync(pids) ? fs.readFileSync(pids, "utf-8").split("\n").filter(Boolean) : []) {
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* already gone */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("a post-checkout hook's background job does not hold any worktree add", async () => {
  const savedDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = path.join(root, "host-state");
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(root, "README.md"), "test\n");
    git("add", ".");
    git("commit", "-qm", "init");
    const base = git("rev-parse", "HEAD");
    git("update-ref", "refs/codecast/cloud/w1", base);
    const hook = path.join(root, ".git", "hooks", "post-checkout");
    fs.writeFileSync(hook, `#!/bin/sh\nsleep 30 &\necho $! >> ${JSON.stringify(pids)}\n`, { mode: 0o755 });
    const opts = { skipSetup: true, skipHooks: true, skipBrowser: true, skipPool: true, agentDriven: false };

    // The async adds (seeded, then plain) wait for the command, not for the job.
    const seededStart = Date.now();
    const first = await acquireWorkspace(root, "w1", { ...opts, branch: "feat/x", startPoint: "refs/codecast/cloud/w1" });
    await acquireWorkspace(root, "plain", opts);
    expect(Date.now() - seededStart).toBeLessThan(5_000);

    const legacyStart = Date.now();
    const legacy = createWorktreeLegacy(root, "legacy", () => {});
    expect("error" in legacy).toBe(false);
    expect(Date.now() - legacyStart).toBeLessThan(5_000);

    // The branch exists already: the first add fails and the second form runs the hook.
    git("branch", "codecast/retry");
    const retryStart = Date.now();
    const retry = createWorktreeLegacy(root, "retry", () => {});
    expect("error" in retry).toBe(false);
    expect(Date.now() - retryStart).toBeLessThan(5_000);

    fs.rmSync(first.workspace.path, { recursive: true, force: true });
    const healStart = Date.now();
    await healWorkspace(root, "w1");
    expect(Date.now() - healStart).toBeLessThan(5_000);
    expect(fs.existsSync(readState(root, "w1")!.path)).toBe(true);
    expect(fs.readFileSync(pids, "utf-8").split("\n").filter(Boolean)).toHaveLength(5);
  } finally {
    if (savedDir === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = savedDir;
  }
}, 60_000);

test("a failed command reports git's reason in the error's stderr and message, sync and async", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-hookjob-err-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    const bad = ["worktree", "add", path.join(dir, "x"), "no-such-branch"];
    let sync: any;
    try { execFileSyncToFile("git", bad, { cwd: dir }); } catch (err) { sync = err; }
    const async_ = await execFileToFile("git", bad, { cwd: dir }).then(() => undefined, (err) => err);
    for (const err of [sync, async_]) {
      expect(err.stderr).toContain("fatal:");
      expect(err.message).toContain("fatal:");
      expect(err.status ?? err.code).toBeGreaterThan(0);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
