import { describe, expect, it } from "bun:test";
import { extendLineRange, isLineSelected } from "../patchParser";
import {
  breadcrumbTrail,
  commitBalanceAccent,
  entryName,
  filterTreeEntries,
  formatLineHash,
  formatSize,
  indexBlameRanges,
  joinPath,
  moveCursor,
  parseCompareRange,
  parseLineHash,
  pathSegments,
  prPageHref,
  commitPageHref,
  repoBlobHref,
  repoBranchesHref,
  repoCommitsHref,
  repoCompareHref,
  repoFamilyOf,
  repoHistoryHref,
  repoHomeHref,
  repoPullsHref,
  repoSearchHref,
  repoTagsHref,
  repoTreeHref,
  toAppHref,
  toStandaloneHref,
  sortTreeEntries,
  splitCommitMessage,
  startsBlameRange,
  type RepoBlameRange,
  type RepoTreeEntry,
} from "../repoView";

describe("line anchors", () => {
  it("reads a single line and a range", () => {
    expect(parseLineHash("#L12")).toEqual({ start: 12, end: 12 });
    expect(parseLineHash("#L12-L20")).toEqual({ start: 12, end: 20 });
    // GitHub's own older form omits the second L.
    expect(parseLineHash("#L12-20")).toEqual({ start: 12, end: 20 });
    expect(parseLineHash("L7")).toEqual({ start: 7, end: 7 });
  });

  it("normalizes a range written backwards", () => {
    expect(parseLineHash("#L20-L12")).toEqual({ start: 12, end: 20 });
  });

  it("answers null for anything that is not a line anchor", () => {
    expect(parseLineHash(undefined)).toBeNull();
    expect(parseLineHash("")).toBeNull();
    expect(parseLineHash("#section-two")).toBeNull();
    expect(parseLineHash("#L0")).toBeNull();
    expect(parseLineHash("#Lx")).toBeNull();
    expect(parseLineHash("#L12-L20-L30")).toBeNull();
  });

  it("round trips through the fragment it writes", () => {
    for (const range of [
      { start: 3, end: 3 },
      { start: 3, end: 40 },
    ]) {
      expect(parseLineHash(formatLineHash(range))).toEqual(range);
    }
    expect(formatLineHash(null)).toBe("");
  });

  it("extends a selection from where it started, in either direction", () => {
    expect(extendLineRange(null, 9)).toEqual({ start: 9, end: 9 });
    expect(extendLineRange({ start: 9, end: 9 }, 15)).toEqual({ start: 9, end: 15 });
    // Shift clicking ABOVE the anchor keeps the anchor as one end.
    expect(extendLineRange({ start: 9, end: 9 }, 4)).toEqual({ start: 4, end: 9 });
    // Re-extending from an existing range still anchors on its start.
    expect(extendLineRange({ start: 9, end: 15 }, 12)).toEqual({ start: 9, end: 12 });
  });

  it("knows which lines a selection covers", () => {
    const range = { start: 4, end: 6 };
    expect([3, 4, 5, 6, 7].map((l) => isLineSelected(range, l))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(isLineSelected(null, 4)).toBe(false);
  });
});

describe("blame lookup", () => {
  const ranges: RepoBlameRange[] = [
    { start_line: 1, end_line: 3, sha: "aaa" },
    { start_line: 8, end_line: 8, sha: "ccc" },
    { start_line: 4, end_line: 7, sha: "bbb" },
  ];

  it("finds the range covering a line whatever order the ranges arrive in", () => {
    const at = indexBlameRanges(ranges);
    expect(at(1)?.sha).toBe("aaa");
    expect(at(3)?.sha).toBe("aaa");
    expect(at(4)?.sha).toBe("bbb");
    expect(at(7)?.sha).toBe("bbb");
    expect(at(8)?.sha).toBe("ccc");
  });

  it("answers undefined outside every range instead of guessing a neighbour", () => {
    const at = indexBlameRanges([{ start_line: 5, end_line: 6, sha: "aaa" }]);
    expect(at(4)).toBeUndefined();
    expect(at(7)).toBeUndefined();
    expect(indexBlameRanges(undefined)(1)).toBeUndefined();
  });

  it("marks only the first line of a range, which is where the label goes", () => {
    const at = indexBlameRanges(ranges);
    expect(startsBlameRange(at(4), 4)).toBe(true);
    expect(startsBlameRange(at(5), 5)).toBe(false);
    expect(startsBlameRange(undefined, 5)).toBe(false);
  });
});

describe("commit message", () => {
  it("splits the subject from the body and trims the blank line between", () => {
    expect(splitCommitMessage("fix: the thing\n\nWhy it broke.\n")).toEqual({
      subject: "fix: the thing",
      body: "Why it broke.",
    });
    expect(splitCommitMessage("one liner")).toEqual({ subject: "one liner", body: "" });
    expect(splitCommitMessage(undefined)).toEqual({ subject: "", body: "" });
  });
});

describe("tree entries", () => {
  const entries: RepoTreeEntry[] = [
    { path: "readme.md", type: "blob", sha: "1", size: 20 },
    { path: "src", type: "tree", sha: "2" },
    { path: "Makefile", type: "blob", sha: "3", size: 4 },
    { path: "app", type: "tree", sha: "4" },
  ];

  it("puts folders first, then sorts each group by name", () => {
    expect(sortTreeEntries(entries).map((e) => e.path)).toEqual([
      "app",
      "src",
      "Makefile",
      "readme.md",
    ]);
  });

  it("filters on the entry name, not the whole path", () => {
    const nested: RepoTreeEntry[] = [
      { path: "packages/web/page.tsx", type: "blob", sha: "1" },
      { path: "packages/web/store.ts", type: "blob", sha: "2" },
    ];
    expect(filterTreeEntries(nested, "PAGE").map((e) => e.path)).toEqual([
      "packages/web/page.tsx",
    ]);
    // An empty filter is not a filter.
    expect(filterTreeEntries(nested, "  ").length).toBe(2);
  });

  it("names an entry by its last segment", () => {
    expect(entryName("a/b/c.ts")).toBe("c.ts");
    expect(entryName("c.ts")).toBe("c.ts");
  });
});

describe("paths", () => {
  it("drops empty segments", () => {
    expect(pathSegments("/a//b/")).toEqual(["a", "b"]);
    expect(pathSegments(undefined)).toEqual([]);
  });

  it("builds a breadcrumb of every prefix", () => {
    expect(breadcrumbTrail("packages/web/app")).toEqual([
      { name: "packages", path: "packages" },
      { name: "web", path: "packages/web" },
      { name: "app", path: "packages/web/app" },
    ]);
    expect(breadcrumbTrail("")).toEqual([]);
  });

  it("joins, skipping the parts that are not there", () => {
    expect(joinPath("packages", undefined, "web")).toBe("packages/web");
    expect(joinPath("", "web")).toBe("web");
  });
});

describe("small formats", () => {
  it("reads sizes at the scale they are written", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(200 * 1024)).toBe("200 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatSize(undefined)).toBe("");
  });

  it("keys the commit accent to what the change mostly did", () => {
    expect(commitBalanceAccent(90, 10)).toBe("var(--sol-green)");
    expect(commitBalanceAccent(10, 90)).toBe("var(--sol-red)");
    expect(commitBalanceAccent(50, 50)).toBe("var(--sol-yellow)");
    expect(commitBalanceAccent(0, 0)).toBe("var(--sol-text-dim)");
  });

  it("clamps the keyboard cursor to the list", () => {
    expect(moveCursor(0, -1, 5)).toBe(0);
    expect(moveCursor(4, 1, 5)).toBe(4);
    expect(moveCursor(2, 1, 5)).toBe(3);
    expect(moveCursor(0, 1, 0)).toBe(0);
  });
});

describe("where the pages live", () => {
  const repo = "codecast-sh/codecast";

  it("builds the app form of every repository page", () => {
    expect(repoHomeHref(repo)).toBe("/repo/codecast-sh/codecast");
    expect(repoTreeHref(repo, "main")).toBe("/repo/codecast-sh/codecast/tree/main");
    expect(repoTreeHref(repo, "main", "packages/web")).toBe(
      "/repo/codecast-sh/codecast/tree/main?path=packages%2Fweb",
    );
    expect(repoBlobHref(repo, "main", "packages/web/lib/repoView.ts")).toBe(
      "/repo/codecast-sh/codecast/blob/main?path=packages%2Fweb%2Flib%2FrepoView.ts",
    );
    expect(repoCommitsHref(repo, "main")).toBe("/repo/codecast-sh/codecast/commits/main");
    expect(repoCompareHref(repo, "main", "topic")).toBe(
      "/repo/codecast-sh/codecast/compare/main...topic",
    );
    expect(repoBranchesHref(repo)).toBe("/repo/codecast-sh/codecast/branches");
    expect(repoTagsHref(repo)).toBe("/repo/codecast-sh/codecast/tags");
    expect(repoPullsHref(repo)).toBe("/repo/codecast-sh/codecast/pulls");
    expect(repoSearchHref(repo)).toBe("/repo/codecast-sh/codecast/search");
    expect(repoSearchHref(repo, "useRepoFamily")).toBe(
      "/repo/codecast-sh/codecast/search?q=useRepoFamily",
    );
    expect(commitPageHref(repo, "abc1234")).toBe("/commit/codecast-sh/codecast/abc1234");
    expect(prPageHref(repo, 12)).toBe("/pr/codecast-sh/codecast/12");
  });

  it("builds the standalone form of the same pages under /r", () => {
    expect(repoHomeHref(repo, "standalone")).toBe("/r/codecast-sh/codecast");
    expect(repoTreeHref(repo, "main", "packages", "standalone")).toBe(
      "/r/codecast-sh/codecast/tree/main?path=packages",
    );
    expect(repoBlobHref(repo, "main", "a/b.ts", "standalone")).toBe(
      "/r/codecast-sh/codecast/blob/main?path=a%2Fb.ts",
    );
    expect(repoCommitsHref(repo, "main", { family: "standalone" })).toBe(
      "/r/codecast-sh/codecast/commits/main",
    );
    expect(repoCompareHref(repo, "main", "topic", "standalone")).toBe(
      "/r/codecast-sh/codecast/compare/main...topic",
    );
    expect(repoBranchesHref(repo, "standalone")).toBe("/r/codecast-sh/codecast/branches");
    expect(repoTagsHref(repo, "standalone")).toBe("/r/codecast-sh/codecast/tags");
    expect(repoPullsHref(repo, "standalone")).toBe("/r/codecast-sh/codecast/pulls");
    expect(repoSearchHref(repo, "hooks", "standalone")).toBe(
      "/r/codecast-sh/codecast/search?q=hooks",
    );
    // A commit and a pull request sit UNDER the repository here, because /r is
    // the whole of what a signed-out reader may see.
    expect(commitPageHref(repo, "abc1234", "standalone")).toBe(
      "/r/codecast-sh/codecast/commit/abc1234",
    );
    expect(prPageHref(repo, 12, "standalone")).toBe("/r/codecast-sh/codecast/pull/12");
  });

  it("carries the file and the author of a commit list in the query", () => {
    expect(repoCommitsHref(repo, "main", { path: "packages/web/lib/repoView.ts" })).toBe(
      "/repo/codecast-sh/codecast/commits/main?path=packages%2Fweb%2Flib%2FrepoView.ts",
    );
    expect(repoCommitsHref(repo, "main", { author: "ashot" })).toBe(
      "/repo/codecast-sh/codecast/commits/main?author=ashot",
    );
    expect(repoCommitsHref(repo, "main", { path: "a.ts", author: "ashot" })).toBe(
      "/repo/codecast-sh/codecast/commits/main?path=a.ts&author=ashot",
    );
  });

  it("keeps the old history spelling pointing at the commit list", () => {
    expect(repoHistoryHref(repo, "main")).toBe("/repo/codecast-sh/codecast/commits/main");
    // No branch named: HEAD is the honest ref for "whatever this repository is on".
    expect(repoHistoryHref(repo)).toBe("/repo/codecast-sh/codecast/commits/HEAD");
    expect(repoHistoryHref(repo, "main", "standalone")).toBe(
      "/r/codecast-sh/codecast/commits/main",
    );
  });

  it("encodes a ref that contains a slash", () => {
    expect(repoTreeHref(repo, "release/1.2")).toBe(
      "/repo/codecast-sh/codecast/tree/release%2F1.2",
    );
    expect(repoCompareHref(repo, "main", "release/1.2")).toBe(
      "/repo/codecast-sh/codecast/compare/main...release%2F1.2",
    );
  });

  it("reads a compare range back", () => {
    expect(parseCompareRange("main...topic")).toEqual({ base: "main", head: "topic" });
    expect(parseCompareRange(encodeURIComponent("main...release/1.2"))).toEqual({
      base: "main",
      head: "release/1.2",
    });
    expect(parseCompareRange("main")).toBeNull();
    expect(parseCompareRange("...topic")).toBeNull();
    expect(parseCompareRange(undefined)).toBeNull();
  });

  it("names the family a live path is in", () => {
    expect(repoFamilyOf("/repo/o/n/tree/main")).toBe("app");
    expect(repoFamilyOf("/r/o/n/tree/main")).toBe("standalone");
    expect(repoFamilyOf("/r")).toBe("standalone");
    // /repo starts with the same letter and is NOT the standalone family.
    expect(repoFamilyOf("/repo")).toBe("app");
    expect(repoFamilyOf("/inbox")).toBe("app");
    expect(repoFamilyOf(null)).toBe("app");
  });
});

describe("between the two families", () => {
  it("converts every repository, commit and pull request path both ways", () => {
    const pairs: [string, string][] = [
      ["/repo/o/n", "/r/o/n"],
      ["/repo/o/n/tree/main", "/r/o/n/tree/main"],
      ["/repo/o/n/blob/main", "/r/o/n/blob/main"],
      ["/repo/o/n/commits/main", "/r/o/n/commits/main"],
      ["/repo/o/n/compare/main...topic", "/r/o/n/compare/main...topic"],
      ["/repo/o/n/branches", "/r/o/n/branches"],
      ["/repo/o/n/tags", "/r/o/n/tags"],
      ["/repo/o/n/pulls", "/r/o/n/pulls"],
      ["/repo/o/n/search", "/r/o/n/search"],
      ["/commit/o/n/abc1234", "/r/o/n/commit/abc1234"],
      ["/pr/o/n/12", "/r/o/n/pull/12"],
    ];
    for (const [app, standalone] of pairs) {
      expect(toStandaloneHref(app)).toBe(standalone);
      expect(toAppHref(standalone)).toBe(app);
    }
  });

  it("keeps the query and the fragment", () => {
    expect(toStandaloneHref("/repo/o/n/blob/main?path=a%2Fb.ts#L12-L20")).toBe(
      "/r/o/n/blob/main?path=a%2Fb.ts#L12-L20",
    );
    expect(toAppHref("/r/o/n/commits/main?path=a.ts&author=ashot")).toBe(
      "/repo/o/n/commits/main?path=a.ts&author=ashot",
    );
    expect(toStandaloneHref("/pr/o/n/12?tab=files")).toBe("/r/o/n/pull/12?tab=files");
  });

  it("hands back anything that is not one of those pages", () => {
    for (const path of ["/repo", "/inbox", "/", "/tasks/ct-1", "/r", "/share/abc"]) {
      expect(toStandaloneHref(path)).toBe(path);
      expect(toAppHref(path)).toBe(path);
    }
  });
});
