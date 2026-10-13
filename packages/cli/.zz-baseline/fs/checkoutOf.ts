/**
 * The checkout a folder belongs to, read from `.git` on disk without a git
 * subprocess: the nearest ancestor holding `.git`. A linked worktree's `.git`
 * is a file naming `<checkout>/.git/worktrees/<name>`, and it folds into that
 * checkout, the way the server's git_root does. Codex keeps its worktrees
 * under ~/.codex/worktrees, outside the checkout, so a path prefix alone
 * cannot tell they belong to it. Leaf module (fs and path only): the sync
 * scope gate imports it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type CheckoutRoot = { root: string; gitDir: string } | null;

const cache = new Map<string, CheckoutRoot>();

export function checkoutRootOf(folder: string): CheckoutRoot {
  if (cache.has(folder)) return cache.get(folder)!;
  let found: CheckoutRoot = null;
  for (let dir = folder; dir && dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(dotGit); } catch {}
    // A `.git` directory without HEAD is not a repository to git (a stray
    // folder holding hooks/ and info/ was found inside a real checkout), so
    // the walk keeps going up to the checkout git itself would name.
    if (stat?.isDirectory() && fs.existsSync(path.join(dotGit, "HEAD"))) { found = { root: dir, gitDir: dotGit }; break; }
    if (stat?.isFile()) {
      let pointer: string | undefined;
      try { pointer = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim(); } catch {}
      const common = pointer?.match(/^(.*)\/\.git\/worktrees\/[^/]+$/)?.[1];
      if (common) { found = { root: common, gitDir: path.join(common, ".git") }; break; }
    }
  }
  if (cache.size > 5000) cache.clear();
  cache.set(folder, found);
  return found;
}
