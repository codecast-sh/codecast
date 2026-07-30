// Server-rendered viewer for published HTML artifacts (codecast.sh/a/<slug>).
//
// Deliberately NOT a SPA route: the artifact itself is a static file served by
// a Convex HTTP action, and wrapping it in the React app meant downloading the
// whole bundle + opening a websocket + a loader splash just to render an iframe
// and a share pill. This renders the entire wrapper server-side — one meta
// query, one tiny HTML response, zero client dependencies — so the share link
// loads as fast as the raw file. Used by BOTH the production Hono server
// (server/index.ts) and the vite dev server (middleware in vite.config.ts), so
// there is exactly one implementation of the page.
//
// The page carries its own og tags (bot-meta.ts does not handle /a/).

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const CONVEX_URL = process.env.VITE_CONVEX_URL || "https://convex.codecast.sh";
const BASE_URL = "https://codecast.sh";

// Slugs are 12-char base62 today; the range tolerates future length changes
// without letting arbitrary paths through.
export const ARTIFACT_SLUG_RE = /^[A-Za-z0-9]{6,32}$/;

let client: ConvexHttpClient | null = null;
function convex(): ConvexHttpClient {
  return (client ??= new ConvexHttpClient(CONVEX_URL));
}

// Micro-cache for the meta query: it is the whole cost of the page (the HTML
// itself is string assembly), and a shared link getting passed around a team
// hits the same slug repeatedly. 30s staleness is invisible next to the
// "updated Xh ago" granularity; misses (null) are cached briefly so a bad link
// can't turn into a query hammer.
type ArtifactMeta = { title: string; updated_at: number; user?: { name?: string } | null };
const META_TTL_MS = 30_000;
const MISS_TTL_MS = 5_000;
const metaCache = new Map<string, { at: number; meta: ArtifactMeta | null }>();

async function getMeta(slug: string): Promise<ArtifactMeta | null> {
  const hit = metaCache.get(slug);
  if (hit && Date.now() - hit.at < (hit.meta ? META_TTL_MS : MISS_TTL_MS)) return hit.meta;
  const meta = (await convex().query(anyApi.artifacts.getShared, { slug })) as ArtifactMeta | null;
  metaCache.set(slug, { at: Date.now(), meta });
  return meta;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// The codecast mark (components/Logo.tsx paths, original 1024 canvas). The C
// follows --logo-c so the pill can theme it; the coral arrow is theme-stable.
const LOGO_C_PATH =
  "M484.642334,414.398438 C441.085785,414.100739 407.961426,431.836365 389.038177,470.938019 C359.991791,530.957275 397.919464,599.922302 462.212036,610.452393 C488.377197,614.737732 512.859131,609.315125 534.993835,594.283020 C536.985901,592.930176 538.769653,590.998291 541.395325,590.790649 C542.830750,592.057068 542.358704,593.648865 542.360229,595.064209 C542.383118,615.894470 542.245728,636.725830 542.454224,657.553894 C542.495239,661.645569 540.944946,663.478516 537.347595,664.804260 C457.310547,694.300720 365.884827,658.371399 330.527679,577.853210 C318.822357,551.196838 314.364532,523.336731 317.783875,494.457825 C326.474518,421.058838 381.311096,368.253448 444.614929,354.822266 C476.047852,348.153107 507.120667,349.994629 537.405273,361.541992 C541.135986,362.964569 542.456543,364.823730 542.420715,368.821503 C542.237122,389.316772 542.366028,409.814758 542.335571,430.311707 C542.333191,431.888306 542.886780,433.635895 541.039673,435.579559 C524.470764,423.311615 505.857056,415.935822 484.642334,414.398438z";
const LOGO_ARROW_PATH =
  "M595.160889,540.159180 C602.995361,532.661072 610.436890,525.255066 618.219727,518.227051 C621.594788,515.179443 621.862915,513.288818 618.369263,510.015167 C605.976135,498.402374 593.950073,486.398682 581.638672,474.697052 C578.746277,471.947968 577.631470,469.026062 577.653381,465.050171 C577.786804,440.902161 577.692810,416.752869 577.674988,392.604004 C577.673828,390.969238 577.674927,389.334503 577.674927,387.822937 C580.475952,386.927032 581.524963,388.753571 582.754211,389.949341 C611.163818,417.584045 639.573853,445.218567 667.919434,472.919006 C680.901062,485.605255 693.661133,498.519287 706.712463,511.132599 C709.948914,514.260376 709.647461,516.128052 706.514099,519.115662 C674.820679,549.334167 643.279907,579.712769 611.649353,609.997375 C601.908936,619.323242 592.027832,628.502197 582.202148,637.738831 C581.252808,638.631287 580.419067,639.758240 578.788452,639.713379 C577.032288,638.391235 577.739929,636.409241 577.736206,634.708374 C577.682861,610.393066 577.748169,586.077332 577.625610,561.762512 C577.608215,558.319458 578.534119,555.799866 581.153076,553.487549 C585.892944,549.302612 590.338135,544.783875 595.160889,540.159180z";

const LOGO_SVG = `<svg width="15" height="15" viewBox="290 340 440 340" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="var(--logo-c)" d="${LOGO_C_PATH}"/><path fill="#e86c5d" d="${LOGO_ARROW_PATH}"/></svg>`;

// Same look in both schemes as the app's chrome: light pill on light content,
// solarized-dark pill in dark scheme. ui-monospace matches the app's mono
// identity without a webfont download.
const PAGE_CSS = `
  html, body { margin: 0; height: 100%; }
  iframe { display: block; width: 100%; height: 100dvh; border: 0; }
  #pill {
    --logo-c: #444444;
    position: fixed; bottom: 12px; right: 12px; z-index: 10;
    display: flex; align-items: center; gap: 8px;
    padding: 6px 12px; border-radius: 999px;
    font: 500 12px/1 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    background: rgba(255, 255, 255, 0.92);
    color: #52524e;
    border: 1px solid rgba(0, 0, 0, 0.1);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    opacity: 1; transition: opacity 0.35s ease;
  }
  #pill.idle { opacity: 0.35; }
  #pill:hover, #pill:focus-within { opacity: 1; }
  #pill a.brand {
    display: flex; align-items: center; gap: 6px;
    color: inherit; text-decoration: none; font-weight: 600;
  }
  #pill a.brand:hover { color: #1a1a18; }
  #pill .sep { width: 1px; height: 14px; background: rgba(0, 0, 0, 0.12); }
  #pill .when { color: #98928a; font-weight: 400; white-space: nowrap; }
  #pill button {
    all: unset; cursor: pointer; padding: 3px 6px; border-radius: 6px;
    font: inherit; color: inherit; white-space: nowrap;
  }
  #pill button:hover { background: rgba(0, 0, 0, 0.06); color: #1a1a18; }
  @media (prefers-color-scheme: dark) {
    #pill {
      --logo-c: #93a1a1;
      background: rgba(0, 33, 43, 0.92);
      color: #93a1a1;
      border-color: rgba(255, 255, 255, 0.1);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
    #pill a.brand:hover { color: #eee8d5; }
    #pill .sep { background: rgba(255, 255, 255, 0.14); }
    #pill .when { color: #657b83; }
    #pill button:hover { background: rgba(255, 255, 255, 0.08); color: #eee8d5; }
  }
`;

// Copy-or-share + live "updated Xm ago" + idle fade. Inline and dependency-free
// so the page stays a single response.
const PAGE_JS = `
  (function () {
    var pill = document.getElementById("pill");
    var btn = document.getElementById("share-btn");
    var when = document.getElementById("when");

    var touch = matchMedia("(pointer: coarse)").matches;
    var canShare = touch && !!navigator.share;
    if (canShare) btn.textContent = "Share";
    btn.addEventListener("click", function () {
      if (canShare) {
        navigator.share({ title: document.title, url: location.href }).catch(function () {});
        return;
      }
      navigator.clipboard.writeText(location.href).then(function () {
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = "Copy link"; }, 1600);
      });
    });

    function rel(ts) {
      var s = Math.max(0, (Date.now() - ts) / 1000);
      if (s < 60) return "just now";
      if (s < 3600) return Math.floor(s / 60) + "m ago";
      if (s < 86400) return Math.floor(s / 3600) + "h ago";
      if (s < 30 * 86400) return Math.floor(s / 86400) + "d ago";
      return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    }
    var ts = Number(when.dataset.ts);
    function tick() { when.textContent = "updated " + rel(ts); }
    tick();
    setInterval(tick, 60000);

    var fade;
    function rest() { fade = setTimeout(function () { pill.classList.add("idle"); }, 2500); }
    pill.addEventListener("pointerenter", function () { clearTimeout(fade); pill.classList.remove("idle"); });
    pill.addEventListener("pointerleave", rest);
    rest();
  })();
`;

function notFoundHtml(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Invalid link · codecast</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; align-items: center; justify-content: center;
    font: 14px/1.6 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    background: #fdf6e3; color: #657b83; }
  main { text-align: center; max-width: 26rem; padding: 0 1.5rem; }
  h1 { font-size: 17px; color: #586e75; margin: 0 0 8px; }
  p { margin: 0 0 20px; }
  a { color: #268bd2; text-decoration: none; }
  @media (prefers-color-scheme: dark) {
    body { background: #002b36; color: #657b83; }
    h1 { color: #93a1a1; }
  }
</style>
</head><body><main>
<h1>Invalid link</h1>
<p>This artifact link is invalid or the artifact has been unpublished.</p>
<a href="${BASE_URL}">codecast.sh</a>
</main></body></html>`;
}

export async function renderArtifactPage(slug: string): Promise<{ status: number; html: string }> {
  if (!ARTIFACT_SLUG_RE.test(slug)) return { status: 404, html: notFoundHtml() };

  let meta: ArtifactMeta | null = null;
  try {
    meta = await getMeta(slug);
  } catch {
    return { status: 502, html: notFoundHtml() };
  }
  if (!meta) return { status: 404, html: notFoundHtml() };

  const title = esc(meta.title);
  const author = meta.user?.name ? ` by ${esc(meta.user.name)}` : "";
  const updatedDate = new Date(meta.updated_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const pageUrl = `${BASE_URL}/a/${slug}`;
  // Raw document served by the Convex HTTP action; /cli/ because that's the
  // prefix the Caddy proxy forwards to HTTP actions (see convex/http.ts).
  const rawUrl = `${CONVEX_URL}/cli/a/${slug}`;

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · codecast</title>
<meta name="description" content="An HTML artifact published${author} with codecast">
<meta property="og:title" content="${title}">
<meta property="og:description" content="An HTML artifact published${author} with codecast · updated ${esc(updatedDate)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:site_name" content="codecast">
<meta property="og:type" content="article">
<meta property="og:image" content="${BASE_URL}/logo-final.png">
<meta name="twitter:card" content="summary">
<link rel="icon" href="${BASE_URL}/favicon.ico">
<style>${PAGE_CSS}</style>
</head><body>
<iframe src="${esc(rawUrl)}" title="${title}" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock"></iframe>
<div id="pill" title="${title}">
  <a class="brand" href="${BASE_URL}" target="_blank" rel="noopener noreferrer">${LOGO_SVG}<span>codecast</span></a>
  <span class="sep"></span>
  <span class="when" id="when" data-ts="${meta.updated_at}">updated ${esc(updatedDate)}</span>
  <span class="sep"></span>
  <button id="share-btn" type="button">Copy link</button>
</div>
<script>${PAGE_JS}</script>
</body></html>`;

  return { status: 200, html };
}
