import { describe, expect, test } from "bun:test";
import {
  mergeRecentProjectPaths,
  recentProjectPathsFromSessionKeys,
  recentProjectPathsFromSessions,
  recentProjectSessionKey,
} from "./recentProjectPaths";

describe("recentProjectPathsFromSessions", () => {
  test("recovers and ranks the current user's recent folders", () => {
    expect(recentProjectPathsFromSessions([
      { user_id: "me", project_path: "/Users/me/dev/codecast", updated_at: 10 },
      { user_id: "me", project_path: "/Users/me/dev/union/union-mobile", updated_at: 30 },
      { user_id: "me", git_root: "/Users/me/dev/codecast", updated_at: 20 },
      { user_id: "teammate", project_path: "/Users/them/private", updated_at: 99 },
    ], "me")).toEqual([
      { path: "/Users/me/dev/union/union-mobile", count: 1, lastActive: 30 },
      { path: "/Users/me/dev/codecast", count: 2, lastActive: 20 },
    ]);
  });

  test("drops home, temp, and foreign-user rows", () => {
    expect(recentProjectPathsFromSessions([
      { user_id: "me", project_path: "/Users/me", updated_at: 30 },
      { user_id: "me", project_path: "/private/tmp/test", updated_at: 20 },
      { user_id: "them", project_path: "/Users/them/dev/app", updated_at: 10 },
    ], "me")).toEqual([]);
  });
});

describe("mergeRecentProjectPaths", () => {
  test("preserves server ranking and appends missing local paths", () => {
    expect(mergeRecentProjectPaths(
      [{ path: "/server/a", count: 2, lastActive: 20 }],
      [
        { path: "/local/b", count: 1, lastActive: 30 },
        { path: "/server/a", count: 1, lastActive: 10 },
      ],
    ).map((project) => project.path)).toEqual(["/server/a", "/local/b"]);
  });
});

describe("recentProjectSessionKey", () => {
  test("stays stable across heartbeat updates within a minute", () => {
    const before = recentProjectSessionKey({ user_id: "me", project_path: "/repo", updated_at: 120_001 });
    const after = recentProjectSessionKey({ user_id: "me", project_path: "/repo", updated_at: 179_999 });
    expect(after).toBe(before);
    expect(recentProjectPathsFromSessionKeys([after], "me")[0]?.path).toBe("/repo");
  });
});
