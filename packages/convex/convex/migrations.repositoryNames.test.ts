// The backfill rewrites only rows whose stored name differs from the canonical
// spelling, walks every table in order, and changes nothing on a dry run.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { canonicalizeRepositoryNames, REPOSITORY_NAME_TABLES } from "./migrations";

function context() {
  const scheduled: any[] = [];
  return {
    db: makeFakeDb({
      pull_requests: [{ _id: "p1", repository: "Codecast-SH/Codecast" }, { _id: "p2", repository: "codecast-sh/codecast" }],
      commits: [{ _id: "c1", repository: "Codecast-SH/Codecast" }, { _id: "c2" }],
      review_comments: [{ _id: "r1", repository: "Codecast-SH/Codecast" }],
      external_events: [],
      github_check_suites: [{ _id: "s1", repository: "codecast-sh/codecast" }],
      github_app_installations: [{ _id: "i1", account_login: "Codecast-SH" }],
    }),
    scheduler: { async runAfter(_d: number, _ref: any, args: any) { scheduled.push(args); } },
    _scheduled: scheduled,
  } as any;
}

async function drain(ctx: any, args: Record<string, any>) {
  const results = [];
  let next: Record<string, any> | undefined = args;
  while (next) {
    results.push(await (canonicalizeRepositoryNames as any)._handler(ctx, next));
    next = ctx._scheduled.shift();
  }
  return results;
}

describe("canonicalizeRepositoryNames", () => {
  test("a dry run counts and patches nothing", async () => {
    const ctx = context();
    const results = await drain(ctx, { auto: true });
    expect(results.map((r) => r.table)).toEqual([...REPOSITORY_NAME_TABLES]);
    expect(results.reduce((n, r) => n + r.rewritten, 0)).toBe(4);
    expect(ctx.db._patched).toEqual([]);
  });

  test("a real run rewrites only the rows that differ, across every table", async () => {
    const ctx = context();
    await drain(ctx, { dryRun: false, auto: true, numItems: 1 });
    expect(ctx.db._patched).toEqual([
      { _id: "p1", patch: { repository: "codecast-sh/codecast" } },
      { _id: "c1", patch: { repository: "codecast-sh/codecast" } },
      { _id: "r1", patch: { repository: "codecast-sh/codecast" } },
      { _id: "i1", patch: { account_login: "codecast-sh" } },
    ]);
    // Idempotent: a second pass finds nothing left to rewrite.
    const again = await drain(ctx, { dryRun: false, auto: true });
    expect(again.reduce((n, r) => n + r.rewritten, 0)).toBe(0);
  });
});
