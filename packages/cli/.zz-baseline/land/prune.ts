/**
 * Patches out of a worktree, and releasing a finished one without losing it.
 *
 * Before a tree goes, its whole change (base to working state, untracked
 * files and binaries included) is written to the archive with a note of where
 * it came from, and its branch is kept as refs/codecast/land-archive/<branch>.
 * A pruned tree can come back with `git worktree add <dir> <that ref>` and
 * `git apply` of the patch. The directory itself goes to a trash sibling
 * (workspace/trash.ts) and is deleted in the background, because unlinking a
 * worktree's node_modules takes longer than the whole scan.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { codecastPath } from "../codecastDir.js";
import { execFileAsync, spawn } from "../proc.js";
import { locateWorktree } from "../worktreeEnv.js";
import { moveToTrash } from "../workspace/trash.js";
import { withWorkingIndex, type FileVerdict, type TreeReport } from "./scan.js";

export const ARCHIVE_REF_PREFIX = "refs/codecast/land-archive/";

export function archiveDir(): string {
  return codecastPath("land", "archive");
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    timeout: 300_000,
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  return String(stdout);
}

/**
 * The tree's change as a binary patch from its base, limited to files of the
 * given verdicts (all of them when `only` is omitted).
 */
export async function treePatch(tree: TreeReport, only?: FileVerdict[]): Promise<string> {
  const files = new Set(tree.files.filter((f) => !only || only.includes(f.verdict)).map((f) => f.path));
  if (files.size === 0) return "";
  const whole = await withWorkingIndex(tree.path, (env) => git(tree.path, ["diff", "--cached", "--binary", "--no-renames", tree.base], env));
  return only ? filterPatch(whole, files) : whole;
}

/** Keep the sections of a `git diff` whose path is in `files`. */
export function filterPatch(patch: string, files: ReadonlySet<string>): string {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((section) => {
      const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
      return !!m && files.has(m[2]);
    })
    .join("");
}

/** `<date>-<repo>-<tree>`: unique per tree per day, readable in a listing. */
export function archiveName(tree: TreeReport, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  const leaf = path.basename(tree.path).replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${day}-${tree.repo}-${leaf}`;
}

export interface PruneResult { path: string; archived: string | null; branchRef: string | null; error?: string }

/** Archive one tree's work and release it. The caller has already decided the tree may go. */
export async function pruneTree(tree: TreeReport, repoRoot: string): Promise<PruneResult> {
  if (tree.primary) return { path: tree.path, archived: null, branchRef: null, error: "a main checkout is never pruned" };
  let archived: string | null = null;
  if (tree.files.length > 0) {
    const dir = archiveDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = archiveName(tree);
    archived = path.join(dir, `${name}.patch`);
    fs.writeFileSync(archived, await treePatch(tree));
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
      repo: tree.repo, path: tree.path, branch: tree.branch, head: tree.head, base: tree.base,
      verdict: tree.verdict, reason: tree.reason, counts: tree.counts, owner: tree.owner,
      lastActivity: new Date(tree.lastActivity).toISOString(), prunedAt: new Date().toISOString(),
    }, null, 2));
  }

  // The branch outlives the tree under an archive ref; the branch name itself is freed.
  let branchRef: string | null = null;
  if (tree.branch && tree.head) {
    branchRef = `${ARCHIVE_REF_PREFIX}${tree.branch}`;
    await git(repoRoot, ["update-ref", branchRef, tree.head]);
  }

  const ws = locateWorktree(tree.path);
  const workspaces = await import("../workspace/index.js");
  if (ws && ws.repoRoot.replace(/\/+$/, "") === repoRoot.replace(/\/+$/, "") && workspaces.readState(ws.repoRoot, ws.name)) {
    await workspaces.releaseWorkspace(ws.repoRoot, ws.name);
  } else {
    const trash = moveToTrash(tree.path);
    await git(repoRoot, ["worktree", "prune"]);
    deleteInBackground(trash);
  }
  if (tree.branch) await git(repoRoot, ["branch", "-D", tree.branch]).catch(() => "");
  return { path: tree.path, archived, branchRef };
}

/** Unlink a trashed tree after this command exits. */
function deleteInBackground(dir: string): void {
  try {
    spawn("rm", ["-rf", dir], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the workspace trash sweep removes it later */
  }
}
