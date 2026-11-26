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
 * A line run starts with its branch alone (lineTrialBranch.ts freshRunBranch),
 * so the first station that uses the tree makes it here too, and a station
 * that does not use it never makes it (usesRunTree).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { c } from "../colors.js";
import { execFileSync } from "../proc.js";
import type { WorkflowGraph, WorkflowNode } from "./types.js";

const NAMES_TREE = /\$(?:worktree\b|\{worktree\})/;

/**
 * Whether `node` works in the run's tree: an isolated station, the subject's
 * own (it freezes the change again from the tree), one whose script or prompt
 * names `$worktree`, or a fan-out to such a station. Only these put the tree
 * back (runner.ts), so a run waiting at Queue holds a branch and no tree: 300+
 * waiting runs each held a 3.4 GB tree built at Start (Nov 20).
 */
export function usesRunTree(node: WorkflowNode, graph: WorkflowGraph): boolean {
  if (node.isolated || node.backend === "subject" || NAMES_TREE.test(`${node.script ?? ""}\n${node.prompt ?? ""}`)) return true;
  if (node.type !== "parallel_fanout") return false;
  return graph.edges.some((e) => {
    const to = e.from === node.id ? graph.nodes.get(e.to) : undefined;
    return !!to && to.type !== "parallel_fanout" && usesRunTree(to, graph);
  });
}

export type RunWorktreeRestore = "present" | "restored" | "no_branch";

/** A run's checkout, from the context it runs with, back before a station (runner.ts driveRun and runNodeLoop). */
export async function restoreRunTree(cwd: string, context: Record<string, string>): Promise<void> {
  const worktree = context["worktree"];
  if (!worktree) return;
  const branch = context["branch"] || `codecast/${worktree}`;
  try {
    // A change run's stations run no dev server of their own, so its tree takes no port (ct-101923).
    const { readFrozenChange } = await import("./flowChangeFile.js");
    if (await restoreRunWorktree(cwd, worktree, branch, { noPorts: !!readFrozenChange(context["run_dir"]) }) === "restored") console.log(`${c.dim}Made worktree ${worktree} on ${branch}${c.reset}`);
  } catch (err) {
    // The station that needs it still fails with its own error; the run is not stopped here.
    console.error(`${c.yellow}Could not put worktree ${worktree} back on ${branch}: ${(err as Error).message}${c.reset}`);
  }
}

/** Put the run's worktree `name` back on `branch` when its directory is gone; `cwd` is the run's checkout. */
export async function restoreRunWorktree(cwd: string, name: string, branch: string, opts: { noPorts?: boolean } = {}): Promise<RunWorktreeRestore> {
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
  await acquireWorkspace(repoRoot, name, { branch, skipPool: true, ...(opts.noPorts ? { noPorts: true } : {}) });
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
 * the next station that uses it (usesRunTree).
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
      // Kept for its work, not for a server: an ended run's tree holds no port (ct-101923).
      const { releaseWorkspacePorts } = await import("../workspace/lifecycle.js");
      const freed = await releaseWorkspacePorts(repoRoot, name).catch(() => false);
      console.log(`${c.dim}Kept worktree ${name}: ${reason} (${off})${freed ? "; its ports are free" : ""}${c.reset}`);
      return;
    }
    await releaseTree(repoRoot, tree);
    console.log(`${c.dim}Released worktree ${name}; its branch ${off ? "stays" : `codecast/${name} holds all of it`}${c.reset}`);
  } catch (err) {
    console.error(`${c.yellow}Could not release worktree ${name}: ${(err as Error).message.split("\n")[0]}${c.reset}`);
  }
}

/**
 * When an acquire finds every port slot taken (workspace/lifecycle.ts), the trees runs left behind give theirs up
 * first, as releaseEndedRunTree has them do at a run's end: the backfill for trees kept before it did (about 25 kept
 * change-ct-* trees held a laptop's slots on Nov 26, ct-101923). A run's tree is spared while its run is live, while it
 * is a few minutes old (its run may not be listed yet), or while a process sits in it; when either read fails, none is
 * touched. The names whose ports it freed.
 */
export async function releaseEndedRunTreePorts(repoRoot: string, liveRunIds?: () => Promise<ReadonlySet<string> | null>, now = Date.now()): Promise<string[]> {
  const { listStates } = await import("../workspace/contract.js");
  const { runTreeNames, runTreesOf } = await import("./runDirs.js");
  const runs = runTreeNames(repoRoot);
  const held = listStates(repoRoot).filter((s) => runs.has(s.name) && !s.noPorts && Object.keys(s.ports).length > 0 && fs.existsSync(s.path));
  if (!held.length) return [];
  const { liveRunIdsOf, readLiveRunsOnDevice } = await import("./liveRuns.js");
  const ids = await (liveRunIds ? liveRunIds() : readLiveRunsOnDevice().then(liveRunIdsOf)).catch(() => null);
  const { readProcessCwds } = await import("../land/scan.js");
  const cwds = ids ? await readProcessCwds() : null;
  if (!ids || !cwds) return [];
  const live = runTreesOf(repoRoot, ids);
  const { young } = await import("./runBranch.js");
  const { releaseWorkspacePorts } = await import("../workspace/lifecycle.js");
  const freed: string[] = [];
  for (const s of held) {
    const tree = fs.realpathSync(s.path);
    if (live.has(s.name) || young(tree, now) || cwds.some((p) => p === tree || p.startsWith(`${tree}/`))) continue;
    if (await releaseWorkspacePorts(repoRoot, s.name).catch(() => false)) freed.push(s.name);
  }
  return freed;
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
