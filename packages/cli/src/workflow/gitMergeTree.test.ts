import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExec, type Exec } from "../lineMerge";
import { MERGE_TREE_FALLBACK_ENV, mergeTree } from "./gitMergeTree";

// The native `git merge-tree --write-tree` and the emulation older gits get
// must answer every merge the same: the tree, and the paths that conflicted.

function repo() {
  const work = mkdtempSync(join(tmpdir(), "merge-tree-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@x", ...args], { cwd: work, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  const write = (file: string, text: string) => writeFileSync(join(work, file), text);
  const commit = (msg: string) => { git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", msg); return git("rev-parse", "HEAD"); };
  return { work, git, write, commit, done: () => rmSync(work, { recursive: true, force: true }) };
}

const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i] ?? `line ${i}`).join("\n") + "\n";

/** Both paths for one merge. */
function both(work: string, ours: string, theirs: string, opts: { mergeBase?: string } = {}) {
  const native = mergeTree(defaultExec, work, ours, theirs, opts);
  process.env[MERGE_TREE_FALLBACK_ENV] = "1";
  try { return { native, emulated: mergeTree(defaultExec, work, ours, theirs, opts) }; } finally { delete process.env[MERGE_TREE_FALLBACK_ENV]; }
}

describe("mergeTree", () => {
  afterEach(() => { delete process.env[MERGE_TREE_FALLBACK_ENV]; });

  test("a clean merge gives the same tree on both paths: edits apart in one file, adds, deletes and a mode change", () => {
    const g = repo();
    try {
      g.write("f.txt", lines(30)); g.write("gone.txt", "x\n"); g.write("run.sh", "echo\n");
      const base = g.commit("base");
      g.write("f.txt", lines(30, { 2: "ours" })); unlinkSync(join(g.work, "gone.txt")); g.write("ours.txt", "o\n");
      const ours = g.commit("ours");
      g.git("checkout", "-q", "-b", "side", base);
      g.write("f.txt", lines(30, { 27: "theirs" })); chmodSync(join(g.work, "run.sh"), 0o755); g.write("theirs.txt", "t\n");
      const theirs = g.commit("theirs");
      const { native, emulated } = both(g.work, ours, theirs);
      expect(native?.conflicts).toEqual([]);
      expect(emulated).toEqual(native);
    } finally { g.done(); }
  });

  test("an edit both sides made to the same line, and a modify/delete, conflict on both paths", () => {
    const g = repo();
    try {
      g.write("f.txt", lines(10)); g.write("d.txt", "keep\n");
      const base = g.commit("base");
      g.write("f.txt", lines(10, { 4: "ours" })); g.write("d.txt", "changed\n");
      const ours = g.commit("ours");
      g.git("checkout", "-q", "-b", "side", base);
      g.write("f.txt", lines(10, { 4: "theirs" })); unlinkSync(join(g.work, "d.txt"));
      const theirs = g.commit("theirs");
      const { native, emulated } = both(g.work, ours, theirs);
      expect(native?.conflicts).toEqual(["d.txt", "f.txt"]);
      expect(emulated?.conflicts).toEqual(["d.txt", "f.txt"]);
    } finally { g.done(); }
  });

  test("an explicit merge base replays one commit the way a cherry-pick does, on both paths", () => {
    const g = repo();
    try {
      g.write("f.txt", lines(20));
      const base = g.commit("base");
      g.write("f.txt", lines(20, { 1: "main" }));
      const main = g.commit("main");
      g.git("checkout", "-q", "-b", "side", base);
      g.write("a.txt", "a\n");
      g.commit("a");
      g.write("f.txt", lines(20, { 18: "pick" }));
      const pick = g.commit("pick");
      const { native, emulated } = both(g.work, main, pick, { mergeBase: `${pick}^` });
      expect(native?.conflicts).toEqual([]);
      expect(emulated).toEqual(native);
      // The commit before the picked one is not in the result.
      expect(g.git("ls-tree", "--name-only", native!.tree)).toBe("f.txt");
    } finally { g.done(); }
  });

  test("a rename the other side touched: the emulation refuses where the native merge follows it, never the reverse", () => {
    const g = repo();
    try {
      g.write("old.ts", lines(12)); g.write("edit.ts", lines(12)); g.write("other.ts", "y\n");
      const base = g.commit("base");
      g.git("mv", "old.ts", "new.ts"); g.git("mv", "edit.ts", "moved.ts");
      const main = g.commit("main renames both");
      g.git("checkout", "-q", "-b", "change", base);
      unlinkSync(join(g.work, "old.ts")); g.write("edit.ts", lines(12, { 3: "edited" }));
      const change = g.commit("the change deletes one and edits the other");
      const { native, emulated } = both(g.work, main, change);
      // Rename against delete conflicts on both paths: read alone it would merge clean into main's own tree.
      expect(native?.conflicts).toContain("new.ts");
      expect(emulated?.conflicts).toContain("new.ts");
      // Rename against an edit: the native merge carries the edit across, the emulation refuses.
      expect(native?.conflicts).not.toContain("moved.ts");
      expect(emulated?.conflicts).toContain("moved.ts");
    } finally { g.done(); }
  });

  test("histories with nothing in common cannot be merged on either path", () => {
    const g = repo();
    try {
      g.write("f.txt", "a\n");
      const ours = g.commit("ours");
      g.git("checkout", "-q", "--orphan", "other");
      g.write("f.txt", "b\n");
      const theirs = g.commit("theirs");
      const { native, emulated } = both(g.work, ours, theirs);
      expect(native).toBeNull();
      expect(emulated).toBeNull();
    } finally { g.done(); }
  });

  test("a git that does not know --write-tree (exit 129) gets the emulated merge", () => {
    const g = repo();
    try {
      g.write("f.txt", lines(10));
      const base = g.commit("base");
      g.write("f.txt", lines(10, { 0: "ours" }));
      const ours = g.commit("ours");
      g.git("checkout", "-q", "-b", "side", base);
      g.write("f.txt", lines(10, { 9: "theirs" }));
      const theirs = g.commit("theirs");
      const asked: string[] = [];
      const oldGit: Exec = (cmd, args, cwd, env) => {
        asked.push(args[0]);
        if (args[0] === "merge-tree") return { status: 129, stdout: "", stderr: "error: unknown option `write-tree'\nusage: git merge-tree <base-tree> <branch1> <branch2>\n" };
        return defaultExec(cmd, args, cwd, env);
      };
      const merged = mergeTree(oldGit, g.work, ours, theirs);
      expect(asked).toContain("read-tree");
      expect(merged).toEqual(mergeTree(defaultExec, g.work, ours, theirs));
    } finally { g.done(); }
  });
});
