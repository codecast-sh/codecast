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
 *   - On macOS the bytes are cloned, not written: APFS gives every worktree a
 *     copy-on-write view of the same blocks, so a credential directory costs
 *     nothing to duplicate. Other filesystems fall back to a plain copy.
 */

import { execSync } from "../proc.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceManifest } from "./types.js";

export interface CopyOptions {
  /** When true, overwrites files already present at the destination. */
  overwrite?: boolean;
  /** Logger used for skip/warn messages. Defaults to console.warn. */
  log?: (msg: string) => void;
  /** Platform to copy for. Defaults to the running one; tests override it. */
  platform?: NodeJS.Platform;
}

/**
 * The copyFile mode for a platform: a copy-on-write clone on macOS, a plain
 * copy everywhere else.
 *
 * COPYFILE_FICLONE asks for a reflink and silently writes bytes when the
 * filesystem has none, so it is safe on a non-APFS Mac volume too.
 */
export function copyFileMode(platform: NodeJS.Platform = process.platform): number {
  return platform === "darwin" ? fs.constants.COPYFILE_FICLONE : 0;
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
      const mode = copyFileMode(opts.platform);
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        copyDirRecursive(src, dest, mode);
      } else {
        // copyFileSync follows symlinks by default — good for portability.
        copyFileCloning(src, dest, mode);
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
 * Copy one file, cloning its blocks when the platform offers it.
 *
 * Why the retry: a clone can be refused for reasons a plain copy survives (a
 * source and destination on different volumes, a filesystem that reports the
 * flag but rejects the operation), and a copied credential file is always
 * better than a missing one.
 */
function copyFileCloning(src: string, dest: string, mode: number): void {
  try {
    fs.copyFileSync(src, dest, mode);
  } catch (err) {
    if (mode === 0) throw err;
    fs.copyFileSync(src, dest, 0);
  }
}

/**
 * Recursive directory copy. Falls back to `cp -r` if the source is large or
 * contains symlinks that fs.cpSync can't handle.
 */
function copyDirRecursive(src: string, dest: string, mode = 0): void {
  if (typeof fs.cpSync !== "function") {
    // Older Node — shell out.
    execSync(`cp -R ${JSON.stringify(src)} ${JSON.stringify(dest)}`, { stdio: "ignore" });
    return;
  }
  const opts = { recursive: true, dereference: false, mode };
  try {
    fs.cpSync(src, dest, opts);
  } catch (err) {
    if (mode === 0) throw err;
    // Clone refused — take the plain copy, same as the single-file path.
    fs.cpSync(src, dest, { ...opts, mode: 0 });
  }
}
