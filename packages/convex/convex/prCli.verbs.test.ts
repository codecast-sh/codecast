// The verbs that change a pull request on GitHub share one shape: resolve the
// caller and the pull request, pick a token, make one call, answer in GitHub's
// words when it refuses. The web page and `cast pr` both call these.
import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { close, draft, edit, merge, reopen, reviewers, review } from "./prCli";

function harness(actor: any, answer: any = {}) {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = {
    async runQuery(_ref: any, _args: any) { return actor; },
    async runAction(ref: any, args: any) {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      if (name.includes("tokenForPR")) return "app_tok";
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
