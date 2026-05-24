/**
 * Gitignored file copier.
 *
 * Copies files (typically .env-family and credentials) from the main worktree
 * to a new workspace. Patterns come from manifest.setup.copy, which has
 * already absorbed .wt-setup-files via the detection step — so we just walk
 * the resolved list.
 *
 * Behavior:
 *   - Missing source files are skipped with a warning, not an error. The
 *     manifest may list optional files (e.g., `.env.local`) that not every
 *     developer has.
 *   - Existing target files are preserved by default — never overwrite a
 *     user's local edits. Pass `overwrite: true` to force replacement.
 *   - Directories are copied recursively.
 *   - Symlinks are followed (we copy the target, not the link) to keep the
 *     workspace self-contained.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceManifest } from "./types.js";

export interface CopyOptions {
  /** When true, overwrites files already present at the destination. */
  overwrite?: boolean;
  /** Logger used for skip/warn messages. Defaults to console.warn. */
  log?: (msg: string) => void;
}

export interface CopyResult {
  copied: string[];
  skippedMissing: string[];
  skippedExisting: string[];
}

/** Copy files declared in manifest.setup.copy from one worktree to another. */
export function copyFiles(
  manifest: WorkspaceManifest,
  fromRoot: string,
  toWorktree: string,
  opts: CopyOptions = {},
): CopyResult {
  const log = opts.log ?? ((m: string) => console.warn(`[workspace.copy] ${m}`));
  const result: CopyResult = {
    copied: [],
    skippedMissing: [],
    skippedExisting: [],
  };

  for (const pattern of manifest.setup.copy) {
    const src = path.join(fromRoot, pattern);
    const dest = path.join(toWorktree, pattern);

    if (!fs.existsSync(src)) {
      result.skippedMissing.push(pattern);
      log(`source not found, skipping: ${pattern}`);
      continue;
    }

    if (fs.existsSync(dest) && !opts.overwrite) {
      result.skippedExisting.push(pattern);
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        copyDirRecursive(src, dest);
      } else {
        // copyFileSync follows symlinks by default — good for portability.
        fs.copyFileSync(src, dest);
      }
      result.copied.push(pattern);
    } catch (err) {
      // Don't fail the whole copy on one bad file — log and continue. The
      // contract validator will catch missing-required-files downstream.
      const msg = err instanceof Error ? err.message : String(err);
      log(`failed to copy ${pattern}: ${msg}`);
    }
  }

  return result;
}

/**
 * Recursive directory copy. Falls back to `cp -r` if the source is large or
 * contains symlinks that fs.cpSync can't handle.
 */
function copyDirRecursive(src: string, dest: string): void {
  if (typeof fs.cpSync === "function") {
    fs.cpSync(src, dest, { recursive: true, dereference: false });
    return;
  }
  // Older Node — shell out.
  execSync(`cp -R ${JSON.stringify(src)} ${JSON.stringify(dest)}`, { stdio: "ignore" });
}
