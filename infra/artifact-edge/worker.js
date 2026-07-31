// a.codecast.sh — edge cache for published HTML artifacts.
//
// GET /<slug>[/<asset-path>] → fetch the same path under
// https://convex.codecast.sh/cli/a/ (the branded artifact document, or a
// bundle asset), cached at this PoP for 60s. Republish staleness is bounded by
// the TTL, which matches the origin's own Cache-Control. /cli/a/<slug> is
// accepted too so either path shape works.
//
// The query string is forwarded verbatim: ?v=N opens a past version, ?r=N is
// the in-page reload badge's cache-buster (new URL → new cache key → fresh
// document), ?meta=1 is the version JSON (never cached — it exists to detect
// staleness). Each distinct query is its own cache entry.
//
// Origin redirects (e.g. bundle trailing-slash normalization) point at the
// origin host — rewrite Location back onto this host so the browser stays on
// the edge.

const ORIGIN = "https://convex.codecast.sh";
const SLUG_RE = /^[A-Za-z0-9]{6,32}$/;
const EDGE_TTL = 60;

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const reqUrl = new URL(request.url);
    const { search } = reqUrl;
    const rest = reqUrl.pathname.replace(/^\/cli\/a\//, "").replace(/^\//, "");
    const [slug, ...tailParts] = rest.split("/");
    if (!SLUG_RE.test(slug)) {
      return new Response("Invalid artifact link", { status: 404 });
    }
    const tail = tailParts.join("/");
    if (tail.length > 600 || tail.includes("..")) {
      return new Response("Invalid artifact path", { status: 404 });
    }
    const isMeta = search.includes("meta=1");
    // Preserve the exact path shape: bare slug, trailing slash (bundle docs),
    // or a nested asset path.
    const tailPath = tail ? `/${tail}` : rest.endsWith("/") ? "/" : "";
    const upstream = await fetch(`${ORIGIN}/cli/a/${slug}${tailPath}${search}`, {
      redirect: "manual",
      cf: isMeta ? { cacheTtl: 0 } : { cacheEverything: true, cacheTtl: EDGE_TTL },
    });
    // Re-wrap so the response is mutable and states its cache policy to
    // browsers regardless of what reached us.
    const res = new Response(upstream.body, upstream);
    const loc = res.headers.get("Location");
    if (loc && loc.startsWith("/cli/a/")) {
      res.headers.set("Location", loc.replace(/^\/cli\/a\//, "/"));
    }
    if (!search && !tail) {
      res.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    }
    return res;
  },
};
