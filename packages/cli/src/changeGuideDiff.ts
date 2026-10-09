import { spawnSync } from "./proc.js";
import * as fs from "fs";
import * as path from "path";

// The diff a change guide's hunks are cut from (ct-57527): the working tree
// against where this work branched from origin/main, so committed and
// uncommitted changes both show. A file git does not track yet diffs against
// nothing. Paths in the guide are relative to the repository root.

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

/** `(file) => unified diff | null` for parseChangeGuide, rooted at the repository. */
export function guideDiffReader(cwd: string, base?: string): { root: string; base: string; diffFor: (file: string) => string | null } {
  const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim() || cwd;
  const from = guideDiffBase(root, base);
  return {
    root,
    base: from,
    diffFor: (file) => {
      const tracked = git(root, ["diff", "--no-color", "--no-ext-diff", from, "--", file]);
      if (tracked) return tracked;
      if (!fs.existsSync(path.join(root, file))) return null;
      // Untracked: --no-index exits 1 when the files differ, which is the point.
      return git(root, ["diff", "--no-color", "--no-index", "--", "/dev/null", file], [0, 1]) || null;
    },
  };
}
