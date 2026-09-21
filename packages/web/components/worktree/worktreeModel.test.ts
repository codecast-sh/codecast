import { describe, expect, test } from "bun:test";
import type { WorktreeEntry } from "@codecast/shared/contracts";
import type { RepoCheckout } from "../../hooks/useRepoBrowse";
import { findWorktree, groupWorktrees, worktreeCondition, worktreeRefOfCode, worktreesOfSession } from "./worktreeModel";

const ROOT = "/Users/ashot/src/union-mobile";
const wt = (over: Partial<WorktreeEntry> & { name: string }): WorktreeEntry => ({ path: `${ROOT}/.codecast/worktrees/${over.name}`, head_sha: "abc", manager: "codecast", ...over });
const checkout = (mine: boolean, worktrees: WorktreeEntry[]): RepoCheckout => ({ root: ROOT, default_branch: "main", truncated: false, sessions_live: true, at: 1, owner: null, mine, worktrees });

const main = wt({ name: "union-mobile", path: ROOT, main: true, manager: "git", branch: "main" });
const tips = wt({ name: "tips-modes", branch: "codecast/tips-modes" });
const theirs = wt({ name: "tips-modes", branch: "codecast/tips-modes", head_sha: "theirs" });
const CHECKOUTS = [checkout(true, [main, tips]), checkout(false, [theirs])];

describe("findWorktree", () => {
  test("finds by absolute path, by a home relative path, by name and by branch", () => {
    expect(findWorktree(CHECKOUTS, { path: tips.path })?.worktree).toBe(tips);
    expect(findWorktree(CHECKOUTS, { path: "~/src/union-mobile/.codecast/worktrees/tips-modes/" })?.worktree).toBe(tips);
    expect(findWorktree(CHECKOUTS, { name: "tips-modes" })?.worktree).toBe(tips);
    expect(findWorktree(CHECKOUTS, { branch: "codecast/tips-modes" })?.worktree).toBe(tips);
  });

  test("a name two machines share means the viewer's own", () => {
    expect(findWorktree(CHECKOUTS, { name: "tips-modes" })?.checkout.mine).toBe(true);
  });

  test("a path inside a worktree the list lacks still resolves by its name, and nothing else matches", () => {
    expect(findWorktree(CHECKOUTS, { path: "/home/box/work/union-mobile/.codecast/worktrees/tips-modes/app" })?.worktree).toBe(tips);
    expect(findWorktree(CHECKOUTS, { name: "missing" })).toBeNull();
    expect(findWorktree(undefined, { name: "tips-modes" })).toBeNull();
  });

  test("the default branch never reads as a worktree reference", () => {
    expect(findWorktree(CHECKOUTS, { branch: "main" })).toBeNull();
  });
});

describe("worktreeRefOfCode", () => {
  test("inline code is a worktree only as a path inside one or a branch one has checked out", () => {
    expect(worktreeRefOfCode("codecast/tips-modes", CHECKOUTS)?.worktree).toBe(tips);
    expect(worktreeRefOfCode("~/src/union-mobile/.codecast/worktrees/tips-modes", CHECKOUTS)?.worktree).toBe(tips);
    expect(worktreeRefOfCode(".codecast/worktrees/tips-modes", CHECKOUTS)?.worktree).toBe(tips);
    expect(worktreeRefOfCode("~/src/union-mobile/.codecast/worktrees", CHECKOUTS)).toBeNull();
    expect(worktreeRefOfCode("~/src/union-mobile/.codecast/worktrees/tips-modes/app/tips.ts", CHECKOUTS)).toBeNull();
    expect(worktreeRefOfCode("tips-modes", CHECKOUTS)).toBeNull();
    expect(worktreeRefOfCode("codecast/other", CHECKOUTS)).toBeNull();
    expect(worktreeRefOfCode("git checkout codecast/tips-modes", CHECKOUTS)).toBeNull();
  });
});

describe("worktreesOfSession", () => {
  const acquired = wt({ name: "acquired", sessions: ["conv1"] });
  const list = [checkout(true, [{ ...main, sessions: ["conv1"] }, tips, acquired])];

  test("a session born in a worktree names it, with or without a published list", () => {
    expect(worktreesOfSession(undefined, { _id: "c", worktree_name: "tips-modes" }).map((r) => r.name)).toEqual(["tips-modes"]);
    expect(worktreesOfSession(list, { _id: "c", project_path: `${tips.path}/packages/web` }).map((r) => r.name)).toEqual(["tips-modes"]);
  });

  test("a session in the main checkout names the worktrees it edited files in", () => {
    const session = { _id: "c", project_path: ROOT, recent_files: [`${tips.path}/packages/web/app.ts`, `${ROOT}/packages/cli/x.ts`, `${tips.path}/b.ts`] };
    expect(worktreesOfSession(undefined, session)).toEqual([{ name: "tips-modes", path: tips.path }]);
  });

  test("a session in the main checkout names the worktrees whose record names it, never the main checkout", () => {
    expect(worktreesOfSession(list, { _id: "conv1", project_path: ROOT }).map((r) => r.name)).toEqual(["acquired"]);
    expect(worktreesOfSession(list, { _id: "other", project_path: ROOT })).toEqual([]);
  });
});

describe("groupWorktrees", () => {
  test("main first, then by who made them, occupied ones leading", () => {
    const groups = groupWorktrees([
      wt({ name: "quiet", committed_at: 9 }),
      wt({ name: "agent-1", manager: "claude", path: `${ROOT}/.claude/worktrees/agent-1` }),
      wt({ name: "busy", sessions: ["c1"], committed_at: 1 }),
      main,
    ]);
    expect(groups.map((g) => [g.key, g.worktrees.map((w) => w.name)])).toEqual([
      ["main", ["union-mobile"]],
      ["codecast", ["busy", "quiet"]],
      ["claude", ["agent-1"]],
    ]);
  });
});

describe("worktreeCondition", () => {
  test("says whether a worktree still holds anything main lacks", () => {
    expect(worktreeCondition(wt({ name: "a", dirty: true, ahead: 3, behind: 68 }))).toEqual({ tone: "work", label: "uncommitted changes · 3 ahead" });
    expect(worktreeCondition(wt({ name: "a", dirty: false, ahead: 0, behind: 12 }))).toEqual({ tone: "ok", label: "nothing main lacks" });
    expect(worktreeCondition(wt({ name: "a", state: "broken", dirty: true }))).toEqual({ tone: "bad", label: "setup is broken" });
    expect(worktreeCondition(wt({ name: "a", prunable: true }))).toEqual({ tone: "bad", label: "directory is gone" });
    expect(worktreeCondition(wt({ name: "a" }))).toEqual({ tone: "idle", label: "not inspected" });
  });
});
