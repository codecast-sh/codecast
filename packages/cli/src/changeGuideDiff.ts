import { spawnSync } from "./proc.js";
import * as fs from "fs";
import * as path from "path";

// The diff a change guide's hunks are cut from (ct-57527): the working tree
// against where this work branched from origin/main, so committed and
// uncommitted changes both show. A file git does not track yet diffs against
// nothing. Paths in the guide are relative to the repository root; one written
// relative to the directory the command ran in is resolved to that (resolve).

function git(cwd: string, args: string[], okCodes = [0]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return okCodes.includes(r.status ?? -1) ? r.stdout : null;
}

export function guideDiffBase(cwd: string, base?: string): string {
  if (base) return base;
  for (const ref of ["origin/main", "origin/HEAD", "main"]) {
    const sha = git(cwd, ["merge-base", "HEAD", ref])?.trim();
    if (sha) return sha;
  }
  return "HEAD";
}

/**
 * `(file) => unified diff | null` for parseChangeGuide, rooted at the
 * repository, and `resolve(file)`, the repository-relative path a guide step
 * means: as written when the root has it, else relative to `cwd` (a guide
 * written from a package directory), else as written.
 */
export function guideDiffReader(cwd: string, base?: string): { root: string; base: string; resolve: (file: string) => string; diffFor: (file: string) => string | null } {
  const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim() || cwd;
  const from = guideDiffBase(root, base);
  const rootDiff = (file: string) => {
    const tracked = git(root, ["diff", "--no-color", "--no-ext-diff", from, "--", file]);
    if (tracked) return tracked;
    if (!fs.existsSync(path.join(root, file))) return null;
    // Untracked: --no-index exits 1 when the files differ, which is the point.
    return git(root, ["diff", "--no-color", "--no-index", "--", "/dev/null", file], [0, 1]) || null;
  };
  const resolve = (file: string) => {
    const fromCwd = path.relative(root, path.resolve(cwd, file)).split(path.sep).join("/");
    const candidates = path.isAbsolute(file) ? [fromCwd] : [...new Set([file, fromCwd])];
    // A deleted file exists nowhere on disk but still has a diff.
    return candidates.find((f) => !f.startsWith("..") && fs.existsSync(path.join(root, f)))
      ?? candidates.find((f) => !f.startsWith("..") && rootDiff(f))
      ?? file;
  };
  return { root, base: from, resolve, diffFor: (file) => rootDiff(resolve(file)) };
}
