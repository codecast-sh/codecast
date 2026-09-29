import { describe, expect, test } from "bun:test";
import { normalizeRepoName, parseSessionQuery } from "./sessionQuery";

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const DAY = 86_400_000;

describe("parseSessionQuery", () => {
  test("plain text passes through with its phrases quoted", () => {
    const q = parseSessionQuery('auth "token refresh" bug', NOW);
    expect(q.text).toBe('auth "token refresh" bug');
    expect(q.hasFilters).toBe(false);
    expect(q.errors).toEqual([]);
  });

  test("each operator lands in its own slot and leaves the text", () => {
    const q = parseSessionQuery(
      "retry file:src/auth.ts commit:3F2A91C pr:482 label:api author:Me repo:codecast-sh/codecast after:7d before:2026-09-20 loop",
      NOW,
    );
    expect(q.text).toBe("retry loop");
    expect(q.files).toEqual(["src/auth.ts"]);
    expect(q.commits).toEqual(["3f2a91c"]);
    expect(q.prs).toEqual([{ number: 482 }]);
    expect(q.labels).toEqual(["api"]);
    expect(q.authors).toEqual(["me"]);
    expect(q.repos).toEqual(["codecast-sh/codecast"]);
    expect(q.after).toBe(NOW - 7 * DAY);
    // A date-only before: covers the whole day.
    expect(q.before).toBe(Date.parse("2026-09-20") + DAY - 1);
    expect(q.hasFilters).toBe(true);
  });

  test("an operator-only query has no text but still filters", () => {
    const q = parseSessionQuery("file:packages/convex/convex/blameCore.ts", NOW);
    expect(q.text).toBe("");
    expect(q.files).toEqual(["packages/convex/convex/blameCore.ts"]);
    expect(q.hasFilters).toBe(true);
  });

  test("quoted operator values keep their spaces", () => {
    const q = parseSessionQuery('file:"docs/a b.md" "exact words"', NOW);
    expect(q.files).toEqual(["docs/a b.md"]);
    expect(q.text).toBe('"exact words"');
  });

  test("unknown x: tokens and URLs stay text", () => {
    const q = parseSessionQuery("todo: fix https://example.com/a", NOW);
    expect(q.text).toBe("todo: fix https://example.com/a");
    expect(q.hasFilters).toBe(false);
  });

  test("operator names are case-insensitive; a dangling operator is ignored", () => {
    const q = parseSessionQuery("FILE:./src/x.ts/ label:", NOW);
    expect(q.files).toEqual(["src/x.ts"]);
    expect(q.labels).toEqual([]);
    expect(q.text).toBe("");
    expect(q.errors).toEqual([]);
  });

  test("an operator followed by a space and a word says the value belongs after the colon", () => {
    const q = parseSessionQuery("file: src/x.ts", NOW);
    expect(q.files).toEqual([]);
    expect(q.errors).toEqual(["file: takes its value right after the colon, with no space (file:src/x.ts)."]);
  });

  test("pull request references in every written form", () => {
    const q = parseSessionQuery(
      "pr:#12 pr:Codecast-sh/codecast#34 pr:https://github.com/codecast-sh/codecast/pull/56",
      NOW,
    );
    expect(q.prs).toEqual([
      { number: 12 },
      { number: 34, repository: "Codecast-sh/codecast" },
      { number: 56, repository: "codecast-sh/codecast" },
    ]);
  });

  test("bad values become errors instead of silent text", () => {
    const q = parseSessionQuery("commit:xyz pr:abc after:soon file:~/x.ts", NOW);
    expect(q.commits).toEqual([]);
    expect(q.prs).toEqual([]);
    expect(q.after).toBeUndefined();
    expect(q.errors).toHaveLength(4);
    expect(q.errors[0]).toContain("commit:");
    expect(q.errors[2]).toContain("7d");
    expect(q.text).toBe("");
  });

  test("repeated time bounds narrow the window", () => {
    const q = parseSessionQuery("after:30d after:7d before:1d before:3d", NOW);
    expect(q.after).toBe(NOW - 7 * DAY);
    expect(q.before).toBe(NOW - 3 * DAY);
  });
});

describe("normalizeRepoName", () => {
  test("remote URLs and ssh remotes reduce to owner/repo", () => {
    expect(normalizeRepoName("git@github.com:Codecast-sh/codecast.git")).toBe("codecast-sh/codecast");
    expect(normalizeRepoName("https://github.com/codecast-sh/codecast/")).toBe("codecast-sh/codecast");
    expect(normalizeRepoName("codecast")).toBe("codecast");
  });
});
