import { describe, expect, it } from "bun:test";
import { resolveComposeProjectPath } from "../inboxStore";

const recentProjects = [{ path: "/Users/j/code/recent" }];

describe("resolveComposeProjectPath", () => {
  it("caller-supplied context wins over everything", () => {
    expect(
      resolveComposeProjectPath({
        context: { projectPath: "/Users/j/code/doc-proj" },
        conversation: { projectPath: "/Users/j/code/conv" },
        activeProjectFilter: "codecast",
        activeProjectPath: "/Users/j/code/codecast",
        recentProjects,
      }),
    ).toBe("/Users/j/code/doc-proj");
  });

  it("inherits the current conversation when no filter is active", () => {
    expect(
      resolveComposeProjectPath({
        conversation: { projectPath: "/Users/j/code/conv" },
        activeProjectFilter: null,
        activeProjectPath: null,
        recentProjects,
      }),
    ).toBe("/Users/j/code/conv");
  });

  it("uses the filtered project when the conversation lives elsewhere", () => {
    expect(
      resolveComposeProjectPath({
        conversation: { projectPath: "/Users/j/code/conv" },
        activeProjectFilter: "codecast",
        activeProjectPath: "/Users/j/code/codecast",
        recentProjects,
      }),
    ).toBe("/Users/j/code/codecast");
  });

  it("keeps the conversation's own path (worktree/subdir) when it matches the filter", () => {
    expect(
      resolveComposeProjectPath({
        conversation: { gitRoot: "/Users/j/code/codecast", projectPath: "/Users/j/code/codecast/packages/web" },
        activeProjectFilter: "codecast",
        activeProjectPath: "/Users/j/code/codecast",
        recentProjects,
      }),
    ).toBe("/Users/j/code/codecast/packages/web");
  });

  it("uses the filter when there is no current conversation", () => {
    expect(
      resolveComposeProjectPath({
        conversation: {},
        activeProjectFilter: "codecast",
        activeProjectPath: "/Users/j/code/codecast",
        recentProjects,
      }),
    ).toBe("/Users/j/code/codecast");
  });

  it("falls back to the most recent project, then undefined", () => {
    expect(
      resolveComposeProjectPath({ conversation: {}, activeProjectFilter: null, activeProjectPath: null, recentProjects }),
    ).toBe("/Users/j/code/recent");
    expect(resolveComposeProjectPath({ conversation: {} })).toBeUndefined();
  });
});
