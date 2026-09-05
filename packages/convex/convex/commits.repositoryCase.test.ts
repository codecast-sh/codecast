import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { commitFilesState, getCommitsByRepository, getUserActiveRepositories } from "./commits";

const sha = "b".repeat(40);
function context(seed: Record<string, any[]> = {}) {
  return {
    auth: { getUserIdentity: async () => ({ subject: "u1|sess" }) },
    db: makeFakeDb({
      users: [{ _id: "u1" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      conversations: [{ _id: "c1", user_id: "u1", git_remote_url: "git@github.com:Codecast-SH/Codecast.git" }],
      commits: [{ _id: "k1", team_id: "team_1", repository: "codecast-sh/codecast", sha, timestamp: 1, files: [] }],
      ...seed,
    }),
  } as any;
}

describe("commit repository case", () => {
  test("getCommitsByRepository finds canonical rows when asked with capitals", async () => {
    const rows = await (getCommitsByRepository as any)._handler(context(), { repository: "Codecast-SH/Codecast" });
    expect(rows.map((r: any) => r._id)).toEqual(["k1"]);
  });

  test("commitFilesState does not mistake a case difference for another repository", async () => {
    const state = await (commitFilesState as any)._handler(context(), { repository: "Codecast-SH/Codecast", sha });
    expect(state?.commit_id).toBe("k1");
  });

  test("a checkout remote with capitals names the canonical repository", async () => {
    const repos = await (getUserActiveRepositories as any)._handler(context(), {});
    expect(repos).toEqual(["codecast-sh/codecast"]);
  });
});
