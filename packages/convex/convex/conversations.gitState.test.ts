import { describe, expect, test } from "bun:test";
import { updateGitState } from "./conversations";
import { ingestLocal } from "./repos";
import { makeFakeDb } from "./testDb";

// The header's prompt line and the session link on locally published commits
// both rest on the daemon naming a session. Both rules: a daemon writes only
// to its own user's sessions, and only what changed.

function context(user: string, overrides: Record<string, any[]> = {}) {
  return {
    auth: { getUserIdentity: async () => ({ subject: `${user}|sess`, tokenIdentifier: "test" }) },
    db: makeFakeDb({
      users: [{ _id: "owner", active_team_id: "team" }, { _id: "other" }],
      team_memberships: [{ _id: "m", user_id: "owner", team_id: "team" }],
      conversations: [{ _id: "conv", user_id: "owner", git_branch: "main", git_commit_hash: "aaaaaaa" }],
      directory_team_mappings: [{ _id: "map", user_id: "owner", path_prefix: "/src", team_id: "team", auto_share: true, created_at: 1 }],
      repo_sources: [],
      repo_cache: [],
      commits: [],
      ...overrides,
    }),
  };
}

describe("conversations.updateGitState", () => {
  test("writes what moved, stamps the time, and skips a no-op", async () => {
    const ctx = context("owner");
    expect(await (updateGitState as any)._handler(ctx, { conversation_id: "conv", git_commit_hash: "bbbbbbb", git_branch: "main", git_ahead: 2, git_behind: 0, git_dirty: true })).toEqual({ updated: true });
    const conv = ctx.db._tables.conversations[0];
    expect(conv).toMatchObject({ git_commit_hash: "bbbbbbb", git_branch: "main", git_ahead: 2, git_behind: 0, git_dirty: true });
    expect(typeof conv.git_state_at).toBe("number");
    expect(await (updateGitState as any)._handler(ctx, { conversation_id: "conv", git_commit_hash: "bbbbbbb", git_ahead: 2, git_dirty: true })).toEqual({ updated: false });
  });
  test("another user's session is left alone", async () => {
    const ctx = context("other");
    expect(await (updateGitState as any)._handler(ctx, { conversation_id: "conv", git_commit_hash: "ccccccc" })).toEqual({ updated: false });
    expect(ctx.db._tables.conversations[0].git_commit_hash).toBe("aaaaaaa");
  });
});

describe("repos.ingestLocal session stamps", () => {
  const commit = (sha: string, conversation_id?: string) => ({ sha, message: "m", author_name: "a", author_email: "e", timestamp: 1, files_changed: 1, insertions: 1, deletions: 0, conversation_id });
  test("a claimed session is written only when it belongs to the caller, and fills a row that had none", async () => {
    const ctx = context("owner", { commits: [{ _id: "c0", sha: "0".repeat(40), repository: "acme/demo", team_id: "team", message: "m", author_name: "a", author_email: "e", timestamp: 1, files_changed: 0, insertions: 0, deletions: 0 }] });
    ctx.db._tables.conversations.push({ _id: "foreign", user_id: "other" });
    await (ingestLocal as any)._handler(ctx, {
      root: "/src/demo", repository: "acme/demo", rows: [],
      commits: [commit("1".repeat(40), "conv"), commit("2".repeat(40), "foreign"), commit("0".repeat(40), "conv")],
    });
    const bySha = Object.fromEntries(ctx.db._tables.commits.map((c: any) => [c.sha[0], c]));
    expect(bySha["1"].conversation_id).toBe("conv");
    expect(bySha["2"].conversation_id).toBeUndefined();
    expect(bySha["0"].conversation_id).toBe("conv");
  });
});
