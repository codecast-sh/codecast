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
  return { root, origin, worktree: checkedOut ? worktree : null, runDir, first, push };
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

  test("with the branch checked out nowhere, the branch itself moves", async () => {
    const { root, runDir, push } = prWorld(false);
    const pushed = push();
    const { change } = await refreezeSessionChange(root, runDir, null);
    expect(change.tip).toBe(pushed);
    expect(git(root, "rev-parse", "fix")).toBe(pushed);
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
