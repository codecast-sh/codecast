import { describe, expect, it } from "bun:test";
import { formatDiffHash, parseDiffHash, prViewHref, prViewOf } from "../prView";
import { toAppHref, toStandaloneHref } from "../repoView";

describe("pull request addresses", () => {
  it("puts the view in the path and leaves the conversation bare", () => {
    expect(prViewHref("a/b", 7, "conversation", "standalone")).toBe("/r/a/b/pull/7");
    expect(prViewHref("a/b", 7, "files", "standalone", "#diff-x.ts")).toBe("/r/a/b/pull/7/files#diff-x.ts");
    expect(prViewHref("a/b", 7, "checks")).toBe("/pr/a/b/7/checks");
  });

  it("reads the view back from either family's path", () => {
    expect(prViewOf("/r/a/b/pull/7")).toBe("conversation");
    expect(prViewOf("/r/a/b/pull/7/files")).toBe("files");
    expect(prViewOf("/pr/a/b/7/commits/")).toBe("commits");
    expect(prViewOf("/pr/a/b/7/nonsense")).toBe("conversation");
  });

  it("round trips a file, a line and a run on either side", () => {
    const cases = [
      { file: "src/lib/a.ts" },
      { file: "src/lib/a.ts", anchor: { side: "RIGHT" as const, lineNumber: 131 } },
      { file: "src/lib/a.ts", anchor: { side: "LEFT" as const, lineNumber: 12, lineEnd: 20 } },
    ];
    for (const target of cases) expect(parseDiffHash(formatDiffHash(target))).toEqual(target);
    expect(formatDiffHash(cases[2])).toBe("#diff-src/lib/a.ts:L12-L20");
  });

  it("reads a backwards run, an encoded path, and refuses what is not a diff address", () => {
    expect(parseDiffHash("#diff-a.ts:R20-R12")).toEqual({ file: "a.ts", anchor: { side: "RIGHT", lineNumber: 12, lineEnd: 20 } });
    expect(parseDiffHash("#diff-my%20dir/a.ts:R3")).toEqual({ file: "my dir/a.ts", anchor: { side: "RIGHT", lineNumber: 3 } });
    expect(parseDiffHash("#L12")).toBeNull();
    expect(parseDiffHash("#diff-")).toBeNull();
    expect(parseDiffHash("")).toBeNull();
    expect(parseDiffHash("#diff-a.ts:R0")).toEqual({ file: "a.ts" });
  });

  it("carries the view and the fragment across the two families", () => {
    expect(toStandaloneHref("/pr/a/b/7/files#diff-x.ts:R3")).toBe("/r/a/b/pull/7/files#diff-x.ts:R3");
    expect(toAppHref("/r/a/b/pull/7/checks")).toBe("/pr/a/b/7/checks");
    expect(toAppHref("/r/a/b/pull/7")).toBe("/pr/a/b/7");
  });
});

import { repoObjectDeepHref } from "../repoView";

describe("a link into a pull request keeps its place", () => {
  it("opens the view and the line in the app", () => {
    expect(repoObjectDeepHref("https://codecast.sh/r/a/b/pull/7/files#diff-x.ts:R3")).toBe("/pr/a/b/7/files#diff-x.ts:R3");
    expect(repoObjectDeepHref("/pr/a/b/7/checks")).toBe("/pr/a/b/7/checks");
    expect(repoObjectDeepHref("https://codecast.sh/r/a/b/commit/abc1234#diff-x.ts")).toBe("/commit/a/b/abc1234#diff-x.ts");
  });
  it("leaves a link to the object alone, and anything that is not ours", () => {
    expect(repoObjectDeepHref("https://codecast.sh/r/a/b/pull/7")).toBeNull();
    expect(repoObjectDeepHref("https://github.com/a/b/pull/7/files")).toBeNull();
    expect(repoObjectDeepHref("https://evil.example/r/a/b/pull/7/files")).toBeNull();
  });
});
