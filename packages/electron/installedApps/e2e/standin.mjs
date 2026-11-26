// A local stand-in for a.codecast.sh, serving example page bundles
// (examples/installed-apps/<name>) with the status codes and headers of the
// real serve route (packages/convex/convex/artifactsHttp.ts `serve`, after
// ct-101002; docs/architecture/installed-apps.md "App info" and "Serving pages
// to installed hosts"). packages/convex/convex/installedAppsStandin.test.ts
// sends the same requests to both and compares them, so a drift fails there.
//
//   GET /<slug>                 a bundle answers 301 to /<slug>/ (query kept)
//   GET /<slug>/?k=..           the page document, with X-Cast-Version. A user
//                               agent ending in " CodecastApp/<v> (<slug>)" gets
//                               no publish bar and a CSP sandbox that adds
//                               allow-same-origin, private, no-store, Vary:
//                               User-Agent; anything else gets the bar
//                               (#__cc_bar), the plain sandbox and the page's
//                               cache policy.
//   GET /<slug>?app=1&k=..      the page's facts in the contract's AppInfo shape
//                               (app from the real resolvePageApp; relation and
//                               policy from the app's options, owner and a
//                               personal page's {install: true, fullAccess: true}
//                               by default); its icon URLs name /a/<slug>, which
//                               302s to /<slug> as codecast.sh/a/<slug> does
//   GET /<slug>?icon=512|1024   the bundle's declared icon PNG, else the
//                               generated monogram (the real monogramPng)
//   GET /<slug>/<asset>         a bundle file (fonts, tray.png)
//   GET /<slug>/_data/<query>   a live query's answer, which /__e2e/control/rows changes
//
// A gated app (gate: {k}) without its key: the page, an asset or _data get the
// password gate page (200), ?app=1 gets 403 {"error":"Locked"}, ?icon gets 404.
// Every page, asset and icon carries the artifact security headers.
//
// Not served the real way: the gate page's markup (a stand-in with the same
// status, headers and gate signal), the publish bar's markup (a marker div),
// and the live data runtime, replaced by e2e/pageRuntime.js (cast.data and
// cast.subscribe polling the _data route) on top of the examples' dev runtime
// (cast.state in localStorage, cast.me). Each document also carries
// e2e/probe.js, which lets a harness run code in the page, whichever host
// renders it (a WKWebView has no DevTools protocol): see createProbes below.
//
// Control (POST, JSON body):
//   /__e2e/control/republish {slug, permission?}  bumps the version, adds the permission to the manifest
//   /__e2e/control/rows {slug, query, rows}       replaces a query's rows
//   /__e2e/control/facts {slug, relation?, policy?}  what ?app=1 says about the viewer and the team
//
// CLI: node standin.mjs [port]   serves needs-you as e2eneedsyou and standup-board as e2estandup
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { appIconSize, parsePageApp, resolvePageApp } from "../../../shared/contracts/pageApp.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXAMPLES = join(HERE, "../../../../examples/installed-apps");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".ttf": "font/ttf", ".woff2": "font/woff2" };

// artifactsHttp.ts ARTIFACT_SECURITY_HEADERS, HOST_HEADERS and the cache policies.
export const PAGE_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock";
export const HOST_CSP = `${PAGE_CSP} allow-same-origin`;
const SECURITY = { "Content-Security-Policy": PAGE_CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
const HOST_HEADERS = { "Content-Security-Policy": HOST_CSP, "Cache-Control": "private, no-store", Vary: "User-Agent" };
const CACHE_PUBLIC = "public, max-age=60, stale-while-revalidate=300";
const CACHE_PROTECTED = "private, no-store";
// shared/render/pageTheme.ts PAGE_GATE_SIGNAL.
const GATE_SIGNAL = `<script>try{if(window.parent!==window)window.parent.postMessage({type:"codecast:gate"},"*")}catch(e){}</script>`;
const MONOGRAM_TS = join(HERE, "../../../convex/convex/lib/appIcon.ts");
const monograms = new Map();
/** The real generated icon (lib/appIcon.ts monogramPng). It is TypeScript with
 * extensionless imports, which node cannot load, so bun draws it once per size. */
function monogram(title, slug, size) {
  const key = `${title}\n${slug}\n${size}`;
  if (!monograms.has(key)) {
    const code = `import { monogramPng } from ${JSON.stringify(MONOGRAM_TS)}; process.stdout.write(Buffer.from(monogramPng(${JSON.stringify(title)}, ${JSON.stringify(slug)}, ${size})));`;
    monograms.set(key, execFileSync("bun", ["-e", code], { maxBuffer: 64 << 20 }));
  }
  return monograms.get(key);
}

// packages/shared/contracts/pageEdge.ts PAGE_HOST_UA_RE.
export const HOST_UA_RE = / CodecastApp\/([0-9A-Za-z.+-]{1,32}) \(([A-Za-z0-9]{1,64})\)$/;
export const BAR_MARKER = 'id="__cc_bar"';

/** Live query fixtures per example, rows as the real readers return them. */
export function fixtures(example, now = Date.now()) {
  const M = 60e3;
  const iso = (ago) => new Date(now - ago).toISOString();
  if (example === "needs-you") {
    return {
      waiting: {
        columns: ["kind", "ref", "title", "detail", "since", "url"],
        rows: [
          ["decision", "sd-4635", "Ship the schema change before the web push?", "Deploy the convex half first", iso(4 * M), "https://codecast.sh/decisions/sd-4635"],
          ["task", "ct-101454", "Review: install published pages as desktop apps", "in review", iso(38 * M), "https://codecast.sh/tasks/ct-101454"],
          ["session", "jx7c6zk", "Fix the sync race in the inbox store", "Blocked: needs a prod key before the last check", iso(96 * M), "https://codecast.sh/conversation/jx7c6zk"],
        ],
      },
    };
  }
  return {};
}

/**
 * Commands for code running in a page. The page's probe says hello on every
 * load (a reload is a new client), long-polls for code, runs it as the body
 * of an async function and posts the result.
 */
function createProbes() {
  const clients = new Map(); // id -> {id, slug, surface, version, href, hasApp, at, queue, waiter, pending}
  const events = [];
  const helloWaiters = new Set();
  let seq = 0;

  function hello(c) {
    const client = { ...c, at: Date.now(), queue: [], waiter: null, pending: new Map() };
    clients.set(c.id, client);
    for (const w of helloWaiters) w();
  }
  function next(id, res) {
    const c = clients.get(id);
    const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    if (!c) return res.writeHead(404, cors).end();
    const deliver = () => {
      const cmd = c.queue.shift();
      c.waiter = null;
      res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(cmd));
    };
    if (c.queue.length) return deliver();
    const timer = setTimeout(() => {
      if (c.waiter === wake) c.waiter = null;
      res.writeHead(204, cors).end();
    }, 15_000);
    const wake = () => {
      clearTimeout(timer);
      deliver();
    };
    c.waiter = wake;
    res.on("close", () => {
      clearTimeout(timer);
      if (c.waiter === wake) c.waiter = null;
    });
  }
  function result(r) {
    const c = clients.get(r.id);
    const p = c && c.pending.get(r.n);
    if (!p) return;
    c.pending.delete(r.n);
    p(r);
  }
  /** Runs `code` (an async function body) in the client; resolves its value, rejects with the page's error. */
  function run(client, code, timeoutMs = 20_000) {
    const c = typeof client === "string" ? clients.get(client) : clients.get(client.id);
    if (!c) return Promise.reject(new Error("no such probe client"));
    const n = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pending.delete(n);
        reject(new Error(`the page (${c.surface}, v${c.version}) did not answer in ${timeoutMs} ms: ${code.slice(0, 80)}`));
      }, timeoutMs);
      c.pending.set(n, (r) => {
        clearTimeout(timer);
        if (r.ok) resolve(r.value);
        else reject(Object.assign(new Error(r.error), { code: r.code }));
      });
      c.queue.push({ n, code });
      if (c.waiter) c.waiter();
    });
  }
  /** The newest client matching `pred`, waiting for one that said hello after `since`. */
  function waitFor(pred, { since = 0, timeoutMs = 30_000, what = "a page" } = {}) {
    const find = () => [...clients.values()].filter((c) => c.at >= since && pred(c)).sort((a, b) => b.at - a.at)[0];
    return new Promise((resolve, reject) => {
      const hit = find();
      if (hit) return resolve(hit);
      const timer = setTimeout(() => {
        helloWaiters.delete(check);
        reject(new Error(`timed out waiting for ${what} to load`));
      }, timeoutMs);
      const check = () => {
        const c = find();
        if (!c) return;
        clearTimeout(timer);
        helloWaiters.delete(check);
        resolve(c);
      };
      helloWaiters.add(check);
    });
  }
  return { clients, events, hello, next, result, run, waitFor };
}

/**
 * Starts the stand-in. `apps`: [{slug, example, gate?: {k}, name?, icon?: false, relation?, policy?}]:
 * `name` overrides the manifest's app name, `icon: false` drops its declared
 * icon (so ?icon serves the monogram), `relation` and `policy` are what ?app=1
 * reports. Resolves {origin, server, probes, state(slug), appInfo(slug, k),
 * republish(slug, permission), setRows(slug, query, rows), setFacts(slug, f), loads, close()}.
 */
export async function startStandin({ apps, port = 0, host = "127.0.0.1", owner = "E2E Owner" } = {}) {
  const bySlug = new Map();
  for (const a of apps) {
    const dir = join(EXAMPLES, a.example);
    const decl = JSON.parse(readFileSync(join(dir, "cast-data.json"), "utf8"));
    const parsed = parsePageApp(decl.app);
    if (!parsed.ok) throw new Error(`${a.example}: ${parsed.error}`);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || a.example;
    const app = { ...parsed.app, ...(a.name ? { name: a.name } : {}) };
    if (a.icon === false) delete app.icon;
    bySlug.set(a.slug, {
      ...a, dir, title, app, version: 1, updatedAt: Date.now(), data: fixtures(a.example),
      relation: a.relation || "owner", policy: { install: true, fullAccess: true, ...(a.policy || {}) },
    });
  }
  const probes = createProbes();
  const loads = []; // every page document served: {slug, ua, host, version, url}
  let origin = "";

  const send = (res, status, headers, body) => {
    res.writeHead(status, { "Access-Control-Allow-Origin": "*", ...headers });
    res.end(body);
  };
  const json = (res, status, value, extra = {}) => send(res, status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra }, JSON.stringify(value));
  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });

  function appInfo(a, k) {
    const keys = k ? `&k=${encodeURIComponent(k)}` : "";
    return {
      slug: a.slug,
      title: a.title,
      version: a.version,
      updated_at: a.updatedAt,
      app: resolvePageApp(a.app, a.title),
      owner: { name: owner },
      // The real route names codecast.sh/a/<slug>, which redirects to a.codecast.sh/<slug>.
      icons: { 512: `${origin}/a/${a.slug}?icon=512${keys}`, 1024: `${origin}/a/${a.slug}?icon=1024${keys}` },
      relation: a.relation,
      policy: { ...a.policy },
    };
  }

  function pageDocument(a, isHost) {
    let html = readFileSync(join(a.dir, "index.html"), "utf8");
    const boot = { slug: a.slug, version: a.version, origin, gate: a.gate || {} };
    const head = `<base href="/${a.slug}/"><script>window.__E2E=${JSON.stringify(boot)}</script>`
      + `<script src="/__e2e/fake-cast.js"></script><script src="/__e2e/pageRuntime.js"></script><script src="/__e2e/probe.js"></script>`;
    html = html.replace(/<head[^>]*>/i, (m) => m + head);
    if (!isHost) html = html.replace(/<\/body>/i, `<div ${BAR_MARKER} style="position:fixed;bottom:0;left:0;right:0;font:12px system-ui;padding:6px;background:#222;color:#ddd">Published with codecast · v${a.version}</div></body>`);
    return html;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (req.method === "OPTIONS") return send(res, 204, { "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "*" }, "");

    if (parts[0] === "__e2e") {
      if (parts[1] === "probe") {
        if (parts[2] === "next") return probes.next(url.searchParams.get("id"), res);
        const body = await readBody(req);
        if (parts[2] === "hello") probes.hello(body);
        else if (parts[2] === "result") probes.result(body);
        else if (parts[2] === "event") probes.events.push({ ...body, at: Date.now() });
        return send(res, 204, {}, "");
      }
      if (parts[1] === "control" && req.method === "POST") {
        const body = await readBody(req);
        const a = bySlug.get(body.slug);
        if (!a) return json(res, 404, { error: "no such app" });
        if (parts[2] === "republish") return json(res, 200, republish(body.slug, body.permission));
        if (parts[2] === "rows") return json(res, 200, setRows(body.slug, body.query, body.rows));
        if (parts[2] === "facts") return json(res, 200, setFacts(body.slug, body));
      }
      const file = { "probe.js": join(HERE, "probe.js"), "pageRuntime.js": join(HERE, "pageRuntime.js"), "fake-cast.js": join(EXAMPLES, "dev/fake-cast.js") }[parts[1]];
      if (file) return send(res, 200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" }, readFileSync(file));
      return send(res, 404, {}, "not found");
    }

    // codecast.sh/a/<slug> (packages/web/server/index.ts): the pretty alias, a 302 to the page origin.
    if (parts[0] === "a" && parts.length === 2) {
      if (!/^[A-Za-z0-9]{6,32}$/.test(parts[1])) return send(res, 404, { "Content-Type": "text/plain; charset=UTF-8" }, "Invalid artifact link");
      return send(res, 302, { Location: `${origin}/${parts[1]}${url.search}`, "Cache-Control": "public, max-age=300" }, "");
    }
    const a = bySlug.get(parts[0]);
    if (!a) return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Page not found");
    const q = url.searchParams;
    const locked = !!(a.gate && a.gate.k && q.get("k") !== a.gate.k);
    const tail = parts.slice(1);
    const ua = req.headers["user-agent"] || "";
    const isHost = HOST_UA_RE.exec(ua)?.[2] === a.slug;
    const cache = a.gate && a.gate.k ? CACHE_PROTECTED : CACHE_PUBLIC;
    const notFound = (msg) => send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, msg);

    if (locked) {
      if (q.get("meta") === "1" || q.get("app") === "1") return send(res, 403, { "Content-Type": "application/json", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, JSON.stringify({ error: "Locked" }));
      if (q.get("thumb") === "1" || q.has("icon")) return notFound("Not found");
      return send(res, 200, { "Content-Type": TYPES[".html"], ...SECURITY, "Cache-Control": CACHE_PROTECTED }, gatePage(a));
    }
    if (tail[0] === "_data") {
      const t = a.data[tail[1]];
      if (!t) return json(res, 200, { columns: [], rows: [], refreshed_at: Date.now(), error: `no query ${tail[1]}`, stale: false });
      return json(res, 200, { columns: t.columns, rows: t.rows, refreshed_at: t.refreshedAt || a.updatedAt, stale: false });
    }
    if (q.get("app") === "1" && !tail.length) {
      return json(res, 200, appInfo(a, q.get("k")), { "Referrer-Policy": "no-referrer" });
    }
    if (q.has("icon") && !tail.length) {
      const png = a.app.icon ? readFileSync(join(a.dir, a.app.icon)) : monogram(a.title, a.slug, appIconSize(q.get("icon")));
      return send(res, 200, { "Content-Type": "image/png", ...SECURITY, "Cache-Control": cache }, png);
    }
    if (tail.length) {
      const file = normalize(join(a.dir, ...tail));
      if (!file.startsWith(a.dir + sep) || !existsSync(file) || !statSync(file).isFile()) return notFound("Not found");
      return send(res, 200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", ...SECURITY, "Cache-Control": cache, ...(isHost ? HOST_HEADERS : {}) }, readFileSync(file));
    }
    // A bundle's document lives at /<slug>/, so its relative URLs resolve under the slug.
    if (!url.pathname.endsWith("/")) return send(res, 301, { Location: `${url.pathname}/${url.search}`, "Cache-Control": "public, max-age=60" }, "");
    loads.push({ slug: a.slug, ua, host: isHost, version: a.version, url: req.url, at: Date.now() });
    send(res, 200, {
      "Content-Type": TYPES[".html"],
      ...SECURITY,
      "Cache-Control": cache,
      "Access-Control-Expose-Headers": "X-Cast-Version",
      "X-Cast-Version": String(a.version),
      ...(isHost ? HOST_HEADERS : {}),
    }, pageDocument(a, isHost));
  });

  function gatePage(a) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${a.title}</title></head><body>${GATE_SIGNAL}<h1>This page is password protected</h1></body></html>`;
  }
  function setFacts(slug, { relation, policy }) {
    const a = bySlug.get(slug);
    if (relation) a.relation = relation;
    if (policy) a.policy = { ...a.policy, ...policy };
    return { relation: a.relation, policy: a.policy };
  }

  function republish(slug, permission) {
    const a = bySlug.get(slug);
    a.version += 1;
    a.updatedAt = Date.now();
    if (permission && !a.app.permissions.includes(permission)) {
      const parsed = parsePageApp({ ...a.app, permissions: [...a.app.permissions, permission] });
      if (!parsed.ok) throw new Error(parsed.error);
      a.app = parsed.app;
    }
    return { version: a.version, permissions: a.app.permissions };
  }
  function setRows(slug, query, rows) {
    const t = bySlug.get(slug).data[query];
    t.rows = rows;
    t.refreshedAt = Date.now();
    return { rows: rows.length };
  }

  await new Promise((r) => server.listen(port, host, r));
  origin = `http://${host}:${server.address().port}`;
  return {
    origin,
    server,
    probes,
    loads,
    state: (slug) => bySlug.get(slug),
    appInfo: (slug, k) => appInfo(bySlug.get(slug), k),
    republish,
    setRows,
    setFacts,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

export const DEFAULT_APPS = [
  { slug: "e2eneedsyou", example: "needs-you", gate: { k: "e2ekey" } },
  { slug: "e2estandup", example: "standup-board" },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startStandin({ apps: DEFAULT_APPS, port: Number(process.argv[2] || 4318) });
  for (const a of DEFAULT_APPS) console.log(`${s.origin}/${a.slug}${a.gate ? `?k=${a.gate.k}` : ""}`);
}
