// a.codecast.sh — edge cache for published HTML artifacts.
//
// GET /<slug>[/<asset-path>] → the same path under
// https://convex.codecast.sh/cli/a/ (the branded artifact document, or a
// bundle asset). /cli/a/<slug> is accepted too so either path shape works,
// and /cli/{player,data,motion}.js are the scripts a page runs.
//
// Why this holds its own copy. An HTTP action at the origin waits seconds in
// the backend's queue before it runs, so a viewer must never wait on one when
// a copy is here. A copy is fresh for FRESH seconds. Past that, and for STALE
// seconds more, it is still served at once while a new one is fetched behind
// the response. Only a page nobody at this PoP opened in the last
// FRESH + STALE seconds waits on the origin.
//
// That window is the origin's revocation bound (REVOCATION_BOUND_MS in
// artifactsHttp.ts): how long a page may still be answered after its owner
// adds a password, sets an expiry or deletes it. The browser's own allowance
// is counted from the moment the copy was fetched, not from when it was
// served, so this cache and the browser's together never pass the bound.
//
// The query string is forwarded verbatim and each distinct query is its own
// entry: ?v=N opens a past version, ?r=N is the reload badge's cache-buster.
// Never stored: ?meta=1 (the version JSON exists to detect staleness),
// <slug>/_data (live query results), ?edit=1 (always the current source),
// ?download= (a signed link that expires), and any request carrying a gate
// token, whose body only that token opens.
//
// Origin redirects (e.g. bundle trailing-slash normalization) point at the
// origin's path — rewrite Location back onto this host's.

const ORIGIN = "https://convex.codecast.sh";
const SLUG_RE = /^[A-Za-z0-9]{6,32}$/;
const RUNTIME_RE = /^\/cli\/(player|data|motion)\.js$/;
const FRESH = 60;
const STALE = 300;
const UNCACHED_POLICY = "private, no-store";
// Viewing capabilities that appear in the query string. A request holding one
// is authorization-dependent and must not be answered from a shared cache.
const GATE_PARAMS = ["k", "e"];
// Answers that are live or single-use whatever the gates say.
const LIVE_PARAMS = ["edit", "download"];
// A page, an asset, the bundle redirect, a media redirect. Errors and the
// "not found" page are never held: a page published a moment ago must appear.
const STORED_STATUSES = new Set([200, 301, 302]);
const STORED_AT = "X-Edge-Fetched-At";

/** What a browser may do with a copy fetched `age` seconds ago: the same
 * fresh-then-stale shape as the origin's policy, cut to what is left of it.
 * `scope` "private" keeps it out of every shared cache: a body only a gate
 * token opens may sit in the browser that holds the token, never elsewhere. */
export function browserPolicy(age, scope = "public", pinned = false) {
  const left = Math.max(0, FRESH + STALE - Math.floor(age));
  // A version-pinned address (r=vN) never shows other content: the browser may
  // use it for the whole bound. Browsers ignore stale-while-revalidate for a
  // frame's document, so the unpinned 60s would send every later visit back.
  if (pinned) return `${scope}, max-age=${left}`;
  const fresh = Math.min(FRESH, left);
  return `${scope}, max-age=${fresh}, stale-while-revalidate=${left - fresh}`;
}

async function fromOrigin(url) {
  // The zone's cache is bypassed: the copy this worker keeps is the only one,
  // so its age is the whole age of what a viewer gets.
  const upstream = await fetch(url, { redirect: "manual", cache: "no-store" });
  // Re-wrap so the response is mutable and the Location rewrite can be made.
  const res = new Response(upstream.body, upstream);
  const loc = res.headers.get("Location");
  if (loc && loc.startsWith("/cli/a/")) res.headers.set("Location", loc.replace(/^\/cli\/a\//, "/"));
  return res;
}

function answer(res, policy, state) {
  const out = new Response(res.body, res);
  // The browser policy is always written here, never passed through: the
  // zone's Browser Cache TTL rewrites every subrequest's Cache-Control (even
  // the origin's `private, no-store`) to four hours before this worker can
  // read it, and only a header the worker sets survives.
  out.headers.set("Cache-Control", policy);
  // Lets the app time a frame's load (cache hit or not) from the page around it.
  out.headers.set("Timing-Allow-Origin", "*");
  out.headers.delete(STORED_AT);
  if (state) out.headers.set("X-Edge-Cache", state);
  return out;
}

export default {
  async fetch(request, _env, ctx) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const reqUrl = new URL(request.url);
    const { search } = reqUrl;
    let originUrl;
    let live = false;
    let gated = false;
    let pinned = false;
    if (RUNTIME_RE.test(reqUrl.pathname)) {
      originUrl = `${ORIGIN}${reqUrl.pathname}`;
    } else {
      const rest = reqUrl.pathname.replace(/^\/cli\/a\//, "").replace(/^\//, "");
      const [slug, ...tailParts] = rest.split("/");
      if (!SLUG_RE.test(slug)) {
        return new Response("Invalid artifact link", { status: 404 });
      }
      const tail = tailParts.join("/");
      if (tail.length > 600 || tail.includes("..")) {
        return new Response("Invalid artifact path", { status: 404 });
      }
      const has = (p) => reqUrl.searchParams.has(p);
      gated = GATE_PARAMS.some(has);
      pinned = /^v\d+$/.test(reqUrl.searchParams.get("r") ?? "");
      live = reqUrl.searchParams.get("meta") === "1" || tail === "_data" || tail.startsWith("_data/") || LIVE_PARAMS.some(has);
      // Preserve the exact path shape: bare slug, trailing slash (bundle docs),
      // or a nested asset path.
      const tailPath = tail ? `/${tail}` : rest.endsWith("/") ? "/" : "";
      originUrl = `${ORIGIN}/cli/a/${slug}${tailPath}${search}`;
    }

    // A page behind a gate is never held here, but the browser that holds its
    // token may keep it as long as an open page: same bound, private scope.
    // Reopening a gated decision report then costs no request at all.
    if (gated && !live && request.method === "GET") {
      const res = await fromOrigin(originUrl);
      return answer(res, STORED_STATUSES.has(res.status) ? browserPolicy(0, "private", pinned) : UNCACHED_POLICY);
    }
    const cache = request.method === "GET" && !gated && !live ? globalThis.caches?.default : undefined;
    if (!cache) return answer(await fromOrigin(originUrl), UNCACHED_POLICY);

    // Keyed by the origin's address, so both path shapes share one entry, but
    // under this host: fetch and the Cache API share one store, and a copy
    // filed under originUrl itself would answer the refresh's own fetch, so a
    // page with steady traffic re-stored its first copy forever.
    const heldUrl = `${reqUrl.origin}/__held${originUrl.slice(ORIGIN.length)}`;
    const key = new Request(heldUrl, { headers: request.headers });
    const refresh = async () => {
      const res = await fromOrigin(originUrl);
      if (!STORED_STATUSES.has(res.status)) return { res, held: false };
      const copy = new Response(res.clone().body, res);
      copy.headers.set(STORED_AT, String(Date.now()));
      copy.headers.set("Cache-Control", `public, max-age=${FRESH + STALE}`);
      await cache.put(heldUrl, copy).catch(() => {});
      return { res, held: true };
    };

    const held = await cache.match(key);
    const age = held ? (Date.now() - Number(held.headers.get(STORED_AT))) / 1000 : Infinity;
    // A pinned copy shows one version for good: held for the whole bound, never refreshed behind a reader.
    if (held && age < (pinned ? FRESH + STALE : FRESH)) return answer(held, browserPolicy(age, "public", pinned), "HIT");
    if (held && age < FRESH + STALE) {
      const work = refresh().catch(() => {});
      if (ctx) ctx.waitUntil(work);
      return answer(held, browserPolicy(age), "STALE");
    }
    const fresh = await refresh();
    return answer(fresh.res, fresh.held ? browserPolicy(0, "public", pinned) : "no-store", "MISS");
  },
};
