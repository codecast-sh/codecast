// A branch run through a flow on a machine that never had it locally (pushed
// from another device) starts from origin's tip, never from this checkout's
// HEAD: a branch made from HEAD holds none of the change, and the ship step's
// rebase then reads it as already landed.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { branchHead } from "./flowChange";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: ENV }).trim();
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-branch-head-")));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function world() {
  const origin = path.join(sandbox, `origin-${Math.random().toString(36).slice(2)}`);
  const other = `${origin}-other`;
  const here = `${origin}-here`;
  git(sandbox, "init", "-q", "--bare", "-b", "main", origin);
  git(sandbox, "clone", "-q", origin, other);
  fs.writeFileSync(path.join(other, "a.txt"), "base\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "base");
  git(other, "push", "-q", "origin", "HEAD:main");
  git(sandbox, "clone", "-q", origin, here);
  git(other, "checkout", "-q", "-b", "ashot/feature");
  fs.writeFileSync(path.join(other, "a.txt"), "change\n");
  git(other, "commit", "-q", "-am", "the change");
  git(other, "push", "-q", "origin", "ashot/feature");
  return { other, here, tip: git(other, "rev-parse", "HEAD") };
}

describe("branchHead", () => {
  test("a branch only on origin starts from origin's tip, and becomes a local branch there", async () => {
    const { here, tip } = world();
    expect(await branchHead(here, "ashot/feature")).toEqual({ head: tip, remote_tip: tip });
    expect(git(here, "rev-parse", "refs/heads/ashot/feature")).toBe(tip);
    expect(git(here, "rev-parse", "HEAD")).not.toBe(tip);
  });

  test("a local branch keeps its own head", async () => {
    const { here, tip } = world();
    git(here, "branch", "ashot/feature", "HEAD");
    const local = git(here, "rev-parse", "HEAD");
    expect(await branchHead(here, "ashot/feature")).toEqual({ head: local, remote_tip: tip });
  });

  test("a branch nowhere is empty, not its own name", async () => {
    const { here } = world();
    expect((await branchHead(here, "nobody/branch")).head).toBe("");
  });
});
