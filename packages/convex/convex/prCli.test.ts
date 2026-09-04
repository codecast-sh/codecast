// What `cast pr` is allowed to see and change.
//
// Two rules carry the whole surface. A pull request is readable by members of
// its team and nobody else, so a caller outside the team gets "no such pull
// request" rather than a redacted row. A session binding is stricter still:
// you may point your own agent at a pull request, never somebody else's.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { ls, show, shepherd, resolve, watchPRs, countChecks, threads, findComment, parseCommentLocation } from "./prCli";

const TEAM = "team_1";
const OTHER_TEAM = "team_2";
const MEMBER = "user_member";
const OUTSIDER = "user_outsider";
const TOKEN = "member-token";
const OUTSIDER_TOKEN = "outsider-token";

async function tables(overrides: Record<string, any[]> = {}) {
  return {
    users: [
      { _id: MEMBER, name: "Member", github_username: "member" },
      { _id: OUTSIDER, name: "Outsider", github_username: "outsider" },
    ],
    api_tokens: [
      { _id: "tok_member", user_id: MEMBER, token_hash: await hashToken(TOKEN) },
      { _id: "tok_outsider", user_id: OUTSIDER, token_hash: await hashToken(OUTSIDER_TOKEN) },
    ],
    teams: [
      { _id: TEAM, name: "Codecast" },
      { _id: OTHER_TEAM, name: "Somebody else" },
    ],
    team_memberships: [
      { _id: "tm_1", user_id: MEMBER, team_id: TEAM, role: "member", joined_at: 1 },
      { _id: "tm_2", user_id: OUTSIDER, team_id: OTHER_TEAM, role: "member", joined_at: 1 },
    ],
    conversations: [
      { _id: "conv_mine", user_id: MEMBER, short_id: "jx7mine", title: "My session", team_id: TEAM },
      { _id: "conv_theirs", user_id: OUTSIDER, short_id: "jx7them", title: "Their session", team_id: OTHER_TEAM },
    ],
    pull_requests: [
      {
        _id: "pr_1",
        team_id: TEAM,
        github_pr_id: 900,
        repository: "codecast-sh/codecast",
        number: 42,
        title: "Fix the auth race",
        body: "",
        state: "open",
        author_github_username: "member",
        head_ref: "fix-auth",
        base_ref: "main",
        linked_session_ids: [],
        checks: [
          { name: "build", status: "completed", conclusion: "success", updated_at: 1 },
          { name: "test", status: "completed", conclusion: "failure", updated_at: 1 },
          { name: "lint", status: "in_progress", updated_at: 1 },
        ],
        checks_state: "failure",
        created_at: 1,
        updated_at: 100,
      },
      {
        _id: "pr_other",
        team_id: OTHER_TEAM,
        github_pr_id: 901,
        repository: "acme/widgets",
        number: 42,
        title: "Somebody else's work",
        body: "",
        state: "open",
        author_github_username: "outsider",
        linked_session_ids: [],
        created_at: 1,
        updated_at: 200,
      },
    ],
    external_events: [
      { _id: "ev_1", team_id: TEAM, source: "github", kind: "pr_check", title: "test failed", pr_id: "pr_1", dedupe_key: "a", created_at: 50 },
      { _id: "ev_2", team_id: TEAM, source: "github", kind: "pr_synchronize", title: "2 commits pushed", pr_id: "pr_1", dedupe_key: "b", created_at: 60 },
    ],
    review_comments: [
      { _id: C1, pull_request_id: "pr_1", content: "This leaks a handle", file_path: "src/auth.ts", line_number: 12, resolved: false, created_at: 10, author_github_username: "reviewer" },
      { _id: "rc_2", pull_request_id: "pr_1", content: "Fixed", resolved: true, created_at: 11 },
    ],
    tasks: [],
    agent_tasks: [],
    ...overrides,
  };
}

async function ctx(overrides: Record<string, any[]> = {}) {
  return { db: makeFakeDb(await tables(overrides)) } as any;
}

const call = (fn: any, testCtx: any, args: Record<string, any>) => (fn as any)._handler(testCtx, args);

describe("resolving a pull request", () => {
  test("a number plus the repository finds it", async () => {
    const result = await call(resolve, await ctx(), {
      api_token: TOKEN,
      repository: "codecast-sh/codecast",
      number: 42,
    });
    expect(result.pull_request?.id).toBe("pr_1");
    expect(result.pull_request?.codecast_url).toBe("https://codecast.sh/pr/codecast-sh/codecast/42");
    expect(result.pull_request?.url).toBe("https://github.com/codecast-sh/codecast/pull/42");
  });

  test("a bare number searches only the caller's own teams", async () => {
    // Both pull requests are number 42. The member must get theirs, never the
    // other team's row that happens to share the number.
    const mine = await call(resolve, await ctx(), { api_token: TOKEN, number: 42 });
    expect(mine.pull_request?.id).toBe("pr_1");

    const theirs = await call(resolve, await ctx(), { api_token: OUTSIDER_TOKEN, number: 42 });
    expect(theirs.pull_request?.id).toBe("pr_other");
  });

  test("a reference the caller typed is parsed on the server too", async () => {
    const result = await call(resolve, await ctx(), {
      api_token: TOKEN,
      ref: "https://github.com/codecast-sh/codecast/pull/42",
    });
    expect(result.pull_request?.id).toBe("pr_1");
  });

  test("a non member cannot read another team's pull request", async () => {
    const result = await call(resolve, await ctx(), {
      api_token: OUTSIDER_TOKEN,
      repository: "codecast-sh/codecast",
      number: 42,
    });
    expect(result.pull_request).toBeNull();
  });

  test("an unknown token is refused outright", async () => {
    await expect(call(resolve, await ctx(), { api_token: "made-up", number: 42 }))
      .rejects.toThrow("Unauthorized");
  });

  test("the branch of the checkout locates the pull request", async () => {
    const result = await call(resolve, await ctx(), {
      api_token: TOKEN,
      repository: "codecast-sh/codecast",
      branch: "fix-auth",
    });
    expect(result.pull_request?.id).toBe("pr_1");
  });

  test("a session's binding locates the pull request with no reference at all", async () => {
    const testCtx = await ctx({
      pull_requests: (await tables()).pull_requests.map((pr: any) =>
        pr._id === "pr_1" ? { ...pr, shepherd_conversation_id: "conv_mine" } : pr),
    });
    const result = await call(resolve, testCtx, { api_token: TOKEN, session: "jx7mine" });
    expect(result.pull_request?.id).toBe("pr_1");
  });
});

describe("listing", () => {
  test("only the caller's teams appear", async () => {
    const mine = await call(ls, await ctx(), { api_token: TOKEN });
    expect(mine.pull_requests.map((pr: any) => pr.id)).toEqual(["pr_1"]);

    const theirs = await call(ls, await ctx(), { api_token: OUTSIDER_TOKEN });
    expect(theirs.pull_requests.map((pr: any) => pr.id)).toEqual(["pr_other"]);
  });

  test("checks are counted for the table", async () => {
    const result = await call(ls, await ctx(), { api_token: TOKEN });
    expect(result.pull_requests[0]).toMatchObject({
      checks_green: 1,
      checks_red: 1,
      checks_pending: 1,
      checks_state: "failure",
    });
  });

  test("--shepherded drops the pull requests nobody owns", async () => {
    const result = await call(ls, await ctx(), { api_token: TOKEN, shepherded: true });
    expect(result.pull_requests).toEqual([]);
  });
});

describe("show", () => {
  test("carries the unresolved comments and the recent events", async () => {
    const result = await call(show, await ctx(), { api_token: TOKEN, number: 42 });
    expect(result.unresolved_comments).toHaveLength(1);
    expect(result.unresolved_comments[0]).toMatchObject({
      file_path: "src/auth.ts",
      line_number: 12,
      author: "reviewer",
    });
    expect(result.events.map((e: any) => e.kind)).toEqual(["pr_synchronize", "pr_check"]);
  });

  test("a non member gets nothing to read", async () => {
    const result = await call(show, await ctx(), { api_token: OUTSIDER_TOKEN, number: 42, repository: "codecast-sh/codecast" });
    expect(result.pull_request).toBeNull();
  });

  // An agent commenting through `cast pr comment` has no GitHub username, so
  // the author falls back to the session that wrote it rather than going blank.
  test("a comment an agent wrote names the session behind it", async () => {
    const testCtx = await ctx({
      review_comments: [
        {
          _id: "rc_3",
          pull_request_id: "pr_1",
          content: "Pushed a fix for the failing check",
          resolved: false,
          created_at: 12,
          conversation_id: "conv_mine",
          author_kind: "agent",
        },
      ],
    });
    const result = await call(show, testCtx, { api_token: TOKEN, number: 42 });
    expect(result.unresolved_comments[0].author).toBe("jx7mine");
  });
});

describe("the shepherd binding", () => {
  test("on binds the session, off releases it", async () => {
    const testCtx = await ctx();
    const on = await call(shepherd, testCtx, {
      api_token: TOKEN,
      number: 42,
      action: "on",
      bind_session: "jx7mine",
    });
    expect(on.pull_request.shepherd).toMatchObject({
      session_id: "conv_mine",
      session_short_id: "jx7mine",
      enabled: true,
      state: "ci_red",
    });
    // The session card learns about the pull request in the same write.
    const cardPatch = testCtx.db._patched.find((p: any) => p._id === "conv_mine" && p.patch.pr_status);
    expect(cardPatch.patch.pr_status).toMatchObject({ repository: "codecast-sh/codecast", number: 42 });

    const off = await call(shepherd, testCtx, {
      api_token: TOKEN,
      number: 42,
      action: "off",
    });
    expect(off.pull_request.shepherd.enabled).toBe(false);
    // A released pull request reports no shepherd state at all, so `watch`
    // sees the release as a transition and the table stops showing a state
    // nobody is acting on.
    expect(off.pull_request.shepherd.state).toBe(null);
    expect(off.pull_request.shepherd_state).toBe(null);
    // Off stands the trigger down. The card keeps naming the pull request: the
    // session is still the one that opened it, it just stops being woken.
    const retired = testCtx.db._patched.filter((p: any) => p.patch.status === "completed");
    expect(retired).toHaveLength(1);
  });

  test("status reads without writing", async () => {
    const testCtx = await ctx();
    const result = await call(shepherd, testCtx, { api_token: TOKEN, number: 42, action: "status" });
    expect(result.changed).toBe(false);
    expect(testCtx.db._patched).toHaveLength(0);
  });

  test("a session you do not own cannot be bound", async () => {
    const testCtx = await ctx();
    await expect(call(shepherd, testCtx, {
      api_token: TOKEN,
      number: 42,
      action: "on",
      bind_session: "jx7them",
    })).rejects.toThrow("No session of yours");
    expect(testCtx.db._patched).toHaveLength(0);
  });

  test("a non member cannot bind their session to another team's pull request", async () => {
    const testCtx = await ctx();
    const result = await call(shepherd, testCtx, {
      api_token: OUTSIDER_TOKEN,
      repository: "codecast-sh/codecast",
      number: 42,
      action: "on",
      bind_session: "jx7them",
    });
    expect(result.pull_request).toBeNull();
    expect(testCtx.db._patched).toHaveLength(0);
  });
});

describe("watching", () => {
  test("open pull requests in the caller's teams, closed ones dropped", async () => {
    const testCtx = await ctx({
      pull_requests: (await tables()).pull_requests.map((pr: any) =>
        pr._id === "pr_1" ? { ...pr, state: "merged" } : pr),
    });
    const result = await call(watchPRs, testCtx, { api_token: TOKEN });
    expect(result.pull_requests).toEqual([]);
  });

  test("an explicit set is watched whatever its state", async () => {
    const testCtx = await ctx({
      pull_requests: (await tables()).pull_requests.map((pr: any) =>
        pr._id === "pr_1" ? { ...pr, state: "merged" } : pr),
    });
    const result = await call(watchPRs, testCtx, { api_token: TOKEN, pr_ids: ["pr_1"] });
    expect(result.pull_requests.map((pr: any) => pr.id)).toEqual(["pr_1"]);
  });
});

describe("counting checks", () => {
  test("a check that has not concluded is still running", () => {
    expect(countChecks([
      { name: "a", status: "completed", conclusion: "success", updated_at: 1 },
      { name: "b", status: "completed", conclusion: "timed_out", updated_at: 1 },
      { name: "c", status: "queued", updated_at: 1 },
    ])).toEqual({ green: 1, red: 1, pending: 1 });
  });

  test("no checks at all is not a failure", () => {
    expect(countChecks(undefined)).toEqual({ green: 0, red: 0, pending: 0 });
  });
});

// ── review threads ──
//
// The point of these is naming a thread: a caller reads the list, then says
// "that one" with a short id or the file and line it sits on.

// Convex-shaped ids on purpose: a comment is named by the last 8 characters of
// its id, so a fixture with "rc_1" would never exercise that path.
const C1 = "p17aaaaaaaaaaaaaaaaaaaaaaaaaa001";
const C2 = "p17bbbbbbbbbbbbbbbbbbbbbbbbbb002";
const C3 = "p17cccccccccccccccccccccccccc003";

// C1 is an open thread on src/auth.ts:12; C2 is resolved and has no file.
const threadTables = {
  review_comments: [
    { _id: C1, pull_request_id: "pr_1", content: "This leaks a handle\nsecond line", file_path: "src/auth.ts", line_number: 12, resolved: false, created_at: 10, author_github_username: "reviewer" },
    { _id: C2, pull_request_id: "pr_1", content: "Fixed", resolved: true, created_at: 11, conversation_id: "conv_mine" },
    { _id: C3, pull_request_id: "pr_1", content: "And this one too", file_path: "src/auth.ts", line_number: 40, resolved: false, created_at: 12, author_github_username: "reviewer" },
  ],
};

describe("listing threads", () => {
  test("open threads only, unless every one is asked for", async () => {
    const open = await call(threads, await ctx(threadTables), { api_token: TOKEN, number: 42 });
    expect(open.threads.map((t: any) => t.id)).toEqual([C1, C3]);
    expect(open.resolved_count).toBe(1);

    const all = await call(threads, await ctx(threadTables), { api_token: TOKEN, number: 42, all: true });
    expect(all.threads).toHaveLength(3);
  });

  test("a row carries what the next command needs", async () => {
    const result = await call(threads, await ctx(threadTables), { api_token: TOKEN, number: 42 });
    expect(result.threads[0]).toMatchObject({
      id: C1,
      file_path: "src/auth.ts",
      line_number: 12,
      author: "reviewer",
      resolved: false,
      // One line, so a long comment cannot break the table.
      first_line: "This leaks a handle",
    });
  });

  test("an agent's thread names the session that wrote it", async () => {
    const result = await call(threads, await ctx(threadTables), { api_token: TOKEN, number: 42, all: true });
    expect(result.threads.find((t: any) => t.id === C2).author).toBe("jx7mine");
  });

  test("a non member sees no threads", async () => {
    const result = await call(threads, await ctx(threadTables), {
      api_token: OUTSIDER_TOKEN, number: 42, repository: "codecast-sh/codecast",
    });
    expect(result.pull_request).toBeNull();
    expect(result.threads).toEqual([]);
  });
});

describe("naming a thread", () => {
  const find = (selector: string) =>
    ctx(threadTables).then((c) => call(findComment, c, { api_token: TOKEN, number: 42, selector }));

  test("the short id the list printed", async () => {
    expect((await find(C1.slice(-8))).comment_id).toBe(C1);
  });

  test("the whole id, as --json prints it", async () => {
    expect((await find(C1)).comment_id).toBe(C1);
  });

  test("the file and line it sits on", async () => {
    expect((await find("src/auth.ts:12")).comment_id).toBe(C1);
    expect((await find("src/auth.ts:40")).comment_id).toBe(C3);
  });

  // Two open threads share src/auth.ts, so the file alone cannot mean one.
  test("a file covering several threads names none of them", async () => {
    const result = await find("src/auth.ts");
    expect(result.comment_id).toBeNull();
    expect(result.matches.map((m: any) => m.id)).toEqual([C1, C3]);
  });

  test("nothing there matches nothing", async () => {
    const result = await find("src/nowhere.ts:1");
    expect(result.comment_id).toBeNull();
    expect(result.matches).toEqual([]);
  });

  // An unresolved thread is what somebody means by "resolve this line".
  test("an open thread wins over a settled one at the same line", async () => {
    const testCtx = await ctx({
      review_comments: [
        { _id: C1, pull_request_id: "pr_1", content: "old", file_path: "a.ts", line_number: 3, resolved: true, created_at: 1 },
        { _id: C2, pull_request_id: "pr_1", content: "new", file_path: "a.ts", line_number: 3, resolved: false, created_at: 2 },
      ],
    });
    const result = await call(findComment, testCtx, { api_token: TOKEN, number: 42, selector: "a.ts:3" });
    expect(result.comment_id).toBe(C2);
  });
});

describe("reading a thread selector", () => {
  test("a file with a line, and a file without one", () => {
    expect(parseCommentLocation("src/auth.ts:12")).toEqual({ file: "src/auth.ts", line: 12 });
    expect(parseCommentLocation("src/auth.ts")).toEqual({ file: "src/auth.ts" });
  });

  test("a convex id is an id, never a path", () => {
    expect(parseCommentLocation("a".repeat(32))).toBeNull();
  });

  test("a bare word is a mistyped id, not a file", () => {
    expect(parseCommentLocation("nonsense")).toBeNull();
  });

  test("a windows-looking path with no line still names a file", () => {
    expect(parseCommentLocation("packages/cli/src/index.ts")).toEqual({ file: "packages/cli/src/index.ts" });
  });
});

describe("repository case", () => {
  test("a repository typed with capitals finds the row stored in canonical form", async () => {
    const result = await call(resolve, await ctx(), {
      api_token: TOKEN,
      repository: "Codecast-SH/Codecast",
      number: 42,
    });
    expect(result.pull_request?.id).toBe("pr_1");
  });

  test("a reference with capitals resolves the same way", async () => {
    const result = await call(resolve, await ctx(), {
      api_token: TOKEN,
      ref: "https://github.com/Codecast-SH/Codecast/pull/42",
    });
    expect(result.pull_request?.id).toBe("pr_1");
  });

  test("ls narrowed to a repository typed with capitals still lists it", async () => {
    const result = await call(ls, await ctx(), { api_token: TOKEN, repository: "Codecast-SH/Codecast" });
    expect(result.pull_requests.map((pr: any) => pr.id)).toContain("pr_1");
  });
});
