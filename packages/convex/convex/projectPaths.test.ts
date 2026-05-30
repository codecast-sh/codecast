import { describe, expect, test } from "bun:test";
import { normalizeProjectPath } from "./projectPaths";

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
