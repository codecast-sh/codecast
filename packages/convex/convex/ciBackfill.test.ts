// CI history read back from the Actions runs API (ciBackfill.ts): only
// finished default-branch runs count, by the webhook's own rule, and a run the
// webhook already kept is not kept twice.
import { describe, expect, test } from "bun:test";
import { recentRepos, runFacts } from "./ciBackfill";
import { withCiRuns } from "@codecast/shared/contracts/volumeWatch";

const repo = { full_name: "codecast-sh/codecast", default_branch: "main" };
const run = (over: Record<string, any> = {}) => ({
  id: 1,
  name: "CI",
  event: "push",
  head_branch: "main",
  head_repository: { full_name: "codecast-sh/codecast" },
  status: "completed",
  conclusion: "success",
  run_started_at: "2026-10-20T10:00:00Z",
  updated_at: "2026-10-20T10:04:00Z",
  ...over,
});

describe("runFacts", () => {
  test("keeps finished default-branch runs with their result and length", () => {
    expect(runFacts(repo, [run(), run({ conclusion: "failure", run_started_at: "2026-10-20T11:00:00Z", updated_at: "2026-10-20T11:01:00Z" })])).toEqual([
      { at: Date.parse("2026-10-20T10:00:00Z"), ok: true, duration_ms: 240_000 },
      { at: Date.parse("2026-10-20T11:00:00Z"), ok: false, duration_ms: 60_000 },
    ]);
  });
  test("drops pull request runs, other branches, forks and silent conclusions", () => {
    expect(runFacts(repo, [
      run({ event: "pull_request" }),
      run({ head_branch: "feature" }),
      run({ head_repository: { full_name: "someone/codecast" } }),
      run({ conclusion: "cancelled" }),
      run({ status: "in_progress" }),
    ])).toEqual([]);
  });
});

describe("recentRepos", () => {
  const now = Date.parse("2026-11-04T00:00:00Z");
  test("only repositories pushed in the window, newest first, archived ones out", () => {
    const listed = [
      { full_name: "a/old", default_branch: "main", pushed_at: "2026-08-01T00:00:00Z" },
      { full_name: "a/one", default_branch: "main", pushed_at: "2026-10-30T00:00:00Z" },
      { full_name: "a/two", default_branch: "trunk", pushed_at: "2026-11-03T00:00:00Z" },
      { full_name: "a/gone", default_branch: "main", pushed_at: "2026-11-03T00:00:00Z", archived: true },
    ];
    expect(recentRepos(listed, now - 30 * 86_400_000).map((r) => r.full_name)).toEqual(["a/two", "a/one"]);
  });
});

describe("withCiRuns", () => {
  test("merges in start order without keeping a webhook run twice", () => {
    const kept = [{ at: 2000, ok: true, duration_ms: 10 }];
    expect(withCiRuns(kept, [{ at: 1000, ok: false, duration_ms: 5 }, { at: 2000, ok: true, duration_ms: 10 }])).toEqual([
      { at: 1000, ok: false, duration_ms: 5 },
      { at: 2000, ok: true, duration_ms: 10 },
    ]);
  });
  test("cuts to the last 30 days before the newest run", () => {
    const day = 86_400_000;
    expect(withCiRuns([], [{ at: 0, ok: true }, { at: 31 * day, ok: true }]).map((r) => r.at)).toEqual([31 * day]);
  });
});
