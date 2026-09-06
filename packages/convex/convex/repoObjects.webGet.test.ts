import { describe, expect, test } from "bun:test";
import { webGet as prWebGet } from "./pull_requests";
import { webGet as commitWebGet } from "./commits";
import { makeFakeDb } from "./testDb";

// The reference surfaces (pills, cards, `cast link`) resolve a pull request or
// a commit by the two halves of its text reference — repository + number, or
// repository + sha — and must answer null, never throw, for anything the
// caller may not read. Same rules as every other reader of these tables.

const SHA = "aa57b85ee0f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5";
const OTHER_SHA = "aa57b85ee9999999999999999999999999999999";

function context(user: string | null = "reader") {
  return {
    auth: { getUserIdentity: async () => (user ? { subject: `${user}|sess`, tokenIdentifier: "test" } : null) },
    db: makeFakeDb({
      users: [{ _id: "reader" }, { _id: "outsider" }],
      team_memberships: [{ _id: "m1", user_id: "reader", team_id: "team" }],
      conversations: [{ _id: "conv", user_id: "reader", is_private: true, title: "mine" }],
      pull_requests: [
        { _id: "pr1", repository: "codecast-sh/codecast", number: 482, title: "Fix the auth race", team_id: "team", state: "open", updated_at: 1, created_at: 1 },
        { _id: "pr2", repository: "codecast-sh/codecast", number: 483, title: "SECRET", team_id: "other-team", state: "open", updated_at: 1, created_at: 1 },
      ],
      commits: [
        { _id: "c1", repository: "codecast-sh/codecast", sha: SHA, message: "feat: thing", team_id: "team", timestamp: 1 },
        { _id: "c2", repository: "someone/else", sha: OTHER_SHA, message: "SECRET", team_id: "other-team", timestamp: 1 },
        { _id: "c3", sha: "bb" + "0".repeat(38), message: "from a transcript", conversation_id: "conv", timestamp: 1 },
      ],
    }),
  };
}

const pr = (ctx: any, args: any) => (prWebGet as any)._handler(ctx, args);
const commit = (ctx: any, args: any) => (commitWebGet as any)._handler(ctx, args);

describe("pull_requests.webGet", () => {
  test("resolves by repository and number for a team member, with display case tolerated", async () => {
    expect((await pr(context(), { repository: "Codecast-sh/Codecast", number: 482 }))?._id).toBe("pr1");
  });
  test("resolves by Convex id", async () => {
    expect((await pr(context(), { id: "pr1" }))?._id).toBe("pr1");
  });
  test("another team's pull request is null, by number and by id", async () => {
    expect(await pr(context(), { repository: "codecast-sh/codecast", number: 483 })).toBeNull();
    expect(await pr(context(), { id: "pr2" })).toBeNull();
  });
  test("unknown number, missing args, and no viewer are null", async () => {
    expect(await pr(context(), { repository: "codecast-sh/codecast", number: 9999 })).toBeNull();
    expect(await pr(context(), {})).toBeNull();
    expect(await pr(context(null), { repository: "codecast-sh/codecast", number: 482 })).toBeNull();
  });
});

describe("commits.webGet", () => {
  test("resolves by full sha and by Convex id for a team member", async () => {
    expect((await commit(context(), { repository: "codecast-sh/codecast", sha: SHA }))?._id).toBe("c1");
    expect((await commit(context(), { id: "c1" }))?._id).toBe("c1");
  });
  test("an abbreviated sha is a prefix match, and the repository breaks ties", async () => {
    expect((await commit(context(), { repository: "codecast-sh/codecast", sha: "AA57B85" }))?._id).toBe("c1");
    // Same prefix, other repository: not this one, and not readable anyway.
    expect(await commit(context(), { repository: "someone/else", sha: "aa57b85" })).toBeNull();
  });
  test("a transcript commit with no repository resolves by sha through its session", async () => {
    expect((await commit(context(), { repository: "any/repo", sha: "bb000000" }))?._id).toBe("c3");
    expect(await commit(context("outsider"), { sha: "bb000000" })).toBeNull();
  });
  test("another team's commit and a missing viewer are null", async () => {
    expect(await commit(context(), { id: "c2" })).toBeNull();
    expect(await commit(context(null), { sha: SHA })).toBeNull();
  });
});
