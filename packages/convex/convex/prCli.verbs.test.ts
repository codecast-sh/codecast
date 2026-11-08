// The verbs that change a pull request on GitHub share one shape: resolve the
// caller and the pull request, pick a token, make one call, answer in GitHub's
// words when it refuses. The web page and `cast pr` both call these.
import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { autoMerge, close, draft, edit, merge, mergeAccess, reopen, reviewers, review, updateBranch } from "./prCli";

function harness(actor: any, answer: any = {}) {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = {
    async runQuery(_ref: any, _args: any) { return actor; },
    async runAction(ref: any, args: any) {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      if (name.includes("tokenForPR")) return "app_tok";
      if (name.includes("pullRequestMergeability") && typeof answer !== "function") {
        return { id: "PR_node", merge_state: "CLEAN", can_bypass: false, head_sha: "abc" };
      }
      if (typeof answer === "function") return answer(name, args);
      return answer;
    },
  } as any;
  return { ctx, calls };
}

const openPr = { id: "pr_1", repository: "codecast-sh/codecast", number: 12, state: "open", head_ref: "feature" };
const withToken = { user_id: "u1", github_token: "user_tok", github_username: "ashot", pr: openPr };
const withoutToken = { user_id: "u1", github_token: null, github_username: null, pr: openPr };

describe("pull request verbs", () => {
  test("reopen refuses an open pull request before touching GitHub", async () => {
    const { ctx, calls } = harness(withToken);
    const out = await (reopen as any)._handler(ctx, { number: 12 });
    expect(out.error).toMatch(/is open, not closed/);
    expect(calls).toEqual([]);
  });

  test("reopen acts as the person when they hold a token", async () => {
    const { ctx, calls } = harness({ ...withToken, pr: { ...openPr, state: "closed" } }, { state: "open" });
    const out = await (reopen as any)._handler(ctx, { number: 12 });
    expect(out).toMatchObject({ repository: "codecast-sh/codecast", number: 12, state: "open", as: "ashot" });
    expect(calls[0].name).toContain("reopenPullRequest");
    expect(calls[0].args.github_access_token).toBe("user_tok");
  });

  test("draft falls back to the app's token when the person has none", async () => {
    const { ctx, calls } = harness(withoutToken, { draft: true });
    const out = await (draft as any)._handler(ctx, { number: 12, draft: true });
    expect(out).toMatchObject({ draft: true, as: "the codecast app" });
    const call = calls.find((c) => c.name.includes("setPullRequestDraft"))!;
    expect(call.args).toMatchObject({ draft: true, github_access_token: "app_tok" });
  });

  test("reviewers passes both lists through", async () => {
    const { ctx, calls } = harness(withToken, { requested_reviewers: ["sam"] });
    const out = await (reviewers as any)._handler(ctx, { number: 12, add: ["sam"], remove: ["ada"] });
    expect(out.requested_reviewers).toEqual(["sam"]);
    expect(calls[0].args).toMatchObject({ add: ["sam"], remove: ["ada"] });
  });

  test("edit works on a closed pull request too", async () => {
    const { ctx } = harness({ ...withToken, pr: { ...openPr, state: "closed" } }, { title: "New", body: "" });
    const out = await (edit as any)._handler(ctx, { number: 12, title: "New" });
    expect(out.title).toBe("New");
  });

  test("GitHub's refusal comes back in its own words", async () => {
    const { ctx } = harness(withToken, () => { throw new Error("Uncaught Error: Pull Request is not mergeable\n    at handler"); });
    const out = await (merge as any)._handler(ctx, { number: 12 });
    expect(out).toEqual({ error: "Pull Request is not mergeable" });
  });

  test("merge, auto-merge and update branch carry the head the person looked at", async () => {
    const { ctx, calls } = harness(withToken, { merged: true, auto_merge: true });
    await (merge as any)._handler(ctx, { number: 12, method: "rebase", expected_head_sha: "abc" });
    await (autoMerge as any)._handler(ctx, { number: 12, enabled: true, expected_head_sha: "abc" });
    await (autoMerge as any)._handler(ctx, { number: 12, enabled: false, expected_head_sha: "abc" });
    await (updateBranch as any)._handler(ctx, { number: 12, expected_head_sha: "abc" });
    expect(calls.map((c) => c.name.split(":")[1])).toEqual(["pullRequestMergeability", "mergePullRequest", "setAutoMerge", "setAutoMerge", "updatePullRequestBranch"]);
    expect(calls[1].args).toMatchObject({ method: "rebase", expected_head_sha: "abc" });
    expect(calls[1].args.bypass_node_id).toBeUndefined();
    expect(calls[2].args).toMatchObject({ enabled: true, expected_head_sha: "abc" });
    // Turning auto-merge off needs no guard: it can only make the branch safer.
    expect(calls[3].args.expected_head_sha).toBeUndefined();
    expect(calls[4].args).toMatchObject({ expected_head_sha: "abc", github_access_token: "user_tok" });
  });

  describe("a merge branch protection holds", () => {
    const held = (canBypass: boolean, state = "BLOCKED") => (name: string) =>
      name.includes("pullRequestMergeability")
        ? { id: "PR_node", merge_state: state, can_bypass: canBypass, head_sha: "abc" }
        : { merged: true, sha: "m1", branch_deleted: false };

    test("is refused without the ask, even for someone who may bypass, and names --admin", async () => {
      const { ctx, calls } = harness(withToken, held(true));
      const out = await (merge as any)._handler(ctx, { number: 12 });
      expect(out.error).toMatch(/Branch protection holds codecast-sh\/codecast#12: required reviews or checks/);
      expect(out.error).toMatch(/ashot may bypass it: cast pr merge --admin/);
      expect(calls.some((c) => c.name.includes("mergePullRequest"))).toBe(false);
    });

    test("is refused with the ask when GitHub does not let this identity bypass", async () => {
      const { ctx, calls } = harness(withoutToken, held(false, "BEHIND"));
      const out = await (merge as any)._handler(ctx, { number: 12, bypass: true });
      expect(out.error).toMatch(/up to date with the base first\. GitHub does not let the codecast app bypass it/);
      expect(calls.some((c) => c.name.includes("mergePullRequest"))).toBe(false);
    });

    test("bypasses as the person when they ask and GitHub allows it", async () => {
      const { ctx, calls } = harness(withToken, held(true));
      const out = await (merge as any)._handler(ctx, { number: 12, bypass: true, expected_head_sha: "abc" });
      expect(out).toMatchObject({ merged: true, bypassed: true, as: "ashot" });
      const call = calls.find((c) => c.name.includes("mergePullRequest"))!;
      expect(call.args).toMatchObject({ bypass_node_id: "PR_node", github_access_token: "user_tok", expected_head_sha: "abc" });
    });

    test("mergeAccess reports the hold and the right to bypass", async () => {
      const { ctx } = harness(withToken, held(true));
      const out = await (mergeAccess as any)._handler(ctx, { number: 12 });
      expect(out).toMatchObject({ merge_state: "BLOCKED", held: true, can_bypass: true, as: "ashot" });
    });
  });

  test("merge refuses a pull request that is not open before touching GitHub", async () => {
    const { ctx, calls } = harness({ ...withToken, pr: { ...openPr, state: "merged" } });
    expect((await (merge as any)._handler(ctx, { number: 12 })).error).toMatch(/is merged, not open/);
    expect((await (updateBranch as any)._handler(ctx, { number: 12 })).error).toMatch(/is merged, not open/);
    expect(calls).toEqual([]);
  });

  test("a review must go out as the person, never as the app", async () => {
    const { ctx, calls } = harness(withoutToken);
    const out = await (review as any)._handler(ctx, { number: 12, event: "APPROVE" });
    expect(out.error).toMatch(/own GitHub account/);
    expect(calls).toEqual([]);
  });

  test("close answers the caller's identity and no pull request matches without one", async () => {
    const { ctx } = harness(null);
    const out = await (close as any)._handler(ctx, { number: 99 });
    expect(out.error).toMatch(/No pull request matched/);
  });
});
