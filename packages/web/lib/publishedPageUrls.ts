import { CONVEX_URL } from "./convexUrl";

// The three URLs a published page (`cast publish`) has, in one place so the
// embed, the option pages, the task evidence and the artifact card agree.

// The serving origin frames the page: it arrives under its own sandbox CSP,
// so an iframe or a stage pane needs no second sanitizer and the share
// page's chrome does not wrap it twice.
export function pageFrameSrc(slug: string): string {
  return `${CONVEX_URL}/cli/a/${slug}`;
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
