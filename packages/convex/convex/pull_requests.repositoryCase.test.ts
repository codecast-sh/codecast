import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { create, fitFilePatches, getPRByNumber, getPRsForTimeline } from "./pull_requests";

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

  test("the timeline returns each team's newest, filtered by repository", async () => {
    const pull_requests = Array.from({ length: 8 }, (_, i) => ({
      _id: `pr_${i}`, team_id: "team_1", repository: i % 2 ? "a/b" : "codecast-sh/codecast", number: i, state: "open", updated_at: i,
    }));
    const newest = await (getPRsForTimeline as any)._handler(context({ pull_requests }), { limit: 3 });
    expect(newest.map((r: any) => r._id)).toEqual(["pr_7", "pr_6", "pr_5"]);
    // One repository's answer keeps every open PR past the limit (the Deploys page lists each one).
    const inRepo = await (getPRsForTimeline as any)._handler(context({ pull_requests }), { repository: "codecast-sh/codecast", limit: 2 });
    expect(inRepo.map((r: any) => r._id)).toEqual(["pr_6", "pr_4", "pr_2", "pr_0"]);
  });

  test("a repository reads only its own rows, not the team's other repositories", async () => {
    const patch = "x".repeat(1024 * 1024);
    const busy = Array.from({ length: 40 }, (_, i) => ({
      _id: `busy_${i}`, team_id: "team_1", repository: "a/busy", number: i, state: "merged", updated_at: 100 + i,
      files: [{ filename: "f.ts", patch }],
    }));
    const pull_requests = [
      ...busy,
      { _id: "old_open", team_id: "team_1", repository: "codecast-sh/codecast", number: 1, state: "open", updated_at: 50 },
      { _id: "newer", team_id: "team_1", repository: "codecast-sh/codecast", number: 2, state: "merged", updated_at: 10 },
      { _id: "other_team", team_id: "team_2", repository: "codecast-sh/codecast", number: 3, state: "open", updated_at: 60 },
    ];
    const ctx = context({ pull_requests });
    const indexes: string[] = [];
    const query = ctx.db.query.bind(ctx.db);
    ctx.db.query = (table: string) => {
      const q = query(table);
      const withIndex = q.withIndex.bind(q);
      q.withIndex = (name: string, range: any) => { indexes.push(name); return withIndex(name, range); };
      return q;
    };
    const rows = await (getPRsForTimeline as any)._handler(ctx, { repository: "codecast-sh/codecast" });
    expect(rows.map((r: any) => r._id)).toEqual(["old_open", "newer"]);
    expect(indexes.filter((name) => name.startsWith("by_repository"))).toEqual(["by_repository_state", "by_repository_number"]);
    expect(indexes).not.toContain("by_team_updated");
  });

  test("the timeline sends list rows, and stops reading past its byte budget", async () => {
    const patch = "x".repeat(1024 * 1024);
    const pull_requests = Array.from({ length: 20 }, (_, i) => ({
      _id: `pr_${i}`, team_id: "team_1", repository: "a/b", number: i, state: "open", updated_at: i,
      files: [{ filename: "f.ts", patch }], commits: [{ sha: "s" }], checks: [{ name: "ci" }],
    }));
    const rows = await (getPRsForTimeline as any)._handler(context({ pull_requests }), {});
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(20);
    expect(rows[0]._id).toBe("pr_19");
    for (const row of rows) expect(row.files ?? row.commits ?? row.checks).toBeUndefined();
  });
});

describe("updatePRFiles patch fit", () => {
  test("a 100-file PR's patches are cut to fit the 1 MiB row; counts stay", () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      filename: `f${i}.ts`, status: "modified", additions: 1, deletions: 1, changes: 2, patch: "x".repeat(50 * 1024),
    }));
    const rest = { title: "big", commits: [{ sha: "a", message: "m".repeat(100 * 1024) }] };
    const fitted = fitFilePatches(files, rest);
    expect(fitted).toHaveLength(100);
    expect(JSON.stringify({ ...rest, files: fitted }).length).toBeLessThan(1024 * 1024);
    expect(fitted[0].patch).toBe(files[0].patch);
    expect(fitted[99].patch).toBeUndefined();
    expect(fitted[99].additions).toBe(1);
  });

  test("small PRs keep every patch", () => {
    const files = [{ filename: "a", status: "added", additions: 3, deletions: 0, changes: 3, patch: "+a" }];
    expect(fitFilePatches(files, { title: "t" })).toEqual(files);
  });
});
