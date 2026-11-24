import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShell } from "../land/shipCheckout";
import { holderGone, SCRATCH_STALE_MS, shutDown, sweepScratchTrees, takeMergeLock, trackStep } from "./mergeScratch";

// What the Merge station holds on its machine: which scratch trees its sweep
// may remove (only its own, only old ones, only a dead maker's), a checkout
// lock that two waiters cannot both take over, and a step stopped as a whole
// process group before its tree goes.

function repo() {
  const root = mkdtempSync(join(tmpdir(), "merge-scratch-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@x", ...args], { cwd: root, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "start");
  return { root, git, done: () => rmSync(root, { recursive: true, force: true }) };
}

const deadPid = () => spawnSync("true").pid!;

describe("sweepScratchTrees", () => {
  test("removes only the station's own trees that are old and whose maker died; a person's merge-* worktree and branch stay", async () => {
    const r = repo();
    try {
      const { acquireWorkspace } = await import("../workspace/lifecycle.js");
      const { listStates } = await import("../workspace/contract.js");
      const now = Date.now();
      const base = { noPorts: true, skipSetup: true, skipHooks: true, skipBrowser: true, startPoint: "HEAD" };
      // A person's: hand-made with no state (as the main checkout's merge-auth is), and one acquired under a merge-* name.
      r.git("worktree", "add", "-q", "-b", "jb/merge-auth", join(r.root, ".codecast", "worktrees", "merge-auth"));
      await acquireWorkspace(r.root, "merge-auth-fix", { ...base, branch: "jb/merge-auth-fix" });
      // The station's: old with a dead maker (swept), young (a step may still run there), and old with a live maker.
      const scratch = (name: string, pid: number, age: number) => acquireWorkspace(r.root, name, { ...base, branch: `codecast/${name}`, purpose: { kind: "merge-scratch", pid, started_at: now - age } });
      await scratch("merge-scratch-old", deadPid(), SCRATCH_STALE_MS + 60_000);
      await scratch("merge-scratch-young", deadPid(), 10 * 60_000);
      await scratch("merge-scratch-live", process.pid, SCRATCH_STALE_MS + 60_000);
      // Marked as the station's but not named as one: not swept either.
      await acquireWorkspace(r.root, "merge-oddly-marked", { ...base, branch: "jb/merge-oddly-marked", purpose: { kind: "merge-scratch", pid: deadPid(), started_at: now - SCRATCH_STALE_MS - 60_000 } });

      await sweepScratchTrees(r.root, now);

      expect(listStates(r.root).map((s) => s.name).sort()).toEqual(["merge-auth-fix", "merge-oddly-marked", "merge-scratch-live", "merge-scratch-young"]);
      expect(existsSync(join(r.root, ".codecast", "worktrees", "merge-auth", "a.txt"))).toBe(true);
      expect(r.git("branch", "--list", "--format=%(refname:short)").split("\n").sort()).toEqual(["codecast/merge-scratch-live", "codecast/merge-scratch-young", "jb/merge-auth", "jb/merge-auth-fix", "jb/merge-oddly-marked", "main"]);
    } finally { r.done(); }
  }, { timeout: 120_000 });
});

describe("takeMergeLock", () => {
  test("a lock left by a dead holder is taken over by exactly one of the waiters at a time", async () => {
    const r = repo();
    try {
      mkdirSync(join(r.root, ".git", "codecast"), { recursive: true });
      writeFileSync(join(r.root, ".git", "codecast", "merge.lock"), String(deadPid()));
      const log = join(r.root, "held.log");
      const script = join(r.root, "waiter.ts");
      writeFileSync(script, `
import { appendFileSync } from "node:fs";
import { takeMergeLock } from ${JSON.stringify(join(import.meta.dir, "mergeScratch.ts"))};
const release = await takeMergeLock(${JSON.stringify(r.root)}, () => {});
appendFileSync(${JSON.stringify(log)}, "in " + Date.now() + "\\n");
await new Promise((res) => setTimeout(res, 800));
appendFileSync(${JSON.stringify(log)}, "out " + Date.now() + "\\n");
release();
`);
      const waiters = [0, 1, 2].map(() => new Promise<number>((res) => spawn("bun", [script], { stdio: "ignore" }).on("close", (c) => res(c ?? 1))));
      expect(await Promise.all(waiters)).toEqual([0, 0, 0]);
      // Strictly alternating: no waiter got in while another held it.
      expect(readFileSync(log, "utf-8").trim().split("\n").map((l) => l.split(" ")[0])).toEqual(["in", "out", "in", "out", "in", "out"]);
      expect(existsSync(join(r.root, ".git", "codecast", "merge.lock"))).toBe(false);
    } finally { r.done(); }
  }, { timeout: 60_000 });

  test("a lock whose pid a later process reused (another start time) is no holder's, and is taken over", async () => {
    const r = repo();
    try {
      mkdirSync(join(r.root, ".git", "codecast"), { recursive: true });
      // This very process's pid, but a start time from before it began: the reboot-reused-pid case.
      writeFileSync(join(r.root, ".git", "codecast", "merge.lock"), `${process.pid} Mon Jan  1 00:00:00 2001`);
      const said: string[] = [];
      const release = await takeMergeLock(r.root, (l) => said.push(l));
      expect(said).toEqual([]);
      const held = readFileSync(join(r.root, ".git", "codecast", "merge.lock"), "utf-8");
      expect(held.startsWith(`${process.pid} `)).toBe(true);
      expect(held).not.toContain("2001");
      release();
    } finally { r.done(); }
  }, { timeout: 30_000 });

  test("a holder this user may not signal (EPERM) is alive, and a ps that answers nothing proves nothing", () => {
    const launchd = spawnSync("ps", ["-o", "lstart=", "-p", "1"], { encoding: "utf-8" }).stdout.trim().replace(/\s+/g, " ");
    expect(holderGone(`1 ${launchd}`, "/nonexistent")).toBe(false);
    expect(holderGone("1", "/nonexistent")).toBe(false);
    // A dead pid is gone whatever start time it names.
    expect(holderGone(`${deadPid()} ${launchd}`, "/nonexistent")).toBe(true);
  });

  test("a live holder is waited on, named once", async () => {
    const r = repo();
    try {
      const holder = spawn("sleep", ["2"]);
      mkdirSync(join(r.root, ".git", "codecast"), { recursive: true });
      writeFileSync(join(r.root, ".git", "codecast", "merge.lock"), String(holder.pid));
      const said: string[] = [];
      const release = await takeMergeLock(r.root, (l) => said.push(l));
      expect(said).toEqual([`waiting for the merge already running in this checkout (pid ${holder.pid}) to finish`]);
      expect(readFileSync(join(r.root, ".git", "codecast", "merge.lock"), "utf-8")).toMatch(new RegExp(`^${process.pid} \\S`));
      release();
    } finally { r.done(); }
  }, { timeout: 30_000 });
});

describe("shutDown", () => {
  test("stops the running step's whole process group, then releases its tree", async () => {
    const r = repo();
    try {
      let pid = 0;
      const ran = runShell("sleep 30 & sleep 30; wait", r.root, () => {}, {}, (child) => { pid = child.pid!; trackStep(child); });
      await new Promise((res) => setTimeout(res, 300));
      let released = false;
      expect(await shutDown(async () => { released = true; }, 10_000)).toBe(true);
      expect(released).toBe(true);
      await ran;
      expect(() => process.kill(-pid, 0)).toThrow();
    } finally { r.done(); }
  }, { timeout: 30_000 });

  test("a station stopped after its merge landed releases its tree and says the sha with exit 0, not 'not merged'", async () => {
    const r = repo();
    try {
      const script = join(r.root, "stopped.ts");
      writeFileSync(script, `
import { acquiredTree, noteLanded, noteRestoring } from ${JSON.stringify(join(import.meta.dir, "mergeScratch.ts"))};
await acquiredTree(${JSON.stringify(r.root)}, "HEAD");
noteLanded("${"f".repeat(40)}");
noteRestoring("sending convex again from main after the merge");
process.kill(process.pid, "SIGTERM");
await new Promise((res) => setTimeout(res, 20_000));
`);
      const child = spawnSync("bun", [script], { encoding: "utf-8", timeout: 40_000 });
      expect(child.status).toBe(0);
      expect(child.stdout.trim().split("\n").pop()).toBe("f".repeat(40));
      // Stopped mid-restore, it says what production may be left on.
      expect(child.stdout).toContain("stopped while sending convex again from main after the merge: production may run a backend the default branch lacks");
      const { listStates } = await import("../workspace/contract.js");
      expect(listStates(r.root)).toEqual([]);
    } finally { r.done(); }
  }, { timeout: 60_000 });

  test("a step that will not stop keeps its tree, for the age-based sweep", async () => {
    const r = repo();
    let pid = 0;
    try {
      void runShell("trap '' TERM; sleep 20", r.root, () => {}, {}, (child) => { pid = child.pid!; trackStep(child); });
      await new Promise((res) => setTimeout(res, 300));
      let released = false;
      expect(await shutDown(async () => { released = true; }, 500)).toBe(false);
      expect(released).toBe(false);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      r.done();
    }
  }, { timeout: 30_000 });

  test("a job of the step's that writes elsewhere and will not stop keeps the tree, though the step's output has closed", async () => {
    const r = repo();
    let pid = 0;
    try {
      const ran = runShell("( trap '' TERM; exec sleep 20 ) >/dev/null 2>&1 & sleep 20; wait", r.root, () => {}, {}, (child) => { pid = child.pid!; trackStep(child); });
      await new Promise((res) => setTimeout(res, 300));
      let released = false;
      expect(await shutDown(async () => { released = true; }, 500)).toBe(false);
      expect(released).toBe(false);
      await ran;
      expect(() => process.kill(-pid, 0)).not.toThrow();
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      r.done();
    }
  }, { timeout: 30_000 });
});
