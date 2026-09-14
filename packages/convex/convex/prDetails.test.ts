import { afterEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { apply, refresh } from "./prDetails";
import { webGet } from "./pull_requests";
import { listPRCommits, listPRChecks, getPull } from "./githubApi";
import { makeFakeDb } from "./testDb";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function harness(overrides: Record<string, unknown> = {}, user: string | null = "member") {
  const db = makeFakeDb({
    pull_requests: [{ _id: "pr1", team_id: "team1", repository: "acme/repo", number: 42,
      state: "open", head_sha: "head", linked_session_ids: [], commits_count: 2, ...overrides }],
    team_memberships: [{ _id: "m1", team_id: "team1", user_id: "member" }],
  });
  const calls: string[] = [];
  const ctx: any = {
    db,
    auth: { getUserIdentity: async () => user ? { subject: `${user}|session` } : null },
    runQuery: async (ref: any, args: any) => {
      expect(getFunctionName(ref)).toBe("pull_requests:webGet");
      return structuredClone(await (webGet as any)._handler(ctx, args));
    },
    runAction: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      calls.push(name);
      if (name === "prShepherd:tokenForPR") return "test-token";
      const handlers: Record<string, any> = { "githubApi:listPRCommits": listPRCommits, "githubApi:listPRChecks": listPRChecks, "githubApi:getPull": getPull };
      const handler = handlers[name];
      if (!handler) throw new Error(`Unexpected action ${name}`);
      return (handler as any)._handler(ctx, args);
    },
    runMutation: async (ref: any, args: any) => {
      expect(getFunctionName(ref)).toBe("prDetails:apply");
      return (apply as any)._handler(ctx, args);
    },
  };
  return { ctx, db, calls, row: () => db._tables.pull_requests[0] };
}

describe("PR detail refresh through the authenticated action, GitHub reader and stored row", () => {
  for (const state of ["open", "closed", "merged"]) {
    test(`a cached ${state} PR with only a count gets its commits`, async () => {
      const { ctx, row } = harness({ state });
      globalThis.fetch = (async (url: any, options: any) => {
        expect(String(url)).toContain("/pulls/42/commits?");
        expect(options.headers.Authorization).toBe("Bearer test-token");
        return Response.json([
          { sha: "base", commit: { message: "First", author: { name: "Ada" } } },
          { sha: "head", commit: { message: "Second" } },
        ]);
      }) as typeof fetch;
      await (refresh as any)._handler(ctx, { pr_id: "pr1", section: "commits" });
      expect(row().commits.map((c: any) => c.message)).toEqual(["First", "Second"]);
      expect(row().commits_count).toBe(2);
    });
  }

  test("check runs and commit statuses backfill without a webhook and update the summary", async () => {
    const { ctx, row } = harness();
    globalThis.fetch = (async (url: any) => {
      expect(String(url)).toContain("/commits/head/");
      return Response.json(String(url).includes("/check-runs?") ? {
        total_count: 1, check_runs: [{ id: 1, name: "Tests", status: "completed", conclusion: "failure", check_suite: { id: 8 } }],
      } : { total_count: 1, statuses: [{ context: "Deploy", state: "success", target_url: "https://example.com/deploy" }] });
    }) as typeof fetch;
    await (refresh as any)._handler(ctx, { pr_id: "pr1", section: "checks" });
    expect(row().checks.map((c: any) => [c.name, c.conclusion])).toEqual([["Tests", "failure"], ["Deploy", "success"]]);
    expect(row().checks_state).toBe("failure");
  });

  test("a successful empty check response is persisted as empty", async () => {
    const { ctx, row } = harness();
    globalThis.fetch = Object.assign(async () => Response.json({ total_count: 0, check_runs: [], statuses: [] }), {
      preconnect: originalFetch.preconnect,
    });
    await (refresh as any)._handler(ctx, { pr_id: "pr1", section: "checks" });
    expect(row().checks).toEqual([]);
    expect(row().checks_state).toBe("none");
  });

  for (const user of [null, "stranger"]) {
    test(`access denial for ${user} happens before credentials or GitHub`, async () => {
      const { ctx, calls, db } = harness({}, user);
      await expect((refresh as any)._handler(ctx, { pr_id: "pr1", section: "checks" })).rejects.toThrow("access denied");
      expect(calls).toEqual([]);
      expect(db._patched).toEqual([]);
    });
  }

  test("a permission error is surfaced and does not erase cached checks", async () => {
    const cached = [{ name: "Tests", status: "completed", conclusion: "success", updated_at: 1 }];
    const { ctx, row } = harness({ checks: cached });
    globalThis.fetch = (async (url: any) => String(url).includes("/check-runs?")
      ? new Response("Resource not accessible by integration", { status: 403 })
      : Response.json({ total_count: 0, statuses: [] })) as typeof fetch;
    await expect((refresh as any)._handler(ctx, { pr_id: "pr1", section: "checks" })).rejects.toThrow("403");
    expect(row().checks).toEqual(cached);
  });

  test("a push during the fetch cannot attach old checks to the new head", async () => {
    const { ctx, db, row } = harness();
    globalThis.fetch = Object.assign(async () => {
      await db.patch("pr1", { head_sha: "new-head" });
      return Response.json({ total_count: 0, check_runs: [], statuses: [] });
    }, { preconnect: originalFetch.preconnect });
    await expect((refresh as any)._handler(ctx, { pr_id: "pr1", section: "checks" })).rejects.toThrow("changed while loading");
    expect(row().checks).toBeUndefined();
  });

  test("a check webhook arriving during a read wins, and known trigger labels survive", async () => {
    const { ctx, row } = harness({ checks: [
      { name: "Tests", external_id: "1", suite_id: "8", status: "completed", conclusion: "success", updated_at: 20, event: "push" },
      { name: "Lint", external_id: "2", status: "completed", conclusion: "success", updated_at: 1, event: "pull_request" },
    ] });
    await (apply as any)._handler(ctx, { pr_id: "pr1", head_sha: "head", started_at: 10, checks: [
      { name: "Tests", external_id: "1", suite_id: "8", status: "in_progress", updated_at: 0 },
      { name: "Lint", external_id: "2", status: "completed", conclusion: "success", updated_at: 0 },
    ] });
    expect(row().checks.find((c: any) => c.name === "Tests")).toMatchObject({ conclusion: "success", event: "push" });
    expect(row().checks.find((c: any) => c.name === "Lint").event).toBe("pull_request");
  });
});

test("PR commit reads page past the first 100 without discarding the rest", async () => {
  const pages: number[] = [];
  globalThis.fetch = (async (url: any) => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    return Response.json(Array.from({ length: page < 3 ? 100 : 30 }, (_, i) => ({ sha: `${page}-${i}`, commit: { message: "Commit" } })));
  }) as typeof fetch;
  const result = await (listPRCommits as any)._handler({}, { repository: "acme/repo", pr_number: 42, github_access_token: "test" });
  expect(pages).toEqual([1, 2, 3]);
  expect(result).toHaveLength(230);
});

test("check runs and statuses both page past 100", async () => {
  globalThis.fetch = (async (url: any) => {
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get("page"));
    const runs = parsed.pathname.endsWith("check-runs");
    const rows = Array.from({ length: page === 1 ? 100 : 2 }, (_, i) => runs
      ? { id: (page - 1) * 100 + i, name: `Test ${page}-${i}`, status: "queued" }
      : { context: `Status ${page}-${i}`, state: "pending" });
    return Response.json({ total_count: 102, [runs ? "check_runs" : "statuses"]: rows });
  }) as typeof fetch;
  const result = await (listPRChecks as any)._handler({}, { repository: "acme/repo", sha: "head", github_access_token: "test" });
  expect(result).toHaveLength(204);
  expect(result.every((check: any) => check.updated_at > 0)).toBe(true);
});
