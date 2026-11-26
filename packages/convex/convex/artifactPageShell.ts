// The chrome every published-page surface shares (artifactPages.ts): the
// codecast mark, the icon builder, and the shell the standalone pages (gates,
// source, diff, editor, expired) render inside. Pure string builders.
import { escAttr, escHtml } from "./htmlEscape";

// The codecast mark (components/Logo.tsx paths, 1024 canvas). C follows
// currentColor via the bar's text color; the coral arrow is theme-stable.
const LOGO_C =
  "M484.642334,414.398438 C441.085785,414.100739 407.961426,431.836365 389.038177,470.938019 C359.991791,530.957275 397.919464,599.922302 462.212036,610.452393 C488.377197,614.737732 512.859131,609.315125 534.993835,594.283020 C536.985901,592.930176 538.769653,590.998291 541.395325,590.790649 C542.830750,592.057068 542.358704,593.648865 542.360229,595.064209 C542.383118,615.894470 542.245728,636.725830 542.454224,657.553894 C542.495239,661.645569 540.944946,663.478516 537.347595,664.804260 C457.310547,694.300720 365.884827,658.371399 330.527679,577.853210 C318.822357,551.196838 314.364532,523.336731 317.783875,494.457825 C326.474518,421.058838 381.311096,368.253448 444.614929,354.822266 C476.047852,348.153107 507.120667,349.994629 537.405273,361.541992 C541.135986,362.964569 542.456543,364.823730 542.420715,368.821503 C542.237122,389.316772 542.366028,409.814758 542.335571,430.311707 C542.333191,431.888306 542.886780,433.635895 541.039673,435.579559 C524.470764,423.311615 505.857056,415.935822 484.642334,414.398438z";
const LOGO_ARROW =
  "M595.160889,540.159180 C602.995361,532.661072 610.436890,525.255066 618.219727,518.227051 C621.594788,515.179443 621.862915,513.288818 618.369263,510.015167 C605.976135,498.402374 593.950073,486.398682 581.638672,474.697052 C578.746277,471.947968 577.631470,469.026062 577.653381,465.050171 C577.786804,440.902161 577.692810,416.752869 577.674988,392.604004 C577.673828,390.969238 577.674927,389.334503 577.674927,387.822937 C580.475952,386.927032 581.524963,388.753571 582.754211,389.949341 C611.163818,417.584045 639.573853,445.218567 667.919434,472.919006 C680.901062,485.605255 693.661133,498.519287 706.712463,511.132599 C709.948914,514.260376 709.647461,516.128052 706.514099,519.115662 C674.820679,549.334167 643.279907,579.712769 611.649353,609.997375 C601.908936,619.323242 592.027832,628.502197 582.202148,637.738831 C581.252808,638.631287 580.419067,639.758240 578.788452,639.713379 C577.032288,638.391235 577.739929,636.409241 577.736206,634.708374 C577.682861,610.393066 577.748169,586.077332 577.625610,561.762512 C577.608215,558.319458 578.534119,555.799866 581.153076,553.487549 C585.892944,549.302612 590.338135,544.783875 595.160889,540.159180z";

// Every icon we inject is built here, and its size rides in an INLINE STYLE,
// never in the width/height attributes alone. The bar and its panels live in
// the artifact's own DOM (no shadow root), so the artifact's CSS reaches them —
// and a width attribute has zero specificity, so one bare rule wins over it.
// A dashboard that ships `svg{display:block;width:100%;height:auto}` for its
// charts (a normal thing to write) blew every icon up to panel width. An inline
// style outranks any host rule short of !important, so the size holds.
// `display` and `flex` are pinned for the same reason: a host `svg{display:block}`
// would drop an icon onto its own line inside a text link.
function iconStyle(size: number): string {
  return `width:${size}px;height:${size}px;display:inline-block;vertical-align:middle;flex:none;max-width:none;min-width:0`;
}

export function iconSvg(size: number, body: string, opts?: { sw?: number; stroke?: string }): string {
  return `<svg width="${size}" height="${size}" style="${iconStyle(size)}" viewBox="0 0 24 24" fill="none" stroke="${opts?.stroke ?? "currentColor"}" stroke-width="${opts?.sw ?? 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function logoSvg(size = 22): string {
  return `<svg width="${size}" height="${size}" style="${iconStyle(size)}" viewBox="290 340 440 340" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="${LOGO_C}"/><path fill="currentColor" d="${LOGO_ARROW}"/></svg>`;
}

export function pageShell(title: string, body: string, extra = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escHtml(title)}</title>
<style>
  @import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap");
  /* Solarized tokens from the web app's globals.css; follows OS scheme. */
  :root { --ink: #002b36; --mut: #586e75; --dim: rgba(0,43,54,.45); --coral: #e86c5d; --blue: #268bd2; --bg: #fbf5e2; --card: #ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #fdf6e3; --mut: #93a1a1; --dim: rgba(253,246,227,.45); --blue: #268bd2; --bg: #002b36; --card: #08404e; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--mut);
    font: 400 14px/1.5 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    -webkit-font-smoothing: antialiased; }
  ::selection { background: rgba(232,108,93,.25); }
  .shell { max-width: 860px; margin: 0 auto;
    padding: 20px calc(16px + env(safe-area-inset-right)) calc(60px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left)); }
  .top { display: flex; align-items: center; gap: 10px; padding: 4px 0 18px; }
  .top a.brand { color: #444; display: inline-flex; }
  .top .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .75; }
  .top a.back { color: var(--blue); text-decoration: none; white-space: nowrap; padding: 6px 0; }
  .top a.back:hover { text-decoration: underline; }
  .card { background: var(--card); border-radius: 12px; box-shadow: 0 1px 6px rgba(0,0,0,.08); padding: 20px;
    animation: __rise .4s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes __rise { from { opacity: 0; transform: translateY(10px); } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
  button.primary { all: unset; cursor: pointer; background: var(--coral); color: #fff; font: inherit; font-weight: 600;
    padding: 10px 18px; border-radius: 8px; text-align: center; -webkit-tap-highlight-color: transparent;
    transition: background .12s ease, transform .06s ease; }
  button.primary:hover { background: #d85b4c; }
  button.primary:active { transform: translateY(1px); }
  button.primary:disabled { opacity: .55; cursor: default; }
  button.primary:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  button.ghost { all: unset; cursor: pointer; font: inherit; padding: 6px 12px; border-radius: 7px; color: var(--ink);
    background: rgba(0,0,0,.05); -webkit-tap-highlight-color: transparent; }
  button.ghost:hover { background: rgba(0,0,0,.1); }
  input[type=password], input[type=email], input[type=text] { font: inherit; padding: 10px 12px; border: 1px solid var(--dim);
    border-radius: 8px; width: 100%; background: var(--bg); color: var(--ink); transition: border-color .12s ease, box-shadow .12s ease; }
  input:focus { outline: none; border-color: var(--coral); box-shadow: 0 0 0 3px rgba(232,108,93,.15); }
  .err { color: #b3372a; min-height: 1.2em; }
  .glyph { width: 44px; height: 44px; border-radius: 12px; background: rgba(232,108,93,.1); display: flex;
    align-items: center; justify-content: center; margin: 0 0 14px; }
  ${extra}
</style>
</head>
<body>
<div class="shell">
${body}
</div>
<script>(function(){
  // Rewrite nav links to stay on THIS origin and carry the gate tokens
  // (k/e) and live flag: server-built links point at the canonical share
  // host, which re-runs the gates, and dropping the tokens lands an
  // unlocked viewer back on the password wall. Each link's own mode params
  // (edit=1, src=raw) are merged, not replaced, and links without a
  // fragment inherit location.hash so #o/#ed keys survive into the editor.
  var q=new URLSearchParams(location.search);
  document.querySelectorAll("a.back").forEach(function(a){
    var href=a.getAttribute("href")||"";
    if(!href||href.charAt(0)==="#")return;
    var hashAt=href.indexOf("#");
    var hash=hashAt>=0?href.slice(hashAt):(location.hash||"");
    var base=hashAt>=0?href.slice(0,hashAt):href;
    var qAt=base.indexOf("?");
    var params=new URLSearchParams(qAt>=0?base.slice(qAt+1):"");
    ["m","k","e","live","view"].forEach(function(p){var v=q.get(p);if(v)params.set(p,v);});
    var qs=params.toString();
    a.href=location.pathname+(qs?"?"+qs:"")+hash;
  });
})();</script>
</body>
</html>`;
}

export function topRow(title: string, shareUrl: string, backLabel = "← Back to page"): string {
  return `<div class="top">
  <a class="brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer">${logoSvg(22)}</a>
  <span class="t">${escHtml(title)}</span>
  <a class="back" href="${escAttr(shareUrl)}">${escHtml(backLabel)}</a>
</div>`;
}
