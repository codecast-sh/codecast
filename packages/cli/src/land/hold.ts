/**
 * A worktree marked held stays on its branch: `cast land` and /deploy report
 * it as "held" with its reason and never land or prune it.
 *
 * The marker lives in the tree's own git dir (`.git/worktrees/<name>/cast-held`),
 * not its working tree, so it is never one of the tree's changes, never
 * committed, and goes away with the worktree.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface HoldMark { reason: string; at: number; by?: string }

const MARKER = "cast-held";

/** The tree's own git dir: `.git` itself in the main checkout, the `gitdir:` it names in a linked worktree. */
export function treeGitDir(tree: string): string | null {
  const dotGit = path.join(tree, ".git");
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf-8"));
    return m ? path.resolve(tree, m[1].trim()) : null;
  } catch {
    return null;
  }
}

/** The tree's hold, or null when it is not held. An unreadable marker still holds, with that as its reason. */
export function readHold(tree: string): HoldMark | null {
  const dir = treeGitDir(tree);
  if (!dir) return null;
  let text: string;
  try { text = fs.readFileSync(path.join(dir, MARKER), "utf-8"); } catch { return null; }
  try {
    const mark = JSON.parse(text) as HoldMark;
    if (typeof mark.reason === "string" && mark.reason.trim()) return mark;
  } catch {}
  return { reason: text.trim() || "held (marker gives no reason)", at: 0 };
}

export function writeHold(tree: string, reason: string, by?: string): HoldMark {
  const dir = treeGitDir(tree);
  if (!dir) throw new Error(`${tree} is not a git worktree`);
  const mark: HoldMark = { reason: reason.trim(), at: Date.now(), ...(by ? { by } : {}) };
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(mark) + "\n");
  return mark;
}

/** Remove the tree's hold. False when it was not held. */
export function clearHold(tree: string): boolean {
  const dir = treeGitDir(tree);
  if (!dir) return false;
  try { fs.unlinkSync(path.join(dir, MARKER)); return true; } catch { return false; }
}
