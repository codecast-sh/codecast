import createDOMPurify from "dompurify";

// Sanitization policy for cast-canvas content (and all-HTML message bodies).
// Conversations sync across a team, so canvases are untrusted: strip all script
// execution and anything that reaches outside the document. Rendering happens in
// a Shadow DOM (see HtmlSnippet.tsx for why shadow + sanitize beats an iframe).

const PURIFY_CONFIG = {
  // DOMPurify keeps these by default; we don't want embeds, forms, external
  // stylesheets, or <base>/<meta> rewrites in untrusted content.
  FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "form", "meta", "link"],
  FORBID_ATTR: ["ping", "formaction"],
  // <use> is off DOMPurify's default allowlist because it can pull content from
  // external URLs. Same-document references (href="#id") are how SVG deduplicates
  // repeated geometry — a hook below rejects everything else.
  ADD_TAGS: ["use"],
  ADD_ATTR: ["target"],
};

// Bound lazily at first sanitize, not at module import: the default dompurify
// export binds to the global window at import time, which yields a dead stub if
// anything pulls this module in before a DOM exists (SSR, tests).
let purify: ReturnType<typeof createDOMPurify> | null = null;
function getPurify() {
  if (purify) return purify;
  purify = createDOMPurify(window);
  purify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    // Force links to open in a new tab without an opener, rather than hijacking
    // the codecast SPA.
    if (el.tagName === "A" && el.getAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    // <use> may only reference the current document.
    if (el.tagName?.toLowerCase() === "use") {
      const href = el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
      if (!href.startsWith("#")) el.remove();
    }
  });
  return purify;
}

export function sanitizeCanvasHtml(code: string): string {
  return getPurify().sanitize(code, PURIFY_CONFIG);
}
