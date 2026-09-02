import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServerAnalytics } from "@platform/analytics/server";
import { Hono } from "hono";
import { readFile, stat } from "fs/promises";
import { extname, join } from "path";
import { createRequire } from "module";
import { botMetaMiddleware } from "./bot-meta";
import { registerShareRoutes, getShellHtml } from "./share";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const app = new Hono();

const DIST_DIR = join(import.meta.dirname, "../dist");

// Server-side PostHog capture for funnel steps with no browser attached (curl
// fetching the install script, dmg redirects). Same Railway env that bakes the
// client key into the bundle. Personless events: a curl has no identity to
// merge, and creating a person per fetch would pollute the person store, so the
// package sends a random distinct_id with $process_person_profile false.
const POSTHOG_KEY = process.env.VITE_POSTHOG_KEY;
const analytics = POSTHOG_KEY
  ? createServerAnalytics({ posthogKey: POSTHOG_KEY, source: "web_server" })
  : null;
function phCapture(event: string, properties: Record<string, unknown> = {}) {
  // Fire and forget; the send swallows its own failures.
  void analytics?.capturePersonless(event, properties);
}

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

async function tryFile(path: string) {
  try {
    const s = await stat(path);
    if (s.isFile()) return s;
  } catch {}
  return null;
}

// Serve precompressed assets with immutable caching. Hashed filenames in
// dist/assets/* are safe to cache forever; if the bundle changes its hash
// changes too. Brotli or gzip variants written by scripts/precompress.mjs
// are served when the client advertises support; otherwise the raw file.
app.use("/assets/*", async (c, next) => {
  const url = new URL(c.req.url);
  const rel = decodeURIComponent(url.pathname);
  const filePath = join(DIST_DIR, rel);
  const baseStat = await tryFile(filePath);
  if (!baseStat) return next();

  const accept = c.req.header("accept-encoding") || "";
  const ext = extname(filePath);
  const type = MIME[ext] || "application/octet-stream";

  let servePath = filePath;
  let encoding: string | null = null;
  if (accept.includes("br") && (await tryFile(`${filePath}.br`))) {
    servePath = `${filePath}.br`;
    encoding = "br";
  } else if (accept.includes("gzip") && (await tryFile(`${filePath}.gz`))) {
    servePath = `${filePath}.gz`;
    encoding = "gzip";
  }

  const body = await readFile(servePath);
  c.header("Content-Type", type);
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  c.header("Vary", "Accept-Encoding");
  if (encoding) c.header("Content-Encoding", encoding);
  return c.body(new Uint8Array(body));
});

const BINARIES: Record<string, string> = {
  "codecast-darwin-arm64": "https://dl.codecast.sh/codecast-darwin-arm64",
  "codecast-darwin-x64": "https://dl.codecast.sh/codecast-darwin-x64",
  "codecast-linux-arm64": "https://dl.codecast.sh/codecast-linux-arm64",
  "codecast-linux-x64": "https://dl.codecast.sh/codecast-linux-x64",
  "codecast-windows-x64.exe": "https://dl.codecast.sh/codecast-windows-x64.exe",
};

// Under the desktop/ prefix, NOT the bucket root: that is where the release
// actually uploads the DMG, alongside the zip + blockmap + latest-mac.yml that
// electron-updater resolves relative to the manifest. The root-level URL this
// pointed at 404'd for every published version (1.1.83, 1.1.85, 1.1.86), so the
// site's Mac download button was dead while in-app auto-update kept working —
// which is why it went unnoticed. Keep this prefix in sync with the upload
// destination in scripts/deploy-all.sh.
const MAC_DMG_URL = "https://dl.codecast.sh/desktop/Codecast-1.1.100-arm64.dmg";
const MAC_DMG_VERSION = "1.1.100";

app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: pkg.version,
  })
);

app.get("/download/mac", (c) => {
  phCapture("desktop_dmg_downloaded", { version: MAC_DMG_VERSION });
  return c.redirect(`${MAC_DMG_URL}?v=${MAC_DMG_VERSION}`, 302);
});

// Latest published desktop version, same-origin so the in-app update banner can
// compare it against the running app's version without a cross-origin fetch to
// the R2 feed. Bumped with every desktop release (alongside MAC_DMG_URL).
app.get("/api/desktop/latest", (c) =>
  c.json({ version: MAC_DMG_VERSION })
);

app.get("/download/:binary", (c) => {
  const binary = c.req.param("binary");
  const url = BINARIES[binary];
  if (!url) return c.text("Binary not found", 404);
  return c.redirect(url, 302);
});

app.get("/install", async (c) => {
  try {
    const script = await readFile(join(DIST_DIR, "install.sh"), "utf-8");
    phCapture("install_script_downloaded", { script: "sh" });
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Cache-Control", "public, max-age=3600");
    return c.text(script);
  } catch {
    return c.text("Install script not found", 404);
  }
});

app.get("/install.ps1", async (c) => {
  try {
    const script = await readFile(join(DIST_DIR, "install.ps1"), "utf-8");
    phCapture("install_script_downloaded", { script: "ps1" });
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Cache-Control", "public, max-age=3600");
    return c.text(script);
  } catch {
    return c.text("Install script not found", 404);
  }
});

// Apple rejects an AASA served as octet-stream (serveStatic's fallback for the
// extensionless file), so serve it explicitly as JSON. assetlinks.json rides
// serveStatic fine — .json already maps to application/json.
app.get("/.well-known/apple-app-site-association", async (c) => {
  try {
    const body = await readFile(
      join(DIST_DIR, ".well-known", "apple-app-site-association"),
      "utf-8"
    );
    c.header("Content-Type", "application/json");
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(body);
  } catch {
    return c.text("Not found", 404);
  }
});

// Published HTML artifacts: /a/<slug> is just the pretty alias — the document
// itself (artifact HTML with the codecast bar injected) is served from the
// Cloudflare edge (infra/artifact-edge worker at a.codecast.sh, which caches
// the Convex origin per-PoP). No wrapper, no SPA.
const ARTIFACT_EDGE = process.env.ARTIFACT_EDGE_URL || "https://a.codecast.sh";
app.get("/a/:slug", (c) => {
  const slug = c.req.param("slug");
  if (!/^[A-Za-z0-9]{6,32}$/.test(slug)) return c.text("Invalid artifact link", 404);
  c.header("Cache-Control", "public, max-age=300");
  // Forward the query so shared past-version links (?v=N) survive the hop.
  const search = new URL(c.req.url).search;
  return c.redirect(`${ARTIFACT_EDGE}/${slug}${search}`, 302);
});

app.use("*", botMetaMiddleware);

// Human share-link visitors: payload-inlined shell, modulepreload hints, and
// the /share/<token> → /conversation/<id> redirect. Registered after the bot
// middleware so crawlers keep getting their meta/prerender pages.
registerShareRoutes(app);

app.use("*", serveStatic({ root: DIST_DIR }));

app.get("*", async (c) => {
  const html = (await getShellHtml()) ?? (await readFile(join(DIST_DIR, "index.html"), "utf-8"));
  c.header("Cache-Control", "no-cache");
  return c.html(html);
});

const port = parseInt(process.env.PORT || "3000", 10);
console.log(`Server running on port ${port}`);

serve({ fetch: app.fetch, port });
