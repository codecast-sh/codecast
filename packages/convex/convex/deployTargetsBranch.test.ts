import { describe, expect, test } from "bun:test";
import { commitFacts } from "./deployTargetsState";

// A stand-in db: get by id, and the one pull_requests lookup by repository and number.
const dbOf = (prs: Array<{ _id: string; repository: string; number: number; head_ref?: string; merge_commit_sha?: string; additions?: number; deletions?: number }>) => ({
  db: {
    get: async (id: string) => prs.find((p) => p._id === id) ?? null,
    query: () => ({
      withIndex: (_: string, f: (q: any) => any) => {
        const eqs: Record<string, unknown> = {};
        const q = { eq: (k: string, v: unknown) => { eqs[k] = v; return q; } };
        f(q);
        return { first: async () => prs.find((p) => p.repository === eqs.repository && p.number === eqs.number) ?? null };
      },
    }),
  },
});
const commit = (message: string, extra: Record<string, unknown> = {}) => ({ sha: "a", message, repository: "o/r", ...extra }) as any;

const branch = async (ctx: any, c: any, conv: { git_branch?: string } | null) => (await commitFacts(ctx, c, conv)).branch;

describe("a commit on main: its branch, pull request and lines (commitFacts)", () => {
  const ctx = dbOf([
    { _id: "pr1", repository: "o/r", number: 12, head_ref: "jb/deploys-focus", merge_commit_sha: "a", additions: 50, deletions: 5 },
    { _id: "pr2", repository: "o/r", number: 13, head_ref: "main" },
    { _id: "pr3", repository: "o/r", number: 14, head_ref: "ana/feature", merge_commit_sha: "f".repeat(40), additions: 9, deletions: 9 },
  ]);
  test("its linked pull request's head", async () => {
    expect(await branch(ctx, commit("Anything", { pr_id: "pr1" }), null)).toBe("jb/deploys-focus");
  });
  test("a pull request its subject names counts only as its squash merge: the PR's merge commit, or the PR its row records", async () => {
    // #12's merge commit is this one ("a").
    expect(await commitFacts(ctx, commit("Fix the thing (#12)\n\nbody"), null)).toEqual({ insertions: 50, deletions: 5, pr_number: 12, branch: "jb/deploys-focus" });
    // #14 merged as another commit: a revert naming it proves nothing, so no lines, branch or number from it.
    expect(await commitFacts(ctx, commit("Revert the feature (#14)"), null)).toEqual({ pr_number: null, branch: null });
    // The row records #14 itself.
    expect(await commitFacts(ctx, commit("Feature", { pr_number: 14 }), null)).toEqual({ insertions: 9, deletions: 9, pr_number: 14, branch: "ana/feature" });
  });
  test("a linked pull request that is not its squash merge gives the branch, never its lines", async () => {
    expect(await commitFacts(ctx, commit("One of #14's commits", { pr_id: "pr3" }), null)).toEqual({ pr_number: 14, branch: "ana/feature" });
  });
  test("the files' own line counts win; a webhook row's zeros claim nothing", async () => {
    const files = [{ filename: "x", status: "modified", additions: 3, deletions: 1, changes: 4 }];
    expect(await commitFacts(ctx, commit("Fix the thing (#12)", { files }), null)).toMatchObject({ insertions: 3, deletions: 1 });
    expect(await commitFacts(ctx, commit("Plain", { files: [{ filename: "x", status: "modified", additions: 0, deletions: 0, changes: 0 }], insertions: 1 }), null)).toEqual({ pr_number: null, branch: null });
  });
  test("else the branch its session worked on", async () => {
    expect(await branch(ctx, commit("No PR here"), { git_branch: "codecast/change-ct-1" })).toBe("codecast/change-ct-1");
  });
  test("the default branch names nothing, and neither does nothing", async () => {
    expect(await branch(ctx, commit("Fix (#13)", { pr_number: 13 }), null)).toBeNull();
    expect(await branch(ctx, commit("No PR"), { git_branch: "main" })).toBeNull();
    expect(await branch(ctx, commit("No PR"), null)).toBeNull();
  });
});
