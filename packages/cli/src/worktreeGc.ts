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
 * branch has nothing that is not already on origin's default branch. Dirty
 * or unpushed work is kept and logged; a person (or `cast ws destroy`)
 * decides about that. `releaseWorkspace` does the removal (teardown hooks,
 * Chrome, `git worktree remove`, state file) when the workspace module
 * tracks the worktree; a legacy worktree with no state gets a plain
 * `git worktree remove`.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { locateWorktree } from "./worktreeEnv.js";

export type GcVerdict =
  | { action: "released"; name: string; path: string }
  | { action: "kept"; name: string; path: string; reason: string }
  | { action: "skipped"; reason: string };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  }).trim();
}

/** Why a worktree must be kept, or null when it may go. Pure over git output. */
export function keepReason(probe: {
  dirty: boolean;
  aheadOfOrigin: number | null;
}): string | null {
  if (probe.dirty) return "uncommitted changes";
  if (probe.aheadOfOrigin === null) return "cannot tell whether its commits are on origin";
  if (probe.aheadOfOrigin > 0) return `${probe.aheadOfOrigin} commit(s) not on origin`;
  return null;
}

/** The default branch origin points at, or main. */
function originDefault(cwd: string): string {
  try {
    return git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "") || "main";
  } catch {
    return "main";
  }
}

export function probeWorktree(worktreePath: string): { dirty: boolean; aheadOfOrigin: number | null } {
  const dirty = git(worktreePath, ["status", "--porcelain"]).length > 0;
  let aheadOfOrigin: number | null = null;
  try {
    const base = `origin/${originDefault(worktreePath)}`;
    aheadOfOrigin = parseInt(git(worktreePath, ["rev-list", "--count", `${base}..HEAD`]), 10);
    if (Number.isNaN(aheadOfOrigin)) aheadOfOrigin = null;
  } catch {
    aheadOfOrigin = null;
  }
  return { dirty, aheadOfOrigin };
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
  let probe: { dirty: boolean; aheadOfOrigin: number | null };
  try {
    probe = probeWorktree(worktreePath);
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
      git(wt.repoRoot, ["worktree", "remove", "--force", worktreePath]);
      try { git(wt.repoRoot, ["branch", "-D", `codecast/${wt.name}`]); } catch { /* branch may be named otherwise */ }
    }
    log(`[WORKTREE-GC] released ${wt.name} (${worktreePath})`);
    return { action: "released", name: wt.name, path: worktreePath };
  } catch (err) {
    const reason = `remove failed: ${(err as Error).message.split("\n")[0]}`;
    log(`[WORKTREE-GC] kept ${wt.name}: ${reason}`);
    return { action: "kept", name: wt.name, path: worktreePath, reason };
  }
}
