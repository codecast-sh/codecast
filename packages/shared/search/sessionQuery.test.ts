import { describe, expect, test } from "bun:test";
import {
  applySessionQueryCompletion,
  matchingSessionOperators,
  normalizeRepoName,
  parseSessionQuery,
  recentFilesFromSessions,
  sessionFilter,
  sessionQueryCompletion,
  sessionSearchHref,
} from "./sessionQuery";

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
      "pr:#12 pr:Codecast-sh/codecast#34 pr:https://github.com/codecast-sh/codecast/pull/56 pr:https://codecast.sh/pr/acme/app/78",
      NOW,
    );
    // Repositories come back in the spelling pull requests are stored under.
    expect(q.prs).toEqual([
      { number: 12 },
      { number: 34, repository: "codecast-sh/codecast" },
      { number: 56, repository: "codecast-sh/codecast" },
      { number: 78, repository: "acme/app" },
    ]);
    expect(parseSessionQuery("pr:acme/app", NOW).errors[0]).toContain("pr:");
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
    expect(normalizeRepoName("Acme/Repo")).toBe("acme/repo");
    expect(normalizeRepoName("https://gitlab.com/Acme/Repo.git")).toBe("https://gitlab.com/acme/repo");
  });
});

describe("sessionFilter / sessionSearchHref", () => {
  test("quotes a value with spaces and round-trips through the parser", () => {
    expect(sessionFilter("file", "src/a.ts")).toBe("file:src/a.ts");
    expect(sessionFilter("file", "docs/a b.md")).toBe('file:"docs/a b.md"');
    expect(parseSessionQuery(sessionFilter("file", "docs/a b.md")).files).toEqual(["docs/a b.md"]);
    expect(parseSessionQuery(sessionFilter("pr", "acme/web#12")).prs).toEqual([{ repository: "acme/web", number: 12 }]);
    expect(sessionSearchHref("commit", "3f2a91c")).toBe("/search?q=commit%3A3f2a91c");
  });
});

describe("sessionQueryCompletion", () => {
  test("a partial operator name at the caret", () => {
    expect(sessionQueryCompletion("auth fi")).toEqual({ kind: "operator", partial: "fi", from: 5, to: 7 });
    expect(sessionQueryCompletion("file")).toMatchObject({ kind: "operator", partial: "file" });
    expect(matchingSessionOperators("a").map((o) => o.op)).toEqual(["author:", "after:"]);
  });
  test("plain words and one letter complete nothing", () => {
    expect(sessionQueryCompletion("login")).toBeNull();
    expect(sessionQueryCompletion("f")).toBeNull();
    expect(sessionQueryCompletion("fix ")).toBeNull();
  });
  test("an operator's value, quoted or not, mid-input", () => {
    expect(sessionQueryCompletion("x file:src/a")).toEqual({ kind: "value", op: "file", partial: "src/a", from: 2, to: 12 });
    expect(sessionQueryCompletion('file:"docs/a b')).toMatchObject({ kind: "value", op: "file", partial: "docs/a b" });
    expect(sessionQueryCompletion("LABEL: x", 6)).toMatchObject({ kind: "value", op: "label", partial: "" });
    // Caret inside a token: the whole token is replaced.
    expect(sessionQueryCompletion("repo:cod tail", 6)).toMatchObject({ partial: "c", from: 0, to: 8 });
  });
  test("applying replaces the token and spaces a finished value", () => {
    const op = sessionQueryCompletion("auth fi")!;
    expect(applySessionQueryCompletion("auth fi", op, "file:")).toEqual({ value: "auth file:", caret: 10 });
    const v = sessionQueryCompletion("file:sr")!;
    expect(applySessionQueryCompletion("file:sr", v, sessionFilter("file", "src/a b.ts"))).toEqual({
      value: 'file:"src/a b.ts" ',
      caret: 18,
    });
    const mid = sessionQueryCompletion("repo:cod tail", 6)!;
    expect(applySessionQueryCompletion("repo:cod tail", mid, "repo:codecast").value).toBe("repo:codecast tail");
  });
});

describe("recentFilesFromSessions", () => {
  test("repo-relative, newest first, deduped, capped, outsiders dropped", () => {
    const rows = [
      { git_root: "/r/a", recent_files: ["/r/a/x.ts", "/r/a/y.ts", "/tmp/z"] },
      { git_root: "/r/a/", recent_files: ["/r/a/x.ts", "/r/a/w.ts"] },
      { recent_files: ["/nowhere/q.ts"] },
    ];
    expect(recentFilesFromSessions(rows, 10)).toEqual(["x.ts", "y.ts", "w.ts"]);
    expect(recentFilesFromSessions(rows, 2)).toEqual(["x.ts", "y.ts"]);
  });
});
