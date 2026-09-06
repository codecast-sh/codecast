import { describe, expect, test } from "bun:test";
import { fuzzyMatch, rankPaths } from "../fuzzyPath";

const PATHS = [
  "packages/web/components/repo/RepoPullsContent.tsx",
  "packages/web/components/repo/RepoChrome.tsx",
  "packages/convex/convex/repos.ts",
  "packages/web/lib/repoView.ts",
  "README.md",
];

describe("fuzzyMatch", () => {
  test("matches a scattered subsequence, not just a substring", () => {
    expect(fuzzyMatch("packages/web/lib/repoView.ts", "rpv")).not.toBeNull();
  });

  test("refuses a query whose characters are out of order", () => {
    expect(fuzzyMatch("README.md", "daer")).toBeNull();
  });

  test("an empty query matches everything at zero", () => {
    expect(fuzzyMatch("anything", "")).toEqual({ path: "anything", score: 0, positions: [] });
  });

  test("reports where each character landed, for highlighting", () => {
    expect(fuzzyMatch("abc", "ac")?.positions).toEqual([0, 2]);
  });
});

describe("rankPaths", () => {
  test("a match in the file name outranks one in the directories", () => {
    // "repo" appears in the directory of both, but RepoChrome carries it in
    // the name; searching the name is what a person means.
    const [first] = rankPaths(PATHS, "repoch");
    expect(first.path).toBe("packages/web/components/repo/RepoChrome.tsx");
  });

  test("an exact file name beats a longer path that also matches", () => {
    const [first] = rankPaths(PATHS, "readme");
    expect(first.path).toBe("README.md");
  });

  test("non-matches are dropped rather than ranked last", () => {
    expect(rankPaths(PATHS, "zzzz")).toEqual([]);
  });

  test("the limit is respected", () => {
    expect(rankPaths(PATHS, "", 2)).toHaveLength(2);
  });
});
