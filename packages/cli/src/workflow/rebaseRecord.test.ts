import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExec } from "../lineMerge";
import { chainBetween, isRebaseOf, readRebaseChain, recordRebase, verifyRebaseChain } from "./rebaseRecord";

// A station's rebase records: written on the server and in rebase.json as a
// chain, and re-derived link by link before Merge trusts any of them.

function repo() {
  const root = mkdtempSync(join(tmpdir(), "rebase-record-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@x", ...args], { cwd, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  const commit = (file: string, text: string) => { writeFileSync(join(work, file), text); git(work, "add", file); git(work, "commit", "-q", "-m", file); return git(work, "rev-parse", "HEAD"); };
  commit("a.txt", "a\n");
  git(work, "push", "-q", "origin", "main");
  return { root, work, git, commit, done: () => rmSync(root, { recursive: true, force: true }) };
}

describe("rebase records", () => {
  test("recordRebase posts first, then extends rebase.json's chain when the new link starts where it ended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rebase-run-"));
    try {
      const posts: unknown[] = [];
      const post = async (path: string, body: Record<string, unknown>) => { posts.push({ path, body }); return {}; };
      const [r, x, y, z] = ["1", "2", "3", "4"].map((c) => c.repeat(40));
      await recordRebase({ post, runId: "run_1", runDir: dir, from: r, to: x });
      await recordRebase({ post, runId: "run_1", runDir: dir, from: x, to: y });
      expect(JSON.parse(readFileSync(join(dir, "rebase.json"), "utf-8"))).toEqual({ from: x, to: y, links: [{ from: r, to: x }, { from: x, to: y }] });
      expect(posts).toEqual([{ path: "/cli/workflow-runs/rebase", body: { run_id: "run_1", from: r, to: x } }, { path: "/cli/workflow-runs/rebase", body: { run_id: "run_1", from: x, to: y } }]);
      expect(chainBetween(readRebaseChain(dir), r, y)).toEqual([{ from: r, to: x }, { from: x, to: y }]);
      expect(chainBetween(readRebaseChain(dir), r, z)).toBeNull();
      // A link that does not continue the chain starts a new one.
      await recordRebase({ post, runId: "run_1", runDir: dir, from: z, to: r });
      expect(readRebaseChain(dir)).toEqual([{ from: z, to: r }]);
      // A refused record writes nothing.
      await expect(recordRebase({ post: async () => { throw new Error("refused"); }, runId: "run_1", runDir: dir, from: r, to: x })).rejects.toThrow("refused");
      expect(readRebaseChain(dir)).toEqual([{ from: z, to: r }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a link is trusted only when `to` is exactly `from` rebased onto main; a chain is checked link by link", () => {
    const g = repo();
    try {
      g.git(g.work, "checkout", "-q", "-b", "change");
      g.commit("b.txt", "b\n");
      const reviewed = g.commit("c.txt", "c\n");
      // Main moves; the change is rebased onto it, twice.
      const rebase = (from: string, file: string) => {
        g.git(g.work, "checkout", "-q", "main");
        g.commit(file, `${file}\n`);
        g.git(g.work, "push", "-q", "origin", "main");
        g.git(g.work, "checkout", "-q", "--detach", from);
        g.git(g.work, "rebase", "-q", "main");
        g.git(g.work, "fetch", "-q", "origin");
        return g.git(g.work, "rev-parse", "HEAD");
      };
      const x = rebase(reviewed, "m1.txt");
      const y = rebase(x, "m2.txt");
      expect(isRebaseOf(defaultExec, g.work, "main", { from: reviewed, to: x })).toBe(true);
      expect(isRebaseOf(defaultExec, g.work, "main", { from: x, to: y })).toBe(true);
      // A commit with something more in it is no rebase, however it is recorded.
      g.git(g.work, "checkout", "-q", "--detach", y);
      const extra = g.commit("evil.txt", "unreviewed\n");
      expect(isRebaseOf(defaultExec, g.work, "main", { from: x, to: extra })).toBe(false);

      const dir = join(g.root, "run");
      mkdirSync(dir);
      writeFileSync(join(dir, "rebase.json"), JSON.stringify({ from: x, to: y, links: [{ from: reviewed, to: x }, { from: x, to: y }] }));
      expect(verifyRebaseChain(defaultExec, g.work, "main", readRebaseChain(dir), reviewed, y)).toBeNull();
      writeFileSync(join(dir, "rebase.json"), JSON.stringify({ from: x, to: extra, links: [{ from: reviewed, to: x }, { from: x, to: extra }] }));
      expect(verifyRebaseChain(defaultExec, g.work, "main", readRebaseChain(dir), reviewed, extra)).toBe(`the recorded rebase of ${x.slice(0, 10)} into ${extra.slice(0, 10)} is not a rebase of it onto main; it must be reviewed again`);
      expect(verifyRebaseChain(defaultExec, g.work, "main", readRebaseChain(dir), reviewed, reviewed)).toBeNull();
    } finally { g.done(); }
  }, { timeout: 60_000 });
});
