// End to end (flows.md FL4): a pull request's change frozen again after its
// session pushed a fix. The branch is checked out in the run's own worktree,
// so a fetch straight into the branch is refused; the refreeze fetches into
// origin's remote-tracking ref and moves that worktree (or the branch, when
// no worktree has it). A worktree holding uncommitted work, or a fetch that
// fails, stops the refreeze and says why. Real git with a bare origin.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { refreezeSessionChange, writeFrozenChange, type FrozenChange } from "./flowChange";
import { readFrozenChange } from "./flowChangeFile";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
let sandbox = "";

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-flow-pr-")));
  for (const [k, v] of Object.entries({ ...ENV, HOME: sandbox })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV } }).replace(/\n$/, "");
const write = (dir: string, file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);

let worlds = 0;
/**
 * A checkout cloned from a bare origin with the pull request's branch `fix`, a
 * run's change recorded on it, and (unless `checkedOut` is false) the run's
 * worktree with `fix` checked out. `push` lands a new commit on origin's `fix`,
 * as the pull request's session would.
 */
function prWorld(checkedOut = true) {
  const dir = path.join(sandbox, `w${++worlds}`);
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const root = path.join(dir, "shared");
  fs.mkdirSync(seed, { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(seed, "init", "-q", "-b", "main");
  write(seed, "a.ts", "export const a = 1;\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "base");
  git(seed, "checkout", "-qb", "fix");
  write(seed, "a.ts", "export const a = 2;\n");
  git(seed, "commit", "-qam", "first try");
  git(seed, "push", "-q", origin, "main", "fix");
  git(dir, "clone", "-q", origin, root);
  git(root, "branch", "-q", "fix", "origin/fix");
  const first = git(root, "rev-parse", "fix");
  const worktree = path.join(dir, "run-wt");
  if (checkedOut) git(root, "worktree", "add", "-q", worktree, "fix");
  const runDir = path.join(root, ".git", "run-pr");
  const change: FrozenChange = { source: "pr", session: "jx7pppp", conversation: "jx7pppppppppppppppppppppppppppp1", base: first, tip: first, branch: "fix", worktree: "run-wt", paths: [], shared: [], held: [] };
  writeFrozenChange(runDir, change);
  const push = () => {
    write(seed, "a.ts", "export const a = 3;\n");
    git(seed, "commit", "-qam", "second try");
    git(seed, "push", "-q", origin, "fix");
    return git(origin, "rev-parse", "fix");
  };
  // The session rewrote the branch (a rebase) and force-pushed it: the old tip is not under the new one.
  const forcePush = () => {
    git(seed, "reset", "-q", "--hard", "HEAD~1");
    write(seed, "a.ts", "export const a = 4;\n");
    git(seed, "commit", "-qam", "rewritten");
    git(seed, "push", "-qf", origin, "fix");
    return git(origin, "rev-parse", "fix");
  };
  // The session rebased the branch onto a main that moved, and force-pushed it: every change it had is still there.
  const rebasePush = () => {
    git(seed, "checkout", "-q", "main");
    write(seed, "b.ts", "export const b = 1;\n");
    git(seed, "add", "b.ts");
    git(seed, "commit", "-qm", "main moved");
    git(seed, "checkout", "-q", "fix");
    git(seed, "rebase", "-q", "main");
    git(seed, "push", "-qf", origin, "main", "fix");
    return git(origin, "rev-parse", "fix");
  };
  return { root, origin, worktree: checkedOut ? worktree : null, runDir, first, push, forcePush, rebasePush };
}

describe("a pull request's change is frozen again from what its session pushed", () => {
  test("with the branch checked out in the run's worktree, the worktree moves to the pushed tip", async () => {
    const { root, worktree, runDir, push } = prWorld();
    const pushed = push();
    const { change, moved } = await refreezeSessionChange(root, runDir, worktree);
    expect(change.tip).toBe(pushed);
    expect(moved).toBe(true);
    expect(git(root, "rev-parse", "refs/remotes/origin/fix")).toBe(pushed);
    expect(git(root, "rev-parse", "fix")).toBe(pushed);
    expect(git(worktree!, "rev-parse", "HEAD")).toBe(pushed);
    expect(fs.readFileSync(path.join(worktree!, "a.ts"), "utf-8")).toBe("export const a = 3;\n");
    expect(readFrozenChange(runDir)?.tip).toBe(pushed);
  }, 180_000);

  test("the run's own worktree follows a force-push: it holds no work of its own", async () => {
    const { root, worktree, runDir, forcePush } = prWorld();
    const pushed = forcePush();
    const { change } = await refreezeSessionChange(root, runDir, worktree);
    expect(change.tip).toBe(pushed);
    expect(git(worktree!, "rev-parse", "HEAD")).toBe(pushed);
  }, 180_000);

  test("another worktree with the branch moves only when the pushed tip fast-forwards it", async () => {
    const { root, worktree, runDir, push } = prWorld();
    const pushed = push();
    // Not the run's worktree: a fast-forward still moves it.
    const { change } = await refreezeSessionChange(root, runDir, null);
    expect(change.tip).toBe(pushed);
    expect(git(worktree!, "rev-parse", "HEAD")).toBe(pushed);
  }, 180_000);

  test("another worktree with commits the pushed branch lacks is never moved, and the commits are named", async () => {
    const { root, worktree, runDir, push } = prWorld();
    push();
    write(worktree!, "a.ts", "export const a = 'local';\n");
    git(worktree!, "commit", "-qam", "unpushed local work");
    const local = git(worktree!, "rev-parse", "HEAD");
    const refused = refreezeSessionChange(root, runDir, null);
    await expect(refused).rejects.toThrow(/checked out in .*run-wt, which has commits the pushed branch lacks \(\w+ unpushed local work\)/);
    expect(git(worktree!, "rev-parse", "HEAD")).toBe(local);
    expect(git(root, "rev-parse", "fix")).toBe(local);
  }, 180_000);

  test("with the branch checked out nowhere, the branch itself moves", async () => {
    const { root, runDir, push } = prWorld(false);
    const pushed = push();
    const { change } = await refreezeSessionChange(root, runDir, null);
    expect(change.tip).toBe(pushed);
    expect(git(root, "rev-parse", "fix")).toBe(pushed);
  }, 180_000);

  test("a branch no worktree holds, with commits the pushed branch lacks, is never moved, and the commits are named", async () => {
    const { root, runDir, push } = prWorld(false);
    push();
    const local = git(root, "commit-tree", `${git(root, "rev-parse", "fix")}^{tree}`, "-p", "fix", "-m", "unpushed local work");
    git(root, "update-ref", "refs/heads/fix", local);
    await expect(refreezeSessionChange(root, runDir, null)).rejects.toThrow(/branch fix has commits here the pushed branch lacks \(\w+ unpushed local work\)/);
    expect(git(root, "rev-parse", "fix")).toBe(local);
  }, 180_000);

  test("a rebase force-pushed over the branch moves it: the tip carries every change it had", async () => {
    const { root, origin, runDir, first, rebasePush } = prWorld(false);
    const pushed = rebasePush();
    // Not a fast-forward: the old commits are not under the new tip.
    expect(() => git(origin, "merge-base", "--is-ancestor", first, pushed)).toThrow();
    const { change } = await refreezeSessionChange(root, runDir, null);
    expect(change.tip).toBe(pushed);
    expect(git(root, "rev-parse", "fix")).toBe(pushed);
  }, 180_000);

  test("a rebase force-pushed over local-only work still refuses, naming only that work", async () => {
    const { root, runDir, rebasePush } = prWorld(false);
    rebasePush();
    git(root, "checkout", "-q", "fix");
    write(root, "c.ts", "export const c = 1;\n");
    git(root, "add", "c.ts");
    git(root, "commit", "-qm", "unpushed local work");
    git(root, "checkout", "-q", "main");
    const local = git(root, "rev-parse", "fix");
    const refused = refreezeSessionChange(root, runDir, null);
    await expect(refused).rejects.toThrow(/lacks \(\w+ unpushed local work\)/);
    expect(git(root, "rev-parse", "fix")).toBe(local);
  }, 180_000);

  test("a worktree holding uncommitted work on the branch stops the refreeze and is named", async () => {
    const { root, worktree, runDir, first, push } = prWorld();
    push();
    write(worktree!, "a.ts", "export const a = 'mine';\n");
    await expect(refreezeSessionChange(root, runDir, worktree)).rejects.toThrow(new RegExp(`checked out in ${worktree!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, which holds uncommitted work`));
    expect(git(root, "rev-parse", "fix")).toBe(first);
    expect(fs.readFileSync(path.join(worktree!, "a.ts"), "utf-8")).toBe("export const a = 'mine';\n");
    expect(readFrozenChange(runDir)?.tip).toBe(first);
  }, 180_000);

  test("a fetch that fails stops the refreeze instead of reading the old tip", async () => {
    const { root, worktree, runDir, origin } = prWorld();
    fs.rmSync(origin, { recursive: true, force: true });
    await expect(refreezeSessionChange(root, runDir, worktree)).rejects.toThrow(/Could not fetch the pull request's branch fix from origin/);
  }, 180_000);
});
