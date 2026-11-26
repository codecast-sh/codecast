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
 *  is a new address. One builder, so a frame the app preloads and a copy the
 *  CLI warms after publishing are the address the embed asks for. */
export function pageEmbedUrl(origin: string, slug: string, theme: string, keys = "", version?: number): string {
  return `${pageServingOrigin(origin)}/cli/a/${slug}?theme=${theme}&embed=1${keys}${version ? `&r=v${version}` : ""}`;
}
