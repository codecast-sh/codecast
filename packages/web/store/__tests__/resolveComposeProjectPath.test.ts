import { describe, expect, it } from "bun:test";
import { resolveComposeProjectPath, findProjectPathByName, bucketProjectPath } from "../inboxStore";
import type { InboxSession } from "../inboxStore";

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

  it("finds a named project among recents, sessions, then machine roots", () => {
    const sessions = {
      s1: { _id: "s1", git_root: "/Users/j/code/codecast", project_path: "/Users/j/code/codecast" },
    } as unknown as Record<string, InboxSession>;
    // Recent project wins.
    expect(
      findProjectPathByName("codecast", {
        recentProjects: [{ path: "/Users/j/code/other" }, { path: "/Users/j/src/codecast" }],
        sessions,
      }),
    ).toBe("/Users/j/src/codecast");
    // Then a session's checkout.
    expect(findProjectPathByName("codecast", { recentProjects, sessions })).toBe("/Users/j/code/codecast");
    // A teammate's checkout no machine of mine has is skipped; the roster's own root still resolves.
    expect(
      findProjectPathByName("codecast", {
        sessions: {
          s1: { _id: "s1", git_root: "/Users/samvit/dev/codecast" },
        } as unknown as Record<string, InboxSession>,
        machineRoster: [{ local_project_roots: ["/Users/j/code/recent", "/Users/j/code/codecast"] }],
      }),
    ).toBe("/Users/j/code/codecast");
    // Nothing known → undefined.
    expect(findProjectPathByName("codecast", { recentProjects })).toBeUndefined();
  });

  it("never seeds from a teammate's conversation whose checkout no machine of mine has", () => {
    const machineRoster = [{ local_project_roots: ["/Users/j/code/recent", "/Users/j/code/conv"] }];
    expect(
      resolveComposeProjectPath({
        conversation: { projectPath: "/Users/samvit/dev/codecast" },
        machineRoster,
        recentProjects,
      }),
    ).toBe("/Users/j/code/recent");
    // My own conversation still seeds through the same roster.
    expect(
      resolveComposeProjectPath({
        conversation: { projectPath: "/Users/j/code/conv" },
        machineRoster,
        recentProjects,
      }),
    ).toBe("/Users/j/code/conv");
    // Roster not loaded yet — don't filter.
    expect(
      resolveComposeProjectPath({
        conversation: { projectPath: "/Users/samvit/dev/codecast" },
        machineRoster: [],
        recentProjects,
      }),
    ).toBe("/Users/samvit/dev/codecast");
  });
});

describe("bucketProjectPath", () => {
  const sessions = {
    a: { _id: "a", updated_at: 1, git_root: "/Users/j/code/old" },
    b: { _id: "b", updated_at: 5, git_root: "/Users/j/code/codex-proj" },
    c: { _id: "c", updated_at: 9, git_root: "/Users/j/code/other" },
  } as unknown as Record<string, InboxSession>;
  const bucketAssignments = {
    a: { conversation_id: "a", bucket_id: "codex" },
    b: { conversation_id: "b", bucket_id: "codex" },
    c: { conversation_id: "c", bucket_id: "misc" },
  } as never;

  it("picks the most recently updated session filed under the active label", () => {
    expect(bucketProjectPath({ activeBucketFilter: "codex", chipFilterExclude: false, sessions, bucketAssignments })).toBe(
      "/Users/j/code/codex-proj",
    );
  });

  it("seeds nothing for an exclude chip or no label", () => {
    expect(bucketProjectPath({ activeBucketFilter: "codex", chipFilterExclude: true, sessions, bucketAssignments })).toBeUndefined();
    expect(bucketProjectPath({ activeBucketFilter: null, chipFilterExclude: false, sessions, bucketAssignments })).toBeUndefined();
  });

  it("skips checkouts none of my machines have", () => {
    const machineRoster = [{ local_project_roots: ["/Users/j/code/old"] }];
    expect(
      bucketProjectPath({ activeBucketFilter: "codex", chipFilterExclude: false, sessions, bucketAssignments, machineRoster }),
    ).toBe("/Users/j/code/old");
  });
});
