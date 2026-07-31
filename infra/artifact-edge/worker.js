// a.codecast.sh — edge cache for published HTML artifacts.
//
// GET /<slug>  →  fetch https://convex.codecast.sh/cli/a/<slug> (the branded
// artifact document), cached at this PoP for 60s. Republish staleness is
// bounded by the TTL, which matches the origin's own Cache-Control.
// /cli/a/<slug> is accepted too so either path shape works.
//
// The query string is forwarded verbatim: ?v=N opens a past version, ?r=N is
// the in-page reload badge's cache-buster (new URL → new cache key → fresh
// document), ?meta=1 is the version JSON. Each distinct query is its own
// cache entry.

const ORIGIN = "https://convex.codecast.sh";
const SLUG_RE = /^[A-Za-z0-9]{6,32}$/;
const EDGE_TTL = 60;

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const { pathname, search } = new URL(request.url);
    const slug = pathname.replace(/^\/cli\/a\//, "").replace(/^\//, "").replace(/\/+$/, "");
    if (!SLUG_RE.test(slug)) {
      return new Response("Invalid artifact link", { status: 404 });
    }
    // The meta poll must see the origin live — it exists to detect staleness.
    const isMeta = search.includes("meta=1");
    const upstream = await fetch(`${ORIGIN}/cli/a/${slug}${search}`, {
      cf: isMeta ? { cacheTtl: 0 } : { cacheEverything: true, cacheTtl: EDGE_TTL },
    });
    // Re-wrap so the response is mutable and states its cache policy to
    // browsers regardless of what reached us.
    const res = new Response(upstream.body, upstream);
    if (!search) {
      res.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    }
    return res;
  },
};
