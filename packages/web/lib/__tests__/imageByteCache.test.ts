// The byte-cache engine's non-hook surface: prefetch dedup, byte persistence
// in Cache Storage, and the entry-cap pruning that keeps "a reasonable amount
// of history" from becoming an unbounded disk footprint.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createByteCache } from "../imageByteCache";

class FakeCache {
  store = new Map<string, Response>();
  async match(url: string | Request) {
    return this.store.get(typeof url === "string" ? url : url.url);
  }
  async put(url: string | Request, resp: Response) {
    this.store.set(typeof url === "string" ? url : url.url, resp);
  }
  async keys() {
    return [...this.store.keys()].map((u) => new Request(u));
  }
  async delete(url: string | Request) {
    return this.store.delete(typeof url === "string" ? url : url.url);
  }
}

const cachesByName = new Map<string, FakeCache>();
let fetchCalls: string[] = [];

const realFetch = globalThis.fetch;
const realCaches = (globalThis as any).caches;

beforeEach(() => {
  cachesByName.clear();
  fetchCalls = [];
  (globalThis as any).caches = {
    open: async (name: string) => {
      let c = cachesByName.get(name);
      if (!c) cachesByName.set(name, (c = new FakeCache()));
      return c;
    },
  };
  (globalThis as any).fetch = async (url: string) => {
    fetchCalls.push(url);
    return new Response("bytes", { status: 200 });
  };
});

afterEach(() => {
  (globalThis as any).fetch = realFetch;
  (globalThis as any).caches = realCaches;
});

// Prefetch work is fire-and-forget; let its promise chains drain.
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("createByteCache prefetch", () => {
  it("fetches each URL once and stores the bytes", async () => {
    const cache = createByteCache({ cacheName: "t1", whileResolving: "wait", onFailed: "remote" });
    cache.prefetch(["https://x.test/a", "https://x.test/b", "https://x.test/a"]);
    await settle();
    cache.prefetch(["https://x.test/a", "https://x.test/b"]); // session dedup
    await settle();
    expect(fetchCalls.sort()).toEqual(["https://x.test/a", "https://x.test/b"]);
    expect(cachesByName.get("t1")!.store.size).toBe(2);
  });

  it("skips URLs whose bytes are already in Cache Storage (a prior session)", async () => {
    const stored = new FakeCache();
    await stored.put("https://x.test/a", new Response("old bytes"));
    cachesByName.set("t2", stored);
    const cache = createByteCache({ cacheName: "t2", whileResolving: "wait", onFailed: "remote" });
    cache.prefetch(["https://x.test/a"]);
    await settle();
    expect(fetchCalls).toEqual([]);
  });

  it("ignores non-http srcs (data:, blob:) and empty slots", async () => {
    const cache = createByteCache({ cacheName: "t3", whileResolving: "wait", onFailed: "remote" });
    cache.prefetch(["data:image/png;base64,xx", "blob:abc", null, undefined]);
    await settle();
    expect(fetchCalls).toEqual([]);
  });

  it("prunes oldest-stored entries beyond maxEntries", async () => {
    const cache = createByteCache({ cacheName: "t4", whileResolving: "wait", onFailed: "remote", maxEntries: 3 });
    cache.prefetch([1, 2, 3, 4, 5].map((n) => `https://x.test/${n}`));
    await settle();
    const store = cachesByName.get("t4")!.store;
    expect(store.size).toBeLessThanOrEqual(3);
    // The most recently stored entry survives.
    expect(store.has("https://x.test/5")).toBe(true);
  });

  it("a failed fetch is not stored and does not poison the session dedup forever", async () => {
    (globalThis as any).fetch = async (url: string) => {
      fetchCalls.push(url);
      return new Response("nope", { status: 500 });
    };
    const cache = createByteCache({ cacheName: "t5", whileResolving: "wait", onFailed: "remote" });
    cache.prefetch(["https://x.test/a"]);
    await settle();
    expect(cachesByName.get("t5")!.store.size).toBe(0);
    expect(fetchCalls).toEqual(["https://x.test/a"]);
  });

  // An <img> renders a CDN that sends no access-control-allow-origin; a
  // fetch() cannot. Byte-caching such an origin only spends a blocked request
  // and a console error, so the engine declines to try.
  it("never fetches a seeded origin that refuses cross-origin reads", async () => {
    const cache = createByteCache({ cacheName: "t6", whileResolving: "remote", onFailed: "none" });
    cache.prefetch(["https://avatars.slack-edge.com/2026-08-25/1_a.png"]);
    await settle();
    expect(fetchCalls).toEqual([]);
  });

  it("learns a refusing origin from one rejection and spares the rest of it", async () => {
    (globalThis as any).fetch = async (url: string) => {
      fetchCalls.push(url);
      throw new TypeError("Failed to fetch");
    };
    const cache = createByteCache({ cacheName: "t7", whileResolving: "remote", onFailed: "none" });
    cache.prefetch(["https://refuses.test/a.png"]);
    await settle();
    cache.prefetch(["https://refuses.test/b.png", "https://refuses.test/c.png"]);
    await settle();
    expect(fetchCalls).toEqual(["https://refuses.test/a.png"]);
  });

  it("reads a status code as this URL being dead, not the origin refusing", async () => {
    (globalThis as any).fetch = async (url: string) => {
      fetchCalls.push(url);
      return new Response("gone", { status: 404 });
    };
    const cache = createByteCache({ cacheName: "t8", whileResolving: "wait", onFailed: "remote" });
    cache.prefetch(["https://answers.test/a.png"]);
    await settle();
    cache.prefetch(["https://answers.test/b.png"]);
    await settle();
    expect(fetchCalls).toEqual(["https://answers.test/a.png", "https://answers.test/b.png"]);
  });
});
