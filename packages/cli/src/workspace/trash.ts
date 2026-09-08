/**
 * Deferred deletion for destroyed worktrees.
 *
 * Unlinking a worktree takes seconds — node_modules alone is hundreds of
 * thousands of files — and `cast ws destroy` used to wait for all of it. A
 * rename is one directory entry, so destroy hands the tree to a `_trash-<uuid>`
 * sibling and returns; the bytes go later. The delay is the second reason:
 * a destroy of the wrong workspace is recoverable until the next workspace
 * operation sweeps the trash past its grace period (ct-49542).
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const TRASH_PREFIX = "_trash-";

/** How long a destroyed worktree stays on disk before a sweep may delete it. */
export const TRASH_GRACE_MS = 5 * 60_000;

/** Rename `target` to a trash sibling and return the new path. */
export function moveToTrash(target: string): string {
  const trashPath = path.join(path.dirname(target), `${TRASH_PREFIX}${randomUUID()}`);
  fs.renameSync(target, trashPath);
  // Why: a rename leaves the directory's own mtime untouched, and the sweep
  // ages trash by mtime — without this an idle worktree is swept at once.
  const now = new Date();
  try {
    fs.utimesSync(trashPath, now, now);
  } catch {
    /* an unstampable trash dir is swept early, never late */
  }
  return trashPath;
}

/** Delete trash siblings in `dir` that are older than the grace period. */
export async function sweepTrash(dir: string): Promise<string[]> {
  const now = Date.now();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const swept: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(TRASH_PREFIX)) continue;
    const full = path.join(dir, entry);
    try {
      if (now - fs.statSync(full).mtimeMs < TRASH_GRACE_MS) continue;
      await fs.promises.rm(full, { recursive: true, force: true });
      swept.push(full);
    } catch {
      /* a partial sweep is retried by the next one */
    }
  }
  return swept;
}
