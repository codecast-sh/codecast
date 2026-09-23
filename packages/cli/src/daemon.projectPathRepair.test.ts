import { describe, expect, test } from "bun:test";
import { managedWorktreeName, projectPathRepairKey, projectPathRepairNeeded } from "./daemon.js";

// The boot sweep sends conversations:updateProjectPath only for transcripts
// whose (path, git root) the server has not already confirmed for that session.
describe("projectPathRepairNeeded", () => {
  const confirmed = {
    "sess-a": projectPathRepairKey("/Users/u/src/app", "/Users/u/src/app"),
    "sess-b": projectPathRepairKey("/Users/u/src/app/packages/web", "/Users/u/src/app"),
    "sess-c": projectPathRepairKey("/tmp/scratch"),
  };

  test("an unchanged session is skipped", () => {
    expect(projectPathRepairNeeded(confirmed, "sess-a", "/Users/u/src/app", "/Users/u/src/app").send).toBe(false);
    expect(projectPathRepairNeeded(confirmed, "sess-b", "/Users/u/src/app/packages/web", "/Users/u/src/app").send).toBe(false);
    expect(projectPathRepairNeeded(confirmed, "sess-c", "/tmp/scratch", undefined).send).toBe(false);
  });

  test("a new session, a moved checkout, or a changed git root is sent", () => {
    expect(projectPathRepairNeeded(confirmed, "sess-new", "/Users/u/src/app", "/Users/u/src/app").send).toBe(true);
    expect(projectPathRepairNeeded(confirmed, "sess-a", "/Users/u/code/app", "/Users/u/code/app").send).toBe(true);
    expect(projectPathRepairNeeded(confirmed, "sess-a", "/Users/u/src/app", undefined).send).toBe(true);
    expect(projectPathRepairNeeded(confirmed, "sess-c", "/tmp/scratch", "/tmp/scratch").send).toBe(true);
  });

  test("the key it returns is what the next boot compares against", () => {
    const plan = projectPathRepairNeeded({}, "sess-x", "/p", "/g");
    expect(plan.send).toBe(true);
    expect(projectPathRepairNeeded({ "sess-x": plan.key }, "sess-x", "/p", "/g").send).toBe(false);
  });

  test("path and git root cannot alias each other in the key", () => {
    expect(projectPathRepairKey("/a\n/b")).not.toBe(projectPathRepairKey("/a", "/b"));
  });

  test("a remote learned after the root was confirmed is sent once", () => {
    const withoutRemote = projectPathRepairNeeded({}, "sess-r", "/p", "/g");
    const known = { "sess-r": withoutRemote.key };
    const withRemote = projectPathRepairNeeded(known, "sess-r", "/p", "/g", "git@github.com:o/r.git");
    expect(withRemote.send).toBe(true);
    expect(projectPathRepairNeeded({ "sess-r": withRemote.key }, "sess-r", "/p", "/g", "git@github.com:o/r.git").send).toBe(false);
  });
});

// The worktree name a session's git fields carry: codex keeps worktrees outside
// the checkout under a hash, every other layout names the folder.
describe("managedWorktreeName", () => {
  test("codex worktrees are named by their hash, not the repeated repo folder", () => {
    expect(managedWorktreeName("/Users/d/.codex/worktrees/c636/littlebird")).toBe("c636");
    expect(managedWorktreeName("/Users/d/.codex/worktrees/c636/littlebird/backend")).toBe("c636");
  });

  test("checkout-local layouts are named by the worktree folder", () => {
    expect(managedWorktreeName("/Users/d/src/app/.codecast/worktrees/fix-auth")).toBe("fix-auth");
    expect(managedWorktreeName("/Users/d/src/app/.claude/worktrees/jev-dismiss-105674/backend")).toBe("jev-dismiss-105674");
    expect(managedWorktreeName("/Users/d/src/app/.conductor/feat-x")).toBe("feat-x");
    expect(managedWorktreeName("/Users/d/.claude-worktrees/app/feat-y")).toBe("feat-y");
  });

  test("a plain checkout has no worktree name", () => {
    expect(managedWorktreeName("/Users/d/src/app")).toBeUndefined();
    expect(managedWorktreeName("/Users/d/.codex/sessions")).toBeUndefined();
  });
});
