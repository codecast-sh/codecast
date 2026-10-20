import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker, { browserPolicy } from "./worker.js";

const realFetch = globalThis.fetch;
const realCaches = globalThis.caches;
const realNow = Date.now;
let now;
let store;
let background;

beforeEach(() => {
  now = 1_000_000;
  Date.now = () => now;
  store = new Map();
  background = [];
  // The PoP's cache: the worker puts by origin address and matches by request.
  globalThis.caches = {
    default: {
      match: async (req) => store.get(req.url)?.clone(),
      put: async (url, res) => void store.set(String(url), res),
    },
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.caches = realCaches;
  Date.now = realNow;
});

// Stand in for the origin, recording what the worker asked for and answering
// with the Cache-Control the zone hands the worker (always rewritten).
function stubOrigin(extra = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), cache: init?.cache });
    return new Response(`body ${calls.length}`, {
      status: extra.status ?? 200,
      headers: { "Cache-Control": "max-age=14400", ...(extra.headers ?? {}) },
    });
  };
  return calls;
}

const ctx = { waitUntil: (p) => background.push(p) };
const get = (path) => worker.fetch(new Request(`https://a.codecast.sh${path}`), {}, ctx);
const later = (seconds) => {
  now += seconds * 1000;
};
const PUBLIC = "public, max-age=60, stale-while-revalidate=300";

describe("artifact edge cache", () => {
  test("a page nobody here has opened waits on the origin once, then is held", async () => {
    const calls = stubOrigin();
    const first = await get("/abcdefghijkl");
    expect(first.headers.get("X-Edge-Cache")).toBe("MISS");
    expect(first.headers.get("Cache-Control")).toBe(PUBLIC);
    expect(calls[0]).toEqual({ url: "https://convex.codecast.sh/cli/a/abcdefghijkl", cache: "no-store" });

    later(30);
    const second = await get("/abcdefghijkl");
    expect(second.headers.get("X-Edge-Cache")).toBe("HIT");
    expect(await second.text()).toBe("body 1");
    expect(calls.length).toBe(1);
  });

  test("past fresh, the held copy is served at once and replaced behind the response", async () => {
    const calls = stubOrigin();
    await get("/abcdefghijkl");
    later(200);
    const res = await get("/abcdefghijkl");
    expect(res.headers.get("X-Edge-Cache")).toBe("STALE");
    expect(await res.text()).toBe("body 1");
    expect(background.length).toBe(1);
    await Promise.all(background);
    expect(calls.length).toBe(2);
    const next = await get("/abcdefghijkl");
    expect(next.headers.get("X-Edge-Cache")).toBe("HIT");
    expect(await next.text()).toBe("body 2");
  });

  test("a refresh reaches the origin even though fetch reads the same store the held copy lives in", async () => {
    // Cloudflare's fetch answers from caches.default when an entry sits under
    // the fetched URL and the request does not opt out of the cache.
    const calls = stubOrigin();
    const origin = globalThis.fetch;
    globalThis.fetch = async (url, init) =>
      init?.cache !== "no-store" && store.has(String(url)) ? store.get(String(url)).clone() : origin(url, init);
    await get("/abcdefghijkl");
    for (let i = 0; i < 3; i++) {
      later(61);
      await get("/abcdefghijkl");
      await Promise.all(background.splice(0));
    }
    expect(calls.length).toBe(4);
    expect(await (await get("/abcdefghijkl")).text()).toBe("body 4");
  });

  test("a version-pinned address (r=vN) is held and kept by the browser for the whole bound, never refreshed", async () => {
    const calls = stubOrigin();
    const first = await get("/abcdefghijkl?theme=dark&embed=1&r=v3");
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=360");
    later(200);
    const res = await get("/abcdefghijkl?theme=dark&embed=1&r=v3");
    expect(res.headers.get("X-Edge-Cache")).toBe("HIT");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=160");
    expect(background.length).toBe(0);
    later(161);
    expect((await get("/abcdefghijkl?theme=dark&embed=1&r=v3")).headers.get("X-Edge-Cache")).toBe("MISS");
    expect(calls.length).toBe(2);
  });

  test("a pinned gated address is kept privately for the whole bound", async () => {
    stubOrigin();
    expect((await get("/abcdefghijkl?embed=1&k=tok&r=v2")).headers.get("Cache-Control")).toBe("private, max-age=360");
  });

  test("only r=v<number> pins: the reload badge's other values stay on the 60s policy", async () => {
    stubOrigin();
    expect((await get("/abcdefghijkl?r=1700000000")).headers.get("Cache-Control")).toBe(PUBLIC);
  });

  test("a copy older than the revocation bound is never served", async () => {
    const calls = stubOrigin();
    await get("/abcdefghijkl");
    later(361);
    const res = await get("/abcdefghijkl");
    expect(res.headers.get("X-Edge-Cache")).toBe("MISS");
    expect(await res.text()).toBe("body 2");
    expect(calls.length).toBe(2);
  });

  test("the browser's allowance is what is left of the bound, counted from the fetch", async () => {
    stubOrigin();
    await get("/abcdefghijkl");
    later(200);
    expect((await get("/abcdefghijkl")).headers.get("Cache-Control")).toBe("public, max-age=60, stale-while-revalidate=100");
    for (const age of [0, 59, 60, 200, 330, 359, 360, 4000]) {
      const [, fresh, stale] = /max-age=(\d+), stale-while-revalidate=(\d+)/.exec(browserPolicy(age)).map(Number);
      expect(age + fresh + stale).toBeLessThanOrEqual(Math.max(age, 360));
    }
  });

  test("the zone's four hour browser TTL and the worker's own bookkeeping never reach the browser", async () => {
    stubOrigin();
    await get("/abcdefghijkl/");
    const held = await get("/abcdefghijkl/");
    expect(held.headers.get("Cache-Control")).toBe(PUBLIC);
    expect(held.headers.get("X-Edge-Fetched-At")).toBeNull();
  });

  test("both path shapes share one copy", async () => {
    const calls = stubOrigin();
    await get("/abcdefghijkl?theme=dark");
    expect((await get("/cli/a/abcdefghijkl?theme=dark")).headers.get("X-Edge-Cache")).toBe("HIT");
    expect((await get("/abcdefghijkl?theme=light")).headers.get("X-Edge-Cache")).toBe("MISS");
    expect(calls.length).toBe(2);
  });

  test("the scripts a page runs are held too", async () => {
    const calls = stubOrigin();
    await get("/cli/player.js");
    expect(calls[0].url).toBe("https://convex.codecast.sh/cli/player.js");
    expect((await get("/cli/player.js")).headers.get("X-Edge-Cache")).toBe("HIT");
    expect((await get("/cli/secrets.js")).status).toBe(404);
  });

  // Gate tokens: fetched past the shared cache and never stored, but the
  // browser holding the token may keep the page for the same bound as an open
  // one, privately.
  for (const path of [
    "/abcdefghijkl?k=deadbeef",
    "/abcdefghijkl?e=tok",
    "/abcdefghijkl/img/logo.png?k=tok",
  ]) {
    test(`${path} is never stored here, and kept only by its own browser`, async () => {
      const calls = stubOrigin();
      const one = await get(path);
      const two = await get(path);
      expect(calls.length).toBe(2);
      expect(calls[0].cache).toBe("no-store");
      expect(calls[0].url).toBe(`https://convex.codecast.sh/cli/a${path}`);
      expect(store.size).toBe(0);
      for (const res of [one, two]) expect(res.headers.get("Cache-Control")).toBe("private, max-age=60, stale-while-revalidate=300");
    });
  }

  test("a gated answer that failed is not kept even by the browser", async () => {
    stubOrigin({ status: 500 });
    expect((await get("/abcdefghijkl?k=deadbeef")).headers.get("Cache-Control")).toBe("private, no-store");
  });

  // Live reads and single-use answers: fetched past the cache, never stored,
  // never browser-cacheable, gate token or not.
  for (const path of [
    "/abcdefghijkl?meta=1",
    "/abcdefghijkl?meta=1&k=tok",
    "/abcdefghijkl/_data",
    "/abcdefghijkl/_data/spend?k=tok",
    "/abcdefghijkl?edit=1",
    "/abcdefghijkl/film.mp4?download=film.mp4",
  ]) {
    test(`${path} is never stored`, async () => {
      const calls = stubOrigin();
      const one = await get(path);
      const two = await get(path);
      expect(calls.length).toBe(2);
      expect(calls[0].cache).toBe("no-store");
      expect(calls[0].url).toBe(`https://convex.codecast.sh/cli/a${path}`);
      expect(store.size).toBe(0);
      for (const res of [one, two]) expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    });
  }

  test("every answer may be timed by the page that frames it", async () => {
    stubOrigin();
    expect((await get("/abcdefghijkl")).headers.get("Timing-Allow-Origin")).toBe("*");
  });

  test("a missing page is not held, so a page published a moment later appears", async () => {
    const calls = stubOrigin({ status: 404 });
    const res = await get("/abcdefghijkl");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await get("/abcdefghijkl");
    expect(calls.length).toBe(2);
  });

  test("the bundle redirect comes back onto this host and is held", async () => {
    const calls = stubOrigin({ status: 301, headers: { Location: "/cli/a/abcdefghijkl/?theme=dark" } });
    expect((await get("/abcdefghijkl?theme=dark")).headers.get("Location")).toBe("/abcdefghijkl/?theme=dark");
    const again = await get("/abcdefghijkl?theme=dark");
    expect(again.status).toBe(301);
    expect(again.headers.get("Location")).toBe("/abcdefghijkl/?theme=dark");
    expect(calls.length).toBe(1);
  });

  test("a failed refresh leaves the held copy in place", async () => {
    stubOrigin();
    await get("/abcdefghijkl");
    later(100);
    globalThis.fetch = async () => {
      throw new Error("origin down");
    };
    expect((await get("/abcdefghijkl")).headers.get("X-Edge-Cache")).toBe("STALE");
    await Promise.all(background);
    expect(await (await get("/abcdefghijkl")).text()).toBe("body 1");
  });

  test("a malformed slug never reaches the origin", async () => {
    const calls = stubOrigin();
    expect((await get("/nope")).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
