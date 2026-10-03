import { describe, expect, test } from "bun:test";
import { commit, MIN, T0 } from "./__fixtures__/commit";
import { dedupeCommits } from "./dedupe";

const base = (sha: string, at: number, over: Partial<Parameters<typeof commit>[0]> = {}) =>
  commit({ sha, subject: "base", timestamp: at, paths: { "backend/app/models.py": 30_000, "backend/app/routes.py": 8_889 }, ...over });

describe("dedupeCommits", () => {
  test("a rebase twin collapses onto the copy on the default branch", () => {
    const r = dedupeCommits([commit({ sha: "side", branch: "feat/x" }), commit({ sha: "main1" })], "main");
    expect(r.commits.map((c) => c.sha)).toEqual(["main1"]);
    expect(r.twins).toEqual({ main1: ["side"] });
  });

  test("three recommitted copies inside 30 minutes collapse to one with two twins", () => {
    const r = dedupeCommits([base("b1", T0), base("b2", T0 + 2 * MIN), base("b3", T0 + 20 * MIN)], "main");
    expect(r.commits).toHaveLength(1);
    const [keeper] = r.commits;
    expect(r.twins[keeper.sha].sort()).toEqual(["b1", "b2", "b3"].filter((s) => s !== keeper.sha));
    expect(Object.keys(r.twins)).toEqual([keeper.sha]);
  });

  test("the same three spread over two hours stay three commits", () => {
    const r = dedupeCommits([base("b1", T0), base("b2", T0 + 60 * MIN), base("b3", T0 + 120 * MIN)], "main");
    expect(r.commits.map((c) => c.sha)).toEqual(["b1", "b2", "b3"]);
    expect(r.twins).toEqual({});
  });

  test("a different size, different areas or another author is a different change", () => {
    const r = dedupeCommits(
      [
        base("b1", T0),
        base("size", T0 + MIN, { paths: { "backend/app/models.py": 30_001, "backend/app/routes.py": 8_889 } }),
        base("area", T0 + 2 * MIN, { paths: { "backend/app/models.py": 30_000, "frontend/routes.ts": 8_889 } }),
        base("who", T0 + 3 * MIN, { author_email: "sam@example.com" }),
      ],
      "main",
    );
    expect(r.commits).toHaveLength(4);
  });

  test("commits that changed no lines are never content twins", () => {
    const r = dedupeCommits([commit({ sha: "m1", subject: "merge", timestamp: T0 }), commit({ sha: "m2", subject: "merge", timestamp: T0 + MIN })], "main");
    expect(r.commits.map((c) => c.sha)).toEqual(["m1", "m2"]);
  });

  test("the content pass keeps the default-branch copy and carries an exact twin's shas along", () => {
    const r = dedupeCommits(
      [base("side", T0, { branch: "feat/x" }), base("sideTwin", T0, { branch: "feat/y", created_at: T0 - 1 }), base("main1", T0 + 5 * MIN)],
      "main",
    );
    expect(r.commits.map((c) => c.sha)).toEqual(["main1"]);
    expect(r.twins.main1.sort()).toEqual(["side", "sideTwin"]);
  });
});
