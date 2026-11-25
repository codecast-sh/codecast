// Where a browser fetches a published page and the scripts it runs. The
// Convex origin serves both (/cli/a/<slug>, /cli/player.js ...), and the
// production origin has a Cloudflare cache in front of it
// (infra/artifact-edge) that answers the same paths. An HTTP action at the
// origin waits in the backend's queue before it runs, so anything a viewer
// loads goes through the edge wherever one exists.
const PAGE_EDGE: Record<string, string> = {
  "https://convex.codecast.sh": "https://a.codecast.sh",
};

/** The host that serves `origin`'s published pages to a browser: its edge
 *  cache when it has one, else the origin itself (dev, self-hosted). */
export function pageServingOrigin(origin: string): string {
  const base = origin.replace(/\/$/, "");
  return PAGE_EDGE[base] ?? base;
}

/** The address an app embed frames a published page at. The theme at mount
 *  rides it so the first paint matches; embed=1 says the window around it
 *  carries its chrome; `keys` ("&k=..&e=..") passes the gates of a page the
 *  reader may open; `version` pins it to one version (r=vN), which the edge
 *  and the browser keep for the whole revocation bound, since a newer version
 *  is a new address; `appHost` marks the phone app's WebView as the page's
 *  host (PAGE_APP_HOST_PARAM). One builder, so a frame the app preloads and a copy the
 *  CLI warms after publishing are the address the embed asks for. */
export function pageEmbedUrl(origin: string, slug: string, theme: string, keys = "", version?: number, appHost = false): string {
  return `${pageServingOrigin(origin)}/cli/a/${slug}?theme=${theme}&embed=1${keys}${version ? `&r=v${version}` : ""}${appHost ? `&${PAGE_APP_HOST_PARAM}` : ""}`;
}

/** The query a codecast app's WebView adds to a page's address (`appHost`
 *  above): the app is the page's host, carrying its chrome and theme, as an
 *  iframe embedder does, though the page is the WebView's top window. */
export const PAGE_APP_HOST_PARAM = "host=app";

/** The page scripts' test for "a codecast window hosts me" (inline JS, an
 *  expression): framed by an app embed, or loaded by the phone app's WebView.
 *  A cross-origin parent counts as framed. */
export const PAGE_HOSTED_JS = `(function(){try{return window.self!==window.top||/[?&]${PAGE_APP_HOST_PARAM}(&|$)/.test(location.search);}catch(e){return true;}})()`;

/** The user agent token an installed app's host appends to its own
 *  (docs/architecture/installed-apps.md, "Serving pages to installed hosts"):
 *  ` CodecastApp/<desktop version> (<slug>)` at the very end. Electron sets it
 *  on the app's partition, the macOS shim on its WKWebView. The edge worker
 *  (infra/artifact-edge/worker.js) keeps its own copy of this pattern. */
export const PAGE_HOST_UA_RE = / CodecastApp\/([0-9A-Za-z.+-]{1,32}) \(([A-Za-z0-9]{1,64})\)$/;

/** The user agent suffix a host for `slug` sends, for the hosts and tests. */
export function pageHostUserAgentSuffix(version: string, slug: string): string {
  return ` CodecastApp/${version} (${slug})`;
}

/** Whether `userAgent` is an installed app hosting `slug` itself: the suffix
 *  is there and names this page. Any other user agent is a browser. */
export function isPageHost(userAgent: string | null | undefined, slug: string): boolean {
  const m = userAgent ? PAGE_HOST_UA_RE.exec(userAgent) : null;
  return !!m && m[2] === slug;
}
