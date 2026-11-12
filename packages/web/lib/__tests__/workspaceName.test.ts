import { describe, expect, test } from "bun:test";
import { workspaceNameOf } from "../projectColors";

describe("workspaceNameOf", () => {
  test("a repository's folder name", () => {
    expect(workspaceNameOf({ git_root: "/Users/r/Documents/GitHub/littlebird" })).toBe("littlebird");
  });
  test("a worktree counts as its repository", () => {
    expect(workspaceNameOf({ git_root: "/Users/r/Documents/GitHub/littlebird/.claude/worktrees/agent-a1" })).toBe("littlebird");
    expect(workspaceNameOf({ git_root: "/Users/r/x/codecast/.codecast/worktrees/fix" })).toBe("codecast");
    expect(workspaceNameOf({ git_root: "/Users/r/x/codecast/.conductor/oslo" })).toBe("codecast");
  });
  test("a folder under ~/code is the repository it sits in", () => {
    expect(workspaceNameOf({ project_path: "/Users/r/code/codecast/packages/web" })).toBe("codecast");
  });
  test("git root wins over the working folder", () => {
    expect(workspaceNameOf({ git_root: "/a/b/repo", project_path: "/elsewhere/sub" })).toBe("repo");
  });
  test("no folder, no workspace", () => {
    expect(workspaceNameOf({})).toBeNull();
  });
});
