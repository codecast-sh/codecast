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
//
// What this PoP may store is the other half of the origin's revocation bound.
// A request carrying a gate token asks for a body that only that token opens,
// so it is fetched past the cache and its response is never stored here: the
// origin answers those `private, no-store`, and a shared cache holding one
// would keep serving it after the owner changes the password or deletes the
// page. Everything else is public content, cached for the origin's own TTL —
// and the origin's header is what decides, so a policy change there does not
// need this worker redeployed to take effect.

const ORIGIN = "https://convex.codecast.sh";
const SLUG_RE = /^[A-Za-z0-9]{6,32}$/;
const EDGE_TTL = 60;
// Viewing capabilities that appear in the query string. A request holding one
// is authorization-dependent and must not be answered from a shared cache.
const GATE_PARAMS = ["k", "e"];

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
    const isMeta = reqUrl.searchParams.get("meta") === "1";
    const isGated = GATE_PARAMS.some((p) => reqUrl.searchParams.has(p));
    // Preserve the exact path shape: bare slug, trailing slash (bundle docs),
    // or a nested asset path.
    const tailPath = tail ? `/${tail}` : rest.endsWith("/") ? "/" : "";
    const upstream = await fetch(`${ORIGIN}/cli/a/${slug}${tailPath}${search}`, {
      redirect: "manual",
      // cacheEverything overrides the origin's own Cache-Control, so it is for
      // public content only. Gated requests and the staleness probe bypass the
      // cache entirely.
      cf: isMeta || isGated ? { cacheTtl: 0 } : { cacheEverything: true, cacheTtl: EDGE_TTL },
    });
    // Re-wrap so the response is mutable and the Location rewrite can be made.
    const res = new Response(upstream.body, upstream);
    const loc = res.headers.get("Location");
    if (loc && loc.startsWith("/cli/a/")) {
      res.headers.set("Location", loc.replace(/^\/cli\/a\//, "/"));
    }
    // The origin states the policy. This worker used to overwrite the bare
    // slug's header with a public 60s policy whatever the origin said, which
    // turned a password gate page or a protected body into a cacheable one.
    if (isGated && !/no-store/.test(res.headers.get("Cache-Control") || "")) {
      res.headers.set("Cache-Control", "private, no-store");
    }
    return res;
  },
};
