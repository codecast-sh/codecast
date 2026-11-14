import { pageEmbedUrl, pageServingOrigin } from "@codecast/shared/contracts";
import { CONVEX_URL } from "./convexUrl";
import { DOCS_SHOTS, DOCS_SHOTS_PAGES_ORIGIN } from "./docsShots/flag";

// The three URLs a published page (`cast publish`) has, in one place so the
// embed, the option pages, the task evidence and the artifact card agree.

// The origin that serves pages: the deployment, or the docs shots mode's
// fixture origin, so the docs images frame fixture pages and never prod.
const PAGES_ORIGIN = DOCS_SHOTS ? DOCS_SHOTS_PAGES_ORIGIN : CONVEX_URL;

// The serving host frames the page: it arrives under its own sandbox CSP,
// so an iframe or a stage pane needs no second sanitizer and the share
// page's chrome does not wrap it twice. In production that host is the edge
// cache, so a frame does not wait on the origin.
export function pageFrameSrc(slug: string): string {
  return `${pageServingOrigin(PAGES_ORIGIN)}/cli/a/${slug}`;
}

// The address an embed frames a page at (shared contracts pageEmbedUrl).
export function pageEmbedSrc(slug: string, theme: string, keys = "", version?: number): string {
  return pageEmbedUrl(PAGES_ORIGIN, slug, theme, keys, version);
}

// The page's live state (version, comments, its agent), read from the origin:
// it is never cached, and the app's connect-src names only the origin.
export function pageMetaUrl(slug: string): string {
  return `${PAGES_ORIGIN}/cli/a/${slug}?meta=1`;
}

// The public share page: what "open in full" and "copy link" hand out.
export function pageShareUrl(slug: string): string {
  return `https://codecast.sh/a/${slug}`;
}

// The capture `cast publish` took, keyed by version so a republish busts
// the browser cache. The endpoint refuses gated pages.
export function pageThumbUrl(slug: string, version: number): string {
  return `${pageFrameSrc(slug)}?thumb=1&r=v${version}`;
}

// The page alone, without the codecast bar, view beacon or comment polling:
// what a card frames, scaled down, when there is no stored capture.
export function pagePreviewSrc(slug: string, version: number): string {
  return `${pageFrameSrc(slug)}?preview=1&r=v${version}`;
}
