import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServerAnalytics } from "@platform/analytics/server";
import { Hono } from "hono";
import { readFile } from "fs/promises";
import { join } from "path";
import { createRequire } from "module";
import { botMetaMiddleware, prerenderedRouteCount } from "./bot-meta";
import { registerShareRoutes, getShellHtml, shareSsrReady } from "./share";
import { registerHashedAssets, registerMissingArtifactGuard, registerStableEntryPoints } from "./staticAssets";
import { createResponsePolicy } from "./responsePolicy";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const app = new Hono();
// CSP violation reports go to Sentry only from a Railway deploy; a local server
// sets the same headers and reports nothing.
app.use("*", createResponsePolicy({
  sentryDsn: process.env.RAILWAY_ENVIRONMENT_NAME ? process.env.VITE_SENTRY_DSN : undefined,
  environment: process.env.RAILWAY_ENVIRONMENT_NAME,
  release: pkg.version,
}));

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

registerHashedAssets(app, DIST_DIR);

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
//
// The version comes from the published feed, the same latest-mac.yml the
// updaters read, so the site serves a release the moment it is uploaded. A
// constant bumped by the release lagged every release by a commit and a
// Railway build (1.1.119 downloaded as 1.1.118, 2026-09-24). The constant is
// only the fallback when the feed cannot be read.
const MAC_DMG_VERSION = "1.1.120";
const DESKTOP_FEED = "https://dl.codecast.sh/desktop/latest-mac.yml";
let desktopLatest = { version: MAC_DMG_VERSION, at: 0 };
async function latestDesktopVersion(): Promise<string> {
  if (Date.now() - desktopLatest.at < 60_000) return desktopLatest.version;
  desktopLatest = { ...desktopLatest, at: Date.now() };
  try {
    const res = await fetch(DESKTOP_FEED, { signal: AbortSignal.timeout(3_000) });
    const version = res.ok ? (await res.text()).match(/^version:\s*(\d+\.\d+\.\d+)\s*$/m)?.[1] : undefined;
    if (version) desktopLatest = { version, at: Date.now() };
  } catch {}
  return desktopLatest.version;
}
const macDmgUrl = (version: string) => `https://dl.codecast.sh/desktop/Codecast-${version}-arm64.dmg`;

app.get("/api/health", async (c) =>
  c.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: pkg.version,
    // false = share pages are on the payload-only fallback (SSR bundle absent
    // from the build). Not fatal, but it should never be false in prod.
    share_ssr: await shareSsrReady(),
    // 0 = the marketing prerender failed, so search and AI crawlers are getting
    // the empty SPA shell. The build fails open on purpose (SEO must never block
    // a deploy), which is why the number is reported here instead.
    prerender_routes: await prerenderedRouteCount(),
  })
);

app.get("/download/mac", async (c) => {
  const version = await latestDesktopVersion();
  phCapture("desktop_dmg_downloaded", { version });
  return c.redirect(`${macDmgUrl(version)}?v=${version}`, 302);
});

// Latest published desktop version, same-origin so the in-app update banner can
// compare it against the running app's version without a cross-origin fetch to
// the R2 feed.
app.get("/api/desktop/latest", async (c) =>
  c.json({ version: await latestDesktopVersion() })
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

registerStableEntryPoints(app);
app.use("*", serveStatic({ root: DIST_DIR }));
registerMissingArtifactGuard(app);

app.get("*", async (c) => {
  const html = (await getShellHtml()) ?? (await readFile(join(DIST_DIR, "index.html"), "utf-8"));
  c.header("Cache-Control", "no-cache");
  return c.html(html);
});

const port = parseInt(process.env.PORT || "3000", 10);
console.log(`Server running on port ${port}`);

serve({ fetch: app.fetch, port });
