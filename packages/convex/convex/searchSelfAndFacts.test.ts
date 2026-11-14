// cast search from inside a session: the session and its workers leave the
// results (and the reply says so), a long query whose words no session holds
// together is announced as partial before the rows, and each row says what its
// session did (commits, pull requests, failed tool calls).
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { hashToken } from "@platform/auth/convex";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { syncPullRequestSessions } from "./lib/prSessions";

const token = "s".repeat(64);
const otherToken = "o".repeat(64);

async function seed() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const viewer = await ctx.db.insert("users", { name: "Viewer", email: "v@x.com" } as any);
    const other = await ctx.db.insert("users", { name: "Other", email: "o@x.com" } as any);
    for (const [user, tok] of [[viewer, token], [other, otherToken]] as const) {
      await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(tok), name: "cli", created_at: now, last_used_at: now } as any);
    }
    const conv = (session_id: string, title: string, extra: Record<string, unknown> = {}, user = viewer) =>
      ctx.db.insert("conversations", {
        user_id: user, agent_type: "claude_code", status: "active", message_count: 1, is_private: true,
        session_id, short_id: session_id.slice(0, 7), title, subtitle: "", idle_summary: "",
        started_at: now - 10_000, updated_at: now - 1000, ...extra,
      } as any);
    // lead -> self -> worker; an unrelated session; someone else's session.
    const lead = await conv("leadsess", "lead session");
    const self = await conv("selfsess", "self session", { parent_conversation_id: lead });
    const worker = await conv("workersess", "worker session", { parent_conversation_id: self });
    const unrelated = await conv("othersess", "unrelated session");
    const foreign = await conv("foreignsess", "foreign session", {}, other);
    const say = (conversation_id: any, content: string) =>
      ctx.db.insert("messages", { conversation_id, role: "assistant", content, timestamp: now - 2000 } as any);
    await say(lead, "the zebra migration plan");
    await say(self, "running the zebra migration now");
    await say(worker, "zebra migration worker notes");
    await say(unrelated, "an older zebra migration attempt with walrus");
    return { now, viewer, other, lead, self, worker, unrelated, foreign };
  });
  return { t, ...ids };
}

const search = (t: any, args: Record<string, unknown>) =>
  t.query(anyApi.conversations.searchForCLI, { api_token: token, ...args }) as Promise<any>;
const titles = (r: any) => r.conversations.map((c: any) => c.title).sort();

describe("self-exclusion", () => {
  test("a session's search leaves out itself and its workers, and says so", async () => {
    const { t, self } = await seed();
    const r = await search(t, { query: "zebra migration", self_conversation_id: String(self) });
    expect(titles(r)).toEqual(["lead session", "unrelated session"]);
    // Its own words do not pull its parent in as a folded worker either.
    expect(r.conversations.find((c: any) => c.title === "lead session").workers).toBeUndefined();
    expect(r.excluded_self).toEqual({ id: "selfses", sessions: 2 });
  });

  test("the agent's own session id names it when no conversation id is exported", async () => {
    const { t } = await seed();
    const r = await search(t, { query: "zebra migration", self_session_id: "selfsess" });
    expect(titles(r)).toEqual(["lead session", "unrelated session"]);
    expect(r.excluded_self?.sessions).toBe(2);
  });

  test("--include-self keeps them, folded under the lead as before", async () => {
    const { t, self } = await seed();
    const r = await search(t, { query: "zebra migration", self_conversation_id: String(self), include_self: true });
    expect(titles(r)).toEqual(["lead session", "unrelated session"]);
    expect(r.conversations.find((c: any) => c.title === "lead session").workers).toBe(2);
    expect(r.excluded_self).toBeUndefined();
  });

  test("a headless child that inherited its parent's conversation id leaves out only itself", async () => {
    const { t, self, viewer, now } = await seed();
    await t.run(async (ctx) => {
      const child = await ctx.db.insert("conversations", {
        user_id: viewer, agent_type: "claude_code", status: "active", message_count: 1, is_private: true,
        session_id: "childsess", short_id: "childse", title: "child session", subtitle: "", idle_summary: "",
        parent_conversation_id: self, started_at: now, updated_at: now,
      } as any);
      await ctx.db.insert("messages", { conversation_id: child, role: "assistant", content: "zebra migration from the child", timestamp: now } as any);
    });
    // The child's own uuid wins over the parent's exported conversation id.
    const r = await search(t, { query: "zebra migration", self_conversation_id: String(self), self_session_id: "childsess" });
    expect(r.excluded_self).toEqual({ id: "childse", sessions: 1 });
    expect(r.conversations.find((c: any) => c.title === "lead session").workers).toBe(2);
  });

  test("an unsynced session falls back to the exported conversation id", async () => {
    const { t, self } = await seed();
    const r = await search(t, { query: "zebra migration", self_conversation_id: String(self), self_session_id: "not-synced-yet" });
    expect(r.excluded_self).toEqual({ id: "selfses", sessions: 2 });
  });

  test("the caller's own workers filling the candidate bound do not empty the page", async () => {
    const { t, self, viewer, now } = await seed();
    await t.run(async (ctx) => {
      // 60 workers saying the words more often than anyone, so they rank first.
      for (let i = 0; i < 60; i++) {
        const w = await ctx.db.insert("conversations", {
          user_id: viewer, agent_type: "claude_code", status: "active", message_count: 1, is_private: true,
          session_id: `bulk${i}`, short_id: `bulk${i}`, title: `bulk ${i}`, subtitle: "", idle_summary: "",
          parent_conversation_id: self, started_at: now, updated_at: now,
        } as any);
        await ctx.db.insert("messages", { conversation_id: w, role: "user", content: "zebra migration zebra migration zebra migration", timestamp: now } as any);
      }
    });
    const r = await search(t, { query: "zebra migration", self_conversation_id: String(self) });
    expect(titles(r)).toEqual(["lead session", "unrelated session"]);
    expect(r.excluded_self.sessions).toBe(62);
  });

  test("a self id the caller does not own excludes nothing", async () => {
    const { t, foreign } = await seed();
    const r = await search(t, { query: "zebra migration", self_conversation_id: String(foreign), self_session_id: "foreignsess" });
    expect(r.conversations.find((c: any) => c.title === "lead session").workers).toBe(2);
    expect(r.excluded_self).toBeUndefined();
  });

  test("nothing matched outside the caller: empty rows, and the reply names why", async () => {
    const { t, self } = await seed();
    const r = await search(t, { query: "running zebra", self_conversation_id: String(self) });
    expect(r.conversations).toEqual([]);
    expect(r.excluded_self?.sessions).toBe(1);
  });

  test("title-only fallback leaves the caller out too", async () => {
    const { t, self } = await seed();
    const r = await search(t, { query: "session", self_conversation_id: String(self), titles_only: true });
    expect(titles(r)).toEqual(["lead session", "unrelated session"]);
    expect(r.excluded_self?.sessions).toBe(2);
  });

  test("cast context file matches leave the caller out", async () => {
    const { t, self, worker, unrelated, viewer } = await seed();
    await t.run(async (ctx) => {
      for (const conversation_id of [self, worker, unrelated]) {
        await ctx.db.insert("file_touches", { user_id: viewer, conversation_id, file_path: "/r/a.ts", operation: "edit", timestamp: Date.now() } as any);
      }
    });
    const r: any = await t.mutation(anyApi.fileTouches.findSimilar, { api_token: token, file_path: "/r/a.ts", self_conversation_id: String(self) });
    expect(r.sessions.map((s: any) => [s.title, s.short_id])).toEqual([["unrelated session", "othersess".slice(0, 7)]]);
    expect(r.excluded_self).toEqual({ id: "selfses", sessions: 2 });
  });
});

describe("partial coverage is announced before the rows", () => {
  test("no session holds every word: partial names the word nothing holds, each row its gaps", async () => {
    const { t } = await seed();
    const r = await search(t, { query: "zebra migration quokka" });
    expect(r.partial).toEqual({ words: ["zebra", "migration", "quokka"], missing_everywhere: ["quokka"] });
    for (const row of r.conversations) expect(row.missing_terms).toEqual(["quokka"]);
  });

  test("a title lookup capped by sessions the caller cannot see proves nothing", async () => {
    const { t, now, viewer, other } = await seed();
    await t.run(async (ctx) => {
      for (let i = 0; i < 55; i++) {
        await ctx.db.insert("conversations", {
          user_id: other, agent_type: "claude_code", status: "active", message_count: 0, is_private: true,
          session_id: `fq${i}`, short_id: `fq${i}`, title: "quokka", subtitle: "", idle_summary: "", started_at: now, updated_at: now,
        } as any);
      }
      await ctx.db.insert("conversations", {
        user_id: viewer, agent_type: "claude_code", status: "active", message_count: 0, is_private: true,
        session_id: "mine-q", short_id: "mineq01", title: "quokka", subtitle: "", idle_summary: "", started_at: now, updated_at: now - 99_999,
      } as any);
    });
    const r = await search(t, { query: "zebra migration quokka" });
    expect(r.partial?.missing_everywhere).toEqual([]);
  });

  test("a message lookup that comes back full claims no gap it could not check", async () => {
    const { t, now, viewer } = await seed();
    let deep: any;
    await t.run(async (ctx) => {
      deep = await ctx.db.insert("conversations", {
        user_id: viewer, agent_type: "claude_code", status: "active", message_count: 0, is_private: true,
        session_id: "deep", short_id: "deep001", title: "deep", subtitle: "", idle_summary: "", started_at: now, updated_at: now,
      } as any);
      for (let i = 0; i < 520; i++) {
        await ctx.db.insert("messages", { conversation_id: deep, role: "assistant", content: `zebra migration step ${i}`, timestamp: now - 10_000 + i } as any);
      }
      await ctx.db.insert("messages", { conversation_id: deep, role: "assistant", content: "the quokka", timestamp: now } as any);
    });
    const r = await search(t, { query: "zebra migration quokka" });
    // deep holds all three, past the pool's cap: no partial notice, no false gap.
    expect(r.partial).toBeUndefined();
    for (const row of r.conversations) expect(row.missing_terms).toBeUndefined();
    // Operator searches look each session up with a small cap: same rule.
    const op = await search(t, { query: "author:me zebra migration quokka" });
    expect(op.conversations.map((c: any) => c.title)).toContain("deep");
    expect(op.partial).toBeUndefined();
    for (const row of op.conversations) expect(row.missing_terms).toBeUndefined();
  });

  test("a word held by a visible session below the coverage bar is not called missing", async () => {
    const { t, now, viewer } = await seed();
    await t.run(async (ctx) => {
      const c = await ctx.db.insert("conversations", {
        user_id: viewer, agent_type: "claude_code", status: "active", message_count: 1, is_private: true,
        session_id: "quokkasess", short_id: "quokkas", title: "animals", subtitle: "", idle_summary: "", started_at: now, updated_at: now,
      } as any);
      await ctx.db.insert("messages", { conversation_id: c, role: "assistant", content: "a quokka appeared", timestamp: now } as any);
    });
    const r = await search(t, { query: "zebra migration quokka" });
    // Only one of three words: below the half bar, so not a row, but it holds quokka.
    expect(titles(r)).not.toContain("animals");
    expect(r.partial).toEqual({ words: ["zebra", "migration", "quokka"], missing_everywhere: [] });
  });

  test("-u checks gaps in what the person wrote only", async () => {
    const { t, now, viewer } = await seed();
    await t.run(async (ctx) => {
      const c = await ctx.db.insert("conversations", {
        user_id: viewer, agent_type: "claude_code", status: "active", message_count: 2, is_private: true,
        session_id: "uonly", short_id: "uonly01", title: "u", subtitle: "", idle_summary: "", started_at: now, updated_at: now,
      } as any);
      await ctx.db.insert("messages", { conversation_id: c, role: "user", content: "plan the zebra migration", timestamp: now } as any);
      await ctx.db.insert("messages", { conversation_id: c, role: "assistant", content: "a quokka", timestamp: now + 1 } as any);
    });
    const r = await search(t, { query: "author:me zebra migration quokka", user_only: true });
    const row = r.conversations.find((c: any) => c.id === "uonly01");
    expect(row.missing_terms).toEqual(["quokka"]);
    expect(r.partial).toBeDefined();
  });

  test("a word held only in a visible session's title is not called missing", async () => {
    const { t, now, viewer } = await seed();
    await t.run((ctx) => ctx.db.insert("conversations", {
      user_id: viewer, agent_type: "claude_code", status: "active", message_count: 0, is_private: true,
      session_id: "qt", short_id: "qt00001", title: "quokka census", subtitle: "", idle_summary: "", started_at: now, updated_at: now,
    } as any));
    const r = await search(t, { query: "zebra migration quokka" });
    expect(r.partial?.missing_everywhere).toEqual([]);
  });

  test("the title-only fallback announces partial coverage too, naming no word", async () => {
    const { t } = await seed();
    const r = await search(t, { query: "lead session quokka", titles_only: true });
    expect(titles(r)).toContain("lead session");
    expect(r.partial).toEqual({ words: ["lead", "session", "quokka"], missing_everywhere: [] });
    expect(r.conversations.find((c: any) => c.title === "lead session").missing_terms).toEqual(["quokka"]);
  });

  test("a word held only by the caller's own session is still missing for it", async () => {
    const { t, self } = await seed();
    // "running" is only in the self session.
    const r = await search(t, { query: "zebra migration running", self_conversation_id: String(self) });
    expect(r.partial?.missing_everywhere).toEqual(["running"]);
  });

  test("a dated window's title rows count before the notice is made", async () => {
    const { t, viewer, now } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("conversations", {
        user_id: viewer, agent_type: "claude_code", status: "active", message_count: 0, is_private: true,
        session_id: "titled", short_id: "titled1", title: "zebra migration quokka", subtitle: "", idle_summary: "", started_at: now, updated_at: now - 500,
      } as any);
    });
    const r = await search(t, { query: "zebra migration quokka", start_time: now - 86_400_000 });
    expect(titles(r)).toContain("zebra migration quokka");
    expect(r.partial).toBeUndefined();
  });

  test("words held only apart: partial, nothing missing everywhere", async () => {
    const { t } = await seed();
    // walrus lives only in the unrelated session, plan only in the lead.
    const r = await search(t, { query: "zebra walrus plan" });
    expect(r.partial?.missing_everywhere).toEqual([]);
    expect(r.conversations.find((c: any) => c.title === "unrelated session").missing_terms).toEqual(["plan"]);
  });

  test("a word held in a session's title counts as held", async () => {
    const { t } = await seed();
    // "lead" appears only in the lead session's title.
    const r = await search(t, { query: "zebra migration lead" });
    expect(r.partial).toBeUndefined();
    expect(r.conversations.find((c: any) => c.title === "lead session").missing_terms).toBeUndefined();
  });

  test("a full match on the page means no partial notice", async () => {
    const { t } = await seed();
    const r = await search(t, { query: "zebra migration" });
    expect(r.partial).toBeUndefined();
    for (const row of r.conversations) expect(row.missing_terms).toBeUndefined();
  });
});

describe("hit facts: commits, pull requests, failed tools", () => {
  test("a commit git made is counted once, re-sync or not; a refused commit is a failure", async () => {
    const { t, viewer } = await seed();
    const conv = await t.run((ctx) => ctx.db.insert("conversations", {
      user_id: viewer, agent_type: "claude_code", status: "active", message_count: 0, is_private: true,
      session_id: "committer", short_id: "commit1", title: "committer", subtitle: "", idle_summary: "", started_at: Date.now(), updated_at: Date.now(),
    } as any));
    let at = Date.now();
    const call = (id: string, command: string) => ({
      message_uuid: `call-${id}`, role: "assistant", timestamp: at++, content: "",
      tool_calls: [{ id, name: "Bash", input: JSON.stringify({ command }) }],
    });
    const result = (id: string, content: string, is_error?: boolean) => ({
      message_uuid: `res-${id}`, role: "user", timestamp: at++, tool_results: [{ tool_use_id: id, content, ...(is_error ? { is_error } : {}) }],
    });
    const send = (messages: any[]) => t.mutation(anyApi.messages.addMessages, { conversation_id: conv, api_token: token, messages });
    await send([
      call("r1", 'git commit -m "fix retry"'), result("r1", "[main 3f2a91c] fix retry\n 1 file changed, 2 insertions(+)"),
      call("r2", 'git commit -m "init"'), result("r2", "[main (root-commit) 0a1b2c3] init\n 3 files changed"),
      call("r3", 'git commit -m "again"'), result("r3", "On branch main\nnothing to commit, working tree clean", true),
      // A commit whose call then failed on a later step keeps its commit.
      call("r5", 'git commit -m "one"'),
      result("r5", "[main 1111111] one\n 1 file changed\nerror: post-commit hook failed", true),
      call("r6", 'git commit -m "detached"'), result("r6", "[detached HEAD 3333333] on a detached head\n 1 file changed"),
      // Codex's envelope around a command's output.
      call("r7", 'git commit -m "from codex"'), result("r7", JSON.stringify({ output: "[main 4444444] from codex\n 1 file changed", metadata: { exit_code: 0 } })),
      // Reading an old log that holds commit lines made no commit.
      call("r8", "cat /tmp/build.log"), result("r8", "[main 5555555] someone else's commit\n 1 file changed"),
    ]);
    await send([result("r1", "[main 3f2a91c] fix retry\n 1 file changed, 2 insertions(+)")]);
    const row: any = await t.run((ctx) => ctx.db.get(conv as any));
    expect(row.session_tallies).toEqual({ failed_tools: 2, commits: 5 });
  });

  test("a row carries the commits, linked PRs and failed tool count of its session", async () => {
    const { t, unrelated, viewer } = await seed();
    await t.run(async (ctx) => {
      const now = Date.now();
      const team = await ctx.db.insert("teams", { name: "T", invite_code: "t", created_at: now } as any);
      await ctx.db.insert("team_memberships", { team_id: team, user_id: viewer, role: "member", joined_at: 0 } as any);
      const otherTeam = await ctx.db.insert("teams", { name: "U", invite_code: "u", created_at: now } as any);
      const pr = (number: number, team_id: any) => ctx.db.insert("pull_requests", {
        team_id, github_pr_id: number, repository: "o/r", number, title: "t", state: "open", author_github_username: "v",
        head_ref: "h", base_ref: "main", linked_session_ids: [unrelated], created_at: now, updated_at: now,
      } as any);
      // The link rows come from the one writer, which stamps number and team.
      for (const [n, team_id] of [[482, team], [490, team], [777, otherTeam]] as const) {
        await syncPullRequestSessions(ctx, (await ctx.db.get(await pr(n, team_id)))!);
      }
      // A link row from before the stamp: skipped, never loads the heavy row.
      await ctx.db.insert("pull_request_sessions", { pull_request_id: await pr(999, team), conversation_id: unrelated } as any);
      await ctx.db.patch(unrelated, { session_tallies: { failed_tools: 4, commits: 2 } } as any);
    });
    const r = await search(t, { query: "zebra migration" });
    const row = r.conversations.find((c: any) => c.title === "unrelated session");
    // PR 777 belongs to a team the viewer is not in.
    expect({ commits: row.commits, prs: row.prs, failed_tools: row.failed_tools }).toEqual({ commits: 2, prs: [490, 482], failed_tools: 4 });
    // The next sync of that pull request stamps its row.
    await t.run(async (ctx) => {
      const old = (await ctx.db.query("pull_requests").collect()).find((p: any) => p.number === 999)!;
      await syncPullRequestSessions(ctx, old);
    });
    expect((await search(t, { query: "zebra migration" })).conversations.find((c: any) => c.title === "unrelated session").prs).toEqual([999, 490, 482]);
    const lead = r.conversations.find((c: any) => c.title === "lead session");
    expect([lead.commits, lead.prs, lead.failed_tools]).toEqual([undefined, undefined, undefined]);
  });

  test("session_tallies count each failure and commit once across re-syncs, rewrites and deletes", async () => {
    const { t, viewer } = await seed();
    // A session counted from its first message.
    const unrelated = await t.run((ctx) => ctx.db.insert("conversations", {
      user_id: viewer, agent_type: "claude_code", status: "active", message_count: 0, is_private: true,
      session_id: "fresh", short_id: "fresh01", title: "fresh", subtitle: "", idle_summary: "", started_at: Date.now(), updated_at: Date.now(),
    } as any));
    const failed = (id: string) => ({ tool_use_id: id, content: "exit 1", is_error: true });
    const ok = (id: string) => ({ tool_use_id: id, content: "fine" });
    const write = (message_uuid: string, tool_results: any[], role = "user") =>
      t.mutation(anyApi.messages.addMessages, {
        conversation_id: unrelated,
        api_token: token,
        messages: [{ message_uuid, role, timestamp: Date.now(), tool_results }],
      });
    const count = async () => ((await t.run((ctx) => ctx.db.get(unrelated as any))) as any).session_tallies?.failed_tools ?? 0;
    await write("u1", [failed("t1"), ok("t2")]);
    expect(await count()).toBe(1);
    await write("u1", [failed("t1"), ok("t2")]);
    expect(await count()).toBe(1);
    await write("u2", [failed("t3"), failed("t4")]);
    expect(await count()).toBe(3);
    // A stored user row keeps its results; a re-sync that differs changes nothing.
    await write("u2", [failed("t3"), ok("t4")]);
    expect(await count()).toBe(3);
    // An assistant row is rewritten in place: turning a failure into a
    // success gives it back.
    await write("a1", [failed("t5")], "assistant");
    expect(await count()).toBe(4);
    await write("a1", [ok("t5")], "assistant");
    expect(await count()).toBe(3);
    // Deleting a row takes its failures with it.
    await t.mutation(anyApi.messages.deleteMessagesByUuid, { conversation_id: unrelated, api_token: token, message_uuids: ["u2"] });
    expect(await count()).toBe(1);
  });

  test("a session with messages before counting began keeps no count rather than a partial one", async () => {
    const { t, unrelated } = await seed();
    await t.mutation(anyApi.messages.addMessages, {
      conversation_id: unrelated, api_token: token,
      messages: [{ message_uuid: "late", role: "user", timestamp: Date.now(), tool_results: [{ tool_use_id: "x", content: "boom", is_error: true }] }],
    });
    const conv: any = await t.run((ctx) => ctx.db.get(unrelated as any));
    expect(conv.session_tallies).toBeUndefined();
  });

  test("a fresh session with no failures reads failed=0, absent from the row", async () => {
    const { t, viewer } = await seed();
    const fresh = await t.run((ctx) => ctx.db.insert("conversations", {
      user_id: viewer, agent_type: "claude_code", status: "active", message_count: 0, is_private: true,
      session_id: "clean", short_id: "clean01", title: "clean", subtitle: "", idle_summary: "", started_at: Date.now(), updated_at: Date.now(),
    } as any));
    await t.mutation(anyApi.messages.addMessages, {
      conversation_id: fresh, api_token: token,
      messages: [{ message_uuid: "c1", role: "user", timestamp: Date.now(), content: "hello" }],
    });
    const conv: any = await t.run((ctx) => ctx.db.get(fresh as any));
    expect(conv.session_tallies).toEqual({ failed_tools: 0, commits: 0 });
  });
});
