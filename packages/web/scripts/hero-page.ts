// Builds public/hero/page.html: the published page the homepage hero shows in
// its Publish chapter (app/(marketing)/heroFly/chapters/publish.tsx). It is the
// real codecast.sh/a/<slug> chrome, brandArtifactHtml around a report an agent
// would write, generated here so the page's marked and highlight.js weight
// never reaches the hero's bundle.
//
// The page runs inside a sandboxed iframe with an opaque origin, cut off from
// the visitor's account and from Convex:
//   - metaUrl is a data: URL holding the fixture comments, so the bar's
//     comment count, pins and discussion panel are the real ones;
//   - apiBase is dead, and a stub prepended to <head> answers every other
//     fetch (the view beacon, a posted comment) locally;
//   - the same stub stands in for localStorage, which an opaque origin
//     refuses, and says the bar was last folded into its pill, as a framed
//     page shows it in a conversation, so the frame carries one title;
//   - the stub sets the page's clock to just after it was published, so its
//     "updated" line and the comments read as fresh whenever it loads, and
//     opens the discussion on the chart's pin once the page is up;
//   - it is a page to read, not to post to: the identity link ("Sign in") and
//     the composers are hidden, every link click is cancelled (a sandboxed
//     frame may still navigate itself), and a CSP keeps it from loading or
//     calling anything but its fonts.
//
// The report keeps to the left 352px of the frame, so the open discussion
// docks beside it on the right instead of covering its lead and its numbers.
//
// The hero shows a still of this page (public/hero/page.jpg, 851x500 CSS px
// captured at 1.6x through an iframe scaled 2x, so the bar lays out at its
// real width) and mounts the live page over it only when a visitor points at
// it; recapture the still whenever the report changes.
//
// Run from packages/web: bun scripts/hero-page.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brandArtifactHtml } from "@codecast/convex/convex/artifactPages";
import { PAGE } from "../app/(marketing)/heroFly/fixtures/publish";

const OUT = join(import.meta.dir, "..", "public", "hero", "page.html");

// A fixed publish time, so the output only changes when the report does; the
// stub reads every relative time against it (see above).
const AT = Date.UTC(2026, 8, 30, 15, 0);
/** How long after publishing the page's clock reads when it loads. */
const SEEN_AFTER = 75_000;

const report = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PAGE.title}</title>
<style>
  :root { --ink: #073642; --mut: #586e75; --dim: #93a1a1; --line: #e8e2cf; --bg: #fdf6e3; --card: #fffdf6; --green: #859900; --red: #dc322f; --blue: #268bd2; --amber: #b58900; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width: 352px; margin: 0; padding: 22px 16px 48px; }
  .kicker { font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; color: var(--mut); }
  h1 { font-size: 26px; line-height: 1.2; margin: 8px 0 6px; letter-spacing: -.01em; }
  .lede { color: var(--mut); margin: 0 0 22px; max-width: 56ch; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 22px; }
  .stat { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .stat b { display: block; font-size: 22px; letter-spacing: -.01em; }
  .stat span { font-size: 12px; color: var(--mut); }
  .stat .good { color: var(--green); }
  h2 { font-size: 15px; margin: 0 0 10px; }
  .chart { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 16px 10px; margin-bottom: 22px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 4px; border-bottom: 1px solid var(--line); }
  th { font-weight: 600; color: var(--mut); font-size: 12px; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; background: rgba(133,153,0,.14); color: var(--green); }
</style>
</head>
<body>
<main>
  <div class="kicker">PR #482 · 24h replayed on staging</div>
  <h1>${PAGE.title}</h1>
  <p class="lede">Failed Stripe deliveries now retry with exponential backoff, at most 5 attempts over about thirty minutes. Nothing was dropped in the replay.</p>
  <div class="stats">
    <div class="stat"><b class="good">0</b><span>dropped (41 before)</span></div>
    <div class="stat"><b>99.98%</b><span>delivered</span></div>
    <div class="stat"><b>2m 10s</b><span>median recovery</span></div>
  </div>
  <div class="chart" id="recovered">
    <h2>Where a failed event recovers</h2>
    <svg viewBox="0 0 680 200" width="100%" role="img" aria-label="Recoveries by attempt">
      ${PAGE.attempts
        .map((a, i) => {
          const h = Math.round((a.share / 100) * 150);
          const x = 30 + i * 130;
          return `<rect x="${x}" y="${170 - h}" width="84" height="${h}" rx="6" fill="${i === 0 ? "#268bd2" : "#93c1e3"}"/><text x="${x + 42}" y="${162 - h}" text-anchor="middle" font-size="13" font-weight="600" fill="#073642">${a.share}%</text><text x="${x + 42}" y="190" text-anchor="middle" font-size="12" fill="#586e75">${a.label}</text>`;
        })
        .join("")}
      <line x1="20" y1="170" x2="660" y2="170" stroke="#e8e2cf"/>
    </svg>
  </div>
  <h2>Why deliveries failed</h2>
  <table>
    <tr><th>Reason</th><th class="n">Events</th><th class="n">Recovered</th></tr>
    ${PAGE.reasons.map((r) => `<tr><td>${r.reason}</td><td class="n">${r.events}</td><td class="n"><span class="pill">${r.recovered}</span></td></tr>`).join("")}
  </table>
</main>
</body>
</html>`;

const meta = {
  version: 2,
  updated_at: AT,
  kind: "html",
  views: PAGE.views,
  comment_count: PAGE.comments.length,
  comments: PAGE.comments.map((c, i) => ({
    id: c.id,
    author_name: c.author,
    author_avatar: null,
    verified: true,
    parent_id: null,
    text: c.text,
    anchor: JSON.stringify(c.anchor),
    version: 2,
    created_at: AT + 20_000 + i * 25_000,
    delivered: false,
  })),
  session: { short_id: PAGE.session.shortId, title: PAGE.session.title },
  gated: { password: false, email: false },
  versions: [
    { version: 2, title: PAGE.title, size: report.length, published_at: AT },
    { version: 1, title: PAGE.title, size: report.length, published_at: AT - 26 * 60_000 },
  ],
};

const stub = `<script>(function(){
  var now=Date.now,shift=${AT + SEEN_AFTER}-now();
  Date.now=function(){return now()+shift;};
  var mem={};
  var store={getItem:function(k){return k.indexOf("__cc_min")===0?"1":(k in mem?mem[k]:null);},setItem:function(k,v){mem[k]=String(v);},removeItem:function(k){delete mem[k];}};
  try{Object.defineProperty(window,"localStorage",{value:store,configurable:true});}catch(e){}
  var real=window.fetch.bind(window);
  window.fetch=function(u,o){
    if(typeof u==="string"&&u.indexOf("data:")===0)return real(u,o);
    return Promise.resolve(new Response("{}",{status:200,headers:{"Content-Type":"application/json"}}));
  };
  var open=function(n){var pin=document.querySelector(".__cc_pin");if(pin)pin.click();else if(n<40)setTimeout(function(){open(n+1);},50);};
  addEventListener("load",function(){open(0);});
  addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a");if(a)e.preventDefault();},true);
  addEventListener("submit",function(e){e.preventDefault();},true);
})();</script>`;

/** Nothing leaves the frame but a font request: no codecast.sh, no API, no beacon. */
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src data:; form-action 'none'">`;

/** Read-only: no identity link, no composers, no reply buttons. */
const READ_ONLY = `<style>.__cc_signin,#__cc_cpanel .__cc_addrow,#__cc_cpanel .__cc_rbtn,#__cc_cpanel .__cc_send,#__cc_cpanel textarea{display:none!important}</style>`;

const branded = brandArtifactHtml(report, {
  title: PAGE.title,
  author: PAGE.author,
  updatedAt: AT,
  shareUrl: `https://${PAGE.url}`,
  version: 2,
  currentVersion: 2,
  metaUrl: `data:application/json,${encodeURIComponent(JSON.stringify(meta))}`,
  apiBase: "https://hero.invalid",
  slug: PAGE.slug,
  kind: "html",
  sessionShortId: PAGE.session.shortId,
  sessionConversationId: PAGE.session.id,
  sessionTitle: PAGE.session.title,
  views: PAGE.views,
  commentCount: PAGE.comments.length,
  commentsEnabled: true,
  gated: { password: false, email: false },
  editMode: "owner",
  live: false,
  hasThumb: false,
});

const html = branded.replace(/<head([^>]*)>/i, (m) => `${m}${CSP}${stub}${READ_ONLY}`);
// The hero copy must never offer a way into the real app: every static link opens out (where the sandbox refuses the popup), and the CSP and the click guard are in.
const bare = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((a) => !/\btarget="_blank"/.test(a));
if (bare.length) throw new Error(`hero page: links that would navigate the frame: ${bare.join(" ")}`);
if (!html.includes(CSP) || !html.includes(READ_ONLY)) throw new Error("hero page: the read-only guards are missing");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${html.length} bytes)`);
