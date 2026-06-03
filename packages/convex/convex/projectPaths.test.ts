import { describe, expect, test } from "bun:test";
import { normalizeProjectPath, pickInheritedGitMeta } from "./projectPaths";

describe("normalizeProjectPath", () => {
  // Regression: a session whose cwd fell back to $HOME (e.g. a remote/resume
  // path that couldn't resolve the real project) records git_root="/Users/m1".
  // That phantom must never become a "recent project" chip.
  test("drops bare home directories and shallower paths", () => {
    expect(normalizeProjectPath("/Users/m1")).toBeNull();
    expect(normalizeProjectPath("/Users/ashot")).toBeNull();
    expect(normalizeProjectPath("/home/ubuntu")).toBeNull();
    expect(normalizeProjectPath("/Users")).toBeNull();
    expect(normalizeProjectPath("/home")).toBeNull();
    expect(normalizeProjectPath("/root")).toBeNull();
    expect(normalizeProjectPath("/")).toBeNull();
  });

  test("keeps real project roots", () => {
    expect(normalizeProjectPath("/Users/ashot/src/codecast")).toBe("/Users/ashot/src/codecast");
    expect(normalizeProjectPath("/home/ubuntu/repos/api")).toBe("/home/ubuntu/repos/api");
    expect(normalizeProjectPath("/Users/ashot/Desktop/scratch")).toBe("/Users/ashot/Desktop/scratch");
  });

  test("trims to the repo dir below a recognized code parent", () => {
    expect(normalizeProjectPath("/Users/ashot/src/codecast/packages/web")).toBe("/Users/ashot/src/codecast");
    expect(normalizeProjectPath("/Users/ashot/projects/foo/bar")).toBe("/Users/ashot/projects/foo");
  });

  test("strips worktree suffixes", () => {
    expect(normalizeProjectPath("/Users/ashot/src/codecast/.conductor/feat-x")).toBe("/Users/ashot/src/codecast");
    expect(normalizeProjectPath("/Users/ashot/src/codecast/.codecast/worktrees/wt1")).toBe("/Users/ashot/src/codecast");
  });

  test("drops temp dirs (incl. macOS /private/var/folders)", () => {
    expect(normalizeProjectPath("/tmp/whatever")).toBeNull();
    expect(normalizeProjectPath("/private/tmp/x")).toBeNull();
    expect(normalizeProjectPath("/var/folders/sr/t5/T/cc-inject-clear-1")).toBeNull();
    expect(normalizeProjectPath("/private/var/folders/sr/t5/T/cc-inject-clear-1")).toBeNull();
  });
});

describe("pickInheritedGitMeta", () => {
  // Regression: a "New Session" off a task whose path was last recorded on
  // another machine (/Users/ec2-user/...) used to inherit the path with NO
  // git_remote_url, so the local daemon couldn't remap it to the local checkout
  // and flashed "clone it first". The remote must be recovered from the task's
  // source conversations, where a daemon stamped it.
  test("recovers the remote + repo root from a foreign source conversation", () => {
    expect(
      pickInheritedGitMeta([
        {
          git_remote_url: "git@github.com:ashot/union-mobile.git",
          git_root: "/Users/ec2-user/src/union-mobile",
          updated_at: 1000,
        },
      ]),
    ).toEqual({
      git_remote_url: "git@github.com:ashot/union-mobile.git",
      git_root: "/Users/ec2-user/src/union-mobile",
    });
  });

  test("picks the most-recently-active source that has a remote", () => {
    expect(
      pickInheritedGitMeta([
        { git_remote_url: "git@github.com:ashot/old.git", git_root: "/a", updated_at: 10 },
        { git_remote_url: "git@github.com:ashot/new.git", git_root: "/b", updated_at: 99 },
        { git_remote_url: "git@github.com:ashot/mid.git", git_root: "/c", updated_at: 50 },
      ]),
    ).toEqual({ git_remote_url: "git@github.com:ashot/new.git", git_root: "/b" });
  });

  test("skips sources with no remote and falls back to started_at", () => {
    expect(
      pickInheritedGitMeta([
        { git_root: "/no-remote", updated_at: 999 },
        { git_remote_url: "git@github.com:ashot/real.git", git_root: "/real", started_at: 5 },
      ]),
    ).toEqual({ git_remote_url: "git@github.com:ashot/real.git", git_root: "/real" });
  });

  test("returns nulls when no source carries a remote", () => {
    expect(pickInheritedGitMeta([])).toEqual({ git_remote_url: null, git_root: null });
    expect(
      pickInheritedGitMeta([{ git_root: "/x", updated_at: 1 }, { git_remote_url: null, git_root: "/y" }]),
    ).toEqual({ git_remote_url: null, git_root: null });
  });
});
