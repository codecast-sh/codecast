import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claimRunBranch } from "./runBranch.js";
import { lineRunDir } from "./runner.js";
import { writeFrozenChange } from "./flowChangeFile.js";

// Real git: what matters is which worktree git says holds the branch, and that no commit on it is lost.
let repo: string;
let savedDir: string | undefined;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const OURS = "change-ct-1";
const BRANCH = `codecast/${OURS}`;
const OTHER = "change-ct-2";
const treeOf = (name: string) => path.join(repo, ".codecast", "worktrees", name);
const live = (...names: string[]) => async () => new Set(names);

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-branch-")));
  savedDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = path.join(repo, "host-state");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".codecast/\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  // The task's branch, holding a committed change.
  git(repo, "branch", BRANCH);
  git(repo, "worktree", "add", "-q", path.join(repo, "scratch"), BRANCH);
  fs.writeFileSync(path.join(repo, "scratch", "a.txt"), "the reviewed change\n");
  git(path.join(repo, "scratch"), "commit", "-qam", "the reviewed change");
  git(repo, "worktree", "remove", "--force", path.join(repo, "scratch"));
});

afterEach(() => {
  try { git(repo, "worktree", "prune"); } catch {}
  fs.rmSync(repo, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = savedDir;
});

/** Another run's worktree `name` with `BRANCH` checked out, as `cast flow run --branch` makes it. */
async function otherRunOn(name: string): Promise<void> {
  const { acquireWorkspace } = await import("../workspace/lifecycle.js");
  await acquireWorkspace(repo, name, { branch: BRANCH, skipPool: true, skipSetup: true, skipHooks: true, noPorts: true });
  fs.mkdirSync(lineRunDir(repo, name), { recursive: true });
}

describe("a change run claims its branch (ct-98893)", () => {
  test("a freeze refuses while another live run's worktree has the branch, and moves nothing", async () => {
    await otherRunOn(OTHER);
    const tip = git(repo, "rev-parse", BRANCH);
    await expect(claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, liveTrees: live(OTHER) }))
      .rejects.toThrow(`${BRANCH} is checked out by worktree ${OTHER}, where a live run works`);
    expect(git(repo, "rev-parse", BRANCH)).toBe(tip);
    expect(fs.existsSync(treeOf(OTHER))).toBe(true);
  });

  test("so does a run of the branch as it stands", async () => {
    await otherRunOn(OTHER);
    await expect(claimRunBranch(repo, "change-ct-3", BRANCH, { task: "ct-3", rewrites: false, liveTrees: live(OTHER) }))
      .rejects.toThrow("where a live run works");
  });

  test("when whether that run is live cannot be told, it refuses rather than guess", async () => {
    await otherRunOn(OTHER);
    await expect(claimRunBranch(repo, "change-ct-3", BRANCH, { task: "ct-3", rewrites: false, liveTrees: async () => null }))
      .rejects.toThrow("cannot be told");
  });

  test("an ended run's worktree holding the branch is released, its leftovers committed onto the branch, and the branch checks out again", async () => {
    await otherRunOn(OTHER);
    fs.writeFileSync(path.join(treeOf(OTHER), "a.txt"), "left uncommitted\n");
    const log = console.log;
    console.log = () => {};
    let notice: string | null;
    try {
      notice = await claimRunBranch(repo, "change-ct-3", BRANCH, { task: "ct-3", rewrites: false, liveTrees: live() });
    } finally { console.log = log; }
    expect(notice!).toContain(`Released worktree ${OTHER}, which an ended run left holding ${BRANCH}; what it left uncommitted is committed onto ${BRANCH}`);
    expect(fs.existsSync(treeOf(OTHER))).toBe(false);
    expect(git(repo, "show", `${BRANCH}:a.txt`)).toBe("left uncommitted");
    const { acquireWorkspace } = await import("../workspace/lifecycle.js");
    const ws = await acquireWorkspace(repo, "change-ct-3", { branch: BRANCH, skipPool: true, skipSetup: true, skipHooks: true, noPorts: true });
    expect(git(ws.workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
  }, 60_000);

  test("a worktree no run made holding the branch refuses: it is not the run's to move", async () => {
    git(repo, "worktree", "add", "-q", path.join(repo, "mine"), BRANCH);
    await expect(claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: false, liveTrees: live() }))
      .rejects.toThrow(`which no run made`);
    expect(git(path.join(repo, "mine"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
  });

  test("the run's own earlier worktree holding the branch is its own to reuse", async () => {
    git(repo, "worktree", "add", "-q", treeOf(OURS), BRANCH);
    writeFrozenChange(lineRunDir(repo, OURS), { source: "session", base: git(repo, "rev-parse", "main"), tip: git(repo, "rev-parse", BRANCH), branch: BRANCH, worktree: OURS, paths: ["a.txt"], shared: [], held: [] });
    expect(await claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, liveTrees: live(OURS) })).toBeNull();
  });

  test("a freeze refuses while the branch holds commits no freeze of this run made", async () => {
    await expect(claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, liveTrees: live() }))
      .rejects.toThrow(`${BRANCH} holds commits no run of ct-1 froze`);
  });

  test("a freeze goes ahead over its own earlier freeze, over a branch the checkout already holds, and with no branch yet", async () => {
    writeFrozenChange(lineRunDir(repo, OURS), { source: "session", base: git(repo, "rev-parse", "main"), tip: git(repo, "rev-parse", BRANCH), branch: BRANCH, worktree: OURS, paths: ["a.txt"], shared: [], held: [] });
    expect(await claimRunBranch(repo, OURS, BRANCH, { task: "ct-1", rewrites: true, liveTrees: live() })).toBeNull();
    git(repo, "branch", "codecast/change-ct-4", "main");
    expect(await claimRunBranch(repo, "change-ct-4", "codecast/change-ct-4", { task: "ct-4", rewrites: true, liveTrees: live() })).toBeNull();
    expect(await claimRunBranch(repo, "change-ct-5", "codecast/change-ct-5", { task: "ct-5", rewrites: true, liveTrees: live() })).toBeNull();
  });
});
