/**
 * A line run's worktree is its branch checked out (runner.ts runSlug). A run
 * parked at its card for days can outlive that checkout, to a disk sweep or a
 * cleanup by hand, while the branch keeps every commit. So a resumed run puts
 * the checkout back on its own branch before any station asks `cast ws path`
 * for it: on Oct 24 the trees of 35 runs waiting at their cards were removed,
 * and each failed at Eval the moment its Ship answer resumed it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { c } from "../colors.js";
import { execFileSync } from "../proc.js";

export type RunWorktreeRestore = "present" | "restored" | "no_branch";

/** A resumed run's checkout, from the context it resumes with (runner.ts driveRun), back before its first station. */
export async function restoreResumedWorktree(cwd: string, context: Record<string, string>): Promise<void> {
  const worktree = context["worktree"];
  if (!worktree) return;
  const branch = context["branch"] || `codecast/${worktree}`;
  try {
    if (await restoreRunWorktree(cwd, worktree, branch) === "restored") console.log(`${c.dim}Put worktree ${worktree} back on ${branch}${c.reset}`);
  } catch (err) {
    // The station that needs it still fails with its own error; the run is not stopped here.
    console.error(`${c.yellow}Could not put worktree ${worktree} back on ${branch}: ${(err as Error).message}${c.reset}`);
  }
}

/** Put the run's worktree `name` back on `branch` when its directory is gone; `cwd` is the run's checkout. */
export async function restoreRunWorktree(cwd: string, name: string, branch: string): Promise<RunWorktreeRestore> {
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  // The root `cast ws path` resolves from a station's directory, so the checkout lands where it looks.
  const repoRoot = git("rev-parse", "--show-toplevel");
  const { readState } = await import("../workspace/contract.js");
  if (fs.existsSync(readState(repoRoot, name)?.path ?? path.join(repoRoot, ".codecast", "worktrees", name))) return "present";
  try { git("show-ref", "--verify", "--quiet", `refs/heads/${branch}`); } catch { return "no_branch"; }
  // git refuses to check a branch out again while it still lists the removed directory as its worktree.
  git("worktree", "prune");
  // An explicit branch with no start point attaches to the branch as it stands and never takes a warm pool slot cut from main.
  const { acquireWorkspace } = await import("../workspace/lifecycle.js");
  await acquireWorkspace(repoRoot, name, { branch, skipPool: true });
  return "restored";
}
