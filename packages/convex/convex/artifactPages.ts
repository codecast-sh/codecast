// Presentation layer for published artifacts: every HTML surface the origin
// serves — the injected bar + og meta, the access-gate interstitials, the
// source / diff / editor pages, and the markdown reading theme. Pure string
// builders, no db access; artifacts.ts owns data, http.ts owns routing.
//
// All pages are self-contained (inline CSS/JS, no external requests except to
// `apiBase`) because artifact documents are served under a sandbox CSP with an
// opaque origin. Secrets travel only in URL fragments (#o / #ed / #em), never
// query strings.

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
    ? `<button id="__cc_cbtn" type="button" title="Comments">✎ <span id="__cc_ccount">${o.commentCount || ""}</span></button>`
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
    box-sizing: border-box; padding: 0 14px;
    font: 500 12px/1 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    background: #ffffff; color: #52524e; box-shadow: 0 1px 6px rgba(0,0,0,.08);
    text-align: left; }
  #__cc_bar .__cc_brand { color: #444444; text-decoration: none; display: inline-flex; align-items: center; }
  #__cc_bar .__cc_brand:hover { color: #1a1a18; }
  #__cc_bar .__cc_title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; opacity: .7; }
  #__cc_bar .__cc_sess { color: #1a63c4; text-decoration: none; white-space: nowrap; font-weight: 400; opacity: .8; }
  #__cc_bar .__cc_sess:hover { opacity: 1; }
  #__cc_bar .__cc_when { opacity: .5; font-weight: 400; white-space: nowrap; }
  #__cc_bar button { all: unset; cursor: pointer; padding: 4px 8px; border-radius: 6px; font: inherit; white-space: nowrap; }
  #__cc_bar button:hover { background: rgba(0,0,0,.06); }
  #__cc_bar button[hidden] { display: none; }
  #__cc_bar #__cc_ver.__cc_old { color: #b3661f; }
  #__cc_bar #__cc_new { background: #e86c5d; color: #ffffff; font-weight: 600; margin-left: 2px; }
  #__cc_bar #__cc_new:hover { background: #d85b4c; }
  #__cc_bar #__cc_latest { color: #1a63c4; text-decoration: none; padding: 4px 8px; border-radius: 6px; white-space: nowrap; }
  #__cc_bar #__cc_latest:hover { background: rgba(0,0,0,.06); }
  .__cc_panel { position: fixed; top: 38px; right: 10px; z-index: 2147483647; min-width: 240px; max-width: min(92vw, 380px);
    max-height: 70vh; overflow-y: auto;
    background: #ffffff; color: #52524e; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,.18);
    font: 400 12px/1.4 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace; padding: 8px; text-align: left; }
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
  @media (max-width: 640px) {
    .__cc_panel { left: 8px; right: 8px; max-width: none; top: auto; bottom: 8px; max-height: 60vh; }
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
<script>(function(){
  var CC=${JSON.stringify(cfg)};
  var frag=new URLSearchParams(location.hash.replace(/^#/,""));
  var ownerKey=frag.get("o")||"";
  var editKey=frag.get("ed")||"";
  var gateEmail=frag.get("em")||"";
  var rel=function(ts){var s=Math.max(0,(Date.now()-ts)/1e3);
    return s<60?"just now":s<3600?Math.floor(s/60)+"m ago":s<86400?Math.floor(s/3600)+"h ago":s<2592e3?Math.floor(s/86400)+"d ago":new Date(ts).toLocaleDateString();};
  var w=document.getElementById("__cc_when");
  if(w){var ts=+w.getAttribute("data-ts");var tick=function(){w.textContent="updated "+rel(ts);};tick();setInterval(tick,6e4);}
  var copyBtn=document.getElementById("__cc_copy");
  var copyText=function(u,done){
    var fallback=function(){var t=document.createElement("textarea");t.value=u;t.style.position="fixed";t.style.opacity="0";
      document.body.appendChild(t);t.select();try{document.execCommand("copy");done();}catch(e){window.prompt("Copy:",u);}t.remove();};
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(done,fallback);}else{fallback();}
  };
  if(copyBtn)copyBtn.addEventListener("click",function(){
    copyText(copyBtn.getAttribute("data-url"),function(){copyBtn.textContent="Copied";setTimeout(function(){copyBtn.textContent="Copy link"},1500);});
  });
  if(!CC.metaUrl)return;
  var api=function(path,body){return fetch(CC.apiBase+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();});};
  // View beacon — one per page load; carries the gate email when present.
  try{api("/cli/artifacts/view",{slug:CC.slug,email:gateEmail||undefined});}catch(e){}
  // Version links stay on whatever host serves this document. r is a
  // cache-buster (new URL → new cache key past the 60s edge/browser cache).
  var keepHash=location.hash||"";
  var verUrl=function(n,current){return location.pathname+(current?"?r=":"?v=")+n+keepHash;};
  var latest=document.getElementById("__cc_latest");
  if(latest)latest.setAttribute("href",verUrl(CC.currentVersion,true));
  var panels=["__cc_hist","__cc_menupanel","__cc_cpanel"].map(function(id){return document.getElementById(id);});
  var closeAll=function(){panels.forEach(function(p){if(p)p.hidden=true;});};
  document.addEventListener("click",closeAll);
  panels.forEach(function(p){if(p)p.addEventListener("click",function(e){e.stopPropagation();});});
  var fetchMeta=function(cb){fetch(CC.metaUrl,{cache:"no-store"}).then(function(r){return r.json();}).then(cb,function(){});};
  // --- history panel ---
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
        if(v.edited_by){var e=document.createElement("span");e.style.opacity=".6";e.style.fontWeight="400";e.textContent=" by "+v.edited_by;l.appendChild(e);}
        if(v.version!==m.version){
          var d=document.createElement("a");d.className="__cc_dlink";d.textContent="diff";
          d.href=location.pathname+"?diff="+v.version+".."+m.version+keepHash;
          d.title="What changed between v"+v.version+" and v"+m.version;
          d.addEventListener("click",function(e){e.stopPropagation();});
          l.appendChild(d);
        }
        var t=document.createElement("span");t.className="__cc_vwhen";t.textContent=rel(v.published_at);
        a.appendChild(l);a.appendChild(t);hist.appendChild(a);
      });
      if(!hist.childNodes.length){var n=document.createElement("div");n.className="__cc_note";n.textContent="No history yet";hist.appendChild(n);}
    };
    chip.addEventListener("click",function(e){
      e.stopPropagation();var was=hist.hidden;closeAll();
      if(!was)return;
      var n=document.createElement("div");n.className="__cc_note";n.textContent="Loading…";
      hist.innerHTML="";hist.appendChild(n);hist.hidden=false;
      fetchMeta(render);
    });
  }
  // --- overflow menu: source, views, manage (owner) ---
  var menuBtn=document.getElementById("__cc_menu");
  var menu=document.getElementById("__cc_menupanel");
  if(menuBtn&&menu){
    menuBtn.addEventListener("click",function(e){
      e.stopPropagation();var was=menu.hidden;closeAll();
      if(!was)return;
      menu.innerHTML="";
      var add=function(label,fn){var a=document.createElement("a");a.className="__cc_row";a.href="#";
        var s=document.createElement("span");s.textContent=label;a.appendChild(s);
        a.addEventListener("click",function(ev){ev.preventDefault();fn();});menu.appendChild(a);return a;};
      add("View source",function(){location.href=location.pathname+"?src=1"+(CC.version!==CC.currentVersion?"&v="+CC.version:"")+keepHash;});
      if(CC.views){var vr=document.createElement("div");vr.className="__cc_note";vr.textContent=CC.views+" view"+(CC.views===1?"":"s");menu.appendChild(vr);}
      if(ownerKey||editKey||CC.editMode==="link"){
        add("Edit this page",function(){location.href=location.pathname+"?edit=1"+keepHash;});
      }
      if(ownerKey){
        add("Manage sharing…",function(){alert("Manage panel ships in the polish pass — use cast publish ls / manage for now.");});
      }
      menu.hidden=false;
    });
  }
  // --- comments (foundation: prompt-based; polished panel lands in PAGES pass) ---
  var cbtn=document.getElementById("__cc_cbtn");
  if(cbtn){
    cbtn.addEventListener("click",function(e){
      e.stopPropagation();
      var text=window.prompt("Comment for the author (sent to their session):");
      if(!text)return;
      var name=window.prompt("Your name:")||"anonymous";
      api("/cli/artifacts/comment",{slug:CC.slug,author_name:name,author_email:gateEmail||undefined,version:CC.version,comments:[{text:text}]})
        .then(function(r){cbtn.firstChild.textContent=r&&r.delivered?"✓ ":"✎ ";setTimeout(function(){cbtn.firstChild.textContent="✎ ";},2000);});
    });
  }
  // --- new-version badge / live reload ---
  if(CC.version===CC.currentVersion){
    var badge=document.getElementById("__cc_new");
    var poll=function(){
      fetchMeta(function(m){
        if(m&&m.version>CC.version){
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escHtml(title)}</title>
<style>
  :root { --ink: #1a1a18; --mut: #52524e; --dim: rgba(0,0,0,.45); --coral: #e86c5d; --blue: #1a63c4; --bg: #faf9f7; --card: #ffffff; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--mut);
    font: 400 14px/1.5 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace; }
  .shell { max-width: 860px; margin: 0 auto; padding: 20px 16px 60px; }
  .top { display: flex; align-items: center; gap: 10px; padding: 4px 0 18px; }
  .top a.brand { color: #444; display: inline-flex; }
  .top .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .75; }
  .top a.back { color: var(--blue); text-decoration: none; white-space: nowrap; }
  .card { background: var(--card); border-radius: 10px; box-shadow: 0 1px 6px rgba(0,0,0,.08); padding: 20px; }
  button.primary { all: unset; cursor: pointer; background: var(--coral); color: #fff; font: inherit; font-weight: 600;
    padding: 8px 16px; border-radius: 8px; }
  button.primary:hover { background: #d85b4c; }
  input[type=password], input[type=email], input[type=text] { font: inherit; padding: 8px 10px; border: 1px solid rgba(0,0,0,.18);
    border-radius: 8px; width: 100%; background: #fff; color: var(--ink); }
  .err { color: #b3372a; min-height: 1.2em; }
  ${extra}
</style>
</head>
<body>
<div class="shell">
${body}
</div>
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

export function passwordGatePage(o: { slug: string; title: string; apiBase: string; shareUrl: string }): string {
  const body = `
<div class="top"><a class="brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer">${logoSvg(22)}</a><span class="t">${escHtml(o.title)}</span></div>
<div class="card" style="max-width:420px;margin:12vh auto 0">
  <h1 style="font-size:15px;color:var(--ink);margin:0 0 6px">This page is password protected</h1>
  <p style="margin:0 0 16px;opacity:.7">Enter the password to view <b>${escHtml(o.title)}</b>.</p>
  <form id="f" style="display:flex;flex-direction:column;gap:10px">
    <input type="password" id="pw" placeholder="Password" autofocus autocomplete="current-password">
    <div class="err" id="err"></div>
    <button class="primary" type="submit">Unlock</button>
  </form>
</div>
<script>(function(){
  var f=document.getElementById("f"),pw=document.getElementById("pw"),err=document.getElementById("err");
  f.addEventListener("submit",function(e){
    e.preventDefault();err.textContent="";
    fetch(${JSON.stringify(o.apiBase)}+"/cli/artifacts/unlock",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({slug:${JSON.stringify(o.slug)},password:pw.value})})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j&&j.k){var u=new URL(location.href);u.searchParams.set("k",j.k);location.replace(u.pathname+u.search+location.hash);}
        else err.textContent="Wrong password";
      },function(){err.textContent="Network error — try again";});
  });
})();</script>`;
  return pageShell(o.title, body);
}

export function emailGatePage(o: { slug: string; title: string; apiBase: string; shareUrl: string }): string {
  const body = `
<div class="top"><a class="brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer">${logoSvg(22)}</a><span class="t">${escHtml(o.title)}</span></div>
<div class="card" style="max-width:420px;margin:12vh auto 0">
  <h1 style="font-size:15px;color:var(--ink);margin:0 0 6px">Enter your email to view</h1>
  <p style="margin:0 0 16px;opacity:.7">The author of <b>${escHtml(o.title)}</b> asks viewers to identify themselves.</p>
  <form id="f" style="display:flex;flex-direction:column;gap:10px">
    <input type="email" id="em" placeholder="you@example.com" autofocus autocomplete="email" required>
    <div class="err" id="err"></div>
    <button class="primary" type="submit">Continue</button>
  </form>
</div>
<script>(function(){
  var f=document.getElementById("f"),em=document.getElementById("em"),err=document.getElementById("err");
  f.addEventListener("submit",function(e){
    e.preventDefault();err.textContent="";
    var email=em.value.trim().toLowerCase();
    fetch(${JSON.stringify(o.apiBase)}+"/cli/artifacts/email-unlock",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({slug:${JSON.stringify(o.slug)},email:email})})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j&&j.e){var u=new URL(location.href);u.searchParams.set("e",j.e);
          var h=new URLSearchParams(location.hash.replace(/^#/,""));h.set("em",email);
          location.replace(u.pathname+u.search+"#"+h.toString());}
        else err.textContent=(j&&j.error)||"Something went wrong";
      },function(){err.textContent="Network error — try again";});
  });
})();</script>`;
  return pageShell(o.title, body);
}

export function expiredPage(o: { title: string }): string {
  const body = `
<div class="top"><a class="brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer">${logoSvg(22)}</a></div>
<div class="card" style="max-width:420px;margin:16vh auto 0;text-align:center">
  <h1 style="font-size:15px;color:var(--ink);margin:0 0 6px">This link has expired</h1>
  <p style="margin:0;opacity:.7">The author set an expiry on <b>${escHtml(o.title)}</b> and it has passed.</p>
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
  const body = `
${topRow(`${o.title} — source (v${o.version})`, o.shareUrl)}
<div class="card" style="padding:0">
  <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid rgba(0,0,0,.07)">
    <span style="opacity:.6">${escHtml(o.kind)} · v${o.version} · ${o.source.length.toLocaleString()} chars</span>
    <span style="flex:1"></span>
    <button class="primary" id="cp" style="padding:5px 12px;font-size:12px">Copy source</button>${editBtn}
  </div>
  <pre id="src" style="margin:0;padding:14px;overflow-x:auto;font-size:12px;line-height:1.5;color:var(--ink);white-space:pre-wrap;word-break:break-word">${escHtml(o.source)}</pre>
</div>
<script>(function(){
  var b=document.getElementById("cp");
  b.addEventListener("click",function(){
    navigator.clipboard.writeText(document.getElementById("src").textContent).then(function(){
      b.textContent="Copied";setTimeout(function(){b.textContent="Copy source"},1500);});
  });
})();</script>`;
  return pageShell(`${o.title} — source`, body);
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
  const rows = o.ops
    .map((op) => {
      const cls = op.t === "add" ? "add" : op.t === "del" ? "del" : "eq";
      const sign = op.t === "add" ? "+" : op.t === "del" ? "−" : " ";
      return `<div class="ln ${cls}"><span class="sg">${sign}</span>${escHtml(op.line) || " "}</div>`;
    })
    .join("");
  const added = o.ops.filter((x) => x.t === "add").length;
  const removed = o.ops.filter((x) => x.t === "del").length;
  const extra = `
  .ln { padding: 0 10px 0 4px; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.5; color: var(--ink); }
  .ln .sg { display: inline-block; width: 18px; opacity: .5; user-select: none; }
  .ln.add { background: rgba(61,138,61,.12); }
  .ln.del { background: rgba(179,55,42,.10); opacity: .8; }
  .ln.eq { opacity: .75; }`;
  const body = `
${topRow(`${o.title} — v${o.a} → v${o.b}`, o.shareUrl)}
<div class="card" style="padding:0">
  <div style="padding:10px 14px;border-bottom:1px solid rgba(0,0,0,.07)">
    <b style="color:var(--ink)">v${o.a} → v${o.b}</b>
    <span style="margin-left:10px;color:#3d8a3d">+${added}</span>
    <span style="margin-left:6px;color:#b3372a">−${removed}</span>
  </div>
  <div style="padding:8px 0;overflow-x:auto">${rows}</div>
</div>`;
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
  const body = `
${topRow(`${o.title} — edit`, o.shareUrl, "← Back (discard)")}
<div class="card" style="padding:0;display:flex;flex-direction:column;height:78vh">
  <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid rgba(0,0,0,.07)">
    <span style="opacity:.6">editing v${o.version} (${escHtml(o.kind)}) — saving publishes a new version</span>
    <span style="flex:1"></span>
    <input type="text" id="nm" placeholder="Your name" style="width:140px;padding:5px 8px;font-size:12px">
    <button class="primary" id="prev" style="padding:5px 12px;font-size:12px;background:#52524e">Preview</button>
    <button class="primary" id="save" style="padding:5px 12px;font-size:12px">Publish</button>
  </div>
  <div class="err" id="err" style="padding:0 14px"></div>
  <textarea id="ed" spellcheck="false" style="flex:1;border:0;outline:none;resize:none;padding:14px;font:12px/1.5 ui-monospace,Menlo,monospace;color:var(--ink);background:#fff;border-radius:0 0 10px 10px">${escHtml(o.source)}</textarea>
</div>
<script>(function(){
  var frag=new URLSearchParams(location.hash.replace(/^#/,""));
  var key=frag.get("o")||frag.get("ed")||"";
  var ed=document.getElementById("ed"),err=document.getElementById("err");
  var save=document.getElementById("save"),prev=document.getElementById("prev"),nm=document.getElementById("nm");
  try{nm.value=localStorage.getItem("__cc_name")||"";}catch(e){}
  prev.addEventListener("click",function(){
    var w=window.open("","_blank");
    if(!w){err.textContent="Popup blocked — allow popups to preview";return;}
    ${o.kind === "markdown" ? `w.document.write("<pre style='font-family:monospace;white-space:pre-wrap;padding:20px'>"+ed.value.replace(/&/g,"&amp;").replace(/</g,"&lt;")+"</pre>");` : `w.document.write(ed.value);`}
    w.document.close();
  });
  save.addEventListener("click",function(){
    err.textContent="";
    if(!key){err.textContent="No edit key in the URL — ask the author for an edit link";return;}
    save.textContent="Publishing…";save.disabled=true;
    try{localStorage.setItem("__cc_name",nm.value);}catch(e){}
    fetch(${JSON.stringify(o.apiBase)}+"/cli/artifacts/edit",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({slug:${JSON.stringify(o.slug)},key:key,content:ed.value,editor_name:nm.value||undefined})})
      .then(function(r){return r.json();})
      .then(function(j){
        save.disabled=false;save.textContent="Publish";
        if(j&&j.version){var u=new URL(location.href);u.searchParams.delete("edit");u.searchParams.set("r",j.version);
          location.href=u.pathname+u.search+location.hash;}
        else err.textContent=(j&&j.error)||"Publish failed";
      },function(){save.disabled=false;save.textContent="Publish";err.textContent="Network error";});
  });
})();</script>`;
  return pageShell(`${o.title} — edit`, body);
}

/** Reading theme wrapping rendered markdown. The result is the stored artifact
 * document, so it goes through brandArtifactHtml at serve time like any HTML. */
export function mdDocumentHtml(o: { title: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(o.title)}</title>
<style>
  :root { --ink: #23231f; --mut: #52524e; --coral: #e86c5d; --blue: #1a63c4; --bg: #faf9f7; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 400 16px/1.65 Charter, Georgia, "Times New Roman", serif; }
  main { max-width: 720px; margin: 0 auto; padding: 40px 20px 80px; }
  h1, h2, h3, h4 { font-family: ui-monospace, "SF Mono", Menlo, monospace; line-height: 1.25; color: var(--ink); }
  h1 { font-size: 26px; margin: 0 0 18px; } h2 { font-size: 19px; margin: 34px 0 10px; } h3 { font-size: 16px; margin: 26px 0 8px; }
  a { color: var(--blue); }
  code { font: 13px/1.5 ui-monospace, Menlo, monospace; background: rgba(0,0,0,.05); padding: 1px 5px; border-radius: 4px; }
  pre { background: #fff; border: 1px solid rgba(0,0,0,.08); border-radius: 8px; padding: 14px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 0; padding: 2px 18px; border-left: 3px solid var(--coral); color: var(--mut); }
  img { max-width: 100%; border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid rgba(0,0,0,.1); }
  hr { border: 0; border-top: 1px solid rgba(0,0,0,.12); margin: 32px 0; }
</style>
</head>
<body>
<main>
${o.bodyHtml}
</main>
</body>
</html>`;
}
