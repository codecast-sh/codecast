import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { create, getPRByNumber, getPRsForTimeline } from "./pull_requests";

function context(seed: Record<string, any[]> = {}) {
  return {
    auth: { getUserIdentity: async () => ({ subject: "u1|sess" }) },
    db: makeFakeDb({
      users: [{ _id: "u1" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      pull_requests: [{ _id: "pr_1", team_id: "team_1", repository: "codecast-sh/codecast", number: 5, state: "open", updated_at: 1 }],
      ...seed,
    }),
  } as any;
}

describe("pull request repository case", () => {
  test("create stores the canonical spelling", async () => {
    const ctx = context({ pull_requests: [] });
    await (create as any)._handler(ctx, {
      team_id: "team_1", github_pr_id: 1, repository: "Codecast-SH/Codecast", number: 1, title: "t", body: "",
      state: "open", author_github_username: "a", linked_session_ids: [],
    });
    expect(ctx.db._tables.pull_requests[0].repository).toBe("codecast-sh/codecast");
  });

  test("getPRByNumber finds the row when asked with capitals", async () => {
    const row = await (getPRByNumber as any)._handler(context(), { repository: "Codecast-SH/Codecast", number: 5 });
    expect(row?._id).toBe("pr_1");
  });

  test("the timeline filter matches case insensitively", async () => {
    const rows = await (getPRsForTimeline as any)._handler(context(), { repository: "Codecast-SH/Codecast" });
    expect(rows.map((r: any) => r._id)).toEqual(["pr_1"]);
  });
});
