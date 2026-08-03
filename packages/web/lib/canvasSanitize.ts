import createDOMPurify from "dompurify";

// Sanitization policy for cast-canvas content (and all-HTML message bodies).
// Conversations sync across a team, so canvases are untrusted. Two invariants:
//   1. No script execution — DOMPurify strips scripts and event handlers.
//   2. No network egress — a canvas viewed by a teammate must not phone home.
//      Remote images and CSS url() fetches would leak viewer IP + timing, so
//      only data: URIs and same-document (#id) references survive.
// Rendering happens in a Shadow DOM (see HtmlSnippet.tsx for why shadow +
// sanitize beats an iframe).

const PURIFY_CONFIG = {
  // DOMPurify keeps these by default; we don't want embeds, forms, external
  // stylesheets, or <base>/<meta> rewrites in untrusted content.
  FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "form", "meta", "link"],
  FORBID_ATTR: ["ping", "formaction", "srcset"],
  // <use> is off DOMPurify's default allowlist because it can pull content from
  // external URLs. Same-document references (href="#id") are how SVG deduplicates
  // repeated geometry — the hook below rejects everything else.
  ADD_TAGS: ["use"],
  ADD_ATTR: ["target"],
};

// Neutralize CSS fetches: url(...) that isn't data: or #fragment, and @import
// (which also accepts a bare string, no url() needed).
const CSS_URL = /url\(\s*(['"]?)(?!\s*['"]?\s*(?:data:|#))[^)]*\)/gi;
const CSS_IMPORT = /@import\b[^;}]*[;}]?/gi;
function stripCssEgress(css: string): string {
  return css.replace(CSS_IMPORT, "").replace(CSS_URL, "none");
}

// Presentation attributes that take url(#id) syntax (mask, filter, clip-path,
// fill/stroke with paint servers) go through the same CSS scrubber as style —
// local fragments survive, remote fetches become "none".
const URL_ATTRS = ["mask", "filter", "clip-path", "fill", "stroke"];

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
    if (tag === "a" && el.getAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    // Only embedded (data:) images — a remote src is a tracking pixel.
    if (tag === "img") {
      const src = el.getAttribute("src") ?? "";
      if (!src.startsWith("data:")) el.remove();
    }
    // SVG's reference-taking elements may only point into the current document
    // (<use href="#id">) or embed their bits (<image href="data:...">).
    if (tag === "use") {
      const href = el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
      if (!href.startsWith("#")) el.remove();
    }
    if (tag === "image") {
      const href = el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
      if (!href.startsWith("data:")) el.remove();
    }
    for (const attr of URL_ATTRS) {
      const v = el.getAttribute(attr);
      if (v && /url\s*\(/i.test(v)) el.setAttribute(attr, stripCssEgress(v));
    }
    const style = el.getAttribute("style");
    if (style && /url\s*\(|@import/i.test(style)) {
      el.setAttribute("style", stripCssEgress(style));
    }
  });
  purify.addHook("afterSanitizeElements", (node) => {
    const el = node as Element;
    if (el.tagName?.toLowerCase() === "style" && el.textContent) {
      const clean = stripCssEgress(el.textContent);
      if (clean !== el.textContent) el.textContent = clean;
    }
  });
  return purify;
}

export function sanitizeCanvasHtml(code: string): string {
  return getPurify().sanitize(code, PURIFY_CONFIG);
}
