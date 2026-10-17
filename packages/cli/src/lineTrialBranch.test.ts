import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { freshRunBranch, processesIn, sessionIdsOf, type RunHands } from "./lineTrialBranch";
import { lineRunDir } from "./workflow/runner";

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

describe("freshRunBranch", () => {
  test("a rerun sets the earlier run's branch, its uncommitted work and its run files aside, and starts from origin/main", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trial-branch-")));
    const origin = path.join(root, "origin.git");
    const repo = path.join(root, "repo");
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    spawnSync("git", ["clone", "-q", origin, repo]);
    for (const [k, val] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(repo, "config", k, val);
    fs.writeFileSync(path.join(repo, "a.txt"), "unfixed\n");
    sh(repo, "add", "."); sh(repo, "commit", "-qm", "base"); sh(repo, "push", "-q", "origin", "main");
    const base = sh(repo, "rev-parse", "HEAD");

    // The earlier run: its fix committed, more left uncommitted, and its run files.
    const tree = path.join(root, "wt");
    sh(repo, "worktree", "add", "-q", "-b", "codecast/agentwatch-trial-ct-1", tree);
    fs.writeFileSync(path.join(tree, "a.txt"), "fixed\n");
    sh(tree, "commit", "-qam", "fix");
    fs.writeFileSync(path.join(tree, "b.txt"), "left over\n");
    const runDir = lineRunDir(repo, "agentwatch-trial-ct-1");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "red.json"), "{}");

    const fresh = await freshRunBranch(repo, { name: "agentwatch_trial" }, "ct-1", new Date("2026-10-12T08:30:00Z"));
    expect(fresh).toEqual({ slug: "agentwatch-trial-ct-1", branch: "codecast/agentwatch-trial-ct-1", base: "origin/main", set_aside: "agentwatch-trial-ct-1-before-20261012-0830" });
    expect(sh(repo, "rev-parse", "codecast/agentwatch-trial-ct-1")).toBe(base);
    expect(sh(repo, "show", "codecast/agentwatch-trial-ct-1-before-20261012-0830:a.txt")).toBe("fixed");
    expect(sh(repo, "show", "codecast/agentwatch-trial-ct-1-before-20261012-0830:b.txt")).toBe("left over");
    expect(fs.existsSync(runDir)).toBe(false);
    expect(fs.existsSync(path.join(lineRunDir(repo, "agentwatch-trial-ct-1-before-20261012-0830"), "red.json"))).toBe(true);

    // A first run on a problem has nothing to set aside.
    expect((await freshRunBranch(repo, { name: "agentwatch_trial" }, "ct-2")).set_aside).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  // ct-60298: a build hand the runner settled while it worked was still in the
  // worktree when the next run cut its fresh branch; it found its branch reset
  // and put its fix back on it, so the next run proved against the old fix.
  const SESSION = "00000000-0000-4000-8000-000000000001";
  async function earlierRunWithHand() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trial-hand-")));
    const origin = path.join(root, "origin.git");
    const repo = path.join(root, "repo");
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    spawnSync("git", ["clone", "-q", origin, repo]);
    for (const [k, val] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(repo, "config", k, val);
    fs.writeFileSync(path.join(repo, "a.txt"), "unfixed\n");
    sh(repo, "add", "."); sh(repo, "commit", "-qm", "base"); sh(repo, "push", "-q", "origin", "main");
    const tree = path.join(root, "wt");
    sh(repo, "worktree", "add", "-q", "-b", "codecast/agentwatch-trial-ct-7", tree);
    fs.writeFileSync(path.join(tree, "a.txt"), "fixed\n");
    sh(tree, "commit", "-qam", "fix");
    // The hand: a process working in the tree, started with its session id.
    const hand = spawn("perl", ["-e", "sleep 60", "--", "--session-id", SESSION], { cwd: tree, detached: true, stdio: "ignore" });
    for (let i = 0; i < 50 && !processesIn(tree).length; i++) await new Promise((r) => setTimeout(r, 100));
    const stopHand = () => { try { process.kill(-hand.pid!, "SIGKILL"); } catch {} };
    return { root, repo, tree, fixed: sh(repo, "rev-parse", "codecast/agentwatch-trial-ct-7"), stopHand };
  }

  test("a session still working in the earlier run's worktree refuses the fresh run and leaves its branch as it was", async () => {
    const { root, repo, fixed, stopHand } = await earlierRunWithHand();
    const stopped: string[] = [];
    const hands: RunHands = { live: async (ids) => ids.map((id) => ({ id, working: true })), stop: async (id) => { stopped.push(id); } };
    try {
      await expect(freshRunBranch(repo, { name: "agentwatch_trial" }, "ct-7", new Date(), hands)).rejects.toThrow(/still working/);
      expect(stopped).toEqual([]);
      expect(sh(repo, "rev-parse", "codecast/agentwatch-trial-ct-7")).toBe(fixed);
    } finally {
      stopHand();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a settled session left in the worktree is stopped, and the fresh branch starts from origin/main", async () => {
    const { root, repo, fixed, stopHand } = await earlierRunWithHand();
    const stopped: string[] = [];
    const hands: RunHands = { live: async (ids) => ids.map((id) => ({ id, working: false })), stop: async (id) => { stopped.push(id); stopHand(); } };
    try {
      const fresh = await freshRunBranch(repo, { name: "agentwatch_trial" }, "ct-7", new Date("2026-10-16T14:23:00Z"), hands);
      expect(stopped).toEqual([SESSION]);
      expect(sh(repo, "rev-parse", "codecast/agentwatch-trial-ct-7")).toBe(sh(repo, "rev-parse", "origin/main"));
      expect(sh(repo, "rev-parse", `codecast/${fresh.set_aside}`)).toBe(fixed);
    } finally {
      stopHand();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("sessionIdsOf reads the session id an agent was started or resumed with", () => {
    expect(sessionIdsOf([1, 2, 3], [
      `/Users/x/.codecast/bin/claude --permission-mode bypassPermissions --session-id ${SESSION} --model opus -- You are running unattended`,
      "codex resume 0199a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b",
      "bash",
    ].join("\n"))).toEqual([SESSION, "0199a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b"]);
  });
});
