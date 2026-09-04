import { describe, expect, test } from "bun:test";
import { getLog, getPulls, ttlFor } from "./repos";
import { makeFakeDb } from "./testDb";

const sha = "a".repeat(40);
function context(overrides: Record<string, any[]> = {}) {
  return {
    auth: { getUserIdentity: async () => ({ subject: "reader|sess", tokenIdentifier: "test" }) },
    db: makeFakeDb({
      users: [{ _id: "reader", active_team_id: "team" }],
      team_memberships: [{ _id: "member", user_id: "reader", team_id: "team" }],
      github_app_installations: [{ _id: "install", account_login: "demo", team_id: "team", installation_id: 1,
        repository_selection: "selected", repositories: [{ full_name: "demo/public" }] }],
      repo_cache: [
        { _id: "log", repository: "demo/public", kind: "log", ref: "main", path: "#1#", fetched_at: Date.now(),
          content: JSON.stringify({ commits: [{ sha, message: "public commit" }] }) },
        { _id: "pulls", repository: "demo/public", kind: "pulls", ref: "open", path: "#1", fetched_at: Date.now(),
          content: JSON.stringify({ pulls: [{ number: 7, title: "public PR" }] }) },
      ],
      conversations: [{ _id: "private-session", user_id: "other-user", is_private: true, title: "SECRET SESSION" }],
      tasks: [{ _id: "private-task", user_id: "other-user", workspace: "user:other-user", short_id: "ct-secret", title: "SECRET TASK" }],
      commits: [{ _id: "private-commit", repository: "different/private", sha, team_id: "other-team",
        conversation_id: "private-session", task_ids: ["private-task"] }],
      pull_requests: [{ _id: "private-pr", repository: "demo/public", number: 7, team_id: "other-team",
        shepherd_conversation_id: "private-session", shepherd_enabled: true }],
      ...overrides,
    }),
  };
}
const log = (ctx: any) => (getLog as any)._handler(ctx, { repository: "demo/public", ref: "main" });
const pulls = (ctx: any) => (getPulls as any)._handler(ctx, { repository: "demo/public" });

describe("repository join authorization", () => {
  test("a matching SHA from another repository does not reveal any joins", async () => {
    const result = await log(context());
    expect(result.commits[0]).toMatchObject({ message: "public commit", session: null, conversation_id: null, tasks: [] });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  test("a readable commit independently checks its private tasks and session", async () => {
    const result = await log(context({ commits: [{ _id: "commit", repository: "demo/public", sha, team_id: "team",
      conversation_id: "private-session", task_ids: ["private-task"] }] }));
    expect(result.commits[0]).toMatchObject({ session: null, conversation_id: null, tasks: [] });
  });
  test("a readable matching row is found after a same-SHA row in another repository", async () => {
    const ctx = context();
    ctx.db._tables.conversations.push({ _id: "own", user_id: "reader", title: "Own session" });
    ctx.db._tables.tasks.push({ _id: "own-task", user_id: "reader", workspace: "team:team", short_id: "ct-1", title: "Own task" });
    ctx.db._tables.commits.push({ _id: "own-commit", repository: "demo/public", sha, team_id: "team",
      conversation_id: "own", task_ids: ["own-task"] });
    const result = await log(ctx);
    expect(result.commits[0].session.title).toBe("Own session");
    expect(result.commits[0].tasks[0].title).toBe("Own task");
  });
  test("a PR from another team contributes no shepherd state", async () => {
    const result = await pulls(context());
    expect(result.pulls[0]).toMatchObject({ title: "public PR", conversation_id: null, shepherd_enabled: null });
  });
  test("a readable PR still cannot expose a private shepherd session", async () => {
    const ctx = context();
    ctx.db._tables.pull_requests[0].team_id = "team";
    expect((await pulls(ctx)).pulls[0]).toMatchObject({ conversation_id: null, shepherd_enabled: true });
  });
  test("losing installation access suppresses previously cached source", async () => {
    expect(await log(context({ team_memberships: [] }))).toBeNull();
    expect(await pulls(context({ team_memberships: [] }))).toBeNull();
  });
});

test("compare cache is immutable only when both refs are commits", () => {
  expect(ttlFor("compare", sha, "main")).toBe(600_000);
  expect(ttlFor("compare", "main", sha)).toBe(600_000);
  expect(ttlFor("compare", sha, "b".repeat(40))).toBe(Infinity);
});
