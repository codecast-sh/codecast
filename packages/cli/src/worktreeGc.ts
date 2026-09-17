/**
 * Worktree garbage collection: release a codecast worktree when its session
 * is gone, but never one that still holds work.
 *
 * Nothing removed worktrees before this; killed and dismissed sessions left
 * `.codecast/worktrees/<name>` (and its node_modules) behind forever, and
 * port indices drifted upward with them. The same code runs on a laptop and
 * on the cloud host, where accumulated worktrees are also disk cost.
 *
 * The rule: a worktree is released only when its tree is clean AND its
 * branch holds no content that is not already on origin's default branch.
 * Dirty or unpushed work is kept and logged; a person (or `cast ws destroy`)
 * decides about that. A worktree SEEDED from a laptop checkout (workspace
 * state carries startPoint/seedBase) is always dirty and always ahead of
 * origin/main by construction, so for it the question is different: has the
 * host made anything since the seed? HEAD still at the seed base and a tree
 * still equal to the seed snapshot means the laptop still holds all of it,
 * and the worktree is released (the workspace release drops the seed ref and
 * the branch). `releaseWorkspace` does the removal (teardown hooks,
 * Chrome, `git worktree remove`, state file) when the workspace module
 * tracks the worktree; a legacy worktree with no state gets a plain
 * `git worktree remove`.
 *
 * "Not already on origin" is a question about content, not about commits.
 * Counting commits ahead of the base reads a squash merged branch as ahead
 * forever, so its worktree was never released. We merge the branch into the
 * base with `merge-tree --write-tree` instead and compare the resulting tree
 * to the base tree: an identical tree proves the branch adds nothing, however
 * its commits were rewritten. The commit count stays as the fallback for a
 * host whose git predates that flag (2.38).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  createGitCapabilityStore,
  isUnsupportedMergeTreeWriteTreeError,
  type GitCapabilityStore,
} from "./gitCapability.js";
import { execFileAsync } from "./proc.js";
import { locateWorktree } from "./worktreeEnv.js";
import { CLOUD_SEED_EXCLUDES, snapshotTree } from "./wipSnapshot.js";

export type GcVerdict =
  | { action: "released"; name: string; path: string }
  | { action: "kept"; name: string; path: string; reason: string }
  | { action: "skipped"; reason: string };

// Why: every git call here runs on the daemon's single loop (the kill path and
// the idle terminal reaper both release worktrees), so none of them may be a
// synchronous spawn — a sync `git fetch` alone stalls the HTTP server, the
// Convex subscriptions and tmux injection for its whole duration (ct-49542).
async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    timeout: timeoutMs,
    // A credential prompt on a fetch would sit on an open stdin until the
    // timeout; a GC has no one to answer it.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

export type WorktreeProbe = {
  dirty: boolean;
  /** Commits on the branch that origin's default branch does not have, or null when git could not tell. */
  aheadOfOrigin: number | null;
  /** True when merging the branch into the base changes the base tree not at all. */
  contentInBase: boolean;
  /**
   * Seeded worktrees only: the host changed something since the laptop seed
   * (a commit past the seed base, or a tree that differs from the snapshot).
   * null = not seeded, or the seed ref is gone / git failed (today's rules apply).
   */
  hostOnlyWork?: boolean | null;
};

/** Why a worktree must be kept, or null when it may go. Pure over git output. */
export function keepReason(probe: WorktreeProbe): string | null {
  if (probe.hostOnlyWork === false) return null;
  if (probe.hostOnlyWork === true) return "changes since the laptop seed";
  if (probe.dirty) return "uncommitted changes";
  // Why: a squash or rebase merge rewrites the commits, so the branch still
  // counts as ahead while its content is already on the base (ct-49542).
  if (probe.contentInBase) return null;
  if (probe.aheadOfOrigin === null) return "cannot tell whether its commits are on origin";
  if (probe.aheadOfOrigin > 0) return `${probe.aheadOfOrigin} commit(s) not on origin`;
  return null;
}

/** The default branch origin points at, or main. */
async function originDefault(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).replace(/^origin\//, "") || "main";
  } catch {
    return "main";
  }
}

/** One fetch per repository per this long, however many worktrees it releases. */
const FETCH_INTERVAL_MS = 5 * 60_000;
const fetchesByRepo = new Map<string, { at: number; run: Promise<void> }>();

/**
 * Refresh origin before judging the branch: the merge usually just happened.
 * A failure is not fatal — the probe then answers from the origin refs already
 * on disk, so an offline host still releases what it can prove is merged.
 */
async function fetchPrune(cwd: string, repoKey: string): Promise<void> {
  const now = Date.now();
  const prior = fetchesByRepo.get(repoKey);
  // Why: reaping a dozen idle sessions releases a dozen worktrees of one repo
  // within a second; without this they would each fetch the same remote.
  if (prior && now - prior.at < FETCH_INTERVAL_MS) return prior.run;
  const run = (async () => {
    try {
      if (!(await git(cwd, ["remote"])).split("\n").includes("origin")) return;
      await git(cwd, ["fetch", "--prune", "--quiet", "origin"], 10_000);
    } catch {
      /* offline or no remote: decide from the refs we already have */
    }
  })();
  fetchesByRepo.set(repoKey, { at: now, run });
  return run;
}

/**
 * True when merging `HEAD` into `baseOid` produces the base tree unchanged —
 * the branch's content is already there, squash merge included.
 */
async function contentAlreadyInBase(
  worktreePath: string,
  baseOid: string,
  caps: GitCapabilityStore,
): Promise<boolean> {
  let baseTree: string;
  try {
    baseTree = await git(worktreePath, ["rev-parse", "--verify", "--quiet", `${baseOid}^{tree}`]);
  } catch {
    return false;
  }
  try {
    return await caps.runWithFallback(
      "merge-tree-write-tree",
      async () => {
        const out = await git(worktreePath, ["merge-tree", "--write-tree", baseOid, "HEAD"]);
        const merged = out.split("\n")[0]?.trim();
        return Boolean(merged) && merged === baseTree;
      },
      () => false,
      isUnsupportedMergeTreeWriteTreeError,
    );
  } catch {
    // A conflicting merge exits non-zero: real content, not yet on the base.
    return false;
  }
}

/**
 * `startPoint`/`seedBase` (a seeded workspace's state) switch the verdict to
 * the host-only-work question; the other options belong to the fetch and
 * the merge-tree probe.
 */
export async function probeWorktree(
  worktreePath: string,
  opts: { capabilities?: GitCapabilityStore; repoKey?: string; startPoint?: string; seedBase?: string } | null = {},
): Promise<WorktreeProbe> {
  opts ??= {};
  const dirty = (await git(worktreePath, ["status", "--porcelain"])).length > 0;
  await fetchPrune(worktreePath, opts.repoKey ?? worktreePath);
  let aheadOfOrigin: number | null = null;
  let contentInBase = false;
  try {
    const base = `origin/${await originDefault(worktreePath)}`;
    const baseOid = await git(worktreePath, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    aheadOfOrigin = parseInt(await git(worktreePath, ["rev-list", "--count", `${baseOid}..HEAD`]), 10);
    if (Number.isNaN(aheadOfOrigin)) aheadOfOrigin = null;
    contentInBase =
      aheadOfOrigin === 0 ||
      (await contentAlreadyInBase(worktreePath, baseOid, opts.capabilities ?? createGitCapabilityStore()));
  } catch {
    aheadOfOrigin = null;
  }
  if (!opts.startPoint || !opts.seedBase) return { dirty, aheadOfOrigin, contentInBase };
  return { dirty, aheadOfOrigin, contentInBase, hostOnlyWork: await hostOnlyWorkSince(worktreePath, opts.startPoint, opts.seedBase) };
}

/**
 * Has the host made anything since the seed? A commit past the seed base is
 * work; otherwise the worktree's tree is written the same way the laptop's
 * snapshot was (temp index, same exclusions) and compared with the seed ref's.
 * null when the ref is gone or git fails: the caller falls through to the
 * dirty/ahead rules, which keep the worktree.
 */
async function hostOnlyWorkSince(worktreePath: string, startPoint: string, seedBase: string): Promise<boolean | null> {
  try {
    if ((await git(worktreePath, ["rev-parse", "HEAD"])) !== seedBase) return true;
    const seedTree = await git(worktreePath, ["rev-parse", `${startPoint}^{tree}`]);
    return (await snapshotTree(worktreePath, CLOUD_SEED_EXCLUDES)) !== seedTree;
  } catch {
    return null;
  }
}

/**
 * Release the worktree a session ran in, if it is a codecast worktree and
 * holds no work. `cwd` may be any path inside the worktree.
 */
export async function releaseSessionWorktree(
  cwd: string | undefined,
  log: (m: string) => void = () => {},
  isShared?: (worktreePath: string) => Promise<boolean>,
): Promise<GcVerdict> {
  if (!cwd) return { action: "skipped", reason: "no cwd" };
  const wt = locateWorktree(cwd);
  if (!wt) return { action: "skipped", reason: "not a codecast worktree" };
  const worktreePath = path.join(wt.repoRoot, ".codecast", "worktrees", wt.name);
  if (!fs.existsSync(worktreePath)) return { action: "skipped", reason: "already gone" };
  if (isShared) {
    try {
      if (await isShared(worktreePath)) {
        return { action: "kept", name: wt.name, path: worktreePath, reason: "another session uses this worktree" };
      }
    } catch {
      return { action: "kept", name: wt.name, path: worktreePath, reason: "cannot verify exclusive session ownership" };
    }
  }
  let probe: WorktreeProbe;
  try {
    // The repo root keys the fetch: releasing ten worktrees of one repo in a
    // reaper pass fetches once, not ten times. A seeded workspace's state
    // carries the seed the verdict is judged against.
    const ws = await import("./workspace/index.js");
    const state = ws.readState(wt.repoRoot, wt.name);
    probe = await probeWorktree(worktreePath, { repoKey: wt.repoRoot, startPoint: state?.startPoint, seedBase: state?.seedBase });
  } catch (err) {
    return { action: "kept", name: wt.name, path: worktreePath, reason: `git probe failed: ${(err as Error).message.split("\n")[0]}` };
  }
  const reason = keepReason(probe);
  if (reason) {
    log(`[WORKTREE-GC] kept ${wt.name}: ${reason}`);
    return { action: "kept", name: wt.name, path: worktreePath, reason };
  }
  try {
    const ws = await import("./workspace/index.js");
    if (ws.readState(wt.repoRoot, wt.name)) {
      await ws.releaseWorkspace(wt.repoRoot, wt.name);
    } else {
      await git(wt.repoRoot, ["worktree", "remove", "--force", worktreePath]);
      try { await git(wt.repoRoot, ["branch", "-D", `codecast/${wt.name}`]); } catch { /* branch may be named otherwise */ }
    }
    log(`[WORKTREE-GC] released ${wt.name} (${worktreePath})`);
    return { action: "released", name: wt.name, path: worktreePath };
  } catch (err) {
    const reason = `remove failed: ${(err as Error).message.split("\n")[0]}`;
    log(`[WORKTREE-GC] kept ${wt.name}: ${reason}`);
    return { action: "kept", name: wt.name, path: worktreePath, reason };
  }
}
