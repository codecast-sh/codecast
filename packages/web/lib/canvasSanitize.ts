import createDOMPurify from "dompurify";
import { isTrustedAbsoluteImageSrc } from "./trustedImageOrigins";
import { sanitizeCanvasCss } from "../../shared/render/canvasCss";

// Sanitization policy for cast-canvas content (and all-HTML message bodies).
// Conversations sync across a team, so canvases are untrusted. Two invariants:
//   1. No script execution — DOMPurify strips scripts and event handlers.
//   2. No third-party network egress — a canvas viewed by a teammate must not
//      phone home. Remote images and CSS url() fetches would leak viewer IP +
//      timing, so only data: URIs, same-document (#id) references, and images
//      on our own trusted origins (Convex storage — where `cast image` uploads
//      and pasted transcript images live) survive.
// Rendering happens in a Shadow DOM (see HtmlSnippet.tsx for why shadow +
// sanitize beats an iframe).

const PURIFY_CONFIG = {
  // Parse the fragment as BODY content. Without this the HTML parser hoists a
  // LEADING <style> into <head>, and DOMPurify serializes only <body> — so a
  // canvas written the natural way, "<style>…</style><div>…</div>", came back
  // with every rule silently gone while the same block placed after any element
  // survived. Styling is most of what a canvas is, so this is load-bearing.
  FORCE_BODY: true,
  // DOMPurify keeps these by default; we don't want embeds, forms, external
  // stylesheets, or <base>/<meta> rewrites in untrusted content.
  FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "form", "meta", "link"],
  FORBID_ATTR: ["ping", "formaction", "srcset", "srcdoc"],
  // <use> is off DOMPurify's default allowlist because it can pull content from
  // external URLs. Same-document references (href="#id") are how SVG deduplicates
  // repeated geometry — the hook below rejects everything else.
  ADD_TAGS: ["use"],
  ADD_ATTR: ["target"],
};

// Neutralize CSS fetches: url(...) that isn't data: or #fragment, and @import
// (which also accepts a bare string, no url() needed).
export function isSafeCanvasLink(href: unknown): href is string {
  const base = "https://codecast.invalid/";
  return typeof href === "string" && URL.canParse(href, base) && /^(https?:|mailto:|tel:)$/.test(new URL(href, base).protocol);
}

// Presentation attributes that take url(#id) syntax (mask, filter, clip-path,
// fill/stroke with paint servers) go through the same CSS scrubber as style —
// local fragments survive, remote fetches become "none".
const URL_ATTRS = ["mask", "filter", "clip-path", "fill", "stroke", "cursor", "marker", "marker-start", "marker-mid", "marker-end"];

// Bound lazily at first sanitize, not at module import: the default dompurify
// export binds to the global window at import time, which yields a dead stub if
// anything pulls this module in before a DOM exists (SSR, tests).
let purify: ReturnType<typeof createDOMPurify> | null = null;
function getPurify() {
  if (purify) return purify;
  purify = createDOMPurify(window);
  purify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    const tag = el.tagName?.toLowerCase();
    // Force links to open in a new tab without an opener, rather than hijacking
    // the codecast SPA.
    if (tag === "a") {
      const href = el.getAttribute("href") ?? el.getAttribute("xlink:href");
      el.removeAttribute("xlink:href");
      if (href && isSafeCanvasLink(href)) {
        el.setAttribute("href", href);
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      } else {
        el.removeAttribute("href");
        el.removeAttribute("target");
      }
    }
    // Embedded (data:) images or our own trusted origins — an arbitrary
    // remote src is a tracking pixel.
    if (tag === "img") {
      const src = el.getAttribute("src") ?? "";
      if (!isTrustedAbsoluteImageSrc(src)) el.remove();
    }
    // SVG's reference-taking elements may only point into the current document
    // (<use href="#id">) or carry image bits under the same policy as <img>.
    if (tag === "use") {
      const href = el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
      if (!href.startsWith("#")) el.remove();
    }
    if (tag === "image") {
      const href = el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
      if (!isTrustedAbsoluteImageSrc(href)) el.remove();
    }
    for (const attr of ["src", "poster", "background"]) {
      const value = el.getAttribute(attr);
      if (value && !isTrustedAbsoluteImageSrc(value)) el.removeAttribute(attr);
    }
    for (const attr of URL_ATTRS) {
      const v = el.getAttribute(attr);
      if (v) el.setAttribute(attr, sanitizeCanvasCss(v, "value"));
    }
    const style = el.getAttribute("style");
    if (style) {
      el.setAttribute("style", sanitizeCanvasCss(style, "declarationList"));
    }
  });
  purify.addHook("afterSanitizeElements", (node) => {
    const el = node as Element;
    if (el.tagName?.toLowerCase() === "style" && el.textContent) {
      const clean = sanitizeCanvasCss(el.textContent);
      if (clean !== el.textContent) el.textContent = clean;
    }
  });
  return purify;
}

export function sanitizeCanvasHtml(code: string): string {
  return getPurify().sanitize(code, PURIFY_CONFIG);
}

export function sanitizeCanvasElement(element: Element): void {
  getPurify().sanitize(element, { ...PURIFY_CONFIG, IN_PLACE: true });
}
