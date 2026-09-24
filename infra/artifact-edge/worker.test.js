import { afterEach, describe, expect, test } from "bun:test";
import worker from "./worker.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Stand in for the origin, recording what cache options the worker asked for
// and answering with the Cache-Control the origin would really send.
function stubOrigin(cacheControl, extra = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), cf: init?.cf });
    return new Response("body", {
      status: extra.status ?? 200,
      headers: { "Cache-Control": cacheControl, ...(extra.headers ?? {}) },
    });
  };
  return calls;
}

const get = (path) => worker.fetch(new Request(`https://a.codecast.sh${path}`));

describe("artifact edge cache", () => {
  test("an ungated page is cached at the PoP with the public policy", async () => {
    const calls = stubOrigin("public, max-age=60, stale-while-revalidate=300");
    const res = await get("/abcdefghijkl");
    expect(calls[0].cf).toEqual({ cacheEverything: true, cacheTtl: 60 });
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60, stale-while-revalidate=300");
  });

  test("the zone's four hour browser TTL never reaches the browser", async () => {
    // Cloudflare rewrites the subrequest's header before the worker reads it.
    stubOrigin("max-age=14400");
    expect((await get("/abcdefghijkl/")).headers.get("Cache-Control")).toBe("public, max-age=60, stale-while-revalidate=300");
    expect((await get("/abcdefghijkl/?k=deadbeef")).headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("a request holding the password token is never stored at the PoP", async () => {
    const calls = stubOrigin("private, no-store");
    const res = await get("/abcdefghijkl?k=deadbeef");
    expect(calls[0].cf).toEqual({ cacheTtl: 0 });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("an email-gated request is not stored either", async () => {
    const calls = stubOrigin("private, no-store");
    await get("/abcdefghijkl?e=tok");
    expect(calls[0].cf).toEqual({ cacheTtl: 0 });
  });

  test("a gated asset under a bundle is not stored", async () => {
    const calls = stubOrigin("private, no-store");
    await get("/abcdefghijkl/img/logo.png?k=tok");
    expect(calls[0].url).toContain("/cli/a/abcdefghijkl/img/logo.png?k=tok");
    expect(calls[0].cf).toEqual({ cacheTtl: 0 });
  });

  // The regression: the worker used to rewrite the bare slug's header to a
  // public 60s policy whatever the origin said, so a protected body became
  // browser-cacheable the moment it was served.
  test("a protected body is never rewritten into a public policy", async () => {
    stubOrigin("private, no-store");
    const res = await get("/abcdefghijkl?k=tok");
    expect(res.headers.get("Cache-Control")).not.toContain("public");
  });

  test("the staleness probe is never cached", async () => {
    const calls = stubOrigin("no-store");
    await get("/abcdefghijkl?meta=1");
    expect(calls[0].cf).toEqual({ cacheTtl: 0 });
  });

  test("the bundle redirect still comes back onto this host", async () => {
    stubOrigin("public, max-age=60", { status: 301, headers: { Location: "/cli/a/abcdefghijkl/" } });
    const res = await get("/abcdefghijkl");
    expect(res.headers.get("Location")).toBe("/abcdefghijkl/");
  });

  test("a malformed slug never reaches the origin", async () => {
    const calls = stubOrigin("public, max-age=60");
    expect((await get("/nope")).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
