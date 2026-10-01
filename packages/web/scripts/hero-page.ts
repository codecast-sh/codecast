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
//     refuses, and says the bar was last left open, as a visitor opening the
//     page's own URL sees it (a framed page otherwise starts as the pill).
//
// Run from packages/web: bun scripts/hero-page.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brandArtifactHtml } from "@codecast/convex/convex/artifactPages";
import { PAGE } from "../app/(marketing)/heroFly/fixtures/publish";

const OUT = join(import.meta.dir, "..", "public", "hero", "page.html");

// A fixed clock, so the output only changes when the report does.
const AT = Date.UTC(2026, 8, 30, 15, 0);

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
  main { max-width: 760px; margin: 0 auto; padding: 28px 32px 48px; }
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
  <div class="kicker">acme/billing · PR #482 · 7 days on staging</div>
  <h1>${PAGE.title}</h1>
  <p class="lede">Failed Stripe deliveries now retry with exponential backoff, at most 5 attempts over about thirty minutes. Nothing was dropped this week.</p>
  <div class="stats">
    <div class="stat"><b class="good">0</b><span>events dropped (41 the week before)</span></div>
    <div class="stat"><b>99.98%</b><span>delivered, retries included</span></div>
    <div class="stat"><b>2m 10s</b><span>median time to recover</span></div>
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
    created_at: AT - (PAGE.comments.length - i) * 4 * 60_000,
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
  var mem={};
  var store={getItem:function(k){return k.indexOf("__cc_min")===0?"0":(k in mem?mem[k]:null);},setItem:function(k,v){mem[k]=String(v);},removeItem:function(k){delete mem[k];}};
  try{Object.defineProperty(window,"localStorage",{value:store,configurable:true});}catch(e){}
  var real=window.fetch.bind(window);
  window.fetch=function(u,o){
    if(typeof u==="string"&&u.indexOf("data:")===0)return real(u,o);
    return Promise.resolve(new Response("{}",{status:200,headers:{"Content-Type":"application/json"}}));
  };
})();</script>`;

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

const html = branded.replace(/<head([^>]*)>/i, (m) => `${m}${stub}`);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${html.length} bytes)`);
