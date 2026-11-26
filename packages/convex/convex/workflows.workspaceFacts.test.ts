// What `cast flow` asks the server before it ships a checkout personal (cli directoryTeam.ts, flows.md FL2): whether a
// team the caller is in already knows the checkout's repository, from a teammate's published checkout (repo_sources)
// a pull request the team holds or a commit its sessions made, whatever folder the checkout sits in. Another team's knowledge does not count.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";

const api = anyApi as any;
setDefaultTimeout(120_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./workflows.ts": () => import("./workflows"),
};

async function seed() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const mine = await ctx.db.insert("teams", { name: "Mine", created_at: now, invite_code: "a" } as any);
    const other = await ctx.db.insert("teams", { name: "Other", created_at: now, invite_code: "b" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", email: "ana@example.com" } as any);
    const bo = await ctx.db.insert("users", { name: "Bo", email: "bo@example.com" } as any);
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: mine, role: "member", joined_at: now } as any);
    await ctx.db.insert("team_memberships", { user_id: bo, team_id: other, role: "member", joined_at: now } as any);
    await ctx.db.insert("api_tokens", { user_id: ana, token_hash: await hashToken("tok-ana"), name: "cli", created_at: now, last_used_at: now } as any);
    // A teammate's published checkout of acme/codecast, and a pull request of acme/union-mobile, in Ana's team.
    await ctx.db.insert("repo_sources", { user_id: bo, team_id: mine, repository: "acme/codecast", root: "/c/codecast", enabled: true, last_synced_at: now, created_at: now, updated_at: now } as any);
    const pr = { github_pr_id: 1, number: 1, title: "t", body: "", state: "open", author_github_username: "ana", linked_session_ids: [], created_at: now, updated_at: now };
    await ctx.db.insert("pull_requests", { ...pr, team_id: mine, repository: "acme/union-mobile" } as any);
    // Only another team knows acme/elsewhere.
    await ctx.db.insert("pull_requests", { ...pr, github_pr_id: 2, team_id: other, repository: "acme/elsewhere" } as any);
    const conv = (session_id: string, team_id?: any) => ctx.db.insert("conversations", {
      user_id: ana, ...(team_id ? { team_id } : {}), is_private: true, git_root: "/c/x", agent_type: "claude_code", session_id,
      started_at: now, updated_at: now, message_count: 1, status: "active",
    } as any);
    await conv("sess-personal");
    await conv("sess-team", mine);
    // Bo's own session, stamped into his team.
    await ctx.db.insert("conversations", {
      user_id: bo, team_id: other, is_private: true, git_root: "/c/y", agent_type: "claude_code", session_id: "sess-bo",
      started_at: now, updated_at: now, message_count: 1, status: "active",
    } as any);
    return { mine, other, ana, bo };
  });
  const facts = (args: Record<string, unknown>) => t.query(api.workflows.workspaceFactsForCli, { api_token: "tok-ana", ...args });
  return { t, ...ids, facts };
}

describe("the workspace facts `cast flow` reads", () => {
  test("a repository a team of the caller's knows, by a published checkout or a pull request, in any spelling", async () => {
    const s = await seed();
    expect((await s.facts({ repository: "acme/codecast" })).team_repository).toBe(true);
    expect((await s.facts({ repository: "Acme/Union-Mobile" })).team_repository).toBe(true);
  });

  test("a repository a team's sessions committed to is the team's, with no published checkout or pull request", async () => {
    const s = await seed();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("commits", { sha: "abc", message: "m", author_name: "Bo", author_email: "bo@example.com", timestamp: Date.now(), files_changed: 1, insertions: 1, deletions: 0, team_id: s.mine, repository: "acme/committed" } as any);
      await ctx.db.insert("commits", { sha: "def", message: "m", author_name: "Bo", author_email: "bo@example.com", timestamp: Date.now(), files_changed: 1, insertions: 1, deletions: 0, team_id: s.other, repository: "acme/theirs" } as any);
    });
    expect((await s.facts({ repository: "acme/committed" })).team_repository).toBe(true);
    expect((await s.facts({ repository: "acme/theirs" })).team_repository).toBe(false);
  });

  test("a repository a teammate's share rule names is the team's, auto-shared or not, and a lock or another team's rule is not", async () => {
    const s = await seed();
    await s.t.run(async (ctx) => {
      const now = Date.now();
      const rule = (team_id: any, repository: string, extra: Record<string, unknown> = {}) =>
        ctx.db.insert("directory_team_mappings", { user_id: s.bo, team_id, path_prefix: `/c/${repository}`, auto_share: false, repository, created_at: now, ...extra } as any);
      await rule(s.mine, "acme/quiet");
      await rule(s.mine, "acme/locked", { private: true });
      await rule(s.other, "acme/elsewhere-rule");
    });
    expect((await s.facts({ repository: "acme/quiet" })).team_repository).toBe(true);
    expect((await s.facts({ repository: "acme/locked" })).team_repository).toBe(false);
    expect((await s.facts({ repository: "acme/elsewhere-rule" })).team_repository).toBe(false);
  });

  test("a repository no team of the caller's knows, or none named, is not a team's", async () => {
    const s = await seed();
    expect((await s.facts({ repository: "jb/tweet-only" })).team_repository).toBe(false);
    expect((await s.facts({ repository: "acme/elsewhere" })).team_repository).toBe(false);
    expect(await s.facts({})).toEqual({ workspace: null, team_repository: false, in_team: true });
  });

  test("a team's checkout is found however many other teams publish the repository", async () => {
    const s = await seed();
    await s.t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 120; i++) {
        const team = await ctx.db.insert("teams", { name: `T${i}`, created_at: now, invite_code: `t${i}` } as any);
        await ctx.db.insert("repo_sources", { user_id: s.bo, team_id: team, repository: "acme/popular", root: `/c/p${i}`, enabled: true, last_synced_at: now, created_at: now, updated_at: now } as any);
      }
      await ctx.db.insert("repo_sources", { user_id: s.bo, team_id: s.mine, repository: "acme/popular", root: "/c/mine", enabled: true, last_synced_at: now, created_at: now, updated_at: now } as any);
    });
    expect((await s.facts({ repository: "acme/popular" })).team_repository).toBe(true);
  });

  test("a session stamped personal but bound to an open team task is the team's; bound to a done one it stays personal", async () => {
    const s = await seed();
    await s.t.run(async (ctx) => {
      const now = Date.now();
      const task = (short_id: string, status: string) => ctx.db.insert("tasks", { short_id, title: "t", status, task_type: "task", priority: "medium", source: "human", user_id: s.ana, team_id: s.mine, workspace: `team:${s.mine}`, created_at: now, updated_at: now } as any);
      const open = await task("ct-1", "open");
      const done = await task("ct-2", "done");
      const conv = (session_id: string, active_task_id: any) => ctx.db.insert("conversations", {
        user_id: s.ana, is_private: true, git_root: "/c/x", agent_type: "claude_code", session_id, active_task_id,
        started_at: now, updated_at: now, message_count: 1, status: "active",
      } as any);
      await conv("sess-team-task", open);
      await conv("sess-done-task", done);
    });
    expect((await s.facts({ session: "sess-team-task" })).workspace).toBe(`team:${s.mine}`);
    expect((await s.facts({ session: "sess-done-task" })).workspace).toBe("personal");
  });

  test("a ref to another person's session reveals no stamp and no team", async () => {
    const s = await seed();
    const r = await s.facts({ session: "sess-bo" });
    expect(r.workspace).toBeNull();
    expect(JSON.stringify(r)).not.toContain(String(s.other));
  });

  test("whether the caller belongs to any team", async () => {
    const s = await seed();
    expect((await s.facts({})).in_team).toBe(true);
    await s.t.run(async (ctx) => {
      const cy = await ctx.db.insert("users", { name: "Cy", email: "cy@example.com" } as any);
      await ctx.db.insert("api_tokens", { user_id: cy, token_hash: await hashToken("tok-cy"), name: "cli", created_at: Date.now(), last_used_at: Date.now() } as any);
    });
    expect(await s.t.query(api.workflows.workspaceFactsForCli, { api_token: "tok-cy", repository: "cy/solo" })).toEqual({ workspace: null, team_repository: false, in_team: false });
  });

  test("the calling session's stamp: personal, its team, or none for a ref the caller owns no session by", async () => {
    const s = await seed();
    expect((await s.facts({ session: "sess-personal" })).workspace).toBe("personal");
    expect((await s.facts({ session: "sess-team" })).workspace).toBe(`team:${s.mine}`);
    expect((await s.facts({ session: "jx7nope", repository: "jb/tweet-only" })).workspace).toBeNull();
  });
});
