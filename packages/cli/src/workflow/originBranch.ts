// Origin's copy of a run's named branch, and where a run of that branch starts: a local branch origin has superseded
// (behind it, or a tip origin held before the author force-pushed past it) starts from origin's tip.
import * as fs from "node:fs";
import * as path from "node:path";
import { isAncestor } from "../land/replay.js";
import { git, gitTry } from "../wipSnapshot.js";

/** Origin's tip of `branch`, fetched now; empty when origin has no such branch or cannot be reached. */
export async function originTip(root: string, branch: string): Promise<string> {
  const remoteRef = `refs/remotes/origin/${branch}`;
  await git(root, ["fetch", "--quiet", "origin", `+${branch}:${remoteRef}`]).catch(() => "");
  return git(root, ["rev-parse", "--verify", "--quiet", remoteRef]).catch(() => "");
}

/**
 * Whether origin's `remote` tip of `branch` is a newer copy of `sha`, so taking it drops nothing only this checkout
 * has: `sha` is under it, or origin once held `sha` (a tip this checkout fetched or pushed, in its remote-tracking
 * reflog) and was rewritten past it since, by the change's author rebasing and pushing from elsewhere. Never when the
 * branch here once stood on origin's tip or past it: then `sha` is the branch rewound on purpose (a reset dropping a
 * commit already pushed), and origin's copy would bring back what was dropped. A commit the checkout lacks, or a
 * reflog git cannot read, says no.
 */
export async function originSupersedes(root: string, branch: string, sha: string, remote: string): Promise<boolean> {
  const under = (a: string, b: string) => isAncestor(root, a, b).catch(() => false);
  const reflog = async (ref: string) => new Set(((await gitTry(root, ["reflog", "show", "-n", "50", "--format=%H", ref])) ?? "").split("\n").filter(Boolean));
  for (const was of await reflog(`refs/heads/${branch}`)) if (was !== sha && (await under(remote, was))) return false;
  if (await under(sha, remote)) return true;
  for (const h of await reflog(`refs/remotes/origin/${branch}`)) if (await under(sha, h)) return true;
  return false;
}

/** Whether a worktree other than `own` has `branch` checked out (the main checkout included). */
async function heldElsewhere(root: string, branch: string, own?: string | null): Promise<boolean> {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const list = (await gitTry(root, ["worktree", "list", "--porcelain"])) ?? "";
  return list.split("\n\n").some((entry) => {
    const tree = /^worktree (.+)$/m.exec(entry)?.[1];
    return !!tree && entry.split("\n").includes(`branch refs/heads/${branch}`) && (!own || real(tree) !== real(own));
  });
}

/**
 * The commit a run of a named branch starts from, the local branch moved to it. A branch pushed from another machine
 * has no local ref here; without one, the worktree the run makes would create the branch fresh from this checkout's
 * HEAD, and the change would vanish (a rebase of it onto the default branch is empty, which reads as "already
 * landed"). A local branch origin has superseded (behind origin, or a tip origin held before the author rebased and
 * force-pushed it from another worktree) starts from origin's tip: run from the stale copy, the PR station found
 * origin holding commits the run never had and stopped the run (ct-102399, ct-102339, ct-101957). A local branch with
 * commits of its own keeps them, and so does one checked out in a worktree other than `own` (the run's own earlier
 * tree, which the run resets to the change): moving it there would leave that checkout showing a staged revert of the
 * author's rebase. Empty when neither this checkout nor origin has the branch.
 */
export async function branchHead(root: string, branch: string, own?: string | null): Promise<{ head: string; remote_tip: string }> {
  const remote_tip = await originTip(root, branch);
  let head = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => "");
  if (!head && remote_tip) {
    await git(root, ["branch", "--quiet", "--no-track", branch, remote_tip]);
    head = remote_tip;
  } else if (head && remote_tip && head !== remote_tip && !(await heldElsewhere(root, branch, own)) && (await originSupersedes(root, branch, head, remote_tip))) {
    await git(root, ["update-ref", `refs/heads/${branch}`, remote_tip, head]);
    head = remote_tip;
  }
  return { head, remote_tip };
}
