// The public repository route has one security property worth a test: a
// refusal must say nothing. A private repository and a repository that does not
// exist have to come back identical, or the route becomes a way to ask whether
// some private repository is real. The rest here pins the pure parts — what a
// path parses to, and where an answer lands in the cache.
import { describe, expect, test } from "bun:test";
import {
  parsePublicRepoPath,
  paramsForKind,
  cacheHeaderFor,
  paramsComplete,
  publicGate,
  notFound,
} from "./repoPublicHttp";
import { cacheKeyFor, ttlFor } from "./repos";

const SHA = "0123456789abcdef0123456789abcdef01234567";

async function describeResponse(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: ((): [string, string][] => {
      const out: [string, string][] = [];
      response.headers.forEach((value, key) => out.push([key, value]));
      return out.sort();
    })(),
  };
}

describe("parsePublicRepoPath", () => {
  test("reads owner, name and kind from either prefix", () => {
    expect(parsePublicRepoPath("/api/public/repo/codecast-sh/codecast/meta")).toEqual({
      repository: "codecast-sh/codecast",
      kind: "meta",
    });
    expect(parsePublicRepoPath("/cli/public/repo/codecast-sh/codecast/blob")).toEqual({
      repository: "codecast-sh/codecast",
      kind: "blob",
    });
  });

  test("rejects anything that is not exactly owner/name/kind", () => {
    expect(parsePublicRepoPath("/api/public/repo/codecast-sh/codecast")).toBeNull();
    expect(parsePublicRepoPath("/api/public/repo/codecast-sh/codecast/tree/extra")).toBeNull();
    expect(parsePublicRepoPath("/api/public/repo/")).toBeNull();
    expect(parsePublicRepoPath("/cli/a/somepage")).toBeNull();
  });

  test("rejects an unknown kind", () => {
    expect(parsePublicRepoPath("/api/public/repo/o/n/secrets")).toBeNull();
  });

  test("rejects owner and name that could never be a repository", () => {
    // Otherwise every piece of garbage mints its own rate-limit counter row.
    expect(parsePublicRepoPath("/api/public/repo/../etc/meta")).toBeNull();
    expect(parsePublicRepoPath("/api/public/repo/o/../meta")).toBeNull();
    expect(parsePublicRepoPath("/api/public/repo/o/n%20ame/meta")).toBeNull();
    // A dot is legal in a repository name and must still be accepted.
    expect(parsePublicRepoPath("/api/public/repo/o/n.js/meta")?.repository).toBe("o/n.js");
  });
});

describe("publicGate", () => {
  test("private and never-heard-of are the same answer, byte for byte", async () => {
    const unknown = await describeResponse(publicGate({ installed: false, private: false })!);
    const secret = await describeResponse(publicGate({ installed: true, private: true })!);

    expect(secret).toEqual(unknown);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toBe('{"error":"not_found"}');
  });

  test("a public repository is not refused", () => {
    expect(publicGate({ installed: true, private: false })).toBeNull();
  });

  test("every other refusal in the route is the same response", async () => {
    // The handler answers notFound() for a bad path, a missing cache row and a
    // 404 from GitHub as well. They have to match the gate's refusal too.
    expect(await describeResponse(notFound())).toEqual(
      await describeResponse(publicGate({ installed: true, private: true })!),
    );
  });
});

describe("paramsForKind", () => {
  const q = (s: string) => new URLSearchParams(s);

  test("each kind reads only its own params", () => {
    expect(paramsForKind("log", q("ref=main&path=src&page=2&author=ada"))).toEqual({
      ref: "main",
      path: "src",
      page: 2,
      author: "ada",
    });
    expect(paramsForKind("compare", q("base=main&head=next"))).toEqual({ base: "main", head: "next" });
    expect(paramsForKind("pulls", q("state=closed&page=3"))).toEqual({ state: "closed", page: 3 });
    expect(paramsForKind("meta", q("ref=main"))).toEqual({});
  });

  test("a missing state defaults to open and a missing directory to the root", () => {
    expect(paramsForKind("pulls", q(""))).toEqual({ state: "open", page: undefined });
    expect(paramsForKind("lastcommits", q("ref=main"))).toEqual({ ref: "main", path: "" });
  });
});

describe("cache keys", () => {
  test("a log page carries its page and author, so two pages are two rows", () => {
    expect(cacheKeyFor("log", { ref: "main", path: "src", page: 2, author: "ada" })).toEqual({
      ref: "main",
      path: "src#2#ada",
    });
    expect(cacheKeyFor("log", { ref: "main", path: "src", page: 2 })).toEqual({
      ref: "main",
      path: "src#2#",
    });
  });

  test("a compare is keyed base to head, and a search by query and page", () => {
    expect(cacheKeyFor("compare", { base: "main", head: "next" })).toEqual({ ref: "main", path: "next" });
    expect(cacheKeyFor("search", { q: "useRepoTree", page: 2 })).toEqual({
      ref: "-",
      path: "scoped-v2:useRepoTree#2",
    });
  });

  test("the whole-repository kinds share one row each", () => {
    for (const kind of ["meta", "tags", "branches", "branchdetails"]) {
      expect(cacheKeyFor(kind, {})).toEqual({ ref: "-", path: "" });
    }
  });

  test("a recursive tree is a different row from a shallow one", () => {
    expect(cacheKeyFor("tree", { ref: "main" })).toEqual({ ref: "main", path: "" });
    expect(cacheKeyFor("tree", { ref: "main", recursive: true })).toEqual({ ref: "main", path: "**" });
  });
});

describe("freshness", () => {
  test("anything pinned to a full sha is cached forever", () => {
    expect(ttlFor("blob", SHA)).toBe(Number.POSITIVE_INFINITY);
    expect(ttlFor("lastcommits", SHA)).toBe(Number.POSITIVE_INFINITY);
  });

  test("what a branch reaches expires in minutes", () => {
    expect(ttlFor("meta", "main")).toBe(10 * 60 * 1000);
    expect(ttlFor("tags", "-")).toBe(2 * 60 * 1000);
    expect(ttlFor("pulls", "open")).toBe(2 * 60 * 1000);
    expect(ttlFor("search", "-")).toBe(5 * 60 * 1000);
    expect(ttlFor("lastcommits", "main")).toBe(10 * 60 * 1000);
    expect(ttlFor("readme", "main")).toBe(10 * 60 * 1000);
  });

  test("an unknown kind still expires", () => {
    expect(ttlFor("something-new", "main")).toBe(5 * 60 * 1000);
  });
});

describe("paramsComplete", () => {
  test("a kind missing what it needs is a bad request, not a GitHub call", () => {
    expect(paramsComplete("blob", { ref: "main" })).toBe(false);
    expect(paramsComplete("blob", { ref: "main", path: "README.md" })).toBe(true);
    expect(paramsComplete("compare", { base: "main" })).toBe(false);
    expect(paramsComplete("compare", { base: "main", head: "next" })).toBe(true);
    expect(paramsComplete("search", { q: "" })).toBe(false);
    expect(paramsComplete("search", { q: "useRepoTree" })).toBe(true);
    expect(paramsComplete("log", {})).toBe(false);
  });

  test("the whole-repository kinds need nothing", () => {
    for (const kind of ["meta", "tags", "branches", "branchdetails", "pulls"] as const) {
      expect(paramsComplete(kind, {})).toBe(true);
    }
  });
});

describe("cacheHeaderFor", () => {
  test("every read reaches the visibility gate, including immutable content", () => {
    expect(cacheHeaderFor({ ref: SHA })).toBe("no-store");
    expect(cacheHeaderFor({ ref: "main" })).toBe("no-store");
    expect(cacheHeaderFor({})).toBe("no-store");
  });
});
