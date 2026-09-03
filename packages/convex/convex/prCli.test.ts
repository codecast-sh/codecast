// What `cast pr` is allowed to see and change.
//
// Two rules carry the whole surface. A pull request is readable by members of
// its team and nobody else, so a caller outside the team gets "no such pull
// request" rather than a redacted row. A session binding is stricter still:
// you may point your own agent at a pull request, never somebody else's.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { ls, show, shepherd, resolve, watchPRs, countChecks } from "./prCli";

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
      { _id: "rc_1", pull_request_id: "pr_1", content: "This leaks a handle", file_path: "src/auth.ts", line_number: 12, resolved: false, created_at: 10, author_github_username: "reviewer" },
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
    const cardPatch = testCtx.db._patched.find((p: any) => p._id === "conv_mine");
    expect(cardPatch.patch.pr_status).toMatchObject({ repository: "codecast-sh/codecast", number: 42 });

    const off = await call(shepherd, testCtx, {
      api_token: TOKEN,
      number: 42,
      action: "off",
    });
    expect(off.pull_request.shepherd.enabled).toBe(false);
    const cleared = testCtx.db._patched.filter((p: any) => p._id === "conv_mine").at(-1);
    expect(cleared.patch).toEqual({ pr_status: undefined });
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
