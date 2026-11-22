import { describe, expect, test } from "bun:test";
import { commitBranch } from "./deployTargetsState";

// A stand-in db: get by id, and the one pull_requests lookup by repository and number.
const dbOf = (prs: Array<{ _id: string; repository: string; number: number; head_ref?: string }>) => ({
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

describe("the branch a commit on main came from", () => {
  const ctx = dbOf([{ _id: "pr1", repository: "o/r", number: 12, head_ref: "jb/deploys-focus" }, { _id: "pr2", repository: "o/r", number: 13, head_ref: "main" }]);
  test("its linked pull request's head", async () => {
    expect(await commitBranch(ctx, commit("Anything", { pr_id: "pr1" }), null)).toBe("jb/deploys-focus");
  });
  test("else the pull request its squash subject names", async () => {
    expect(await commitBranch(ctx, commit("Fix the thing (#12)\n\nbody"), null)).toBe("jb/deploys-focus");
  });
  test("else the branch its session worked on", async () => {
    expect(await commitBranch(ctx, commit("No PR here"), { git_branch: "codecast/change-ct-1" })).toBe("codecast/change-ct-1");
  });
  test("the default branch names nothing, and neither does nothing", async () => {
    expect(await commitBranch(ctx, commit("Fix (#13)"), null)).toBeNull();
    expect(await commitBranch(ctx, commit("No PR"), { git_branch: "main" })).toBeNull();
    expect(await commitBranch(ctx, commit("No PR"), null)).toBeNull();
  });
});
