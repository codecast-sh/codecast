/**
 * A cloud host keeps its own disk: what sessions leave behind in its checkouts
 * is released once nobody uses it and it holds no work only the host has.
 *
 * Two kinds of leftovers. Codecast worktrees (`<repo>/.codecast/worktrees/*`)
 * whose session ended some way other than the kill path that already releases
 * them (worktreeGc.ts); they go through that same rule, in every checkout: the
 * ones under ~/work and the ones kept where the laptop keeps them (`checkouts`,
 * remoteRepoPath). And the clones moves once landed in beside a busy checkout
 * under ~/work (`<repo>-mv-<batch>`; moves merge into the checkout now): such
 * a clone was seeded from the laptop, so it may go when it is clean, has no
 * stash, and no commit was made in it after it landed. Anything else is kept
 * and logged, for a person to decide.
 *
 * "In use" is the server's roster of live sessions this device runs
 * (cloud:hostSessions); a path any of them sits in is never touched.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileAsync } from "./proc.js";
import { LANDED_REF, MOVE_CLONE_RE } from "./remote/session-move.js";
import { releaseSessionWorktree, type GcVerdict } from "./worktreeGc.js";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf-8", timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return String(stdout).trim();
}

const isRepo = (dir: string) => fs.existsSync(path.join(dir, ".git"));
const inUse = (dir: string, paths: readonly string[]) => paths.some((p) => p === dir || p.startsWith(`${dir}/`));

/** Why a move clone must stay, or null when it may go. */
export async function moveCloneKeepReason(dir: string): Promise<string | null> {
  if (await git(dir, ["status", "--porcelain"])) return "uncommitted changes";
  if (await git(dir, ["stash", "list"])) return "stashed work";
  if (!(await git(dir, ["rev-parse", "--verify", "--quiet", LANDED_REF]).catch(() => ""))) return "no record of what the move landed";
  // Commits on any branch beyond what the move handed over or the remotes already hold.
  if (Number(await git(dir, ["rev-list", "--count", "--branches", "--not", LANDED_REF, "--remotes"])) > 0) return "commits made on this host";
  return null;
}

export type SweepResult = { released: string[]; kept: Array<{ path: string; reason: string }> };

export async function sweepHostDisk(opts: { workDir: string; checkouts?: readonly string[]; inUsePaths: readonly string[]; log: (m: string) => void }): Promise<SweepResult> {
  const result: SweepResult = { released: [], kept: [] };
  let entries: string[] = [];
  try { entries = fs.readdirSync(opts.workDir); } catch { return result; }
  for (const name of entries) {
    const dir = path.join(opts.workDir, name);
    if (!isRepo(dir)) continue;
    if (!MOVE_CLONE_RE.test(name)) {
      await sweepWorktrees(dir, opts, result);
      continue;
    }
    if (inUse(dir, opts.inUsePaths)) continue;
    const reason = await moveCloneKeepReason(dir).catch((err) => `could not inspect it: ${String(err).split("\n")[0]}`);
    if (reason) {
      result.kept.push({ path: dir, reason });
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    opts.log(`[DISK] released move clone ${dir}`);
    result.released.push(dir);
  }
  for (const dir of opts.checkouts ?? []) {
    if (path.dirname(dir) !== opts.workDir && isRepo(dir)) await sweepWorktrees(dir, opts, result);
  }
  return result;
}

async function sweepWorktrees(repo: string, opts: { inUsePaths: readonly string[]; log: (m: string) => void }, result: SweepResult): Promise<void> {
  const root = path.join(repo, ".codecast", "worktrees");
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    const wt = path.join(root, name);
    if (!fs.statSync(wt).isDirectory() || inUse(wt, opts.inUsePaths)) continue;
    const verdict: GcVerdict = await releaseSessionWorktree(wt, opts.log).catch((err) => ({ action: "kept" as const, name, path: wt, reason: String(err).slice(0, 120) }));
    if (verdict.action === "released") result.released.push(wt);
    else if (verdict.action === "kept") result.kept.push({ path: wt, reason: verdict.reason });
  }
}

/** Free space on the disk holding `dir`, as a share of its size (0 to 1), or null when it cannot be read. */
export function freeDiskShare(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return s.blocks > 0 ? s.bavail / s.blocks : null;
  } catch {
    return null;
  }
}
