/**
 * A change run takes its branch only when no other run is on it (ct-98893).
 * `cast flow run` names a change's branch and worktree after the task
 * (runner.ts runSlug), and a branch can be checked out by another run's
 * worktree: one started with `--branch` on it. On Nov 21 a session bound to
 * ct-98846 froze other edits onto codecast/change-ct-98846 while the live run
 * of ct-98880 had that branch checked out, replacing the commit it was
 * reviewing, and only then failed "already used by worktree". So before
 * anything moves the branch or checks it out:
 * - a worktree of a live run holding it refuses the run;
 * - one an ended run left holding it (a run that failed keeps its tree) is
 *   released, what it left uncommitted committed onto the branch first
 *   (lineTrialBranch.ts freeBranch), so a rerun needs no hand cleanup;
 * - one no run made (a person's, an agent's) refuses, since it is not ours to move;
 * - a freeze, which replaces the branch's commits, refuses while the branch
 *   holds commits no freeze of this run made and the checkout lacks.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { readFrozenChange } from "./flowChangeFile.js";
import { readRebaseChain } from "./rebaseRecord.js";
import { lineRunsRoot, runTreeNames } from "./runDirs.js";
import type { RunHands } from "../lineTrialBranch.js";

/** The worktree names live runs on this machine work in (worktreeGc.ts RunTreesInUse), or null when that cannot be told. */
export type LiveRunTrees = () => Promise<ReadonlySet<string> | null>;

const git = (cwd: string, args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? (r.stdout ?? "").trim() : null;
};
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/**
 * Make `branch` free for the run whose worktree is `slug`, or throw why it is not. `rewrites`: the run freezes its
 * change onto the branch (a session's or the checkout's edits) rather than running the branch as it stands. Returns a
 * line saying what it released, or null.
 */
export async function claimRunBranch(repo: string, slug: string, branch: string, opts: { task: string; rewrites: boolean; liveTrees: LiveRunTrees; hands?: RunHands }): Promise<string | null> {
  if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) === null) return null;
  const { worktreeOf, freeBranch } = await import("../lineTrialBranch.js");
  const holder = worktreeOf(repo, branch);
  const worktrees = real(path.join(repo, ".codecast", "worktrees"));
  let notice: string | null = null;
  if (holder && real(holder) !== path.join(worktrees, slug)) {
    const name = path.dirname(real(holder)) === worktrees ? path.basename(holder) : null;
    if (!name || !runTreeNames(repo).has(name)) {
      throw new Error(`${branch} is checked out in ${holder}, which no run made: switch that worktree off it, or run this change on another branch`);
    }
    const live = await opts.liveTrees();
    if (!live) throw new Error(`${branch} is checked out by worktree ${name}, and whether the run there is still live cannot be told (the server did not answer): run this again, or release it with cast ws destroy ${name}`);
    if (live.has(name)) throw new Error(`${branch} is checked out by worktree ${name}, where a live run works: wait for that run to end, or stop it, then run this change again`);
    const freed = await freeBranch(repo, name, branch, opts.task, opts.hands);
    notice = `Released worktree ${name}, which an ended run left holding ${branch}${freed?.committed ? `; what it left uncommitted is committed onto ${branch}` : ""}`;
  }
  if (opts.rewrites) {
    const tip = git(repo, ["rev-parse", `refs/heads/${branch}`])!;
    if (!frozenTips(repo, slug).has(tip) && !inCheckout(repo, tip)) {
      throw new Error(`${branch} holds commits no run of ${opts.task} froze (its tip ${tip.slice(0, 10)}), and freezing this change onto it would replace them: run that branch itself (cast flow run --branch ${branch}), or move it aside (git branch -m ${branch} <new name>) and run this again`);
    }
  }
  return notice;
}

/** Every tip a freeze of this run left its branch at: the change as frozen, as origin had it, and each rebase of it. */
function frozenTips(repo: string, slug: string): Set<string> {
  const runDir = path.join(lineRunsRoot(repo), slug);
  const change = readFrozenChange(runDir);
  const tips = new Set([change?.tip, change?.frozen_tip, change?.remote_tip].filter((t): t is string => !!t));
  for (const link of readRebaseChain(runDir)) tips.add(link.from).add(link.to);
  return tips;
}

/** Whether the checkout's own history, or its upstream's, already holds `tip`: a freeze over it loses nothing. */
function inCheckout(repo: string, tip: string): boolean {
  return ["HEAD", "@{upstream}", "refs/remotes/origin/HEAD"].some((ref) =>
    spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", tip, ref], { stdio: "ignore" }).status === 0);
}
