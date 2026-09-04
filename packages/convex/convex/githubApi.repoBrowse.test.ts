import { afterEach, expect, test } from "bun:test";
import { lastCommitsForPaths, searchCode } from "./githubApi";
import { cacheKeyFor } from "./repos";
import { scopedRepoSearch } from "./lib/repoSearch";
import { paramsComplete } from "./repoPublicHttp";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("search replaces every repository scope and versions pre-fix cache entries", () => {
  expect(scopedRepoSearch("demo/public", 'filename:README repo:other/private org:other -repo:demo/public user:someone'))
    .toBe("filename:README repo:demo/public");
  expect(scopedRepoSearch("demo/public", '"a phrase" language:TypeScript')).toBe('"a phrase" language:TypeScript repo:demo/public');
  expect(cacheKeyFor("search", { q: "x", page: 1 }).path).toBe("scoped-v2:x#1");
});
test("search refuses foreign results rather than leaking fragments or counts", async () => {
  globalThis.fetch = (async (url: any) => {
    expect(new URL(url).searchParams.get("q")).toBe("README repo:demo/public");
    return Response.json({ total_count: 1, items: [{ repository: { full_name: "other/private" }, path: "secret" }] });
  }) as typeof fetch;
  await expect((searchCode as any)._handler({}, { repository: "demo/public", q: "README repo:other/private", github_access_token: "test" }))
    .rejects.toThrow("outside the requested repository");
});
for (const ref of ["main", "v1.0"]) {
  test(`cold root lastcommits resolves a tree at ${ref}`, async () => {
    const requests: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return Response.json(requests.length === 1
        ? { data: { repository: { object: { entries: [{ name: "README.md" }] } } } }
        : { data: { repository: { object: { p0: { nodes: [{ oid: "a".repeat(40), messageHeadline: "Update", committedDate: "2026-01-01" }] } } } } });
    }) as typeof fetch;
    const result = await (lastCommitsForPaths as any)._handler({}, { repository: "demo/public", ref, dir: "", github_access_token: "test" });
    expect(requests[0].variables.expression).toBe(`${ref}:`);
    expect(requests[1].query).toContain('history(first: 1, path: "README.md")');
    expect(result["README.md"].subject).toBe("Update");
  });
}
test("public pagination and pull states are validated before upstream calls", () => {
  for (const page of [NaN, -1, 0, 1.5, 1001]) expect(paramsComplete("log", { ref: "main", page })).toBe(false);
  expect(paramsComplete("pulls", { state: "invalid" })).toBe(false);
  expect(paramsComplete("pulls", { state: "all", page: 2 })).toBe(true);
});
