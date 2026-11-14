// Raw captures of a published page (cast publish) for the docs: the page with
// its bar and discussion open, its Manage sharing sheet, and the page embedded
// in a conversation. A published page is served by Convex HTTP, not by the web
// app, so the docs shots server cannot draw it. This script renders it with
// the real presentation code (convex/artifactPages.ts brandArtifactHtml) over
// the Acme world's report, served from a local fixture origin that answers
// every request the page and its bar make (/cli/a/<slug>, ?meta=1,
// /cli/artifacts/*), so nothing reaches a real origin. The address bar is not
// in the capture; the bar names the page by its codecast.sh share link. The
// shots mode points the app's page URLs at this origin (lib/publishedPageUrls),
// so the embed in the report session's transcript and the Pages list's
// previews frame these pages too: keep `serve` running while the
// recall-showing batch captures. The PNGs land in docs-shots/raw/publish and
// the manifest frames them (`raw` entries in batches/recall-showing.ts).
//
//   bun packages/web/docs-shots/published-pages.ts           all three
//   bun packages/web/docs-shots/published-pages.ts embed     one (page, manage, embed)
//   bun packages/web/docs-shots/published-pages.ts serve     only serve the page at http://127.0.0.1:3297/a/<slug>

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brandArtifactHtml } from "../../convex/convex/artifactPages";
import { attachCastTab, type CastTab } from "../scripts/castTab";
import { DOCS_SHOTS_PAGES_ORIGIN } from "../lib/docsShots/flag";
import { MIN, PEOPLE, SESSIONS } from "../lib/acmeWorld/world";
import { PAGES, REPORT_SESSION, REPORT_SLUG } from "../lib/acmeWorld/pages";

const OUT = resolve(import.meta.dir, "raw/publish");
const SHOTS_ORIGIN = "http://127.0.0.1:3290";
const VIEWPORT = { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false };
const LOCAL = DOCS_SHOTS_PAGES_ORIGIN;
const API = LOCAL;
const OWNER_KEY = "acme-owner-key";
const wanted = process.argv.slice(2);
const want = (name: string) => !wanted.length || wanted.includes(name);

/* ── The page and what its server answers ──────────────────────────────── */

const now = Date.now();
const row = PAGES(now).find((p) => p.slug === REPORT_SLUG)!;

const HOURS = [3, 2, 4, 2, 1, 2, 5, 9, 14, 11, 6, 4, 3, 2, 3, 2, 18, 27, 12, 5, 3, 2, 2, 1];
const bars = HOURS.map((v, i) => `<rect x="${i * 26 + 4}" y="${180 - v * 6}" width="20" height="${v * 6}" rx="3" fill="${v > 15 ? "#c2410c" : "#0f766e"}"/>`).join("");
const REPORT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${row.title}</title>
<style>
body{font-family:-apple-system,"Inter",system-ui,sans-serif;color:#1f2a2a;background:#fbf8f1;margin:0}
main{max-width:860px;margin:0 auto;padding:40px 32px 64px}
h1{font-size:30px;margin:0 0 6px;letter-spacing:-.01em}
.sub{color:#5b6b6b;margin:0 0 28px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px}
.kpi{background:#fff;border:1px solid #e5e0d4;border-radius:10px;padding:14px 16px}
.kpi b{display:block;font-size:24px;font-variant-numeric:tabular-nums}
.kpi span{color:#5b6b6b;font-size:13px}
h2{font-size:17px;margin:28px 0 10px}
svg{background:#fff;border:1px solid #e5e0d4;border-radius:10px;width:100%;height:auto}
table{width:100%;border-collapse:collapse;font-size:14px;background:#fff;border:1px solid #e5e0d4;border-radius:10px;overflow:hidden}
td,th{padding:9px 12px;border-bottom:1px solid #eee8db;text-align:left}th{color:#5b6b6b;font-weight:500}
td.n{text-align:right;font-variant-numeric:tabular-nums}
</style></head><body><main>
<h1>Webhook retry failures, last 7 days</h1>
<p class="sub">1,284 failed deliveries across 212 endpoints. 96% landed on a retry.</p>
<div class="kpis">
<div class="kpi"><b>1,284</b><span>failed first attempts</span></div>
<div class="kpi"><b>96.1%</b><span>delivered by attempt 5</span></div>
<div class="kpi"><b>77%</b><span>delivered on attempt 2</span></div>
<div class="kpi"><b>50</b><span>dead-lettered</span></div>
</div>
<h2>Failures by hour (UTC)</h2>
<svg viewBox="0 0 632 200">${bars}<text x="410" y="40" font-size="12" text-anchor="end" fill="#c2410c">ledger restart, 02:00 →</text></svg>
<h2>Top failing endpoints</h2>
<table><tr><th>Endpoint</th><th>Status</th><th class="n">Failures</th><th class="n">Recovered</th></tr>
<tr><td>hooks.northwind.io/stripe</td><td>502</td><td class="n">318</td><td class="n">99%</td></tr>
<tr><td>api.lumen.app/webhooks</td><td>504</td><td class="n">201</td><td class="n">97%</td></tr>
<tr><td>billing.fable.dev/events</td><td>429</td><td class="n">143</td><td class="n">100%</td></tr>
<tr><td>old.orbit.co/hooks</td><td>410</td><td class="n">50</td><td class="n">0%</td></tr>
</table></main></body></html>`;

const COMMENTS = [
  { id: "c-maya", author_name: PEOPLE.maya.name, author_avatar: PEOPLE.maya.image, verified: true, parent_id: null, text: "The 410s should not count as failures at all. Can the chart leave them out?", anchor: null, version: 3, created_at: now - 9 * MIN, delivered: false, delivered_at: null, delivered_version: null, role: "teammate" },
  { id: "c-sarah", author_name: PEOPLE.sarah.name, author_avatar: PEOPLE.sarah.image, verified: true, parent_id: null, text: "Add the ledger restart window as a shaded band so support can point at it.", anchor: null, version: 3, created_at: now - 4 * MIN, delivered: false, delivered_at: null, delivered_version: null, role: "teammate" },
];

const VERSIONS = [3, 2, 1].map((v) => ({ version: v, title: row.title, size: 48_000, published_at: now - 14 * MIN - (3 - v) * 40 * MIN, edited_by: null }));

const META = {
  version: 3,
  updated_at: row.updated_at,
  kind: "html",
  views: row.views,
  comment_count: COMMENTS.length,
  comments: COMMENTS,
  session: { short_id: SESSIONS.lead.short_id, conversation_id: SESSIONS.lead._id, title: SESSIONS.lead.title, short_title: SESSIONS.lead.title },
  agent: { state: "idle", since: now - 14 * MIN, awaiting_since: null },
  gated: { team: false, password: false, email: false },
  versions: VERSIONS,
};

const PANEL = {
  ok: true,
  artifact_id: "hero-artifact-report",
  slug: REPORT_SLUG,
  title: row.title,
  kind: "html",
  url: row.url,
  versions: VERSIONS.map((v, i) => ({ ...v, current: i === 0 })),
  access: { team_only: false, has_password: false, email_gate: false, expires_at: null, edit_mode: "owner", show_session: true, comments_enabled: true },
  session_short_id: SESSIONS.lead.short_id,
  edit_url: null,
  stats: { views: row.views, last_viewed_at: now - 2 * MIN },
  viewers: [],
  comments: COMMENTS.map((c) => ({ ...c, author_email: null, status: "open" })),
};

function pageHtml(embed: boolean) {
  return brandArtifactHtml(REPORT, {
    title: row.title,
    author: PEOPLE.me.name,
    updatedAt: row.updated_at,
    shareUrl: row.url,
    version: 3,
    currentVersion: 3,
    metaUrl: `${API}/cli/a/${REPORT_SLUG}?meta=1`,
    apiBase: API,
    slug: REPORT_SLUG,
    kind: "html",
    sessionShortId: SESSIONS.lead.short_id,
    sessionConversationId: SESSIONS.lead._id,
    sessionTitle: SESSIONS.lead.title,
    views: row.views,
    commentCount: COMMENTS.length,
    commentsEnabled: true,
    gated: { team: false, password: false, email: false },
    editMode: "owner",
    live: false,
    hasThumb: false,
    hasAgent: !embed,
  });
}

/* ── The other pages, as their previews (?preview=1: the page alone, no bar) ── */

const doc = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>
body{font-family:-apple-system,"Inter",system-ui,sans-serif;color:#1f2a2a;background:#fbf8f1;margin:0}
main{max-width:1040px;margin:0 auto;padding:48px 56px}
h1{font-size:44px;margin:0 0 10px;letter-spacing:-.01em}.sub{color:#5b6b6b;font-size:22px;margin:0 0 32px}
.row{display:flex;gap:18px}.card{flex:1;background:#fff;border:1px solid #e5e0d4;border-radius:14px;padding:20px 22px}
.card b{display:block;font-size:34px}.card span{color:#5b6b6b;font-size:17px}
.bars{display:flex;align-items:flex-end;gap:10px;height:200px;margin-top:28px;background:#fff;border:1px solid #e5e0d4;border-radius:14px;padding:18px}
.bars i{flex:1;border-radius:5px 5px 0 0;background:#0f766e}
table{width:100%;border-collapse:collapse;font-size:19px;background:#fff;border:1px solid #e5e0d4}td,th{padding:12px 16px;border-bottom:1px solid #eee8db;text-align:left}
.ok{color:#15803d}.bad{color:#c2410c}
</style></head><body><main>${body}</main></body></html>`;
const barChart = (hs: number[], hot = -1) => `<div class="bars">${hs.map((h, i) => `<i style="height:${h}%;${i === hot ? "background:#c2410c" : ""}"></i>`).join("")}</div>`;

const PREVIEWS: Record<string, string> = {
  d4nq8vz2tlwc: doc("Retry queue dashboard", `<h1>Retry queue</h1><p class="sub">Live, last 24 hours</p><div class="row"><div class="card"><b>38</b><span>waiting to retry</span></div><div class="card"><b>2.1s</b><span>median wait</span></div><div class="card"><b>4</b><span>dead-lettered</span></div></div>${barChart([20, 35, 30, 55, 40, 70, 45, 30, 25, 60, 50, 35], 5)}`),
  m9hc3pxr6ayk: doc("Attempt history mockup", `<h1>evt_1Q8x… <span style="font-size:24px;color:#c2410c">failed</span></h1><p class="sub">hooks.northwind.io/stripe · charge.refunded</p><table><tr><th>Attempt</th><th>When</th><th>Status</th></tr><tr><td>1</td><td>02:00:04</td><td class="bad">502</td></tr><tr><td>2</td><td>02:00:06</td><td class="bad">502</td></tr><tr><td>3</td><td>02:00:10</td><td class="ok">200</td></tr></table><p style="margin-top:26px"><span style="background:#0f766e;color:#fff;padding:12px 22px;border-radius:10px;font-size:19px">Retry now</span></p>`),
  b2wf7kqn5jre: doc("Backoff strategies compared", `<h1>Backoff strategies</h1><p class="sub">Recovered by the fifth attempt, 1,284 failed deliveries</p><div class="row"><div class="card"><b>71%</b><span>fixed 5s</span></div><div class="card"><b>82%</b><span>linear</span></div><div class="card" style="border-color:#0f766e"><b class="ok">96%</b><span>exponential + jitter</span></div></div>${barChart([41, 58, 66, 71, 41, 63, 74, 82, 41, 77, 89, 96], 11)}`),
  l5yr9cbw3npx: doc("Ledger restart incident review", `<h1>Ledger restart, Nov 10</h1><p class="sub">02:00 to 02:04 UTC · 2 events dropped, both replayed</p><h2 style="font-size:26px">What happened</h2><p style="font-size:20px;line-height:1.6">The ledger restarted for the Postgres 16 upgrade. Webhook deliveries in those four minutes got a 502 and were not tried again. The retry queue now covers this case.</p>`),
  [REPORT_SLUG]: REPORT,
};

type Reply = { status?: number; type: string; body: string };
function answer(url: URL, method: string): Reply | null {
  const json = (o: unknown): Reply => ({ type: "application/json", body: JSON.stringify(o) });
  const slug = /\/a\/([A-Za-z0-9]+)$/.exec(url.pathname)?.[1];
  if (slug && url.searchParams.get("preview") === "1" && PREVIEWS[slug]) return { type: "text/html; charset=utf-8", body: PREVIEWS[slug] };
  if (url.pathname.endsWith(`/a/${REPORT_SLUG}`)) {
    if (url.searchParams.get("meta") === "1") return json(META);
    return { type: "text/html; charset=utf-8", body: pageHtml(url.searchParams.get("embed") === "1") };
  }
  if (url.pathname === "/cli/artifacts/manage") return json(PANEL);
  if (url.pathname.startsWith("/cli/artifacts/")) return json({ ok: true });
  if (method === "OPTIONS") return { status: 204, type: "text/plain", body: "" };
  return null;
}

/** The fixture origin: answer() for every request, a 404 for anything else. */
function serve() {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Cache-Control": "no-store" };
  return Bun.serve({
    port: Number(new URL(LOCAL).port),
    hostname: "127.0.0.1",
    fetch(req) {
      const reply = answer(new URL(req.url), req.method) ?? { status: 404, type: "text/plain", body: "not in the docs fixture" };
      return new Response(reply.body, { status: reply.status ?? 200, headers: { "Content-Type": reply.type, ...cors } });
    },
  });
}

/* ── Capture ───────────────────────────────────────────────────────────── */

async function until(tab: CastTab, expression: string, what: string, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await tab.evaluate<boolean>(`!!(${expression})`).catch(() => false)) return;
    await Bun.sleep(400);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function shoot(tab: CastTab, name: string, clip?: { x: number; y: number; width: number; height: number }) {
  const box = clip ?? { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height };
  const { data } = await tab.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: { ...box, scale: 1 } });
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`captured ${name.padEnd(8)} ${file}`);
}

const boxOf = (selectorJs: string, pad: number) => `(() => { const e = ${selectorJs}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}), width: r.width + ${pad * 2}, height: r.height + ${pad * 2} }; })()`;

async function point(tab: CastTab, selectorJs: string, click: boolean) {
  const at = await tab.evaluate<{ x: number; y: number } | null>(`(() => { const e = ${selectorJs}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!at) throw new Error(`nothing at ${selectorJs}`);
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  // A background tab handles input only once it draws a frame: a 1px capture makes it draw.
  await tab.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
  if (!click) return;
  for (const type of ["mousePressed", "mouseReleased"]) await tab.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...at });
}

const byText = (selector: string, text: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().includes(${JSON.stringify(text)}) && e.getClientRects().length)`;

/** A tab of this session's own, opened for the page and closed after. */
async function pageTab(): Promise<CastTab> {
  execFileSync("cast", ["browser", "tab", "new", "--label", "docs-published", "about:blank"], { stdio: "ignore" });
  return attachCastTab((u) => u === "about:blank", "about:blank", { ownOnly: true });
}

async function standalone() {
  const tab = await pageTab();
  try {
    await tab.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
    if (want("page")) {
      await tab.send("Page.navigate", { url: `${LOCAL}/a/${REPORT_SLUG}` });
      await tab.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
      await until(tab, `document.getElementById("__cc_bar") && document.body.innerText.includes("Top failing endpoints")`, "the page and its bar");
      await Bun.sleep(1500);
      await tab.evaluate(`document.getElementById("__cc_cbtn").click()`);
      await until(tab, byText("#__cc_cpanel *", "The 410s should not count"), "the discussion");
      await Bun.sleep(800);
      await shoot(tab, "page");
    }
    if (want("manage")) {
      await tab.send("Page.navigate", { url: `${LOCAL}/a/${REPORT_SLUG}#o=${OWNER_KEY}` });
      await tab.send("Page.reload", {});
      await tab.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
      await until(tab, `document.getElementById("__cc_bar") && document.body.innerText.includes("Top failing endpoints")`, "the owner's page");
      await Bun.sleep(1500);
      await tab.evaluate(`document.getElementById("__cc_menu").click()`);
      await until(tab, byText("#__cc_menupanel *", "Manage sharing"), "the menu");
      await tab.evaluate(`(${byText("#__cc_menupanel button, #__cc_menupanel a, #__cc_menupanel div", "Manage sharing")}).click()`);
      await until(tab, byText("#__cc_mgr *", "Copy manage link"), "the manage sheet");
      await Bun.sleep(800);
      const clip = await tab.evaluate<any>(boxOf(`document.getElementById("__cc_mgr")`, 12));
      await shoot(tab, "manage", clip ?? undefined);
    }
  } finally {
    tab.close();
    execFileSync("cast", ["browser", "tab", "close", "docs-published"], { stdio: "ignore" });
  }
}

/** The page embedded in the report session's transcript, on the docs shots server, hovered so its toolbar shows. */
async function embed() {
  const tab = await attachCastTab((u) => u.startsWith(SHOTS_ORIGIN), SHOTS_ORIGIN, { ownOnly: true });
  try {
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 2, mobile: false });
    await until(tab, `window.__docsShots?.ready && document.querySelector("[data-cc-shell]")`, "the docs shots app", 300_000);
    await tab.evaluate(`(() => { __inboxStore.getState().closeSidePanel?.(); history.pushState(null, "", "/inbox"); dispatchEvent(new PopStateEvent("popstate")); })()`);
    await Bun.sleep(1500);
    await tab.evaluate(`(() => { history.pushState(null, "", "/conversation/${REPORT_SESSION._id}"); dispatchEvent(new PopStateEvent("popstate")); })()`);
    await until(tab, `document.querySelector("[data-sv-feed] iframe[src*='${REPORT_SLUG}']")`, "the embed");
    await Bun.sleep(5000);
    // The reply in view below the sticky header, the pointer on the embed's own row.
    await tab.evaluate(`document.querySelector("[data-sv-feed] iframe[src*='${REPORT_SLUG}']").closest(".page-embed").scrollIntoView({ block: "center" })`);
    await Bun.sleep(800);
    await point(tab, `[...document.querySelectorAll(".page-embed *")].find((e) => e.children.length === 0 && e.textContent.trim() === "Expand") ?? document.querySelector(".page-embed")`, false);
    // A background tab may not apply :hover; the toolbar also shows on .page-embed:focus-within, and a focused
    // frame draws no ring.
    await tab.evaluate(`document.querySelector("[data-sv-feed] iframe[src*='${REPORT_SLUG}']").focus()`);
    await Bun.sleep(800);
    await tab.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
    // The reply around the embed: the smallest block holding its first and last lines.
    const clip = await tab.evaluate<any>(boxOf(`[...document.querySelectorAll("[data-sv-feed] *")].filter((e) => e.textContent.includes("The report is up") && e.textContent.includes("landed on a retry")).at(-1)`, 16));
    await shoot(tab, "embed", clip ?? undefined);
  } finally {
    tab.close();
  }
}

const server = serve();
// `serve` only serves the fixture page, for looking at it by hand.
if (wanted.includes("serve")) await new Promise(() => {});
if (want("page") || want("manage")) await standalone();
if (want("embed")) await embed();
server.stop(true);
process.exit(0);
