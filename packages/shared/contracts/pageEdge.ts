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
