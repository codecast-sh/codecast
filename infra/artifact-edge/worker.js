// a.codecast.sh — edge cache for published HTML artifacts.
//
// GET /<slug>  →  fetch https://convex.codecast.sh/cli/a/<slug> (the branded
// artifact document), cached at this PoP for 60s. Republish staleness is
// bounded by the TTL, which matches the origin's own Cache-Control.
// /cli/a/<slug> is accepted too so either path shape works.

const ORIGIN = "https://convex.codecast.sh";
const SLUG_RE = /^[A-Za-z0-9]{6,32}$/;
const EDGE_TTL = 60;

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const { pathname } = new URL(request.url);
    const slug = pathname.replace(/^\/cli\/a\//, "").replace(/^\//, "").replace(/\/+$/, "");
    if (!SLUG_RE.test(slug)) {
      return new Response("Invalid artifact link", { status: 404 });
    }
    const upstream = await fetch(`${ORIGIN}/cli/a/${slug}`, {
      cf: { cacheEverything: true, cacheTtl: EDGE_TTL },
    });
    // Re-wrap so the response is mutable and states its cache policy to
    // browsers regardless of what reached us.
    const res = new Response(upstream.body, upstream);
    res.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return res;
  },
};
