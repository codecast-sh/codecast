import * as path from "node:path";
import { acquireFileLock } from "../lockFile.js";
import { execFileSync } from "../proc.js";

/**
 * Runs one `git worktree add` on `repoRoot` while no other process adds a
 * worktree to the same repository.
 *
 * git writes a new worktree's admin files under .git/worktrees/<name> one at
 * a time, and every add reads all of them while it checks that the branch is
 * not checked out elsewhere. So two adds at once can read the other's
 * commondir before it holds anything and die ("failed to read
 * .git/worktrees/line-1/commondir: Success"). Line runs start several at a
 * time on one host. One add on Union's repository takes about 3 s, so ten
 * queued adds wait about half a minute.
 */
export async function withWorktreeAdd<T>(repoRoot: string, add: () => Promise<T> | T): Promise<T> {
  const common = execFileSync("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf-8" }).trim();
  const release = await acquireFileLock(path.join(common, "codecast-worktree-add.lock"), { waitMs: 10 * 60_000, staleMs: 30 * 60_000, describe: "git worktree add" });
  try {
    return await add();
  } finally {
    release();
  }
}
