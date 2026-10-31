import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorktreeLegacy } from "./worktreeLegacy.js";
import { acquireWorkspace, healWorkspace } from "./workspace/lifecycle.js";
import { readState } from "./workspace/contract.js";

// A post-checkout hook that backgrounds a job without redirecting it (`npm run
// build:watch &`) leaves the job holding git's stdout and stderr. The sync
// worktree adds on the daemon's thread must return when git does, not when the
// job lets go of those, or the daemon's event loop stops for as long as it lives.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-hookjob-")));
const pids = path.join(root, "job-pids");
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

afterAll(() => {
  for (const pid of fs.existsSync(pids) ? fs.readFileSync(pids, "utf-8").split("\n").filter(Boolean) : []) {
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* already gone */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("a post-checkout hook's background job does not hold the sync worktree adds", async () => {
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
    // Created before the hook exists: the async add used for new seeded worktrees waits for pipes.
    const first = await acquireWorkspace(root, "w1", { skipSetup: true, skipHooks: true, skipBrowser: true, skipPool: true, agentDriven: false, branch: "feat/x", startPoint: "refs/codecast/cloud/w1" });

    const hook = path.join(root, ".git", "hooks", "post-checkout");
    fs.writeFileSync(hook, `#!/bin/sh\nsleep 30 &\necho $! >> ${JSON.stringify(pids)}\n`, { mode: 0o755 });

    const legacyStart = Date.now();
    const legacy = createWorktreeLegacy(root, "legacy", () => {});
    expect("error" in legacy).toBe(false);
    expect(Date.now() - legacyStart).toBeLessThan(5_000);

    fs.rmSync(first.workspace.path, { recursive: true, force: true });
    const healStart = Date.now();
    await healWorkspace(root, "w1");
    expect(Date.now() - healStart).toBeLessThan(5_000);
    expect(fs.existsSync(readState(root, "w1")!.path)).toBe(true);
    expect(fs.readFileSync(pids, "utf-8").split("\n").filter(Boolean)).toHaveLength(2);
  } finally {
    if (savedDir === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = savedDir;
  }
}, 60_000);
