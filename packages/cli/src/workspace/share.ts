/**
 * Shared directories: one dependency install serving every worktree.
 *
 * A fresh worktree has no node_modules and no .venv, and installing one per
 * worktree costs minutes and gigabytes. `setup.share` names directories the
 * worktree borrows from the primary checkout through a symlink instead.
 *
 * Two rules make sharing safe:
 *
 *   - Only directories that EXIST in the primary checkout and are GITIGNORED
 *     are shared. A tracked directory is already materialized by the checkout,
 *     and a symlink at an unignored path shows up as a worktree diff.
 *   - A directory that holds workspace links back into the repo is refused.
 *     Sharing it would make every workspace import inside the worktree resolve
 *     to the PRIMARY checkout's source, so tests silently run against two
 *     trees at once (see the worktree-node-modules-symlink-escapes-tree memory,
 *     ct-49541).
 *
 * The functions are synchronous: detection is a synchronous API, the git probe
 * is one batched `check-ignore`, and linking a handful of directories is a few
 * symlink(2) calls.
 */

import { execFileSync } from "../proc.js";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Directories detection offers to share when they exist and are gitignored.
 *
 * Dependency installs only, never build outputs: two worktrees hold different
 * code, so one shared `target/` or `dist/` would have them overwrite each
 * other's artifacts.
 */
export const SHARE_CANDIDATES: readonly string[] = [
  "node_modules",
  ".venv",
  "venv",
  "vendor",
];

/** A Windows drive designator, including the drive-relative `C:foo` form. */
const WINDOWS_DRIVE = /^[a-zA-Z]:/;

/**
 * A configured entry as a repo-relative path, or null when it names something
 * outside the repo. Entries are only ever relative to the checkout root; an
 * absolute path or a `..` hop would place the link anywhere on disk.
 *
 * Both separators are checked on every host, so the same entry is judged the
 * same way wherever it is read.
 */
export function safeShareName(raw: string): string | null {
  const rel = raw.trim();
  if (!rel || rel.startsWith("/") || rel.startsWith("\\")) return null;
  if (WINDOWS_DRIVE.test(rel)) return null;
  if (rel.split(/[\\/]/).includes("..")) return null;
  return rel;
}

/**
 * The subset of `names` this machine can actually share from `primaryRoot`.
 * Never throws: a repo without git, or a name that turns out to be a file,
 * drops out of the list rather than blocking worktree creation.
 */
export function resolveSharedDirectories(
  primaryRoot: string,
  names: readonly string[] | undefined,
): string[] {
  // Why undefined is a real input: a workspace created before setup.share
  // existed has a persisted manifest without the field (ct-49541).
  if (!names) return [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of names) {
    const rel = safeShareName(raw);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(primaryRoot, rel));
    } catch {
      continue; // not installed yet — nothing to share
    }
    if (stat.isDirectory()) candidates.push(rel);
  }
  if (candidates.length === 0) return [];

  const ignored = gitIgnoredPaths(primaryRoot, candidates);
  return candidates.filter(
    (rel) => ignored.has(rel) && !holdsEscapingLinks(primaryRoot, rel),
  );
}

/**
 * Symlink each shared directory from the primary checkout into the worktree.
 * Returns the entries actually linked.
 *
 * An entry already present in the worktree is left alone — a real directory
 * there is the developer's, and re-linking an existing link is a no-op.
 */
export function linkSharedDirectories(
  primaryRoot: string,
  worktreePath: string,
  names: readonly string[] | undefined,
): string[] {
  const linked: string[] = [];
  for (const rel of resolveSharedDirectories(primaryRoot, names)) {
    const target = path.join(worktreePath, rel);
    if (pathExists(target)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // "junction" is ignored on POSIX and is the only directory link Windows
      // creates without developer mode; both take the absolute source.
      fs.symlinkSync(path.join(primaryRoot, rel), target, "junction");
      linked.push(rel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[workspace.share] failed to share ${rel}: ${msg}`);
    }
  }
  return linked;
}

/**
 * Remove shared-directory symlinks from a worktree. Returns what was unlinked.
 *
 * Why destroy must call this FIRST: a directory-only ignore rule
 * (`node_modules/`) matches the primary's real directory but never the
 * worktree's symlink, so git reports the link as untracked and refuses
 * `git worktree remove` without --force.
 *
 * Takes the CONFIGURED names rather than a resolved list, for the same reason:
 * resolution would have dropped the very entries whose ignore rule stops
 * matching once they are a link. Only symbolic links are removed, so a real
 * directory sharing the name is never destroyed.
 */
export function unlinkSharedDirectories(
  worktreePath: string,
  names: readonly string[] | undefined,
): string[] {
  const unlinked: string[] = [];
  if (!names) return unlinked;
  for (const raw of names) {
    const rel = safeShareName(raw);
    if (!rel) continue;
    const target = path.join(worktreePath, rel);
    try {
      if (!fs.lstatSync(target).isSymbolicLink()) continue;
      fs.unlinkSync(target);
      unlinked.push(rel);
    } catch {
      // Absent or unreadable: nothing of ours to remove.
    }
  }
  return unlinked;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pathExists(target: string): boolean {
  try {
    // lstat, so a pre-existing (even broken) link is preserved, not replaced.
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** The subset of `rels` git ignores in `repoRoot`. Empty when git can't say. */
function gitIgnoredPaths(repoRoot: string, rels: readonly string[]): Set<string> {
  let out = "";
  try {
    out = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: repoRoot,
      input: rels.join("\n"),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch (err) {
    // Exit 1 means "nothing matched" and still carries the matches on stdout;
    // any other failure (not a repo) leaves the set empty.
    out = (err as { stdout?: string }).stdout ?? "";
  }
  return new Set(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

/**
 * True if `rel` holds symlinks pointing back into the repo but outside `rel`
 * itself — the shape a package manager creates for workspace packages
 * (`node_modules/@scope/web -> ../../packages/web`).
 *
 * Why refuse those: the links are relative and resolve from the real
 * directory, so inside a worktree they reach the PRIMARY checkout's source
 * with no error, and a test run there mixes two trees (ct-49541). Links that
 * stay inside the shared directory (`.bin` entries, a store layout) are fine —
 * they resolve to the same shared install either way.
 */
function holdsEscapingLinks(primaryRoot: string, rel: string): boolean {
  // The real path, so a relative link resolved below lands under the same
  // prefix we compare against (/var vs /private/var on macOS).
  const root = realPath(primaryRoot);
  const shared = path.join(root, rel);
  return scanForEscapingLinks(shared, shared, root, 2);
}

function scanForEscapingLinks(
  dir: string,
  shared: string,
  root: string,
  depth: number,
): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = path.resolve(dir, fs.readlinkSync(full));
      } catch {
        continue;
      }
      if (isInside(root, resolved) && !isInside(shared, resolved)) return true;
      continue;
    }
    // Scoped packages (`@scope/`) nest one level deeper; nothing else does.
    if (depth > 1 && entry.isDirectory() && entry.name.startsWith("@")) {
      if (scanForEscapingLinks(full, shared, root, depth - 1)) return true;
    }
  }
  return false;
}

function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
