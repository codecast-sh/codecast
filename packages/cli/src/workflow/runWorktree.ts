/**
 * A line run's worktree is its branch checked out (runner.ts runSlug). A run
 * parked at its card or a hold for days can outlive that checkout, to a disk
 * sweep or a cleanup by hand, while the branch keeps every commit. So a run puts
 * the checkout back on its own branch before each station that may ask
 * `cast ws path` for it: on Oct 24 the trees of 35 runs waiting at their cards
 * were removed, and each failed at Eval the moment its Ship answer resumed it.
 * `cast land prune` frees the branch name too and keeps its head under
 * refs/codecast/land-archive/<branch> (land/prune.ts); the branch comes back
 * from there (ct-68695 and ct-62158 failed at Eval on Nov 5 with both gone).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { c } from "../colors.js";
import { execFileSync } from "../proc.js";

export type RunWorktreeRestore = "present" | "restored" | "no_branch";

/** A run's checkout, from the context it runs with, back before a station (runner.ts driveRun and runNodeLoop). */
export async function restoreRunTree(cwd: string, context: Record<string, string>): Promise<void> {
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
  const has = (ref: string) => { try { git("show-ref", "--verify", "--quiet", ref); return true; } catch { return false; } };
  if (!has(`refs/heads/${branch}`)) {
    const { ARCHIVE_REF_PREFIX } = await import("../land/prune.js");
    if (!has(`${ARCHIVE_REF_PREFIX}${branch}`)) return "no_branch";
    git("branch", branch, `${ARCHIVE_REF_PREFIX}${branch}`);
  }
  // git refuses to check a branch out again while it still lists the removed directory as its worktree.
  git("worktree", "prune");
  // An explicit branch with no start point attaches to the branch as it stands and never takes a warm pool slot cut from main.
  const { acquireWorkspace } = await import("../workspace/lifecycle.js");
  await acquireWorkspace(repoRoot, name, { branch, skipPool: true });
  return "restored";
}

/**
 * A run that ended takes its checkout with it: it made the tree, so it
 * removes it, and with it the tree's port slot. Whatever the tree holds
 * uncommitted is first committed onto the run's own branch
 * (worktreeGc.ts commitRunLeftovers), which stays, so a resume or
 * `cast ws acquire` puts the same content back (restoreRunWorktree). On Nov 22
 * the trees of a day's unlanded runs held all 40 port slots of a line host and
 * every run after them failed with "no free port" (ct-99146). A tree a process
 * still sits in is kept; so is one off its run's branch, or on a change
 * frozen for the run, that holds work main lacks (worktreeGc.ts contentKeepReason), which the daemon's sweep shows to
 * the run's task. A run waiting at a gate never gets here: its runner waits
 * with it, and a runner that dies there is resumed, restoring the tree before
 * the gate.
 */
export async function releaseEndedRunTree(cwd: string, context: Record<string, string>): Promise<void> {
  const name = context["worktree"];
  if (!name) return;
  try {
    const repoRoot = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const { readState } = await import("../workspace/contract.js");
    const tree = readState(repoRoot, name)?.path ?? path.join(repoRoot, ".codecast", "worktrees", name);
    if (!fs.existsSync(tree)) return;
    const { readProcessCwds } = await import("../land/scan.js");
    const cwds = await readProcessCwds();
    if (!cwds || cwds.some((p) => p === tree || p.startsWith(`${tree}/`))) {
      console.log(`${c.dim}Kept worktree ${name}: ${cwds ? "a running process sits in it" : "could not read which processes sit in it"}${c.reset}`);
      return;
    }
    const { commitRunLeftovers, contentKeepReason, releaseTree } = await import("../worktreeGc.js");
    const message = `Left uncommitted when the run${context["task_id"] ? ` on ${context["task_id"]}` : ""} ended${context["run_id"] ? ` (run ${context["run_id"]})` : ""}`;
    const off = await commitRunLeftovers(tree, name, message, context["run_dir"]);
    const reason = off ? await contentKeepReason(tree, repoRoot) : null;
    if (reason) {
      console.log(`${c.dim}Kept worktree ${name}: ${reason} (${off})${c.reset}`);
      return;
    }
    await releaseTree(repoRoot, tree);
    console.log(`${c.dim}Released worktree ${name}; its branch ${off ? "stays" : `codecast/${name} holds all of it`}${c.reset}`);
  } catch (err) {
    console.error(`${c.yellow}Could not release worktree ${name}: ${(err as Error).message.split("\n")[0]}${c.reset}`);
  }
}

/**
 * Stop the run's workspace Chrome, if one runs. Called when each station ends
 * and when the run ends (runner.ts), so a browser a station started never
 * outlives it: a run parked at a gate, waiting on CI or at Go live, holds
 * none. Six parked change runs each held one at ~460% CPU on Nov 21 (ct-98941).
 * Reads the state file first, so a run with no browser pays one file read.
 */
export async function stopRunBrowser(cwd: string, context: Record<string, string>): Promise<boolean> {
  const worktree = context["worktree"];
  if (!worktree) return false;
  let repoRoot: string;
  try {
    repoRoot = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return false; // not a checkout: no workspace, so no browser
  }
  const { readState } = await import("../workspace/contract.js");
  if (!readState(repoRoot, worktree)?.chrome) return false;
  try {
    const { stopWorkspaceBrowser } = await import("../workspace/lifecycle.js");
    const stopped = await stopWorkspaceBrowser(repoRoot, worktree);
    if (stopped) console.log(`${c.dim}Stopped worktree ${worktree}'s Chrome${c.reset}`);
    return stopped;
  } catch (err) {
    console.error(`${c.yellow}Could not stop worktree ${worktree}'s Chrome: ${(err as Error).message}${c.reset}`);
    return false;
  }
}
