// Motion pages: a published page that holds a HyperFrames composition (HTML
// whose root carries data-composition-id and one paused GSAP timeline at
// window.__timelines[id]). The server injects the HyperFrames runtime and the
// cast motion player into such a page; the CLI renders it to MP4 on request.

/** The HyperFrames release every motion page runs, the same bytes the npm
 * package ships (dist/hyperframe.runtime.iife.js), pinned by integrity so the
 * CDN can never serve a page different code. Bump all three together:
 * `curl -sL <url> | openssl dgst -sha384 -binary | base64`. */
export const HYPERFRAMES_RUNTIME = {
  version: "0.8.142",
  url: "https://cdn.jsdelivr.net/npm/@hyperframes/core@0.8.142/dist/hyperframe.runtime.iife.js",
  integrity: "sha384-y4R6WhUur3WlMAj5CABPvXMT2BlKhvFMCeDe80CP69T/tuu3I6JjkZpyw8iM8ASy",
} as const;

/** Where `cast publish <dir> --render` leaves the MP4 and its manifest inside
 * the composition's directory, so every later publish of the directory keeps
 * offering the last render. */
export const MOTION_RENDER_DIR = "cast-render";
export const MOTION_RENDER_MP4 = `${MOTION_RENDER_DIR}/motion.mp4`;
export const MOTION_RENDER_MANIFEST = `${MOTION_RENDER_DIR}/motion.json`;

export interface MotionRenderManifest {
  mp4: string;
  rendered_at: number;
  /** sha256 over the composition's files at render time (the render dir excluded). */
  source_sha256: string;
  bytes: number;
}

/** The still a motion page shows before play, and its thumbnail captures, in
 * seconds: the root's data-poster when set, else the moment the first beat has
 * settled (its last entrance tween done), so a page never opens on a blank
 * t=0. Plain ES5 source, (root, timeline) => seconds, so the page's player and
 * the CLI's thumbnail page run the same rule. */
export const MOTION_POSTER_TIME_JS = `function (root, tl) {
  var p = parseFloat(root.getAttribute("data-poster"));
  if (isFinite(p) && p >= 0) return p;
  var first = null, kids = root.children;
  for (var k = 0; k < kids.length; k++) {
    if (!kids[k].hasAttribute("data-start")) continue;
    var s = parseFloat(kids[k].getAttribute("data-start")) || 0, d = parseFloat(kids[k].getAttribute("data-duration"));
    if (d > 0 && (!first || s < first.s)) first = { s: s, d: d };
  }
  if (!first) return 0;
  var end = first.s + first.d, settled = -1;
  var parts = tl && tl.getChildren ? tl.getChildren(false, true, true) : [];
  for (var i = 0; i < parts.length; i++) {
    var a = parts[i].startTime(), b = parts[i].endTime();
    if (a < end && b > first.s && b > settled) settled = Math.min(b, end);
  }
  if (settled < 0) settled = first.s + first.d / 2;
  return Math.max(first.s, Math.min(settled + 0.1, end - 0.05));
}`;

/** A page whose root element declares a HyperFrames composition: an element
 * with data-composition-id plus the canvas size. A sub-composition host (it has
 * data-composition-src) alone does not make a page a composition. */
export function pageIsMotion(html: string): boolean {
  for (const m of html.matchAll(/<(?!template)[a-z][\w-]*\b[^>]*\bdata-composition-id\s*=[^>]*>/gi)) {
    const tag = m[0];
    if (/\bdata-composition-src\s*=/i.test(tag)) continue;
    if (/\bdata-width\s*=/i.test(tag) && /\bdata-height\s*=/i.test(tag)) return true;
  }
  return false;
}

/** The page already loads a HyperFrames runtime itself (a preview export does). */
export function pageHasHyperframesRuntime(html: string): boolean {
  return /hyperframe[.-]runtime(\.iife)?\.js/i.test(html);
}
