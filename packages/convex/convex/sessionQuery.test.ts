import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { hashToken } from "@platform/auth/convex";
import schema from "./schema";
import { SESSION_TRAILER_KEY, sessionTrailerValue } from "@codecast/shared/blame";
import { parseSessionQuery } from "@codecast/shared/search";
import { narrowByOperators, OPERATOR_LIMITS } from "./sessionQuerySearch";
import {
  fileQueryPrefixes,
  intersectCandidates,
  matchAuthorIds,
  pathMatchesPrefix,
  repoMatchesConversation,
  worktreeContainer,
} from "./sessionQueryCore";

describe("sessionQueryCore", () => {
  test("a repo-relative path is tried under every checkout root; an absolute one names itself", () => {
    expect(fileQueryPrefixes("src/a.ts", ["/Users/a/repo", "/Users/b/code/repo/", "relative"])).toEqual([
      "/Users/a/repo/src/a.ts",
      "/Users/b/code/repo/src/a.ts",
    ]);
    expect(fileQueryPrefixes("/abs/x.ts", ["/Users/a/repo"])).toEqual(["/abs/x.ts"]);
  });

  test("a worktree checkout names the folder that holds its siblings", () => {
    expect(worktreeContainer("/r/.codecast/worktrees/fix-auth")).toBe("/r/.codecast/worktrees/");
    expect(worktreeContainer("/r/.claude/worktrees/a/b")).toBe("/r/.claude/worktrees/");
    expect(worktreeContainer("/r/worktrees/a")).toBeNull();
    expect(worktreeContainer("/r")).toBeNull();
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
  "./syncOutbox.ts": () => import("./syncOutbox"),
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
      return { now, viewer, mine: String(mine), shared: String(shared), hidden: String(hidden), foreign: String(foreign) };
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
    // Cutoffs come from the seed's clock, so a slow run cannot slide them past an edit.
    const cutoff = new Date(s.now - 7500).toISOString();
    const r = await web(s.t, s.viewer, `file:src/auth.ts after:${cutoff}`);
    expect(ids(r)).toEqual([s.shared]);
  });
  test("commit: holds the commit's time to after:/before:", async () => {
    const s = await seed();
    const cli = (query: string) => s.t.query(anyApi.conversations.searchForCLI, { api_token: token, query });
    const rows = (r: any) => r.conversations.map((c: any) => c.title);
    const iso = (ms: number) => new Date(s.now - ms).toISOString();
    // abc1234 was committed 8.5s ago, d1b0237001 about 4s ago.
    expect(rows(await cli(`commit:abc1234 after:${iso(1000)}`))).toEqual([]);
    expect(rows(await cli(`commit:abc1234 before:${iso(8000)}`))).toEqual(["Viewer auth work"]);
    expect(rows(await cli(`commit:d1b0237001 before:${iso(6000)}`))).toEqual([]);
    expect(rows(await cli(`commit:d1b0237001 after:${iso(6000)}`))).toEqual(["Mate auth fix"]);
  });
});

// Budgets and ordering: a hot file, a folder whose early paths are noisy, a
// user with many checkouts and remotes, and text inside a wide narrowed set.
describe("operator search at volume", () => {
  const modules = {
    "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
    "./conversations.ts": () => import("./conversations"),
  };
  const token = "v".repeat(64);

  // `checkouts` adds the hundreds of checkouts and remotes. Only the tests about
  // them seed it: convex-test scans every row for each index read, and the root
  // walk reads once per checkout, so every relative path search would pay for it.
  async function seed({ checkouts }: { checkouts: boolean }) {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const viewer = await ctx.db.insert("users", { name: "Viewer", email: "v@x.com" } as any);
      await ctx.db.insert("api_tokens", { user_id: viewer, token_hash: await hashToken(token), name: "cli", created_at: now, last_used_at: now } as any);
      const conv = (title: string, extra: Record<string, unknown> = {}) =>
        ctx.db.insert("conversations", {
          user_id: viewer, agent_type: "claude_code", status: "active", started_at: 1, message_count: 1, session_id: `s${Math.random()}`,
          title, git_root: "/Users/v/src/repo", project_path: "/Users/v/src/repo", git_remote_url: "git@github.com:acme/repo.git",
          is_private: true, updated_at: now, ...extra,
        } as any);
      const msg = (conversation_id: any, content: string) =>
        ctx.db.insert("messages", { conversation_id, role: "user", content, timestamp: now } as any);
      const edit = async (conversation_id: any, file_path: string, timestamp: number, extra: Record<string, unknown> = {}) =>
        ctx.db.insert("file_changes", {
          conversation_id, message_id: await msg(conversation_id, "edit"), change_key: `${Math.random()}`, seq: 0,
          file_path, change_type: "edit", timestamp, ...extra,
        } as any);

      // Three older sessions edited the hot file once; then one session edited it 60 times.
      const old = [];
      for (let i = 0; i < 3; i++) {
        const c = await conv(`Old hot ${i}`, { updated_at: now - 900_000 + i });
        await edit(c, "/Users/v/src/repo/src/hot.ts", now - 900_000 + i * 1000);
        old.push(String(c));
      }
      const busy = await conv("Busy hot");
      for (let i = 0; i < 60; i++) await edit(busy, "/Users/v/src/repo/src/hot.ts", now - 60_000 + i * 100);

      // A folder whose alphabetically first file has 60 edits, and a later file one.
      const early = await conv("Early file");
      for (let i = 0; i < 60; i++) await edit(early, "/Users/v/src/repo/lib/aaa.ts", now - 50_000 + i);
      const late = await conv("Late file");
      await edit(late, "/Users/v/src/repo/lib/zzz.ts", now - 40_000);

      let zroot: unknown = null;
      if (checkouts) {
        // 410 checkouts that sort before the one that edited src/late.ts.
        for (let i = 0; i < 410; i++) {
          const root = `/Users/v/a/wt-${String(i).padStart(3, "0")}`;
          await conv(`Worktree ${i}`, { git_root: root, project_path: root, git_remote_url: `git@github.com:acme/r${String(i).padStart(3, "0")}.git`, updated_at: now - 1_000_000 });
        }
        // A pile of worktrees that sorts before an old checkout, one of which edited src/wt.ts.
        for (let i = 0; i < 30; i++) {
          const root = `/Users/v/a/.codecast/worktrees/w${String(i).padStart(2, "0")}`;
          const c = await conv(`Worktree task ${i}`, { git_root: root, project_path: root, updated_at: now - 2_000_000 });
          if (i === 7) await edit(c, `${root}/src/wt.ts`, now - 2_000_000);
        }
        const app = await conv("Old app checkout", { git_root: "/Users/v/a/app", project_path: "/Users/v/a/app", updated_at: now - 3_000_000 });
        await edit(app, "/Users/v/a/app/src/mid.ts", now - 3_000_000);
        zroot = await conv("Late checkout", { git_root: "/Users/v/z/repo", project_path: "/Users/v/z/repo", git_remote_url: "git@github.com:acme/zebra.git", updated_at: now + 1000 });
        await edit(zroot, "/Users/v/z/repo/src/late.ts", now - 30_000);
      }

      // 45 sessions edited one file; only the oldest mentions the word.
      let needle = "";
      for (let i = 0; i < 45; i++) {
        const c = await conv(`Many ${i}`);
        await edit(c, "/Users/v/src/repo/src/many.ts", now - 20_000 + i);
        if (i === 0) {
          await msg(c, "the quokkaword lives here");
          needle = String(c);
        }
      }
      return { now, viewer, old, busy: String(busy), early: String(early), late: String(late), zroot: String(zroot), needle };
    });
    return { t, ...ids };
  }
  // Tests that only read share one seed of each shape; a test that writes seeds its own.
  let plainSeed: ReturnType<typeof seed> | undefined;
  let checkoutSeed: ReturnType<typeof seed> | undefined;
  const plain = () => (plainSeed ??= seed({ checkouts: false }));
  const withCheckouts = () => (checkoutSeed ??= seed({ checkouts: true }));
  // A full walk of every checkout is about 900 index reads, and convex-test scans
  // every row for each one: about a second of CPU, which bun's 5s wall clock
  // default trips on a loaded machine.
  const FULL_WALK_MS = 30_000;

  const cli = (t: any, query: string, extra: Record<string, unknown> = {}) =>
    t.query(anyApi.conversations.searchForCLI, { api_token: token, query, limit: 100, ...extra });
  const titles = (r: any) => r.conversations.map((c: any) => c.title);

  test("a hot file lists every session that edited it, not the last few", async () => {
    const s = await plain();
    expect(titles(await cli(s.t, "file:src/hot.ts"))).toEqual(["Busy hot", "Old hot 2", "Old hot 1", "Old hot 0"]);
  });

  test("before: reaches edits older than the newest rows", async () => {
    const s = await plain();
    const cutoff = new Date(s.now - 120_000).toISOString();
    expect(titles(await cli(s.t, `file:src/hot.ts before:${cutoff}`))).toEqual(["Old hot 2", "Old hot 1", "Old hot 0"]);
  });

  test("a folder reaches every file under it, not the alphabetically first rows", async () => {
    const s = await plain();
    expect(titles(await cli(s.t, "file:lib"))).toEqual(["Late file", "Early file"]);
  });

  test("a checkout that sorts after hundreds of others still resolves a relative path", async () => {
    const s = await withCheckouts();
    expect(titles(await cli(s.t, "file:src/late.ts"))).toEqual(["Late checkout"]);
  }, FULL_WALK_MS);

  test("repo: finds a remote past the first sixty", async () => {
    const s = await withCheckouts();
    expect(titles(await cli(s.t, "repo:zebra"))).toEqual(["Late checkout"]);
    expect(titles(await cli(s.t, "repo:acme/zebra"))).toEqual(["Late checkout"]);
  }, FULL_WALK_MS);

  test("text inside a wide narrowed set is looked up in every session, not the newest forty", async () => {
    const s = await plain();
    // titles_only skips the shared pool, so only per-session lookups can find it.
    expect(titles(await cli(s.t, "file:src/many.ts quokkaword", { titles_only: true }))).toEqual(["Many 0"]);
  });

  // The budgets themselves, run against small limits.
  const narrow = (s: any, query: string, limits: Partial<typeof OPERATOR_LIMITS>, isVisible: (c: any) => boolean = () => true) =>
    s.t.run(async (ctx: any) => {
      const viewer = await ctx.db.get(s.viewer);
      const r = await narrowByOperators(ctx, parseSessionQuery(query), { viewerId: s.viewer, users: [viewer], teamIds: [], isVisible }, { ...OPERATOR_LIMITS, ...limits });
      if ("error" in r) throw new Error(r.error);
      return { titles: r.candidates.map((c) => c.conv.title), truncated: r.truncated };
    });

  test("a walk that stops at its row budget says so and keeps the newest edits", async () => {
    const s = await plain();
    const r = await narrow(s, "file:src/hot.ts", { fileRows: 10 });
    expect(r.titles).toEqual(["Busy hot"]);
    expect(r.truncated.join("\n")).toContain("file:src/hot.ts stopped after reading 10 edits");
    expect((await narrow(s, "file:src/hot.ts", {})).truncated).toEqual([]);
  });

  test("a folder gives each file a bounded walk and keeps the newest sessions across all of them", async () => {
    const s = await plain();
    const capped = await narrow(s, "file:lib", { folderFileRows: 5 });
    expect(capped.titles).toEqual(["Late file", "Early file"]);
    expect(capped.truncated.join("\n")).toContain("newest 5 edits of each file");
    // The alphabetically first file does not take the only seat: the newest edit does.
    const one = await narrow(s, "file:lib", { fileSessions: 1 });
    expect(one.titles).toEqual(["Late file"]);
    expect(one.truncated.join("\n")).toContain("kept the 1 session with");
  });

  test("a row still carrying legacy inline text counts against the size budget", async () => {
    const s = await seed({ checkouts: false });
    await s.t.run(async (ctx: any) => {
      const c = await ctx.db.insert("conversations", { user_id: s.viewer, agent_type: "claude_code", status: "active", started_at: 1, message_count: 1, session_id: "legacy", title: "Legacy", git_root: "/Users/v/src/repo", updated_at: Date.now() } as any);
      const m = await ctx.db.insert("messages", { conversation_id: c, role: "user", content: "x", timestamp: Date.now() } as any);
      await ctx.db.insert("file_changes", { conversation_id: c, message_id: m, change_key: "k", seq: 0, file_path: "/Users/v/src/repo/src/hot.ts", change_type: "write", timestamp: Date.now(), new_content: "x".repeat(50_000) } as any);
    });
    const r = await narrow(s, "file:src/hot.ts", { fileBytes: 20_000 });
    expect(r.titles).toEqual([]);
    expect(r.truncated.join("\n")).toContain("size budget");
  });

  test("past the root cap, the newest sessions' checkouts are still searched", async () => {
    const s = await withCheckouts();
    const r = await narrow(s, "file:src/late.ts", { roots: 5 });
    expect(r.titles).toEqual(["Late checkout"]);
    expect(r.truncated.join("\n")).toContain("checkouts");
  });

  test("a pile of worktrees is walked after every other checkout", async () => {
    const s = await withCheckouts();
    // Five reads: the worktree folder is skipped in one, so the old checkout past it is still reached.
    const r = await narrow(s, "file:src/mid.ts", { roots: 5 });
    expect(r.titles).toEqual(["Old app checkout"]);
    // With room, the worktrees themselves are walked too.
    expect((await narrow(s, "file:src/wt.ts", {})).titles).toEqual(["Worktree task 7"]);
  }, FULL_WALK_MS);

  test("sessions the viewer cannot see never take the seats of ones they can", async () => {
    const s = await plain();
    const r = await narrow(s, "file:src/hot.ts", { candidates: 2 }, (c) => c.title !== "Busy hot");
    expect(r.titles).toEqual(["Old hot 2", "Old hot 1"]);
    expect(r.truncated.join("\n")).toContain("stopped at 2 matching sessions");
  });
});
