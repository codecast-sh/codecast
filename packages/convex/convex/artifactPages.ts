// Presentation layer for published artifacts: every HTML surface the origin
// serves — the injected bar + og meta, the access-gate interstitials, the
// source / diff / editor pages, and the markdown reading theme. Pure string
// builders, no db access; artifacts.ts owns data, http.ts owns routing.
//
// All pages are self-contained (inline CSS/JS, no external requests except to
// `apiBase`) because artifact documents are served under a sandbox CSP with an
// opaque origin. That opaque origin also means localStorage THROWS on access —
// every storage touch goes through a try/catch helper that degrades to an
// in-memory value for the life of the page. Secrets travel only in URL
// fragments (#o / #ed / #em), never query strings.

// The codecast mark (components/Logo.tsx paths, 1024 canvas). C follows
// currentColor via the bar's text color; the coral arrow is theme-stable.
const LOGO_C =
  "M484.642334,414.398438 C441.085785,414.100739 407.961426,431.836365 389.038177,470.938019 C359.991791,530.957275 397.919464,599.922302 462.212036,610.452393 C488.377197,614.737732 512.859131,609.315125 534.993835,594.283020 C536.985901,592.930176 538.769653,590.998291 541.395325,590.790649 C542.830750,592.057068 542.358704,593.648865 542.360229,595.064209 C542.383118,615.894470 542.245728,636.725830 542.454224,657.553894 C542.495239,661.645569 540.944946,663.478516 537.347595,664.804260 C457.310547,694.300720 365.884827,658.371399 330.527679,577.853210 C318.822357,551.196838 314.364532,523.336731 317.783875,494.457825 C326.474518,421.058838 381.311096,368.253448 444.614929,354.822266 C476.047852,348.153107 507.120667,349.994629 537.405273,361.541992 C541.135986,362.964569 542.456543,364.823730 542.420715,368.821503 C542.237122,389.316772 542.366028,409.814758 542.335571,430.311707 C542.333191,431.888306 542.886780,433.635895 541.039673,435.579559 C524.470764,423.311615 505.857056,415.935822 484.642334,414.398438z";
const LOGO_ARROW =
  "M595.160889,540.159180 C602.995361,532.661072 610.436890,525.255066 618.219727,518.227051 C621.594788,515.179443 621.862915,513.288818 618.369263,510.015167 C605.976135,498.402374 593.950073,486.398682 581.638672,474.697052 C578.746277,471.947968 577.631470,469.026062 577.653381,465.050171 C577.786804,440.902161 577.692810,416.752869 577.674988,392.604004 C577.673828,390.969238 577.674927,389.334503 577.674927,387.822937 C580.475952,386.927032 581.524963,388.753571 582.754211,389.949341 C611.163818,417.584045 639.573853,445.218567 667.919434,472.919006 C680.901062,485.605255 693.661133,498.519287 706.712463,511.132599 C709.948914,514.260376 709.647461,516.128052 706.514099,519.115662 C674.820679,549.334167 643.279907,579.712769 611.649353,609.997375 C601.908936,619.323242 592.027832,628.502197 582.202148,637.738831 C581.252808,638.631287 580.419067,639.758240 578.788452,639.713379 C577.032288,638.391235 577.739929,636.409241 577.736206,634.708374 C577.682861,610.393066 577.748169,586.077332 577.625610,561.762512 C577.608215,558.319458 578.534119,555.799866 581.153076,553.487549 C585.892944,549.302612 590.338135,544.783875 595.160889,540.159180z";

export function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function logoSvg(size = 22): string {
  return `<svg width="${size}" height="${size}" viewBox="290 340 440 340" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="${LOGO_C}"/><path fill="#e86c5d" d="${LOGO_ARROW}"/></svg>`;
}

export interface BrandOpts {
  title: string;
  author?: string | null;
  updatedAt: number;
  shareUrl: string;
  // Version of the document being served vs the artifact's current version.
  version?: number;
  currentVersion?: number;
  // Absolute URL of the ?meta=1 JSON; absent disables version chip, history,
  // polling, comments, and manage (plain legacy bar).
  metaUrl?: string;
  // Absolute origin base for API calls, e.g. https://convex.codecast.sh
  apiBase?: string;
  slug?: string;
  kind?: string;
  sessionShortId?: string | null;
  views?: number;
  commentCount?: number;
  gated?: { password: boolean; email: boolean };
  editMode?: string;
  live?: boolean;
  hasThumb?: boolean;
}

// ---------------------------------------------------------------------------
// The injected bar. Everything is id-prefixed __cc_ and styles are scoped to
// those ids so the bar can't collide with the artifact's own markup. Pinned to
// the viewport top; the html margin reserves its height (never an overlay).
//
// Panels (history / menu / comments / manage) are anchored dropdowns on
// desktop and become drag-handle bottom sheets under 640px. The comments
// panel collects MULTIPLE draft comments (pinned by tapping the page, or
// anchored to a text selection) and sends them as ONE batch.
// ---------------------------------------------------------------------------
function barHtml(o: BrandOpts): string {
  const when = new Date(o.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const version = o.version ?? 1;
  const currentVersion = o.currentVersion ?? version;
  const viewingOld = version < currentVersion;
  const interactive = !!o.metaUrl;
  const verChip = interactive
    ? `<button id="__cc_ver" type="button" title="Version history"${viewingOld ? ' class="__cc_old"' : ""}>v${version}${viewingOld ? " (old)" : ""} ▾</button>`
    : "";
  const latestLink = viewingOld ? `<a id="__cc_latest" href="#">Latest ↗</a>` : "";
  const sessionLink = o.sessionShortId
    ? `<a class="__cc_sess" href="https://codecast.sh/conversation/${escAttr(o.sessionShortId)}" target="_blank" rel="noopener noreferrer" title="Open the session that published this">by ${escAttr(o.sessionShortId)}</a>`
    : "";
  const commentsBtn = interactive
    ? `<button id="__cc_cbtn" type="button" title="Comment on this page">✎ <span id="__cc_ccount">${o.commentCount || ""}</span></button>`
    : "";
  const menuBtn = interactive ? `<button id="__cc_menu" type="button" title="More">⋯</button>` : "";
  const cfg = {
    metaUrl: o.metaUrl ?? "",
    apiBase: o.apiBase ?? "",
    slug: o.slug ?? "",
    version,
    currentVersion,
    kind: o.kind ?? "html",
    views: o.views ?? 0,
    comments: o.commentCount ?? 0,
    live: !!o.live,
    editMode: o.editMode ?? "owner",
    gated: o.gated ?? { password: false, email: false },
  };
  return `
<style id="__cc_style">
  /* Pinned to the viewport top; the html margin reserves exactly the bar's
     height so the artifact's content starts below it — pinned, not overlaying. */
  html { margin-top: 36px !important; }
  #__cc_bar { position: fixed; top: 0; left: 0; right: 0; height: 36px; z-index: 2147483647;
    display: flex; align-items: center; gap: 8px;
    box-sizing: border-box;
    padding: 0 calc(14px + env(safe-area-inset-right)) 0 calc(14px + env(safe-area-inset-left));
    font: 500 12px/1 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    background: #ffffff; color: #52524e; box-shadow: 0 1px 6px rgba(0,0,0,.08);
    text-align: left; }
  #__cc_bar .__cc_brand { color: #444444; text-decoration: none; display: inline-flex; align-items: center; }
  #__cc_bar .__cc_brand:hover { color: #1a1a18; }
  #__cc_bar .__cc_title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; opacity: .7; }
  #__cc_bar .__cc_sess { color: #1a63c4; text-decoration: none; white-space: nowrap; font-weight: 400; opacity: .8; }
  #__cc_bar .__cc_sess:hover { opacity: 1; }
  #__cc_bar .__cc_when { opacity: .5; font-weight: 400; white-space: nowrap; }
  #__cc_bar button { all: unset; cursor: pointer; padding: 4px 8px; border-radius: 6px; font: inherit; white-space: nowrap;
    -webkit-tap-highlight-color: transparent; }
  #__cc_bar button:hover { background: rgba(0,0,0,.06); }
  #__cc_bar button[hidden] { display: none; }
  #__cc_bar #__cc_ver.__cc_old { color: #b3661f; }
  #__cc_bar #__cc_new { background: #e86c5d; color: #ffffff; font-weight: 600; margin-left: 2px; }
  #__cc_bar #__cc_new:hover { background: #d85b4c; }
  #__cc_bar #__cc_latest { color: #1a63c4; text-decoration: none; padding: 4px 8px; border-radius: 6px; white-space: nowrap; }
  #__cc_bar #__cc_latest:hover { background: rgba(0,0,0,.06); }
  #__cc_bar #__cc_ccount { background: rgba(232,108,93,.14); color: #c2543f; border-radius: 999px; padding: 1px 6px; font-size: 10px; font-weight: 600; }
  #__cc_bar #__cc_ccount:empty { display: none; }
  .__cc_panel { position: fixed; top: 38px; right: 10px; z-index: 2147483647; min-width: 264px; max-width: min(92vw, 400px);
    max-height: 72vh; overflow-y: auto; overscroll-behavior: contain;
    background: #ffffff; color: #52524e; border-radius: 10px;
    box-shadow: 0 6px 24px rgba(0,0,0,.16), 0 0 0 1px rgba(0,0,0,.04);
    font: 400 12px/1.45 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace; padding: 8px; text-align: left;
    opacity: 0; transform: translateY(-4px); transition: opacity .16s ease, transform .16s ease; }
  .__cc_panel.__cc_in { opacity: 1; transform: none; }
  .__cc_panel[hidden] { display: none; }
  .__cc_panel a { color: inherit; text-decoration: none; }
  .__cc_panel .__cc_row { display: flex; justify-content: space-between; gap: 14px; align-items: baseline; padding: 6px 8px; border-radius: 6px; }
  .__cc_panel .__cc_row:hover { background: rgba(0,0,0,.06); }
  .__cc_panel .__cc_vlabel { font-weight: 600; color: #1a1a18; }
  .__cc_panel a.__cc_cur .__cc_vlabel::after { content: " · current"; font-weight: 400; color: #3d8a3d; }
  .__cc_panel a.__cc_viewing { background: rgba(232,108,93,.12); }
  .__cc_panel .__cc_vwhen { opacity: .55; white-space: nowrap; }
  .__cc_panel .__cc_note { padding: 6px 8px; opacity: .55; }
  .__cc_panel .__cc_dlink { opacity: .6; margin-left: 8px; }
  .__cc_panel .__cc_dlink:hover { opacity: 1; color: #1a63c4; }
  .__cc_panel .__cc_ph { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px 8px; }
  .__cc_panel .__cc_pht { font-weight: 600; color: #1a1a18; font-size: 13px; }
  .__cc_panel .__cc_phn { opacity: .55; }
  .__cc_panel .__cc_h2 { font-weight: 600; color: #1a1a18; padding: 12px 8px 4px; font-size: 10px; text-transform: uppercase; letter-spacing: .07em; opacity: .7; }
  .__cc_panel .__cc_kv { display: flex; align-items: center; gap: 8px; padding: 5px 8px; flex-wrap: wrap; }
  .__cc_panel .__cc_k { color: #1a1a18; }
  .__cc_panel .__cc_v { opacity: .6; }
  .__cc_panel .__cc_v.__cc_on { color: #3d8a3d; opacity: 1; }
  .__cc_panel .__cc_sp { flex: 1; }
  .__cc_panel .__cc_btn { all: unset; cursor: pointer; padding: 5px 10px; border-radius: 6px; background: rgba(0,0,0,.05); color: #1a1a18;
    white-space: nowrap; -webkit-tap-highlight-color: transparent; }
  .__cc_panel .__cc_btn:hover { background: rgba(0,0,0,.1); }
  .__cc_panel .__cc_btn:disabled { opacity: .5; cursor: default; }
  .__cc_panel .__cc_btn.__cc_danger { color: #b3372a; background: rgba(179,55,42,.08); }
  .__cc_panel .__cc_btn.__cc_danger:hover { background: rgba(179,55,42,.16); }
  .__cc_panel .__cc_chips { display: flex; gap: 6px; padding: 4px 8px; flex-wrap: wrap; }
  .__cc_panel .__cc_chip2 { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px; background: rgba(0,0,0,.05); color: #1a1a18;
    -webkit-tap-highlight-color: transparent; }
  .__cc_panel .__cc_chip2:hover { background: rgba(0,0,0,.1); }
  .__cc_panel .__cc_chip2.__cc_segon { background: #1a1a18; color: #ffffff; }
  .__cc_panel .__cc_in2 { font: inherit; flex: 1; min-width: 120px; padding: 6px 9px; border: 1px solid rgba(0,0,0,.16); border-radius: 7px;
    color: #1a1a18; background: #ffffff; outline: none; box-sizing: border-box; }
  .__cc_panel .__cc_in2:focus { border-color: #e86c5d; box-shadow: 0 0 0 3px rgba(232,108,93,.15); }
  .__cc_panel .__cc_draft { margin: 6px 8px; border: 1px solid rgba(0,0,0,.1); border-radius: 8px; padding: 8px; background: #fcfbfa; }
  .__cc_panel .__cc_dtop { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .__cc_panel .__cc_dnum { width: 20px; height: 20px; border-radius: 50% 50% 50% 4px; background: #e86c5d; color: #ffffff; font-weight: 600;
    font-size: 10px; display: inline-flex; align-items: center; justify-content: center; flex: none; }
  .__cc_panel .__cc_dsnip { opacity: .55; font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .__cc_panel .__cc_x { all: unset; cursor: pointer; padding: 2px 7px; border-radius: 6px; opacity: .5; font-size: 14px; }
  .__cc_panel .__cc_x:hover { opacity: 1; background: rgba(0,0,0,.07); }
  .__cc_panel .__cc_ta { font: inherit; width: 100%; box-sizing: border-box; border: 1px solid rgba(0,0,0,.14); border-radius: 7px;
    padding: 7px 9px; color: #1a1a18; resize: vertical; min-height: 44px; outline: none; background: #ffffff; }
  .__cc_panel .__cc_ta:focus { border-color: #e86c5d; box-shadow: 0 0 0 3px rgba(232,108,93,.15); }
  .__cc_panel .__cc_addrow { display: flex; gap: 6px; padding: 6px 8px; }
  .__cc_panel .__cc_who { padding: 2px 8px 6px; display: flex; }
  .__cc_panel .__cc_send { all: unset; cursor: pointer; display: block; text-align: center; margin: 2px 8px 6px; padding: 9px 12px;
    border-radius: 8px; background: #e86c5d; color: #ffffff; font-weight: 600; -webkit-tap-highlight-color: transparent; }
  .__cc_panel .__cc_send:hover { background: #d85b4c; }
  .__cc_panel .__cc_send:disabled { opacity: .45; cursor: default; }
  .__cc_panel .__cc_cerr { color: #b3372a; padding: 0 8px 6px; }
  .__cc_panel .__cc_okwrap { text-align: center; padding: 22px 12px 26px; }
  .__cc_panel .__cc_okmark { width: 36px; height: 36px; margin: 0 auto 10px; border-radius: 50%; background: rgba(61,138,61,.12);
    color: #3d8a3d; font-size: 18px; line-height: 36px; }
  .__cc_panel .__cc_okt { font-weight: 600; color: #1a1a18; margin-bottom: 4px; }
  .__cc_panel .__cc_oks { opacity: .6; }
  .__cc_panel .__cc_cmt { margin: 4px 8px 8px; padding: 8px; border: 1px solid rgba(0,0,0,.08); border-radius: 8px; }
  .__cc_panel .__cc_cmeta { opacity: .55; margin-bottom: 2px; }
  .__cc_panel .__cc_ctext { color: #1a1a18; margin: 4px 0 8px; white-space: pre-wrap; word-break: break-word; }
  #__cc_pins { position: absolute; top: 0; left: 0; width: 100%; height: 0; overflow: visible; z-index: 2147483645; pointer-events: none; }
  #__cc_pins .__cc_pin { position: absolute; transform: translate(-50%,-100%); width: 22px; height: 22px;
    border-radius: 50% 50% 50% 4px; background: #e86c5d; color: #ffffff; font: 600 11px/22px ui-monospace, Menlo, monospace;
    text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.25); pointer-events: auto; cursor: pointer;
    animation: __cc_pop .18s ease; }
  @keyframes __cc_pop { from { transform: translate(-50%,-100%) scale(.6); opacity: 0; } }
  #__cc_hint { position: fixed; left: 50%; bottom: calc(18px + env(safe-area-inset-bottom)); transform: translateX(-50%);
    z-index: 2147483647; background: #1a1a18; color: #ffffff; padding: 11px 18px; border-radius: 999px;
    font: 500 12px/1 ui-monospace, Menlo, monospace; box-shadow: 0 6px 20px rgba(0,0,0,.3); white-space: nowrap; }
  html.__cc_pinmode, html.__cc_pinmode * { cursor: crosshair !important; }
  /* Bottom-sheet mode. The media query catches real narrow layout viewports;
     the .__cc_sheet class is the same rules applied by JS from screen.width,
     because an artifact WITHOUT a viewport meta lays out at ~980px on phones
     and the media query alone would never fire there. */
  @media (max-width: 640px) {
    #__cc_bar .__cc_when { display: none; }
    .__cc_panel { left: 0; right: 0; top: auto; bottom: 0; max-width: none; min-width: 0; max-height: 78vh;
      border-radius: 16px 16px 0 0; padding: 8px 10px calc(14px + env(safe-area-inset-bottom));
      box-shadow: 0 -8px 32px rgba(0,0,0,.2); transform: translateY(24px); }
    .__cc_panel::before { content: ""; display: block; width: 38px; height: 4px; border-radius: 2px;
      background: rgba(0,0,0,.16); margin: 2px auto 10px; }
    .__cc_panel.__cc_in { transform: none; }
    .__cc_panel .__cc_row { padding: 11px 8px; }
    .__cc_panel .__cc_kv { padding: 8px; }
    .__cc_panel .__cc_btn { padding: 8px 12px; }
    .__cc_panel .__cc_chip2 { padding: 8px 12px; }
    .__cc_panel .__cc_send { padding: 13px 12px; }
    .__cc_panel .__cc_ta { min-height: 56px; }
  }
  .__cc_panel.__cc_sheet { left: 0; right: 0; top: auto; bottom: 0; max-width: none; min-width: 0; max-height: 78vh;
    border-radius: 16px 16px 0 0; padding: 8px 10px calc(14px + env(safe-area-inset-bottom));
    box-shadow: 0 -8px 32px rgba(0,0,0,.2); transform: translateY(24px); }
  .__cc_panel.__cc_sheet::before { content: ""; display: block; width: 38px; height: 4px; border-radius: 2px;
    background: rgba(0,0,0,.16); margin: 2px auto 10px; }
  .__cc_panel.__cc_sheet.__cc_in { transform: none; }
  .__cc_panel.__cc_sheet .__cc_row { padding: 11px 8px; }
  .__cc_panel.__cc_sheet .__cc_send { padding: 13px 12px; }
  @media (max-width: 480px) {
    #__cc_bar { gap: 5px; }
    #__cc_bar .__cc_sess { display: none; }
  }
</style>
<div id="__cc_bar">
  <a class="__cc_brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer" title="Published with codecast">${logoSvg(22)}</a>
  <span class="__cc_title">${escAttr(o.title)}</span>
  ${sessionLink}
  ${latestLink}<button id="__cc_new" type="button" hidden></button>
  <span class="__cc_when" id="__cc_when" data-ts="${o.updatedAt}">updated ${escAttr(when)}</span>
  ${verChip}
  ${commentsBtn}
  <button id="__cc_copy" type="button" data-url="${escAttr(o.shareUrl)}">Copy link</button>
  ${menuBtn}
</div>
<div id="__cc_hist" class="__cc_panel" hidden></div>
<div id="__cc_menupanel" class="__cc_panel" hidden></div>
<div id="__cc_cpanel" class="__cc_panel" hidden></div>
<div id="__cc_mgr" class="__cc_panel" hidden></div>
<script>(function(){
  var CC=${JSON.stringify(cfg)};
  var frag=new URLSearchParams(location.hash.replace(/^#/,""));
  var ownerKey=frag.get("o")||"";
  var editKey=frag.get("ed")||"";
  var gateEmail=frag.get("em")||"";
  // Opaque-origin storage: localStorage throws under the sandbox CSP, so every
  // touch is guarded and falls back to page-lifetime memory.
  var mem={};
  var sGet=function(k){try{var v=localStorage.getItem(k);if(v!=null)return v;}catch(e){}return mem[k]||"";};
  var sSet=function(k,v){mem[k]=v;try{localStorage.setItem(k,v);}catch(e){}};
  var el=function(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
  var host=function(){return document.body||document.documentElement;};
  var rel=function(ts){var s=Math.max(0,(Date.now()-ts)/1e3);
    return s<60?"just now":s<3600?Math.floor(s/60)+"m ago":s<86400?Math.floor(s/3600)+"h ago":s<2592e3?Math.floor(s/86400)+"d ago":new Date(ts).toLocaleDateString();};
  var inFmt=function(ts){var s=(ts-Date.now())/1e3;
    return s<=0?"expired":s<3600?"in "+Math.ceil(s/60)+"m":s<86400?"in "+Math.ceil(s/3600)+"h":"in "+Math.ceil(s/86400)+"d";};
  var w=document.getElementById("__cc_when");
  if(w){var ts=+w.getAttribute("data-ts");var tick=function(){w.textContent="updated "+rel(ts);};tick();setInterval(tick,6e4);}
  var copyBtn=document.getElementById("__cc_copy");
  var copyText=function(u,done){
    var fallback=function(){var t=document.createElement("textarea");t.value=u;t.style.position="fixed";t.style.opacity="0";
      host().appendChild(t);t.select();try{document.execCommand("copy");done();}catch(e){window.prompt("Copy:",u);}t.remove();};
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(done,fallback);}else{fallback();}
  };
  var flashLabel=function(btn,label,back){btn.textContent=label;setTimeout(function(){btn.textContent=back;},1400);};
  if(copyBtn)copyBtn.addEventListener("click",function(){
    copyText(copyBtn.getAttribute("data-url"),function(){flashLabel(copyBtn,"Copied","Copy link");});
  });
  if(!CC.metaUrl)return;
  var api=function(path,body){return fetch(CC.apiBase+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();});};
  // View beacon — one per page load; carries the gate email when present.
  try{api("/cli/artifacts/view",{slug:CC.slug,email:gateEmail||undefined});}catch(e){}
  // Version links stay on whatever host serves this document. r is a
  // cache-buster (new URL → new cache key past the 60s edge/browser cache).
  // EVERY navigation must carry the gate tokens (k/e) and live flag forward,
  // or a reload on a gated page lands back on the password wall. This helper
  // (and the a.back rewrite in pageShell) is the single place that encodes
  // WHERE tokens live: the query string. If gated bundle assets ever move
  // tokens into the path (e.g. /_k/<tok>/ under a base href), both must
  // change in the same commit or in-page nav strands unlocked viewers.
  var keepHash=location.hash||"";
  var withQ=function(extra){var q=new URLSearchParams(location.search);var out=new URLSearchParams();
    ["k","e","live"].forEach(function(p){var val=q.get(p);if(val)out.set(p,val);});
    Object.keys(extra).forEach(function(p){out.set(p,String(extra[p]));});
    return location.pathname+"?"+out.toString()+keepHash;};
  var verUrl=function(n,current){return withQ(current?{r:n}:{v:n});};
  var reloadFresh=function(){location.href=withQ({r:Date.now()});};
  var latest=document.getElementById("__cc_latest");
  if(latest)latest.setAttribute("href",verUrl(CC.currentVersion,true));
  // --- panel machinery: dropdowns on desktop, bottom sheets on mobile ---
  var panels=["__cc_hist","__cc_menupanel","__cc_cpanel","__cc_mgr"].map(function(id){return document.getElementById(id);});
  // Sheet mode from the PHYSICAL screen, not the layout viewport: a document
  // without a viewport meta lays out at ~980px on phones, so a media query
  // alone would keep desktop dropdowns on mobile.
  if((screen.width||9999)<=680||matchMedia("(max-width: 640px)").matches){
    panels.forEach(function(p){if(p)p.classList.add("__cc_sheet");});
  }
  var closeAll=function(){panels.forEach(function(p){if(p){p.hidden=true;p.classList.remove("__cc_in");}});};
  var show=function(p){
    panels.forEach(function(q){if(q&&q!==p){q.hidden=true;q.classList.remove("__cc_in");}});
    // Forced reflow between unhide and the class add makes the entrance
    // transition reliable without rAF (which Chrome throttles in occluded
    // windows and embedded iframes — the class must land regardless).
    if(p.hidden){p.hidden=false;void p.offsetWidth;p.classList.add("__cc_in");}
  };
  document.addEventListener("click",closeAll);
  panels.forEach(function(p){if(p)p.addEventListener("click",function(e){e.stopPropagation();});});
  var fetchMeta=function(cb){fetch(CC.metaUrl,{cache:"no-store"}).then(function(r){return r.json();}).then(cb,function(){});};
  var setCount=function(){var cc=document.getElementById("__cc_ccount");if(cc)cc.textContent=CC.comments?String(CC.comments):"";};
  // --- history panel (restore appears with the owner key) ---
  var chip=document.getElementById("__cc_ver");
  var hist=document.getElementById("__cc_hist");
  if(chip&&hist){
    var render=function(m){
      hist.innerHTML="";
      (m.versions||[]).forEach(function(v){
        var a=document.createElement("a");a.className="__cc_row";
        a.href=verUrl(v.version,v.version===m.version);
        if(v.version===m.version)a.className+=" __cc_cur";
        if(v.version===CC.version)a.className+=" __cc_viewing";
        var l=document.createElement("span");l.className="__cc_vlabel";l.textContent="v"+v.version;
        if(v.edited_by){var eb=document.createElement("span");eb.style.opacity=".6";eb.style.fontWeight="400";eb.textContent=" by "+v.edited_by;l.appendChild(eb);}
        if(v.version!==m.version){
          var d=document.createElement("a");d.className="__cc_dlink";d.textContent="diff";
          d.href=withQ({diff:v.version+".."+m.version});
          d.title="What changed between v"+v.version+" and v"+m.version;
          d.addEventListener("click",function(e){e.stopPropagation();});
          l.appendChild(d);
          if(ownerKey){
            var rb=document.createElement("a");rb.className="__cc_dlink";rb.textContent="restore";rb.href="#";
            rb.title="Republish v"+v.version+" as the newest version";
            rb.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();rb.textContent="restoring…";
              api("/cli/artifacts/manage",{slug:CC.slug,owner_key:ownerKey,rollback_to:v.version}).then(function(r){
                if(r&&r.ok)reloadFresh();else rb.textContent="failed";
              },function(){rb.textContent="failed";});});
            l.appendChild(rb);
          }
        }
        var t=document.createElement("span");t.className="__cc_vwhen";t.textContent=rel(v.published_at);
        a.appendChild(l);a.appendChild(t);hist.appendChild(a);
      });
      if(!hist.childNodes.length){hist.appendChild(el("div","__cc_note","No history yet"));}
    };
    chip.addEventListener("click",function(e){
      e.stopPropagation();
      if(!hist.hidden){closeAll();return;}
      hist.innerHTML="";hist.appendChild(el("div","__cc_note","Loading…"));
      show(hist);
      fetchMeta(render);
    });
  }
  // --- comments: multiple drafts, pinned to the page, sent as ONE batch ---
  var cbtn=document.getElementById("__cc_cbtn");
  var cpanel=document.getElementById("__cc_cpanel");
  var drafts=[];
  var pinLayer=null,hint=null,pinMode=false;
  var pinsOn=function(){if(!pinLayer){pinLayer=document.createElement("div");pinLayer.id="__cc_pins";host().appendChild(pinLayer);}return pinLayer;};
  var renderPins=function(){
    if(!pinLayer&&!drafts.some(function(d){return d.px!=null;}))return;
    pinsOn().innerHTML="";
    drafts.forEach(function(d,i){
      if(d.px==null)return;
      var p=el("div","__cc_pin",String(i+1));
      p.style.left=d.px+"px";p.style.top=d.py+"px";
      p.title=d.text?d.text:"Draft comment "+(i+1);
      p.addEventListener("click",function(e){e.stopPropagation();openC(i);});
      pinLayer.appendChild(p);
    });
  };
  var exitPin=function(){pinMode=false;document.documentElement.classList.remove("__cc_pinmode");if(hint){hint.remove();hint=null;}};
  var enterPin=function(){
    closeAll();pinMode=true;document.documentElement.classList.add("__cc_pinmode");
    if(!hint){hint=el("div",null,"Tap anywhere to pin your comment — Esc cancels");hint.id="__cc_hint";host().appendChild(hint);}
  };
  document.addEventListener("keydown",function(e){if(e.key==="Escape"){exitPin();closeAll();}});
  var selPath=function(n){try{
    var parts=[],d=0;
    while(n&&n.nodeType===1&&d<4&&n!==document.body&&n!==document.documentElement){
      if(n.id){parts.unshift("#"+n.id);return parts.join(">");}
      var tag=n.tagName.toLowerCase(),ix=1,s=n;
      while((s=s.previousElementSibling))if(s.tagName===n.tagName)ix++;
      parts.unshift(tag+":nth-of-type("+ix+")");
      n=n.parentElement;d++;
    }
    return parts.join(">");
  }catch(e){return "";}};
  document.addEventListener("click",function(e){
    if(!pinMode)return;
    var t=e.target;
    if(t&&t.closest&&t.closest("#__cc_bar,.__cc_panel,#__cc_hint,#__cc_pins"))return;
    e.preventDefault();e.stopPropagation();
    var snip="";try{snip=String(window.getSelection()||"").trim();}catch(x){}
    if(!snip&&t&&t.textContent)snip=t.textContent.replace(/\\s+/g," ").trim();
    snip=snip.slice(0,120);
    var docH=Math.max(document.documentElement.scrollHeight,1);
    var a={y:Math.round(e.pageY/docH*1000)/1000};
    if(snip)a.snippet=snip;
    var sp=t?selPath(t):"";
    if(sp)a.sel=sp;
    drafts.push({text:"",anchor:a,px:e.pageX,py:e.pageY});
    exitPin();renderPins();openC(drafts.length-1);
  },true);
  var syncSend=function(){var b=document.getElementById("__cc_sendbtn");if(!b)return;
    var n=drafts.filter(function(d){return d.text.trim();}).length;
    b.disabled=!n;b.textContent=n?("Send "+n+" comment"+(n===1?"":"s")):"Send";};
  var doSend=function(name){
    var ready=drafts.filter(function(d){return d.text.trim();});
    if(!ready.length)return;
    var b=document.getElementById("__cc_sendbtn");
    var errBox=cpanel.querySelector(".__cc_cerr");
    if(b){b.disabled=true;b.textContent="Sending…";}
    sSet("__cc_name",name||"");
    api("/cli/artifacts/comment",{slug:CC.slug,author_name:(name||"").trim()||"anonymous",
      author_email:gateEmail||undefined,version:CC.version,
      comments:ready.map(function(d){var c={text:d.text.trim()};if(d.anchor)c.anchor=JSON.stringify(d.anchor);return c;})})
    .then(function(r){
      if(!r||r.error){if(errBox)errBox.textContent=(r&&r.error)||"Send failed — try again";syncSend();return;}
      drafts=[];renderPins();
      CC.comments+=ready.length;setCount();
      cpanel.innerHTML="";
      var ok=el("div","__cc_okwrap");
      ok.appendChild(el("div","__cc_okmark","✓"));
      ok.appendChild(el("div","__cc_okt","Sent "+ready.length+(ready.length===1?" comment":" comments")));
      ok.appendChild(el("div","__cc_oks",r.delivered?"Delivered to the author's session.":"Saved — the author will see them."));
      cpanel.appendChild(ok);
      setTimeout(closeAll,2400);
    },function(){if(errBox)errBox.textContent="Network error — your drafts are kept";syncSend();});
  };
  var renderC=function(focusIdx){
    cpanel.innerHTML="";
    var head=el("div","__cc_ph");
    head.appendChild(el("span","__cc_pht","Comments"));
    if(CC.comments>0)head.appendChild(el("span","__cc_phn",CC.comments+" open"));
    cpanel.appendChild(head);
    if(!drafts.length){
      cpanel.appendChild(el("div","__cc_note","Pin notes anywhere on the page (or select text first). They send together as one batch, straight to the author."));
    }
    drafts.forEach(function(d,i){
      var card=el("div","__cc_draft");card.setAttribute("data-i",String(i));
      var top=el("div","__cc_dtop");
      top.appendChild(el("span","__cc_dnum",d.px!=null?String(i+1):"•"));
      if(d.anchor&&d.anchor.snippet)top.appendChild(el("span","__cc_dsnip","\\u201C"+d.anchor.snippet.slice(0,60)+(d.anchor.snippet.length>60?"…":"")+"\\u201D"));
      top.appendChild(el("span","__cc_sp"));
      var rm=el("button","__cc_x","×");rm.type="button";rm.title="Remove this draft";
      rm.addEventListener("click",function(){drafts.splice(i,1);renderPins();renderC();});
      top.appendChild(rm);
      card.appendChild(top);
      var ta=document.createElement("textarea");ta.className="__cc_ta";ta.placeholder="Write your comment…";ta.value=d.text;ta.rows=2;
      ta.addEventListener("input",function(){d.text=ta.value;syncSend();});
      card.appendChild(ta);
      cpanel.appendChild(card);
    });
    var addrow=el("div","__cc_addrow");
    var pinB=el("button","__cc_btn","+ Pin on page");pinB.type="button";
    pinB.addEventListener("click",function(){enterPin();});
    var genB=el("button","__cc_btn","+ General note");genB.type="button";
    genB.addEventListener("click",function(){drafts.push({text:"",anchor:null,px:null,py:null});renderC(drafts.length-1);});
    addrow.appendChild(pinB);addrow.appendChild(genB);
    cpanel.appendChild(addrow);
    if(drafts.length){
      var who=el("div","__cc_who");
      var nm=document.createElement("input");nm.type="text";nm.className="__cc_in2";nm.placeholder="Your name";
      nm.value=sGet("__cc_name")||(gateEmail?gateEmail.split("@")[0]:"");
      nm.addEventListener("input",function(){sSet("__cc_name",nm.value);});
      who.appendChild(nm);cpanel.appendChild(who);
      cpanel.appendChild(el("div","__cc_cerr",""));
      var send=el("button","__cc_send","Send");send.type="button";send.id="__cc_sendbtn";
      send.addEventListener("click",function(){doSend(nm.value);});
      cpanel.appendChild(send);
    }
    syncSend();
    if(focusIdx!=null){var t=cpanel.querySelector('[data-i="'+focusIdx+'"] textarea');if(t)t.focus();}
  };
  var openC=function(focusIdx){show(cpanel);renderC(focusIdx);};
  if(cbtn&&cpanel){
    cbtn.addEventListener("click",function(e){
      e.stopPropagation();
      if(!cpanel.hidden){closeAll();return;}
      // A live text selection becomes an anchored draft immediately.
      var s="";try{s=String(window.getSelection()||"").trim();}catch(x){}
      if(s){
        var a={snippet:s.slice(0,120)};
        try{
          var r0=window.getSelection().getRangeAt(0).getBoundingClientRect();
          var docH=Math.max(document.documentElement.scrollHeight,1);
          a.y=Math.round((r0.top+r0.height/2+window.pageYOffset)/docH*1000)/1000;
          drafts.push({text:"",anchor:a,px:Math.round(r0.left+r0.width/2+window.pageXOffset),py:Math.round(r0.top+window.pageYOffset)});
        }catch(x){drafts.push({text:"",anchor:a,px:null,py:null});}
        renderPins();
        openC(drafts.length-1);
      }else{
        openC();
      }
    });
  }
  // --- manage sheet (owner key only) ---
  var mgr=document.getElementById("__cc_mgr");
  var mgrPw=false;
  var mnote=function(msg){mgr.innerHTML="";mgr.appendChild(el("div","__cc_note",msg));};
  var mreq=function(extra){
    var b={slug:CC.slug,owner_key:ownerKey},k;
    for(k in extra)b[k]=extra[k];
    api("/cli/artifacts/manage",b).then(function(j){
      if(!j||j.error){mnote((j&&j.error)||"Failed to load");return;}
      renderMgr(j);
    },function(){mnote("Network error");});
  };
  var mset=function(setObj){mreq({set:setObj});};
  var renderMgr=function(j){
    mgr.innerHTML="";
    var ac=j.access||{},st=j.stats||{};
    var head=el("div","__cc_ph");head.appendChild(el("span","__cc_pht","Manage sharing"));mgr.appendChild(head);
    var views=st.views||0;
    mgr.appendChild(el("div","__cc_note",views+" view"+(views===1?"":"s")+(st.last_viewed_at?" · last viewed "+rel(st.last_viewed_at):"")));

    mgr.appendChild(el("div","__cc_h2","Access"));
    var pw=el("div","__cc_kv");
    pw.appendChild(el("span","__cc_k","Password"));
    pw.appendChild(el("span","__cc_v"+(ac.has_password?" __cc_on":""),ac.has_password?"required":"off"));
    pw.appendChild(el("span","__cc_sp"));
    if(!mgrPw){
      var setb=el("button","__cc_btn",ac.has_password?"Change":"Set");setb.type="button";
      setb.addEventListener("click",function(){mgrPw=true;renderMgr(j);});
      pw.appendChild(setb);
      if(ac.has_password){
        var rmb=el("button","__cc_btn __cc_danger","Remove");rmb.type="button";rmb.title="Anyone with the link will be able to view";
        rmb.addEventListener("click",function(){rmb.disabled=true;mset({password:null});});
        pw.appendChild(rmb);
      }
    }
    mgr.appendChild(pw);
    if(mgrPw){
      var pr=el("div","__cc_kv");
      var pin=document.createElement("input");pin.type="text";pin.className="__cc_in2";pin.placeholder="New password";
      pin.setAttribute("autocapitalize","off");pin.setAttribute("autocomplete","off");
      var sv=el("button","__cc_btn","Save");sv.type="button";
      var commit=function(){if(pin.value){mgrPw=false;mset({password:pin.value});}};
      sv.addEventListener("click",commit);
      pin.addEventListener("keydown",function(e){if(e.key==="Enter")commit();});
      var cx=el("button","__cc_btn","Cancel");cx.type="button";
      cx.addEventListener("click",function(){mgrPw=false;renderMgr(j);});
      pr.appendChild(pin);pr.appendChild(sv);pr.appendChild(cx);
      mgr.appendChild(pr);
      pin.focus();
    }
    var eg=el("div","__cc_kv");
    eg.appendChild(el("span","__cc_k","Email gate"));
    eg.appendChild(el("span","__cc_v"+(ac.email_gate?" __cc_on":""),ac.email_gate?"on":"off"));
    eg.appendChild(el("span","__cc_sp"));
    var tg=el("button","__cc_btn"+(ac.email_gate?" __cc_danger":""),ac.email_gate?"Turn off":"Turn on");tg.type="button";
    tg.title=ac.email_gate?"Viewers will no longer have to identify themselves":"Viewers must enter their email to view";
    tg.addEventListener("click",function(){tg.disabled=true;mset({email_gate:!ac.email_gate});});
    eg.appendChild(tg);
    mgr.appendChild(eg);
    var ex=el("div","__cc_kv");
    ex.appendChild(el("span","__cc_k","Expires"));
    ex.appendChild(el("span","__cc_v",ac.expires_at?inFmt(ac.expires_at):"never"));
    mgr.appendChild(ex);
    var chips=el("div","__cc_chips");
    [["1h",3600e3],["24h",86400e3],["7d",604800e3],["30d",2592e6],["never",null]].forEach(function(p){
      var b=el("button","__cc_chip2",p[0]);b.type="button";
      b.addEventListener("click",function(){b.disabled=true;mset({expires_in_ms:p[1]});});
      chips.appendChild(b);
    });
    mgr.appendChild(chips);

    mgr.appendChild(el("div","__cc_h2","Editing"));
    var seg=el("div","__cc_chips");
    ["owner","link","team"].forEach(function(m){
      var b=el("button","__cc_chip2"+((ac.edit_mode||"owner")===m?" __cc_segon":""),m);b.type="button";
      b.addEventListener("click",function(){if((ac.edit_mode||"owner")!==m){b.disabled=true;mset({edit_mode:m});}});
      seg.appendChild(b);
    });
    mgr.appendChild(seg);
    mgr.appendChild(el("div","__cc_note",
      {owner:"Only you can publish edits.",
       link:"Anyone with the edit link can publish new versions — and read the source, password or not.",
       team:"Your teammates can publish edits — and read the source, password or not."}[ac.edit_mode||"owner"]||""));

    mgr.appendChild(el("div","__cc_h2","Links"));
    var lr=el("div","__cc_chips");
    var base=copyBtn?copyBtn.getAttribute("data-url"):location.href.split("#")[0];
    var cm=el("button","__cc_btn","Copy manage link");cm.type="button";
    cm.addEventListener("click",function(){copyText(base+"#o="+ownerKey,function(){flashLabel(cm,"Copied","Copy manage link");});});
    lr.appendChild(cm);
    if(j.edit_url){
      var ce=el("button","__cc_btn","Copy edit link");ce.type="button";
      ce.addEventListener("click",function(){copyText(j.edit_url,function(){flashLabel(ce,"Copied","Copy edit link");});});
      lr.appendChild(ce);
    }
    mgr.appendChild(lr);

    var openC2=(j.comments||[]).filter(function(c){return c.status==="open";});
    CC.comments=openC2.length;setCount();
    if(openC2.length){
      mgr.appendChild(el("div","__cc_h2","Open comments ("+openC2.length+")"));
      openC2.forEach(function(c){
        var row=el("div","__cc_cmt");
        row.appendChild(el("div","__cc_cmeta",c.author_name+(c.author_email?" <"+c.author_email+">":"")+" · v"+c.version+" · "+rel(c.created_at)));
        var an=null;try{an=c.anchor?JSON.parse(c.anchor):null;}catch(e){}
        if(an&&an.snippet)row.appendChild(el("div","__cc_dsnip","\\u201C"+String(an.snippet).slice(0,80)+"\\u201D"));
        row.appendChild(el("div","__cc_ctext",c.text));
        var rb=el("button","__cc_btn","Resolve");rb.type="button";
        rb.addEventListener("click",function(){rb.disabled=true;rb.textContent="Resolving…";mreq({resolve_comment_id:c.id});});
        row.appendChild(rb);
        mgr.appendChild(row);
      });
    }
    if((j.viewers||[]).length){
      mgr.appendChild(el("div","__cc_h2","Seen by"));
      j.viewers.forEach(function(v){
        var row=el("div","__cc_kv");
        row.appendChild(el("span","__cc_k",v.email));
        row.appendChild(el("span","__cc_sp"));
        row.appendChild(el("span","__cc_v",(v.view_count||1)+"× · first "+rel(v.first_seen)+" · last "+rel(v.last_seen)));
        mgr.appendChild(row);
      });
    }
  };
  var openManage=function(){show(mgr);mnote("Loading…");mreq({});};
  // --- overflow menu: source, views, edit, manage (owner) ---
  var menuBtn=document.getElementById("__cc_menu");
  var menu=document.getElementById("__cc_menupanel");
  if(menuBtn&&menu){
    menuBtn.addEventListener("click",function(e){
      e.stopPropagation();
      if(!menu.hidden){closeAll();return;}
      menu.innerHTML="";
      var add=function(label,fn){var a=document.createElement("a");a.className="__cc_row";a.href="#";
        var s=document.createElement("span");s.textContent=label;a.appendChild(s);
        a.addEventListener("click",function(ev){ev.preventDefault();fn();});menu.appendChild(a);return a;};
      add("View source",function(){var x={src:1};if(CC.version!==CC.currentVersion)x.v=CC.version;location.href=withQ(x);});
      if(ownerKey||editKey||CC.editMode==="link"){
        add("Edit this page",function(){location.href=withQ({edit:1});});
      }
      if(ownerKey){
        add("Manage sharing…",openManage);
      }
      if(CC.views){menu.appendChild(el("div","__cc_note",CC.views+" view"+(CC.views===1?"":"s")));}
      show(menu);
    });
  }
  // --- new-version badge / live reload (also refreshes the comment count) ---
  if(CC.version===CC.currentVersion){
    var badge=document.getElementById("__cc_new");
    var poll=function(){
      fetchMeta(function(m){
        if(!m)return;
        if(typeof m.comment_count==="number"&&m.comment_count!==CC.comments){CC.comments=m.comment_count;setCount();}
        if(m.version>CC.version){
          if(CC.live){location.href=verUrl(m.version,true);return;}
          if(badge){
            badge.textContent="v"+m.version+" published — reload";
            badge.hidden=false;
            badge.onclick=function(){location.href=verUrl(m.version,true);};
          }
        }
      });
    };
    setInterval(poll,CC.live?5e3:3e4);
  }
})();</script>`;
}

function ogMeta(o: BrandOpts): string {
  const author = o.author ? ` by ${escAttr(o.author)}` : "";
  const image =
    o.hasThumb && o.apiBase && o.slug && !(o.gated?.password || o.gated?.email)
      ? `\n<meta property="og:image" content="${escAttr(`${o.apiBase}/cli/a/${o.slug}?thumb=1`)}">\n<meta name="twitter:card" content="summary_large_image">`
      : `\n<meta name="twitter:card" content="summary">`;
  return `
<meta property="og:title" content="${escAttr(o.title)}">
<meta property="og:description" content="An HTML artifact published${author} with codecast">
<meta property="og:url" content="${escAttr(o.shareUrl)}">
<meta property="og:site_name" content="codecast">
<meta property="og:type" content="article">${image}
<meta name="robots" content="noindex">`;
}

/**
 * Inject the codecast header bar (after <body>, else prepended) and og meta
 * (after <head>, when one exists) into an artifact's HTML. The artifact's own
 * markup — including its <title> — is never modified, only added to.
 */
export function brandArtifactHtml(html: string, opts: BrandOpts): string {
  let out = html;
  const headMatch = out.match(/<head[^>]*>/i);
  if (headMatch) {
    const at = out.indexOf(headMatch[0]) + headMatch[0].length;
    out = out.slice(0, at) + ogMeta(opts) + out.slice(at);
  }
  const bar = barHtml(opts);
  const bodyMatch = out.match(/<body[^>]*>/i);
  if (bodyMatch) {
    const at = out.indexOf(bodyMatch[0]) + bodyMatch[0].length;
    return out.slice(0, at) + bar + out.slice(at);
  }
  return bar + out;
}

// ---------------------------------------------------------------------------
// Standalone pages (gates, source, diff, editor, markdown theme, expired).
// One shared shell keeps them visually coherent with the bar.
// ---------------------------------------------------------------------------

function pageShell(title: string, body: string, extra = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escHtml(title)}</title>
<style>
  :root { --ink: #1a1a18; --mut: #52524e; --dim: rgba(0,0,0,.45); --coral: #e86c5d; --blue: #1a63c4; --bg: #faf9f7; --card: #ffffff; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--mut);
    font: 400 14px/1.5 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
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
  input[type=password], input[type=email], input[type=text] { font: inherit; padding: 10px 12px; border: 1px solid rgba(0,0,0,.18);
    border-radius: 8px; width: 100%; background: #fff; color: var(--ink); transition: border-color .12s ease, box-shadow .12s ease; }
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
    ["k","e","live"].forEach(function(p){var v=q.get(p);if(v)params.set(p,v);});
    var qs=params.toString();
    a.href=location.pathname+(qs?"?"+qs:"")+hash;
  });
})();</script>
</body>
</html>`;
}

function topRow(title: string, shareUrl: string, backLabel = "← Back to page"): string {
  return `<div class="top">
  <a class="brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer">${logoSvg(22)}</a>
  <span class="t">${escHtml(title)}</span>
  <a class="back" href="${escAttr(shareUrl)}">${escHtml(backLabel)}</a>
</div>`;
}

const LOCK_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e86c5d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`;
const MAIL_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e86c5d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>`;
const CLOCK_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e86c5d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`;

export function passwordGatePage(o: { slug: string; title: string; apiBase: string; shareUrl: string }): string {
  const body = `
<div class="top"><a class="brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer">${logoSvg(22)}</a><span class="t">${escHtml(o.title)}</span></div>
<div class="card" style="max-width:420px;margin:12vh auto 0">
  <div class="glyph">${LOCK_SVG}</div>
  <h1 style="font-size:16px;color:var(--ink);margin:0 0 6px">This page is password protected</h1>
  <p style="margin:0 0 18px;opacity:.7">Enter the password to view <b>${escHtml(o.title)}</b>.</p>
  <form id="f" style="display:flex;flex-direction:column;gap:10px">
    <input type="password" id="pw" placeholder="Password" autofocus autocomplete="current-password">
    <div class="err" id="err" role="alert"></div>
    <button class="primary" id="go" type="submit">Unlock</button>
  </form>
</div>
<script>(function(){
  var f=document.getElementById("f"),pw=document.getElementById("pw"),err=document.getElementById("err"),go=document.getElementById("go");
  f.addEventListener("submit",function(e){
    e.preventDefault();err.textContent="";
    if(!pw.value)return;
    go.disabled=true;go.textContent="Unlocking…";
    var reset=function(msg){go.disabled=false;go.textContent="Unlock";err.textContent=msg;pw.select();};
    fetch(${JSON.stringify(o.apiBase)}+"/cli/artifacts/unlock",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({slug:${JSON.stringify(o.slug)},password:pw.value})})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j&&j.k){var u=new URL(location.href);u.searchParams.set("k",j.k);location.replace(u.pathname+u.search+location.hash);}
        else reset("Wrong password");
      },function(){reset("Network error — try again");});
  });
})();</script>`;
  return pageShell(o.title, body);
}

export function emailGatePage(o: { slug: string; title: string; apiBase: string; shareUrl: string }): string {
  const body = `
<div class="top"><a class="brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer">${logoSvg(22)}</a><span class="t">${escHtml(o.title)}</span></div>
<div class="card" style="max-width:420px;margin:12vh auto 0">
  <div class="glyph">${MAIL_SVG}</div>
  <h1 style="font-size:16px;color:var(--ink);margin:0 0 6px">Enter your email to view</h1>
  <p style="margin:0 0 18px;opacity:.7">The author of <b>${escHtml(o.title)}</b> asks viewers to identify themselves.</p>
  <form id="f" style="display:flex;flex-direction:column;gap:10px">
    <input type="email" id="em" placeholder="you@example.com" autofocus autocomplete="email" autocapitalize="off" autocorrect="off" inputmode="email" required>
    <div class="err" id="err" role="alert"></div>
    <button class="primary" id="go" type="submit">Continue</button>
  </form>
</div>
<script>(function(){
  var f=document.getElementById("f"),em=document.getElementById("em"),err=document.getElementById("err"),go=document.getElementById("go");
  f.addEventListener("submit",function(e){
    e.preventDefault();err.textContent="";
    var email=em.value.trim().toLowerCase();
    if(!email)return;
    go.disabled=true;go.textContent="One moment…";
    var reset=function(msg){go.disabled=false;go.textContent="Continue";err.textContent=msg;};
    fetch(${JSON.stringify(o.apiBase)}+"/cli/artifacts/email-unlock",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({slug:${JSON.stringify(o.slug)},email:email})})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j&&j.e){var u=new URL(location.href);u.searchParams.set("e",j.e);
          var h=new URLSearchParams(location.hash.replace(/^#/,""));h.set("em",email);
          location.replace(u.pathname+u.search+"#"+h.toString());}
        else reset((j&&j.error)||"Something went wrong");
      },function(){reset("Network error — try again");});
  });
})();</script>`;
  return pageShell(o.title, body);
}

export function expiredPage(o: { title: string }): string {
  const body = `
<div class="top"><a class="brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer">${logoSvg(22)}</a></div>
<div class="card" style="max-width:420px;margin:16vh auto 0;text-align:center">
  <div class="glyph" style="margin:0 auto 14px">${CLOCK_SVG}</div>
  <h1 style="font-size:16px;color:var(--ink);margin:0 0 6px">This link has expired</h1>
  <p style="margin:0;opacity:.7">The author set an expiry on <b>${escHtml(o.title)}</b> and it has passed.</p>
  <p style="margin:14px 0 0;opacity:.55">If you need access, ask the author to republish or extend the expiry.</p>
</div>`;
  return pageShell(o.title, body);
}

export function sourcePage(o: {
  slug: string;
  title: string;
  source: string;
  kind: string;
  version: number;
  apiBase: string;
  shareUrl: string;
  canEdit: boolean;
}): string {
  const editBtn = o.canEdit
    ? `<a class="back" style="margin-left:12px" href="${escAttr(o.shareUrl.split("#")[0])}?edit=1${o.shareUrl.includes("#") ? "#" + o.shareUrl.split("#")[1] : ""}">Edit ↗</a>`
    : "";
  const lines = o.source.split("\n");
  const rows = lines
    .map((ln, i) => `<div class="ln"><span class="no">${i + 1}</span><span class="lc">${escHtml(ln)}</span></div>`)
    .join("");
  const extra = `
  .tools { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid rgba(0,0,0,.07);
    position: sticky; top: 0; background: var(--card); z-index: 2; border-radius: 12px 12px 0 0; }
  .ln { display: flex; font-size: 12px; line-height: 1.55; color: var(--ink); }
  .ln:hover { background: rgba(0,0,0,.03); }
  .ln .no { flex: 0 0 46px; text-align: right; padding-right: 12px; opacity: .35; user-select: none; -webkit-user-select: none; }
  .ln .lc { white-space: pre-wrap; word-break: break-word; flex: 1; min-width: 0; padding-right: 12px; }
  .ln .lc:empty::before { content: "\\00a0"; }
  @media (max-width: 640px) { .ln .no { flex-basis: 34px; padding-right: 8px; } .ln { font-size: 11px; } }`;
  const body = `
${topRow(`${o.title} — source (v${o.version})`, o.shareUrl)}
<div class="card" style="padding:0">
  <div class="tools">
    <span style="opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${escHtml(o.kind)} · v${o.version} · ${lines.length.toLocaleString()} lines · ${o.source.length.toLocaleString()} chars</span>
    <span style="flex:1"></span>
    <a class="back" id="raw" href="#">Raw</a>
    <button class="primary" id="cp" style="padding:5px 12px;font-size:12px">Copy source</button>${editBtn}
  </div>
  <div id="src" style="padding:8px 0;overflow-x:auto">${rows}</div>
</div>
<script>(function(){
  var raw=document.getElementById("raw");
  try{var u=new URL(location.href);u.searchParams.set("src","raw");raw.href=u.pathname+u.search;}catch(e){raw.style.display="none";}
  var b=document.getElementById("cp");
  var text=function(){return Array.prototype.map.call(document.querySelectorAll("#src .lc"),function(n){return n.textContent;}).join("\\n");};
  b.addEventListener("click",function(){
    var t=text();
    var done=function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy source"},1500);};
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,function(){});}
  });
})();</script>`;
  return pageShell(`${o.title} — source`, body, extra);
}

export function diffPage(o: {
  slug: string;
  title: string;
  a: number;
  b: number;
  ops: Array<{ t: "eq" | "add" | "del"; line: string }>;
  apiBase: string;
  shareUrl: string;
}): string {
  const fmt = (op: { t: string; line: string }, a: number | null, b: number | null) => {
    const cls = op.t === "add" ? "add" : op.t === "del" ? "del" : "eq";
    const sign = op.t === "add" ? "+" : op.t === "del" ? "−" : " ";
    return `<div class="ln ${cls}"><span class="no">${a ?? ""}</span><span class="no">${b ?? ""}</span><span class="sg">${sign}</span><span class="tx">${escHtml(op.line) || " "}</span></div>`;
  };
  // Number both sides, then fold long unchanged runs (>8 lines) behind an
  // expander that keeps 3 lines of context on each edge.
  let aN = 0;
  let bN = 0;
  const rendered: string[] = [];
  let run: string[] = [];
  const flushRun = () => {
    if (run.length > 8) {
      rendered.push(...run.slice(0, 3));
      const hidden = run.slice(3, run.length - 3);
      rendered.push(
        `<button class="unfold" type="button">⋯ ${hidden.length} unchanged lines</button><div class="fold" hidden>${hidden.join("")}</div>`,
      );
      rendered.push(...run.slice(run.length - 3));
    } else {
      rendered.push(...run);
    }
    run = [];
  };
  for (const op of o.ops) {
    if (op.t === "eq") {
      aN++;
      bN++;
      run.push(fmt(op, aN, bN));
    } else {
      flushRun();
      if (op.t === "add") {
        bN++;
        rendered.push(fmt(op, null, bN));
      } else {
        aN++;
        rendered.push(fmt(op, aN, null));
      }
    }
  }
  flushRun();
  const added = o.ops.filter((x) => x.t === "add").length;
  const removed = o.ops.filter((x) => x.t === "del").length;
  const extra = `
  .tools { display: flex; align-items: baseline; gap: 10px; padding: 10px 14px; border-bottom: 1px solid rgba(0,0,0,.07);
    position: sticky; top: 0; background: var(--card); z-index: 2; border-radius: 12px 12px 0 0; }
  .ln { display: flex; font-size: 12px; line-height: 1.5; color: var(--ink); }
  .ln .no { flex: 0 0 38px; text-align: right; padding-right: 8px; opacity: .35; user-select: none; -webkit-user-select: none; }
  .ln .sg { flex: 0 0 18px; text-align: center; opacity: .5; user-select: none; -webkit-user-select: none; }
  .ln .tx { white-space: pre-wrap; word-break: break-word; flex: 1; min-width: 0; padding-right: 10px; }
  .ln.add { background: rgba(61,138,61,.12); }
  .ln.del { background: rgba(179,55,42,.10); opacity: .85; }
  .ln.eq { opacity: .8; }
  .unfold { all: unset; cursor: pointer; display: block; width: 100%; box-sizing: border-box; text-align: center;
    padding: 6px 10px; color: var(--blue); background: rgba(26,99,196,.05); font-size: 11px;
    -webkit-tap-highlight-color: transparent; }
  .unfold:hover { background: rgba(26,99,196,.1); }
  @media (max-width: 640px) { .ln .no { flex-basis: 28px; } .ln { font-size: 11px; } }`;
  const body = `
${topRow(`${o.title} — v${o.a} → v${o.b}`, o.shareUrl)}
<div class="card" style="padding:0">
  <div class="tools">
    <b style="color:var(--ink)">v${o.a} → v${o.b}</b>
    <span style="color:#3d8a3d">+${added}</span>
    <span style="color:#b3372a">−${removed}</span>
  </div>
  <div style="padding:8px 0;overflow-x:auto">${rendered.join("")}</div>
</div>
<script>(function(){
  document.addEventListener("click",function(e){
    var b=e.target&&e.target.closest?e.target.closest(".unfold"):null;
    if(!b)return;
    var f=b.nextElementSibling;
    if(f&&f.classList.contains("fold")){f.hidden=false;b.remove();}
  });
})();</script>`;
  return pageShell(`${o.title} — diff`, body, extra);
}

export function editorPage(o: {
  slug: string;
  title: string;
  kind: string;
  source: string;
  version: number;
  apiBase: string;
  shareUrl: string;
}): string {
  const isMd = o.kind === "markdown";
  const previewEl = isMd
    ? `<div id="pv" class="mdprev" aria-label="Preview"></div>`
    : `<iframe id="pv" sandbox="allow-scripts" title="Preview"></iframe>`;
  const extra = `
  .edcard { padding: 0; display: flex; flex-direction: column; height: calc(100vh - 130px); min-height: 420px; overflow: hidden; }
  .edbar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid rgba(0,0,0,.07); flex-wrap: wrap; }
  .edbar .st { opacity: .6; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dirty { color: var(--coral); font-weight: 600; white-space: nowrap; }
  .split { display: flex; flex: 1; min-height: 0; }
  #ed { flex: 1; min-width: 0; border: 0; outline: none; resize: none; padding: 14px;
    font: 12.5px/1.55 ui-monospace, "SF Mono", Menlo, monospace; color: var(--ink); background: #fff; }
  #pv { flex: 1; min-width: 0; border: 0; border-left: 1px solid rgba(0,0,0,.08); background: var(--bg); }
  div#pv { overflow-y: auto; padding: 20px 24px; font: 16px/1.65 Charter, Georgia, "Times New Roman", serif; color: #23231f; }
  div#pv h1, div#pv h2, div#pv h3, div#pv h4 { font-family: ui-monospace, "SF Mono", Menlo, monospace; line-height: 1.25; }
  div#pv h1 { font-size: 24px; } div#pv h2 { font-size: 18px; } div#pv h3 { font-size: 15px; }
  div#pv pre { background: #fff; border: 1px solid rgba(0,0,0,.08); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 12.5px; }
  div#pv code { font: 13px/1.5 ui-monospace, Menlo, monospace; background: rgba(0,0,0,.05); padding: 1px 4px; border-radius: 4px; }
  div#pv pre code { background: none; padding: 0; }
  div#pv blockquote { margin: 0; padding: 2px 14px; border-left: 3px solid var(--coral); color: var(--mut); }
  div#pv a { color: var(--blue); }
  div#pv img { max-width: 100%; }
  #nm { width: 140px; padding: 6px 9px; font-size: 12px; }
  #tgl { display: none; }
  @media (max-width: 900px) {
    #tgl { display: inline-block; }
    .split.showpv #ed { display: none; }
    .split:not(.showpv) #pv { display: none; }
    #pv { border-left: 0; }
    .edcard { height: calc(100vh - 150px); }
    #nm { width: 110px; }
  }`;
  const body = `
${topRow(`${o.title} — edit`, o.shareUrl, "← Back")}
<div class="card edcard">
  <div class="edbar">
    <span class="st">v${o.version} (${escHtml(o.kind)}) · publish mints a new version · Cmd/Ctrl+S</span>
    <span id="dirty" class="dirty" hidden>● unsaved</span>
    <span style="flex:1"></span>
    <button class="ghost" id="tgl" type="button">Preview</button>
    <input type="text" id="nm" placeholder="Your name" autocomplete="name">
    <button class="primary" id="save" type="button" style="padding:6px 14px;font-size:12px">Publish</button>
  </div>
  <div class="err" id="err" style="padding:0 14px" role="alert"></div>
  <div class="split" id="split">
    <textarea id="ed" spellcheck="false" autocapitalize="off">${escHtml(o.source)}</textarea>
    ${previewEl}
  </div>
</div>
<script>(function(){
  var IS_MD=${JSON.stringify(isMd)};
  var frag=new URLSearchParams(location.hash.replace(/^#/,""));
  var key=frag.get("o")||frag.get("ed")||"";
  var ed=document.getElementById("ed"),err=document.getElementById("err");
  var save=document.getElementById("save"),nm=document.getElementById("nm");
  var pv=document.getElementById("pv"),tgl=document.getElementById("tgl"),split=document.getElementById("split");
  var dirtyEl=document.getElementById("dirty");
  var initial=ed.value;
  var mem={};
  var sGet=function(k){try{var v=localStorage.getItem(k);if(v!=null)return v;}catch(e){}return mem[k]||"";};
  var sSet=function(k,v){mem[k]=v;try{localStorage.setItem(k,v);}catch(e){}};
  nm.value=sGet("__cc_name")||(frag.get("em")?frag.get("em").split("@")[0]:"");
  nm.addEventListener("input",function(){sSet("__cc_name",nm.value);});
  var dirty=function(){return ed.value!==initial;};
  var syncDirty=function(){dirtyEl.hidden=!dirty();};
  window.addEventListener("beforeunload",function(e){if(dirty()){e.preventDefault();e.returnValue="";}});
  // Minimal markdown approximation for LIVE PREVIEW ONLY — the server render
  // (marked) is authoritative and happens on publish.
  var mdr=function(src){
    var esc=function(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");};
    var inline=function(s){
      s=esc(s);
      s=s.replace(/\`([^\`]+)\`/g,"<code>$1</code>");
      s=s.replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>");
      s=s.replace(/(^|[^*])\\*([^*]+)\\*/g,"$1<em>$2</em>");
      s=s.replace(/!?\\[([^\\]]*)\\]\\(([^)]+)\\)/g,'<a href="$2">$1</a>');
      return s;
    };
    var lines=src.split(/\\r?\\n/);
    var out=[],i,inCode=false,codeBuf=[],listMode="";
    var closeList=function(){if(listMode){out.push(listMode==="ul"?"</ul>":"</ol>");listMode="";}};
    for(i=0;i<lines.length;i++){
      var L=lines[i];
      if(/^\\s*\`\`\`/.test(L)){
        if(inCode){out.push("<pre><code>"+esc(codeBuf.join("\\n"))+"</code></pre>");codeBuf=[];inCode=false;}
        else{closeList();inCode=true;}
        continue;
      }
      if(inCode){codeBuf.push(L);continue;}
      var h=L.match(/^(#{1,6})\\s+(.*)$/);
      if(h){closeList();out.push("<h"+h[1].length+">"+inline(h[2])+"</h"+h[1].length+">");continue;}
      if(/^\\s*(---+|\\*\\*\\*+|___+)\\s*$/.test(L)){closeList();out.push("<hr>");continue;}
      var q=L.match(/^>\\s?(.*)$/);
      if(q){closeList();out.push("<blockquote>"+inline(q[1])+"</blockquote>");continue;}
      var ul=L.match(/^\\s*[-*+]\\s+(.*)$/);
      if(ul){if(listMode!=="ul"){closeList();out.push("<ul>");listMode="ul";}out.push("<li>"+inline(ul[1])+"</li>");continue;}
      var ol=L.match(/^\\s*\\d+[.)]\\s+(.*)$/);
      if(ol){if(listMode!=="ol"){closeList();out.push("<ol>");listMode="ol";}out.push("<li>"+inline(ol[1])+"</li>");continue;}
      if(!L.trim()){closeList();continue;}
      closeList();out.push("<p>"+inline(L)+"</p>");
    }
    if(inCode)out.push("<pre><code>"+esc(codeBuf.join("\\n"))+"</code></pre>");
    closeList();
    return out.join("\\n");
  };
  var render=function(){
    if(IS_MD){pv.innerHTML=mdr(ed.value);}
    else{pv.srcdoc=ed.value;}
  };
  var rt=null;
  ed.addEventListener("input",function(){
    syncDirty();
    if(rt)clearTimeout(rt);
    rt=setTimeout(render,IS_MD?150:400);
  });
  render();
  if(tgl)tgl.addEventListener("click",function(){
    var showing=split.classList.toggle("showpv");
    tgl.textContent=showing?"Edit":"Preview";
    if(showing)render();
  });
  var doSave=function(){
    err.textContent="";
    if(!key){err.textContent="No edit key in the URL — ask the author for an edit link";return;}
    if(save.disabled)return;
    save.textContent="Publishing…";save.disabled=true;
    fetch(${JSON.stringify(o.apiBase)}+"/cli/artifacts/edit",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({slug:${JSON.stringify(o.slug)},key:key,content:ed.value,editor_name:nm.value||undefined})})
      .then(function(r){return r.json();})
      .then(function(j){
        save.disabled=false;save.textContent="Publish";
        if(j&&j.version){
          initial=ed.value;syncDirty();
          var u=new URL(location.href);u.searchParams.delete("edit");u.searchParams.set("r",j.version);
          location.href=u.pathname+u.search+location.hash;
        }
        else err.textContent=(j&&j.error)||"Publish failed";
      },function(){save.disabled=false;save.textContent="Publish";err.textContent="Network error";});
  };
  save.addEventListener("click",doSave);
  document.addEventListener("keydown",function(e){
    if((e.metaKey||e.ctrlKey)&&(e.key==="s"||e.key==="S")){e.preventDefault();doSave();}
  });
})();</script>`;
  return pageShell(`${o.title} — edit`, body, extra);
}

/** Reading theme wrapping rendered markdown. The result is the stored artifact
 * document, so it goes through brandArtifactHtml at serve time like any HTML.
 * Auto dark mode via prefers-color-scheme — the md theme only; the injected
 * bar stays its light self. */
export function mdDocumentHtml(o: { title: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escHtml(o.title)}</title>
<style>
  :root { --ink: #23231f; --mut: #52524e; --coral: #e86c5d; --blue: #1a63c4; --bg: #faf9f7;
    --card: #ffffff; --line: rgba(0,0,0,.1); --codebg: rgba(0,0,0,.05); }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e8e6e1; --mut: #a8a69f; --blue: #6ca0e8; --bg: #161513;
      --card: #1e1d1a; --line: rgba(255,255,255,.12); --codebg: rgba(255,255,255,.08); }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 400 16px/1.65 Charter, Georgia, "Times New Roman", serif;
    -webkit-font-smoothing: antialiased; }
  ::selection { background: rgba(232,108,93,.3); }
  main { max-width: 720px; margin: 0 auto;
    padding: 40px calc(20px + env(safe-area-inset-right)) 80px calc(20px + env(safe-area-inset-left)); }
  h1, h2, h3, h4 { font-family: ui-monospace, "SF Mono", Menlo, monospace; line-height: 1.25; color: var(--ink); }
  h1 { font-size: 26px; margin: 0 0 18px; } h2 { font-size: 19px; margin: 34px 0 10px; } h3 { font-size: 16px; margin: 26px 0 8px; }
  h4 { font-size: 14px; margin: 22px 0 6px; }
  p { margin: 0 0 14px; }
  a { color: var(--blue); text-underline-offset: 2px; }
  code { font: 13px/1.5 ui-monospace, Menlo, monospace; background: var(--codebg); padding: 1px 5px; border-radius: 4px; }
  pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 0 0 14px; padding: 2px 18px; border-left: 3px solid var(--coral); color: var(--mut); }
  ul, ol { padding-left: 26px; margin: 0 0 14px; }
  li { margin: 3px 0; }
  li::marker { color: var(--coral); }
  img { max-width: 100%; border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; margin: 0 0 16px; display: block; overflow-x: auto; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); }
  th { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 32px 0; }
</style>
</head>
<body>
<main>
${o.bodyHtml}
</main>
</body>
</html>`;
}
