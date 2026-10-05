import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sweepHostDisk } from "./hostDiskSweep.js";
import { LANDED_REF } from "./remote/session-move.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

function world() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "host-sweep-"));
  const repo = path.join(work, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  // A move landing: a clone with what was handed over recorded, as gitPushWorktree leaves it.
  const clone = (name: string) => {
    const dir = path.join(work, name);
    execFileSync("git", ["clone", "-q", repo, dir]);
    git(dir, "update-ref", LANDED_REF, "HEAD");
    return dir;
  };
  return { work, repo, clone };
}

test("move clones: an unused clean one goes; in use, dirty, stashed or host-committed ones stay; the main checkout is never touched", async () => {
  const { work, repo, clone } = world();
  const clean = clone("repo-mv-aaaa");
  const used = clone("repo-mv-bbbb");
  const dirty = clone("repo-mv-cccc");
  fs.writeFileSync(path.join(dirty, "a.txt"), "edited\n");
  const committed = clone("repo-mv-dddd");
  fs.writeFileSync(path.join(committed, "b.txt"), "host work\n");
  git(committed, "add", "-A");
  git(committed, "commit", "-qm", "work made on the host");
  const stashed = clone("repo-mv-eeee");
  fs.writeFileSync(path.join(stashed, "a.txt"), "parked\n");
  git(stashed, "stash", "-q");
  const unrecorded = path.join(work, "repo-mv-ffff");
  execFileSync("git", ["clone", "-q", repo, unrecorded]);

  const r = await sweepHostDisk({ workDir: work, inUsePaths: [path.join(used, "sub")], log: () => {} });
  expect(r.released).toEqual([clean]);
  expect(Object.fromEntries(r.kept.map((k) => [path.basename(k.path), k.reason]))).toEqual({
    "repo-mv-cccc": "uncommitted changes", "repo-mv-dddd": "commits made on this host", "repo-mv-eeee": "stashed work", "repo-mv-ffff": "no record of what the move landed",
  });
  expect([fs.existsSync(clean), fs.existsSync(used), fs.existsSync(repo)]).toEqual([false, true, true]);
});
