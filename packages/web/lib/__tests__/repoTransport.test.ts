// The public transport has to build the same request the route parses, and it
// has to share one in-flight request per URL — a directory page and its
// last-commit column both ask for the tree, and two mounts must not be two
// round trips.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { publicRepoUrl, readPublic, clearPublicRepoCache } from "../repoTransport";

const REPO = "codecast-sh/codecast";

describe("publicRepoUrl", () => {
  test("puts the repository in the path and the rest in the query", () => {
    const url = publicRepoUrl(REPO, "log", { repository: REPO, ref: "main", path: "src", page: 2 });
    const parsed = new URL(url!);
    expect(parsed.pathname).toBe(`/cli/public/repo/${REPO}/log`);
    expect(parsed.searchParams.get("ref")).toBe("main");
    expect(parsed.searchParams.get("path")).toBe("src");
    expect(parsed.searchParams.get("page")).toBe("2");
    // The repository rides the path, so it must not be repeated as a param.
    expect(parsed.searchParams.get("repository")).toBeNull();
  });

  test("drops what is not set and spells booleans the way the route reads them", () => {
    const url = publicRepoUrl(REPO, "tree", { ref: "main", recursive: true, path: undefined });
    expect(new URL(url!).searchParams.get("recursive")).toBe("1");
    expect(new URL(url!).searchParams.get("path")).toBeNull();
  });

  test("a read that is not ready yet has no URL", () => {
    expect(publicRepoUrl(undefined, "meta", {})).toBeNull();
    expect(publicRepoUrl(REPO, "meta", null)).toBeNull();
  });

  test("a whole-repository read carries no query string at all", () => {
    expect(publicRepoUrl(REPO, "meta", { repository: REPO })).toBe(
      `${new URL(publicRepoUrl(REPO, "meta", { repository: REPO })!).origin}/cli/public/repo/${REPO}/meta`,
    );
  });
});

describe("readPublic", () => {
  const realFetch = globalThis.fetch;
  let calls = 0;

  beforeEach(() => {
    calls = 0;
    clearPublicRepoCache();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const stub = (status: number, body: unknown) => {
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  };

  test("two askers for one URL share a single request", async () => {
    stub(200, { default_branch: "main" });
    const [a, b] = await Promise.all([
      readPublic("https://example.test/x"),
      readPublic("https://example.test/x"),
    ]);
    expect(calls).toBe(1);
    expect(a.data).toEqual({ default_branch: "main" });
    expect(b).toBe(a);
  });

  test("a 404 is an empty answer, not an error", async () => {
    stub(404, { error: "not_found" });
    const result = await readPublic("https://example.test/missing");
    expect(result.missing).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("any other failure keeps its error", async () => {
    stub(502, { error: "upstream_unavailable" });
    const result = await readPublic("https://example.test/broken");
    expect(result.missing).toBe(false);
    expect(result.error?.message).toContain("502");
  });

  test("a thrown request is not remembered as this minute's answer", async () => {
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("offline");
    }) as typeof fetch;

    const first = await readPublic("https://example.test/flaky");
    expect(first.error?.message).toBe("offline");

    stub(200, { ok: true });
    const second = await readPublic("https://example.test/flaky");
    expect(second.data).toEqual({ ok: true });
  });
});
