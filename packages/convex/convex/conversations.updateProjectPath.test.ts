import { describe, expect, test } from "bun:test";
import { updateProjectPath, updateSessionId } from "./conversations";
import { makeFakeDb } from "./testDb";

// The daemon's boot sweep and session binding stamp a checkout root AND its
// origin. A row created without git info (every codex rollout before 2026-09)
// keys on its cwd until this lands; the origin is what later groups the row
// under its repository. Older daemons omit git_remote_url and nothing changes
// for them.
const USER = "users_owner";
const CONV = "conversations_c1";

function ctxFor(conv: Record<string, any>) {
  const db = makeFakeDb({
    conversations: [{ _id: CONV, user_id: USER, session_id: "sess-1", ...conv }],
    directory_team_mappings: [],
  });
  return { db, auth: { getUserIdentity: async () => ({ subject: `${USER}|session` }) } };
}

describe("updateProjectPath", () => {
  test("stamps the origin beside the root", async () => {
    const ctx = ctxFor({ project_path: "/Users/d/.codex/worktrees/c636/lb" });
    const result = await (updateProjectPath as any)._handler(ctx, {
      session_id: "sess-1",
      project_path: "/Users/d/.codex/worktrees/c636/lb",
      git_root: "/Users/d/Desktop/lb",
      git_remote_url: "https://github.com/o/lb.git",
      api_token: "t",
    });
    expect(result).toMatchObject({ updated: true });
    expect(ctx.db._patched[0].patch).toMatchObject({
      project_path: "/Users/d/.codex/worktrees/c636/lb",
      git_root: "/Users/d/Desktop/lb",
      git_remote_url: "https://github.com/o/lb.git",
    });
  });

  test("a row that already carries path, root and origin is left alone", async () => {
    const ctx = ctxFor({ project_path: "/p", git_root: "/g", git_remote_url: "https://github.com/o/lb.git" });
    const result = await (updateProjectPath as any)._handler(ctx, {
      session_id: "sess-1", project_path: "/p", git_root: "/g", git_remote_url: "https://github.com/o/lb.git", api_token: "t",
    });
    expect(result).toEqual({ updated: false });
    expect(ctx.db._patched).toHaveLength(0);
  });

  test("an older daemon that sends no origin neither clears nor blocks on it", async () => {
    const ctx = ctxFor({ project_path: "/p", git_root: "/g", git_remote_url: "https://github.com/o/lb.git" });
    const unchanged = await (updateProjectPath as any)._handler(ctx, { session_id: "sess-1", project_path: "/p", git_root: "/g", api_token: "t" });
    expect(unchanged).toEqual({ updated: false });
    const moved = await (updateProjectPath as any)._handler(ctx, { session_id: "sess-1", project_path: "/p/sub", git_root: "/g", api_token: "t" });
    expect(moved).toMatchObject({ updated: true });
    expect(ctx.db._patched[0].patch.git_remote_url).toBeUndefined();
  });
});

describe("updateProjectPath and visibility", () => {
  const mapping = { _id: "directory_team_mappings_m", user_id: USER, team_id: "teams_t", path_prefix: "/Users/d/Desktop/lb", auto_share: true, created_at: 1 };
  const ctxWithMapping = (conv: Record<string, any>) => {
    const db = makeFakeDb({
      conversations: [{ _id: CONV, user_id: USER, session_id: "sess-1", ...conv }],
      directory_team_mappings: [mapping],
      team_memberships: [],
    });
    return { db, auth: { getUserIdentity: async () => ({ subject: `${USER}|session` }) } };
  };

  test("learning the root of a path the row already had never changes who sees it", async () => {
    const ctx = ctxWithMapping({ project_path: "/Users/d/.codex/worktrees/c636/lb", is_private: true });
    await (updateProjectPath as any)._handler(ctx, {
      session_id: "sess-1", project_path: "/Users/d/.codex/worktrees/c636/lb", git_root: "/Users/d/Desktop/lb", api_token: "t",
    });
    const patch = ctx.db._patched[0].patch;
    expect(patch.git_root).toBe("/Users/d/Desktop/lb");
    expect(patch.is_private).toBeUndefined();
    expect(patch.team_id).toBeUndefined();
  });

  test("a born blank stub that gains its real path resolves against the mapping", async () => {
    const ctx = ctxWithMapping({ is_private: true });
    await (updateProjectPath as any)._handler(ctx, {
      session_id: "sess-1", project_path: "/Users/d/Desktop/lb", git_root: "/Users/d/Desktop/lb", api_token: "t",
    });
    expect(ctx.db._patched[0].patch).toMatchObject({ team_id: "teams_t", is_private: false, auto_shared: true });
  });
});

describe("updateSessionId", () => {
  test("carries the origin with the reconciled path", async () => {
    const ctx = ctxFor({ project_path: "/stub" });
    await (updateSessionId as any)._handler(ctx, {
      conversation_id: CONV, session_id: "sess-2", project_path: "/real", git_root: "/real", git_remote_url: "git@github.com:o/lb.git", api_token: "t",
    });
    expect(ctx.db._patched[0].patch).toMatchObject({ session_id: "sess-2", project_path: "/real", git_root: "/real", git_remote_url: "git@github.com:o/lb.git" });
  });
});
