import { describe, expect, test } from "bun:test";
import {
  browseProjectOrder,
  frequentProjectChips,
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

describe("frequentProjectChips", () => {
  const projects = [
    { path: "/dev/rarely", count: 1, lastActive: 90 },
    { path: "/dev/daily", count: 30, lastActive: 80 },
    { path: "/dev/sometimes", count: 5, lastActive: 70 },
    { path: "/dev/weekly", count: 12, lastActive: 60 },
    { path: "/dev/often", count: 20, lastActive: 50 },
    { path: "/roots/unused", count: 0, lastActive: 0, suggested: true },
  ];

  test("caps at 4 most-used and never includes suggestions", () => {
    expect(frequentProjectChips(projects).map((p) => p.path)).toEqual([
      "/dev/daily",
      "/dev/often",
      "/dev/weekly",
      "/dev/sometimes",
    ]);
  });

  test("returns fewer chips when there is less real usage", () => {
    expect(frequentProjectChips([
      { path: "/roots/a", count: 0, lastActive: 0, suggested: true },
      { path: "/dev/one", count: 2, lastActive: 10 },
    ]).map((p) => p.path)).toEqual(["/dev/one"]);
  });
});

describe("browseProjectOrder", () => {
  test("keeps used folders first and groups suggestions at the tail", () => {
    expect(browseProjectOrder([
      { path: "/roots/a", suggested: true },
      { path: "/dev/x" },
      { path: "/roots/b", suggested: true },
      { path: "/dev/y" },
    ]).map((p) => p.path)).toEqual(["/dev/x", "/dev/y", "/roots/a", "/roots/b"]);
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
