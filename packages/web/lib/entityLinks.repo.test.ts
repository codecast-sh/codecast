import { test, expect, describe } from "bun:test";
import {
  parseEntityUrl,
  buildEntityUrl,
  entityRoute,
  entityTypeFromId,
  isEntityId,
  entityMentionRegex,
  bareEntityIdRegex,
  parseRepoObjectId,
  repoObjectId,
  parseGitHubLocationUrl,
  contextualPrRefRegex,
  contextualPrRefPayload,
  parseContextualPrRef,
  splitContextualPrRefs,
  namedPullRequests,
  pullRequestRepository,
} from "./entityLinks";

describe("repository objects: pull requests and commits", () => {
  const PR = "codecast-sh/codecast#482";
  const COMMIT = "codecast-sh/codecast@aa57b85ee";

  test("a GitHub pull request or commit URL is the codecast object", () => {
    expect(parseEntityUrl("https://github.com/codecast-sh/codecast/pull/482")).toEqual({ type: "pr", id: PR });
    // Views of the object (files, a review thread) and display case collapse to the object.
    expect(parseEntityUrl("https://github.com/Codecast-sh/Codecast/pull/482/files#discussion_r12")).toEqual({ type: "pr", id: PR });
    expect(parseEntityUrl("https://www.github.com/codecast-sh/codecast.git/pull/482")).toEqual({ type: "pr", id: PR });
    expect(parseEntityUrl("https://github.com/codecast-sh/codecast/commit/aa57b85ee")).toEqual({ type: "commit", id: COMMIT });
  });

  test("other GitHub URLs are places, not objects", () => {
    expect(parseEntityUrl("https://github.com/codecast-sh/codecast")).toBeNull();
    expect(parseEntityUrl("https://github.com/codecast-sh/codecast/blob/main/README.md")).toBeNull();
    expect(parseEntityUrl("https://github.com/codecast-sh/codecast/pulls")).toBeNull();
    expect(parseEntityUrl("https://github.com/codecast-sh/codecast/issues/12")).toBeNull();
    expect(parseEntityUrl("https://github.com/codecast-sh/codecast/pull/not-a-number")).toBeNull();
  });

  test("codecast's own pages for them parse in both families", () => {
    expect(parseEntityUrl("/pr/codecast-sh/codecast/482")).toEqual({ type: "pr", id: PR });
    expect(parseEntityUrl("https://codecast.sh/commit/codecast-sh/codecast/aa57b85ee")).toEqual({ type: "commit", id: COMMIT });
    expect(parseEntityUrl("/r/codecast-sh/codecast/pull/482")).toEqual({ type: "pr", id: PR });
    expect(parseEntityUrl("/r/codecast-sh/codecast/commit/aa57b85ee")).toEqual({ type: "commit", id: COMMIT });
    // The repository pages under /r are not objects.
    expect(parseEntityUrl("/r/codecast-sh/codecast")).toBeNull();
    expect(parseEntityUrl("/r/codecast-sh/codecast/tree/main")).toBeNull();
  });

  test("routes and public URLs are built from the reference", () => {
    expect(entityRoute("pr", PR)).toBe("/pr/codecast-sh/codecast/482");
    expect(entityRoute("commit", COMMIT)).toBe("/commit/codecast-sh/codecast/aa57b85ee");
    expect(buildEntityUrl("pr", PR)).toBe("https://codecast.sh/pr/codecast-sh/codecast/482");
    // A raw Convex id names the row but not its repository: not routable from here.
    expect(entityRoute("pr", "s97f0jvy02p54v6as7gnfkegrs8aps7a")).toBeNull();
  });

  test("the text forms carry their type", () => {
    expect(entityTypeFromId(PR)).toBe("pr");
    expect(entityTypeFromId("Codecast-sh/codecast#7")).toBe("pr");
    expect(entityTypeFromId(COMMIT)).toBe("commit");
    expect(isEntityId(PR)).toBe(true);
    expect(isEntityId(COMMIT)).toBe(true);
    expect(parseRepoObjectId("Codecast-sh/codecast#7")).toEqual({ type: "pr", repository: "codecast-sh/codecast", number: 7 });
    expect(parseRepoObjectId("a/b@ABCDEF1")).toEqual({ type: "commit", repository: "a/b", sha: "abcdef1" });
    expect(repoObjectId({ type: "commit", repository: "A/B", sha: "ABCDEF1" })).toBe("a/b@abcdef1");
  });

  test("near misses stay text: file paths with a line, version pins, short shas", () => {
    expect(isEntityId("src/foo.ts:12")).toBe(false);
    expect(isEntityId("@scope/pkg@1.2.3")).toBe(false);
    expect(isEntityId("a/b@12345")).toBe(false); // fewer than 7 hex chars
    expect(isEntityId("#482")).toBe(false); // no repository
    expect(parseRepoObjectId("a/b#")).toBeNull();
  });

  test("the prose scanner finds them beside the other ids", () => {
    const text = "merged codecast-sh/codecast#482 (ct-9) as foo/bar@deadbeef1; npm i @scope/pkg@1.2.3";
    expect(text.match(bareEntityIdRegex())).toEqual(["codecast-sh/codecast#482", "ct-9", "foo/bar@deadbeef1"]);
    const mention = entityMentionRegex().exec("@[Fix the auth race codecast-sh/codecast#482]");
    expect(mention?.[1]).toBe("Fix the auth race");
    expect(mention?.[2]).toBe("codecast-sh/codecast#482");
  });
});

describe("parseGitHubLocationUrl", () => {
  test("repository, tree, blob with a line range, commits, compare, lists", () => {
    expect(parseGitHubLocationUrl("https://github.com/codecast-sh/codecast")).toEqual({ repository: "codecast-sh/codecast", kind: "repo" });
    expect(parseGitHubLocationUrl("https://github.com/codecast-sh/codecast/tree/main/packages/web")).toEqual({ repository: "codecast-sh/codecast", kind: "tree", ref: "main", path: "packages/web" });
    expect(parseGitHubLocationUrl("https://github.com/codecast-sh/codecast/blob/main/packages/web/x.ts#L10-L20")).toEqual({ repository: "codecast-sh/codecast", kind: "blob", ref: "main", path: "packages/web/x.ts", line: 10, endLine: 20 });
    expect(parseGitHubLocationUrl("https://github.com/codecast-sh/codecast/blob/aa57b85ee/README.md#L3")).toEqual({ repository: "codecast-sh/codecast", kind: "blob", ref: "aa57b85ee", path: "README.md", line: 3 });
    expect(parseGitHubLocationUrl("https://github.com/codecast-sh/codecast/commits/main")).toEqual({ repository: "codecast-sh/codecast", kind: "commits", ref: "main" });
    expect(parseGitHubLocationUrl("https://github.com/codecast-sh/codecast/compare/main...feat/x")).toEqual({ repository: "codecast-sh/codecast", kind: "compare", base: "main", head: "feat/x" });
    expect(parseGitHubLocationUrl("https://github.com/codecast-sh/codecast/pulls")).toEqual({ repository: "codecast-sh/codecast", kind: "pulls" });
    expect(parseGitHubLocationUrl("https://github.com/codecast-sh/codecast/tags")).toEqual({ repository: "codecast-sh/codecast", kind: "tags" });
  });

  test("objects, foreign hosts and non-repository pages are null", () => {
    expect(parseGitHubLocationUrl("https://github.com/codecast-sh/codecast/pull/1")).toBeNull();
    expect(parseGitHubLocationUrl("https://github.com/codecast-sh/codecast/commit/aa57b85ee")).toBeNull();
    expect(parseGitHubLocationUrl("https://github.com/codecast-sh")).toBeNull();
    expect(parseGitHubLocationUrl("https://github.com/codecast-sh/codecast/issues/4")).toBeNull();
    expect(parseGitHubLocationUrl("https://gitlab.com/codecast-sh/codecast/tree/main")).toBeNull();
    expect(parseGitHubLocationUrl("/repo/codecast-sh/codecast")).toBeNull();
  });
});

describe("pull requests named outright", () => {
  test("PR N, pull request N and GitHub links count; a lone #N does not", () => {
    expect(
      namedPullRequests("PR 12 and pull request #13, then #14 moved to #2; see https://github.com/Union-AI/union/pull/15"),
    ).toEqual({ ids: ["union-ai/union#15"], numbers: [12, 13] });
  });

  test("a PR number belongs to the session's repository, else the one repository the conversation knows it in", () => {
    const known = new Set(["jasonbenn/sit#1", "o/r#2", "x/y#2"]);
    // A session in a real repository keeps its own, even when a linked upstream PR shares the number.
    expect(pullRequestRepository(2, known, "A/B")).toBe("a/b");
    expect(pullRequestRepository(1, known, null)).toBe("jasonbenn/sit");
    expect(pullRequestRepository(2, known, null)).toBeNull();
    expect(pullRequestRepository(3, known, null)).toBeNull();
    expect(pullRequestRepository(7, new Set(["jasonbenn/sit#2"]), null)).toBe("jasonbenn/sit");
    expect(pullRequestRepository(7, new Set(), null)).toBeNull();
  });
});

describe("contextual pull request references", () => {
  // A number alone names a pull request only inside a conversation bound to a
  // repository, so the scanner reports the number and the words before it,
  // and the payload carries the text as written so no surface alters prose.
  const all = (text: string) => [...text.matchAll(contextualPrRefRegex())].map((m) => [m[1], m[2]]);
  const numbers = (text: string) =>
    [...text.matchAll(contextualPrRefRegex())].flatMap((m) => splitContextualPrRefs(m[1], m[2], m[3] ?? "")).flatMap((t) => ("number" in t ? [t.label] : []));

  test("finds a hash number, PR with and without a hash, and pull request", () => {
    expect(all("see #3263 and PR 3247 and PR #3230, also pull request 12 and PRs 5")).toEqual([
      ["#", "3263"], ["PR ", "3247"], ["PR #", "3230"], ["pull request ", "12"], ["PRs ", "5"],
    ]);
  });

  test("a hash glued to a word, a path, an entity or a longer number is not one", () => {
    expect(all("open page.html#12 and &#123; and #1234567 and a#3")).toEqual([]);
    expect(all("issue#12")).toEqual([]);
  });

  test("a list after the first number continues the reference, same digit count only", () => {
    expect(numbers("PRs 3263 (rescheduled card), 3262 (verbal yes on a call), 3254 and 3253 (feedback), 3261 (sim write leak) all trace")).toEqual(
      ["3263", "3262", "3254", "3253", "3261"],
    );
    expect(numbers("PRs 3252 (reconciler timeouts), 3260, 3259, 3251 come from here")).toEqual(["3252", "3260", "3259", "3251"]);
    expect(numbers("PR 3263 (x), 3 items and #482, #483")).toEqual(["3263", "#482", "#483"]);
    // The prose between the numbers is kept, character for character.
    const m = contextualPrRefRegex().exec("PRs 3254 and 3253 (feedback), 3261 next")!;
    expect(splitContextualPrRefs(m[1], m[2], m[3]).map((t) => ("text" in t ? t.text : `<${t.label}>`)).join("")).toBe("PRs <3254> and <3253> (feedback), <3261>");
    expect(m[0]).toBe("PRs 3254 and 3253 (feedback), 3261");
    // A "#" after the words belongs to the label, so "PR #6" never reads "PR ##6".
    const hashed = contextualPrRefRegex().exec("Still blocked: PR #6 merges")!;
    expect(splitContextualPrRefs(hashed[1], hashed[2], hashed[3]).map((t) => ("text" in t ? t.text : `<${t.label}>`)).join("")).toBe("PR <#6>");
  });

  test("the payload round-trips number, label and whether the number stood alone", () => {
    expect(contextualPrRefPayload(3263, "#3263")).toBe("pr:#3263|#3263");
    expect(contextualPrRefPayload(3263, "#3263", true)).toBe("pr:?#3263|#3263");
    expect(parseContextualPrRef("pr:#3263|#3263")).toEqual({ number: 3263, label: "#3263", bare: false });
    expect(parseContextualPrRef("pr:?#3263|#3263")).toEqual({ number: 3263, label: "#3263", bare: true });
    expect(parseContextualPrRef("pr:#3247|3247")).toEqual({ number: 3247, label: "3247", bare: false });
    expect(parseContextualPrRef("pr:3247")).toBeNull();
    expect(parseContextualPrRef("doc:abc")).toBeNull();
  });
});
