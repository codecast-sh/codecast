// `git merge-tree --write-tree` on every git a host runs. The command (and its
// --name-only, --no-messages) arrived in git 2.38 and --merge-base in 2.40;
// some hosts still run 2.34. On those this does the same three-way merge in a
// throwaway index: read-tree the merge, merge each file both sides changed
// with merge-file, write-tree. The result reads the same either way: the
// merged tree and the paths that conflicted. A clean merge gives the same tree
// on both paths; a conflicted one differs only in its markers' labels.
//
// The emulation follows no renames. A file one side renamed and the other
// side touched (changed, deleted, or added at the new name) is therefore
// reported as conflicted, even where the native merge carries the edit across:
// read alone, a rename beside a deletion merges clean into a tree that still
// holds the renamed file, which would call a change landed that never was. So
// where the two paths differ, the emulation only ever refuses (a rebase is
// reviewed again, a change is not yet called landed).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Exec } from "../lineMerge.js";
import { isUnsupportedMergeTreeWriteTreeError } from "../gitCapability.js";

export type MergeTree = { tree: string; conflicts: string[] };

/** Set only by tests, to take the emulated path on a git that has the native command. */
export const MERGE_TREE_FALLBACK_ENV = "CODECAST_TEST_MERGE_TREE_FALLBACK";

/** The three-way merge of `theirs` into `ours` (over `mergeBase` when given, else their merge base); null when git cannot merge them at all. */
export function mergeTree(exec: Exec, cwd: string, ours: string, theirs: string, opts: { mergeBase?: string } = {}): MergeTree | null {
  if (process.env[MERGE_TREE_FALLBACK_ENV] !== "1") {
    const r = exec("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", ...(opts.mergeBase ? [`--merge-base=${opts.mergeBase}`] : []), ours, theirs], cwd);
    if (r.status === 0 || r.status === 1) {
      const [tree, ...paths] = r.stdout.split("\n").map((l) => l.trim());
      return tree ? { tree, conflicts: r.status === 1 ? [...new Set(paths.filter(Boolean))] : [] } : null;
    }
    // 129 is git's answer to an option it does not know (--write-tree before 2.38, --merge-base before 2.40).
    if (r.status !== 129 && !isUnsupportedMergeTreeWriteTreeError(r.stderr)) return null;
  }
  return emulated(exec, cwd, ours, theirs, opts.mergeBase);
}

function emulated(exec: Exec, cwd: string, ours: string, theirs: string, mergeBase?: string): MergeTree | null {
  const git = (args: string[], env?: Record<string, string>) => exec("git", args, cwd, env);
  const base = mergeBase ?? git(["merge-base", ours, theirs]).stdout.split("\n")[0].trim();
  const gitDir = git(["rev-parse", "--absolute-git-dir"]).stdout.trim();
  if (!base || !gitDir) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-merge-tree-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    if (git(["read-tree", "-m", "-i", "--aggressive", base, ours, theirs], env).status !== 0) return null;
    // What read-tree left unmerged: path -> its entries by stage (1 base, 2 ours, 3 theirs).
    const unmerged = new Map<string, Record<number, { mode: string; sha: string }>>();
    for (const line of git(["ls-files", "-u", "-z"], env).stdout.split("\0").filter(Boolean)) {
      const [meta, file] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
      const [mode, sha, stage] = meta.split(" ");
      unmerged.set(file, { ...unmerged.get(file), [Number(stage)]: { mode, sha } });
    }
    const unpack = (sha: string) => path.join(dir, exec("git", ["--git-dir", gitDir, "unpack-file", sha], dir).stdout.trim());
    const conflicts: string[] = [];
    // Renames read-tree cannot see: each side's renamed files the other side touched.
    const renamed = (side: string) => {
      const out = git(["diff", "--name-status", "-z", "--find-renames", "--diff-filter=R", base, side]).stdout.split("\0");
      const pairs: [string, string][] = [];
      for (let i = 0; i + 2 < out.length; i += 3) pairs.push([out[i + 1], out[i + 2]]);
      return pairs;
    };
    const touched = (side: string) => new Set(git(["diff", "--name-only", "-z", "--no-renames", base, side]).stdout.split("\0").filter(Boolean));
    for (const [side, other] of [[ours, theirs], [theirs, ours]]) {
      const otherTouched = touched(other);
      for (const [from, to] of renamed(side)) if (otherTouched.has(from) || otherTouched.has(to)) conflicts.push(to);
    }
    for (const [file, s] of unmerged) {
      let keep = s[2] ?? s[3]!;
      let clean = false;
      const regular = (e?: { mode: string }) => !e || e.mode === "100644" || e.mode === "100755";
      if (s[2] && s[3] && regular(s[1]) && regular(s[2]) && regular(s[3])) {
        const [a, b] = [unpack(s[2].sha), unpack(s[3].sha)];
        const o = s[1] ? unpack(s[1].sha) : path.join(dir, "empty");
        if (!s[1]) fs.writeFileSync(o, "");
        clean = exec("git", ["merge-file", "-q", a, o, b], dir).status === 0;
        const mode = s[2].mode === s[3].mode ? s[2].mode : s[2].mode === s[1]?.mode ? s[3].mode : s[3].mode === s[1]?.mode ? s[2].mode : null;
        if (!mode) clean = false;
        keep = { mode: mode ?? s[2].mode, sha: git(["hash-object", "-w", a]).stdout.trim() };
      }
      if (!clean) conflicts.push(file);
      git(["update-index", "--force-remove", "--", file], env);
      if (git(["update-index", "--add", "--cacheinfo", `${keep.mode},${keep.sha},${file}`], env).status !== 0) return null;
    }
    const tree = git(["write-tree"], env);
    return tree.status === 0 ? { tree: tree.stdout.trim(), conflicts: [...new Set(conflicts)].sort() } : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
