import { pageServingOrigin } from "@codecast/shared/contracts";
import { CONVEX_URL } from "./convexUrl";

// The three URLs a published page (`cast publish`) has, in one place so the
// embed, the option pages, the task evidence and the artifact card agree.

// The serving host frames the page: it arrives under its own sandbox CSP,
// so an iframe or a stage pane needs no second sanitizer and the share
// page's chrome does not wrap it twice. In production that host is the edge
// cache, so a frame does not wait on the origin.
export function pageFrameSrc(slug: string): string {
  return `${pageServingOrigin(CONVEX_URL)}/cli/a/${slug}`;
}

// The address an embed frames a page at: the theme at mount rides it so the
// first paint matches, embed=1 says the window around it carries its chrome,
// and `keys` ("&k=..&e=..") passes the gates of a page the reader may open.
// One builder, so a frame preloaded ahead of a click is the one the embed
// asks for.
export function pageEmbedSrc(slug: string, theme: string, keys = ""): string {
  return `${pageFrameSrc(slug)}?theme=${theme}&embed=1${keys}`;
}

// The page's live state (version, comments, its agent), read from the origin:
// it is never cached, and the app's connect-src names only the origin.
export function pageMetaUrl(slug: string): string {
  return `${CONVEX_URL}/cli/a/${slug}?meta=1`;
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
