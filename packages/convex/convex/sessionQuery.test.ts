import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { hashToken } from "@platform/auth/convex";
import schema from "./schema";
import { SESSION_TRAILER_KEY, sessionTrailerValue } from "@codecast/shared/blame";
import {
  fileQueryPrefixes,
  intersectCandidates,
  matchAuthorIds,
  pathMatchesPrefix,
  repoMatchesConversation,
} from "./sessionQueryCore";

describe("sessionQueryCore", () => {
  test("a repo-relative path is tried under every checkout root; an absolute one names itself", () => {
    expect(fileQueryPrefixes("src/a.ts", ["/Users/a/repo", "/Users/b/code/repo/", "relative"])).toEqual([
      "/Users/a/repo/src/a.ts",
      "/Users/b/code/repo/src/a.ts",
    ]);
    expect(fileQueryPrefixes("/abs/x.ts", ["/Users/a/repo"])).toEqual(["/abs/x.ts"]);
  });

  test("a prefix matches the file itself or anything under it as a folder, never a sibling", () => {
    expect(pathMatchesPrefix("/r/src/a.ts", "/r/src/a.ts")).toBe(true);
    expect(pathMatchesPrefix("/r/src/a.tsx", "/r/src/a.ts")).toBe(false);
    expect(pathMatchesPrefix("/r/src/web/x.ts", "/r/src/web")).toBe(true);
    expect(pathMatchesPrefix("/r/src/web-old/x.ts", "/r/src/web")).toBe(false);
  });

  test("candidates intersect and keep the newest matched time", () => {
    const a = new Map<string, number | undefined>([["x", 5], ["y", undefined], ["z", 1]]);
    const b = new Map<string, number | undefined>([["x", 9], ["y", 3]]);
    expect([...intersectCandidates(a, b)]).toEqual([["x", 9], ["y", 3]]);
    expect(intersectCandidates(null, b)).toBe(b);
  });

  test("repo: matches owner/repo, the bare repository name, or the checkout folder", () => {
    const conv = { git_remote_url: "git@github.com:Acme/Repo.git", git_root: "/Users/a/work/checkout" };
    expect(repoMatchesConversation(conv, "acme/repo")).toBe(true);
    expect(repoMatchesConversation(conv, "repo")).toBe(true);
    expect(repoMatchesConversation(conv, "checkout")).toBe(true);
    expect(repoMatchesConversation(conv, "other/repo")).toBe(false);
  });

  test("author: me is the viewer; other values match name, email or GitHub login", () => {
    const users = [
      { _id: "u1", name: "Ashot P", email: "a@x.com" },
      { _id: "u2", name: "Samvit", email: "s@x.com", github_username: "samvitj" },
    ];
    expect([...matchAuthorIds(users, "me", "u1")]).toEqual(["u1"]);
    expect([...matchAuthorIds(users, "samvitj", "u1")]).toEqual(["u2"]);
    expect(matchAuthorIds(users, "nobody", "u1").size).toBe(0);
  });
});

// The whole path against the real queries: a viewer, a teammate who shares
// one session and keeps one private, and an outsider, all of whom edited the
// same repo-relative file from different checkouts.
describe("operator search end to end", () => {
  const modules = {
    "./_generated/server.ts": () => import("./_generated/server"),
    "./conversations.ts": () => import("./conversations"),
  };
  const token = "q".repeat(64);

  async function seed() {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const viewer = await ctx.db.insert("users", { name: "Viewer", email: "v@x.com" } as any);
      const mate = await ctx.db.insert("users", { name: "Mate", email: "m@x.com" } as any);
      const outsider = await ctx.db.insert("users", { name: "Outsider", email: "o@x.com" } as any);
      await ctx.db.insert("api_tokens", { user_id: viewer, token_hash: await hashToken(token), name: "cli", created_at: now, last_used_at: now } as any);
      const team = await ctx.db.insert("teams", { name: "T", invite_code: "t", created_at: now } as any);
      for (const user_id of [viewer, mate]) {
        await ctx.db.insert("team_memberships", { team_id: team, user_id, role: "member", joined_at: 0, visibility: "full" } as any);
      }
      const remote = "git@github.com:acme/repo.git";
      const conv = (user_id: any, extra: Record<string, unknown>) =>
        ctx.db.insert("conversations", {
          user_id, agent_type: "claude_code", status: "active", started_at: 1, message_count: 1, session_id: `s${Math.random()}`,
          git_remote_url: remote, ...extra,
        } as any);
      const mine = await conv(viewer, { title: "Viewer auth work", git_root: "/Users/v/src/repo", project_path: "/Users/v/src/repo", is_private: true, updated_at: now - 3000 });
      const shared = await conv(mate, { title: "Mate auth fix", git_root: "/Users/m/code/repo", project_path: "/Users/m/code/repo", is_private: false, team_id: team, updated_at: now - 2000 });
      const hidden = await conv(mate, { title: "Mate private", git_root: "/Users/m/code/repo", project_path: "/Users/m/code/repo", is_private: true, team_id: team, updated_at: now - 1000 });
      const foreign = await conv(outsider, { title: "Outsider", git_root: "/Users/o/repo", project_path: "/Users/o/repo", is_private: false, updated_at: now });
      const msg = async (conversation_id: any, content: string) =>
        ctx.db.insert("messages", { conversation_id, role: "user", content, timestamp: now } as any);
      const edit = async (conversation_id: any, file_path: string, timestamp: number, extra: Record<string, unknown> = {}) =>
        ctx.db.insert("file_changes", {
          conversation_id, message_id: await msg(conversation_id, "edit"), change_key: `${Math.random()}`, seq: 0,
          file_path, change_type: "edit", timestamp, ...extra,
        } as any);
      await edit(mine, "/Users/v/src/repo/src/auth.ts", now - 9000);
      await edit(mine, "/Users/v/src/repo/src/other.ts", now - 8000);
      await edit(shared, "/Users/m/code/repo/src/auth.ts", now - 7000);
      await edit(hidden, "/Users/m/code/repo/src/auth.ts", now - 6000);
      await edit(foreign, "/Users/o/repo/src/auth.ts", now - 5000);
      await edit(mine, "git commit", now - 8500, { change_type: "commit", commit_hash: "abc1234", commit_message: "auth" });
      await msg(shared, "the retry loop in auth");
      // A commit whose session printed no hash: blame finds it by subject + time.
      await edit(shared, "git commit", now - 4000, { change_type: "commit", commit_message: "fix(auth): retry the refresh" });
      await ctx.db.insert("commits", {
        sha: "d1b0237001" + "0".repeat(30), message: "fix(auth): retry the refresh\n\nbody", author_name: "m", author_email: "m@x.com",
        timestamp: now - 3990, files_changed: 1, insertions: 1, deletions: 0, repository: "acme/repo",
      } as any);
      // Squashed commits nothing else ties to a session: only the trailer names one.
      for (const [sha, named] of [["ee77aa1100", mine], ["ff88bb2200", hidden]] as const) {
        await ctx.db.insert("commits", {
          sha: sha + "0".repeat(30), message: `squash: unrelated subject\n\n${SESSION_TRAILER_KEY}: ${sessionTrailerValue(String(named), "https://codecast.sh")}`,
          author_name: "v", author_email: "v@x.com", timestamp: now - 100000, files_changed: 1, insertions: 1, deletions: 0, repository: "acme/repo",
        } as any);
      }
      await ctx.db.insert("pull_requests", {
        team_id: team, github_pr_id: 1, repository: "acme/repo", number: 7, title: "Auth", body: "", state: "open",
        author_github_username: "m", linked_session_ids: [shared], created_at: now, updated_at: now,
      } as any);
      // A repository only the team's GitHub installation names: no session pushes there.
      await ctx.db.insert("github_app_installations", {
        team_id: team, installation_id: 1, account_login: "acme", account_type: "Organization", account_id: 1,
        repository_selection: "selected", repositories: [{ id: 2, name: "infra", full_name: "acme/infra" }], created_at: now, updated_at: now,
      } as any);
      await ctx.db.insert("pull_requests", {
        team_id: team, github_pr_id: 2, repository: "acme/infra", number: 9, title: "Infra", body: "", state: "open",
        author_github_username: "v", linked_session_ids: [mine], created_at: now, updated_at: now,
      } as any);
      const bucket = await ctx.db.insert("inbox_buckets", { user_id: viewer, name: "auth", created_at: now, updated_at: now } as any);
      await ctx.db.insert("bucket_assignments", { user_id: viewer, conversation_id: shared, bucket_id: bucket, updated_at: now } as any);
      return { viewer, mine: String(mine), shared: String(shared), hidden: String(hidden), foreign: String(foreign) };
    });
    return { t, ...ids };
  }

  const web = async (t: any, viewer: any, query: string) => {
    const r = await t.withIdentity({ subject: `${viewer}|test` }).query(anyApi.conversations.searchConversations, { query });
    return r;
  };
  const ids = (r: any) => r.results.map((x: any) => x.conversationId);

  test("file: finds every visible session that edited the repo-relative file, newest change first", async () => {
    const s = await seed();
    const r = await web(s.t, s.viewer, "file:src/auth.ts");
    // The teammate's private session and the outsider's session edited it too.
    expect(ids(r)).toEqual([s.shared, s.mine]);
  });

  test("the CLI query answers the same operators, and its flags are sugar for them", async () => {
    const s = await seed();
    const cli = (query: string, extra: Record<string, unknown> = {}) =>
      s.t.query(anyApi.conversations.searchForCLI, { api_token: token, query, ...extra });
    const rows = (r: any) => r.conversations.map((c: any) => c.title);
    expect(rows(await cli("file:src/auth.ts"))).toEqual(["Mate auth fix", "Viewer auth work"]);
    expect(rows(await cli("file:src/auth.ts", { mine_only: true }))).toEqual(["Viewer auth work"]);
    expect(rows(await cli("file:src/auth.ts author:me"))).toEqual(["Viewer auth work"]);
    expect(rows(await cli("file:/Users/v/src/repo/src"))).toEqual(["Viewer auth work"]);
    expect(rows(await cli("commit:abc1234"))).toEqual(["Viewer auth work"]);
    expect(rows(await cli("commit:abc1234deadbeef"))).toEqual(["Viewer auth work"]);
    expect(rows(await cli("commit:d1b0237001"))).toEqual(["Mate auth fix"]);
    // The trailer links a squashed commit; one naming a session the viewer cannot see links nothing.
    expect(rows(await cli("commit:ee77aa1100"))).toEqual(["Viewer auth work"]);
    expect(rows(await cli("commit:ff88bb2200"))).toEqual([]);
    expect(rows(await cli("pr:7"))).toEqual(["Mate auth fix"]);
    expect(rows(await cli("pr:acme/repo#7"))).toEqual(["Mate auth fix"]);
    expect(rows(await cli("pr:Acme/Repo#7"))).toEqual(["Mate auth fix"]);
    expect(rows(await cli("pr:9"))).toEqual(["Viewer auth work"]);
    expect(rows(await cli("label:auth"))).toEqual(["Mate auth fix"]);
    expect(rows(await cli("file:src/auth.ts", { label: "auth" }))).toEqual(["Mate auth fix"]);
    expect(rows(await cli("repo:acme/repo"))).toEqual(["Mate auth fix", "Viewer auth work"]);
    expect(rows(await cli("file:src/auth.ts retry"))).toEqual(["Mate auth fix"]);
    expect((await cli("commit:zz")).error).toContain("commit:");
    expect((await cli("author:nobody")).error).toContain("nobody");
  });

  test("after: holds the matching change to the window, not the session's last activity", async () => {
    const s = await seed();
    const cutoff = new Date(Date.now() - 7500).toISOString();
    const r = await web(s.t, s.viewer, `file:src/auth.ts after:${cutoff}`);
    expect(ids(r)).toEqual([s.shared]);
  });
});
