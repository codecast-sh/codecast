import { describe, expect, test } from "bun:test";
import { buildPathRestampUpdate, conversationRepository, matchDirectoryMapping, resolveTeamForPath } from "./privacy";

// A sharing rule sits on a checkout path, and every other clone or linked
// worktree of the same repository resolves to it when no path rule of its own
// says otherwise. A codex worktree lives under ~/.codex/worktrees, outside
// every mapped folder, and was one "Only me" row per worktree before this.
const TEAM = "t_team" as any;
const OTHER = "t_other" as any;
const REPO = "littlebirdai/littlebird";
const shared = { team_id: TEAM, path_prefix: "/Users/d/Desktop/LB-codex/littlebird", auto_share: true, repository: REPO };

describe("matchDirectoryMapping", () => {
  test("a session in another clone of the repository resolves to the mapping", () => {
    expect(matchDirectoryMapping([shared], "/Users/d/Desktop/LB1/littlebird", REPO)).toBe(shared);
    expect(matchDirectoryMapping([shared], "/Users/d/.codex/worktrees/c636/littlebird", REPO)).toBe(shared);
  });

  test("a path rule on the clone itself wins over the repository rule", () => {
    const privateClone = { team_id: OTHER, path_prefix: "/Users/d/Desktop/LB1/littlebird", auto_share: false, repository: REPO };
    expect(matchDirectoryMapping([shared, privateClone], "/Users/d/Desktop/LB1/littlebird/backend", REPO)).toBe(privateClone);
  });

  test("a different repository or no repository matches nothing", () => {
    expect(matchDirectoryMapping([shared], "/Users/d/src/other", "o/other")).toBeNull();
    expect(matchDirectoryMapping([shared], "/Users/d/Documents/notes", undefined)).toBeNull();
  });

  test("a mapping without a repository stamp is path only", () => {
    const legacy = { team_id: TEAM, path_prefix: "/Users/d/Desktop/LB-codex/littlebird", auto_share: true };
    expect(matchDirectoryMapping([legacy], "/Users/d/Desktop/LB1/littlebird", REPO)).toBeNull();
    expect(matchDirectoryMapping([legacy], "/Users/d/Desktop/LB-codex/littlebird/x", REPO)).toBe(legacy);
  });
});

// A "never share" lock is a rule with no team. As a path rule it wins the
// way any path rule does; among repository rules it beats a share, so one
// locked checkout keeps every clone and worktree of the repository private.
describe("a never share lock", () => {
  const lock = { path_prefix: "/Users/d/Desktop/LB1/littlebird", auto_share: false, private: true, repository: REPO };
  const folderLock = { path_prefix: "/Users/d/health", auto_share: false, private: true };

  test("a locked folder beats the repository rule for a worktree inside it", () => {
    expect(matchDirectoryMapping([shared, folderLock], "/Users/d/health/littlebird-wt", REPO)).toBe(folderLock);
  });

  test("a lock on one checkout wins over a share on another for every other clone", () => {
    expect(matchDirectoryMapping([shared, lock], "/Users/d/.codex/worktrees/c636/littlebird", REPO)).toBe(lock);
    expect(matchDirectoryMapping([lock, shared], "/Users/d/.codex/worktrees/c636/littlebird", REPO)).toBe(lock);
  });

  test("a locked session is private and routed to no team, whatever the fallback", () => {
    expect(resolveTeamForPath([shared, folderLock], "/Users/d/health/notes", TEAM)).toEqual({ teamId: undefined, isPrivate: true, autoShared: false });
    expect(resolveTeamForPath([shared, lock], "/Users/d/.codex/worktrees/c636/littlebird", TEAM, undefined, REPO)).toEqual({ teamId: undefined, isPrivate: true, autoShared: false });
  });

  test("a share rule on a deeper path is still the more specific word", () => {
    const sub = { team_id: TEAM, path_prefix: "/Users/d/health/public", auto_share: true };
    expect(resolveTeamForPath([folderLock, sub], "/Users/d/health/public/x", undefined).isPrivate).toBe(false);
  });
});

describe("resolveTeamForPath with a repository", () => {
  test("shares a worktree outside the mapped folder", () => {
    const r = resolveTeamForPath([shared], "/Users/d/.codex/worktrees/c636/littlebird", undefined, undefined, REPO);
    expect(r).toEqual({ teamId: TEAM, isPrivate: false, autoShared: true });
  });

  test("the share start applies through the repository rule too", () => {
    const since = { ...shared, share_since: 1000 };
    expect(resolveTeamForPath([since], "/Users/d/Desktop/LB1/littlebird", undefined, 999, REPO).isPrivate).toBe(true);
    expect(resolveTeamForPath([since], "/Users/d/Desktop/LB1/littlebird", undefined, 1000, REPO).isPrivate).toBe(false);
  });

  test("a session with a repository but no path still resolves", () => {
    expect(resolveTeamForPath([shared], undefined, undefined, undefined, REPO).teamId).toBe(TEAM);
  });

  test("without a repository the old path behaviour is unchanged", () => {
    expect(resolveTeamForPath([shared], "/Users/d/Desktop/LB1/littlebird", undefined)).toEqual({ teamId: undefined, isPrivate: true, autoShared: false });
    expect(resolveTeamForPath([shared], "/Users/d/Desktop/LB-codex/littlebird/x", undefined).teamId).toBe(TEAM);
  });
});

describe("conversationRepository", () => {
  test("every remote form of one repository keys the same", () => {
    expect(conversationRepository({ git_remote_url: "https://github.com/LittlebirdAI/littlebird.git" })).toBe(REPO);
    expect(conversationRepository({ git_remote_url: "git@github.com:littlebirdai/littlebird.git" })).toBe(REPO);
    expect(conversationRepository({ git_remote_url: "ssh://git@gitlab.com/team/app.git" })).toBe("team/app");
    expect(conversationRepository({ git_remote_url: undefined })).toBeUndefined();
    expect(conversationRepository(null)).toBeUndefined();
  });
});

describe("buildPathRestampUpdate reads the row's remote", () => {
  test("a born blank row in another clone gains the team through the repository", () => {
    const row = { is_private: true, git_remote_url: "git@github.com:littlebirdai/littlebird.git" } as any;
    expect(buildPathRestampUpdate(row, [shared] as any, "/Users/d/Desktop/LB1/littlebird")).toEqual({ team_id: TEAM, is_private: false, auto_shared: true } as any);
  });
});
