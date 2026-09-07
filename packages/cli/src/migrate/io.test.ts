import { describe, expect, test } from "bun:test";
import { resolveLocalDestination, sameOrigin } from "./io.js";

// Where a session coming back from the cloud lands, and how two origins are
// judged to be one repository. Pure functions; the SSH/git around them are
// exercised live.

describe("sameOrigin", () => {
  test("protocol, user, .git and case do not matter", () => {
    expect(sameOrigin("git@github.com:acme/repo.git", "https://github.com/acme/repo")).toBe(true);
    expect(sameOrigin("ssh://git@github.com/acme/repo.git", "GitHub.com/Acme/Repo/")).toBe(true);
    expect(sameOrigin("git@github.com:acme/repo.git", "git@github.com:acme/other.git")).toBe(false);
    expect(sameOrigin(null, "x")).toBe(false);
    expect(sameOrigin("x", undefined)).toBe(false);
  });
});

describe("resolveLocalDestination", () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);
  const roots = [
    { root: "/Users/me/src/other", origin: "git@github.com:acme/other.git" },
    { root: "/Users/me/src/repo", origin: "git@github.com:acme/repo.git" },
  ];

  test("the path it left from wins when it still exists", () => {
    const r = resolveLocalDestination({
      sessionId: "s", remoteCwd: "/home/ubuntu/work/a", remoteOrigin: null, worktreeName: null,
      recordedLocalCwd: "/Users/me/src/repo/.codecast/worktrees/a", localRoots: roots,
      exists: exists(["/Users/me/src/repo/.codecast/worktrees/a"]),
    });
    expect(r).toEqual({ localCwd: "/Users/me/src/repo/.codecast/worktrees/a" });
  });

  test("a cloud-born worktree lands under the local checkout of the same origin, created if missing", () => {
    const r = resolveLocalDestination({
      sessionId: "s", remoteCwd: "/home/ubuntu/work/repo/.codecast/worktrees/cloud-1a2b3c", remoteOrigin: "https://github.com/acme/repo",
      worktreeName: "cloud-1a2b3c", recordedLocalCwd: null, localRoots: roots, exists: exists([]),
    });
    expect(r).toEqual({ localCwd: "/Users/me/src/repo/.codecast/worktrees/cloud-1a2b3c", createIn: "/Users/me/src/repo" });
  });

  test("an existing local worktree is reused, not recreated", () => {
    const r = resolveLocalDestination({
      sessionId: "s", remoteCwd: "/home/ubuntu/work/repo/.codecast/worktrees/w", remoteOrigin: "git@github.com:acme/repo.git",
      worktreeName: "w", recordedLocalCwd: null, localRoots: roots, exists: exists(["/Users/me/src/repo/.codecast/worktrees/w"]),
    });
    expect(r).toEqual({ localCwd: "/Users/me/src/repo/.codecast/worktrees/w" });
  });

  test("without an origin match the directory name decides", () => {
    const r = resolveLocalDestination({
      sessionId: "s", remoteCwd: "/home/ubuntu/work/repo/.codecast/worktrees/w", remoteOrigin: null,
      worktreeName: null, recordedLocalCwd: null, localRoots: roots.map((x) => ({ ...x, origin: null })), exists: exists([]),
    });
    expect(r).toEqual({ localCwd: "/Users/me/src/repo/.codecast/worktrees/w", createIn: "/Users/me/src/repo" });
  });

  test("a session that ran in the host's main checkout comes back to the local root itself", () => {
    const r = resolveLocalDestination({
      sessionId: "s", remoteCwd: "/home/ubuntu/work/repo", remoteOrigin: "git@github.com:acme/repo.git",
      worktreeName: null, recordedLocalCwd: null, localRoots: roots, exists: exists(["/Users/me/src/repo"]),
    });
    expect(r).toEqual({ localCwd: "/Users/me/src/repo" });
  });

  test("a worktree pushed whole by cast remote move (basename under the base dir) becomes a local worktree of its repo", () => {
    const r = resolveLocalDestination({
      sessionId: "s", remoteCwd: "/home/ubuntu/work/feature-x", remoteOrigin: "git@github.com:acme/repo.git",
      worktreeName: null, recordedLocalCwd: null, localRoots: roots, exists: exists([]),
    });
    expect(r).toEqual({ localCwd: "/Users/me/src/repo/.codecast/worktrees/feature-x", createIn: "/Users/me/src/repo" });
  });

  test("no local checkout at all is a clear error", () => {
    expect(() => resolveLocalDestination({
      sessionId: "s", remoteCwd: "/home/ubuntu/work/unknown/.codecast/worktrees/w", remoteOrigin: "git@github.com:acme/unknown.git",
      worktreeName: "w", recordedLocalCwd: null, localRoots: roots, exists: exists([]),
    })).toThrow(/no local checkout of git@github.com:acme\/unknown.git/);
  });
});
