import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { freshRunBranch } from "./lineTrialBranch";
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
  });
});
