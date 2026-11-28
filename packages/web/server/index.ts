import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServerAnalytics } from "@platform/analytics/server";
import { Hono, type Context } from "hono";
import { readFile } from "fs/promises";
import { join } from "path";
import { createRequire } from "module";
import { botMetaMiddleware, prerenderedRouteCount } from "./bot-meta";
import { registerShareRoutes, getShellHtml, shareSsrReady } from "./share";
import { registerWeekCardImage } from "./weekCardImage";
import { registerHashedAssets, registerMissingArtifactGuard, registerStableEntryPoints } from "./staticAssets";
import { createResponsePolicy } from "./responsePolicy";
import { CONVEX_URL } from "./convexUrl";
import { MCP_ROUTES } from "@codecast/shared/contracts/agentAccess";
import { mcpForwardHeaders } from "./mcpForward";
import { frameCheckResponse } from "./frameCheck";

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
const MAC_DMG_VERSION = "1.1.135";
/** The latest version a desktop feed under desktop/ names, read at most once a
 * minute; `fallback` until the feed is read. latest-mac.yml is the Mac feed,
 * latest.yml the Windows one (electron-updater's names). */
function desktopFeedVersion(yml: string, fallback: string): () => Promise<string> {
  let latest = { version: fallback, at: 0 };
  return async () => {
    if (Date.now() - latest.at < 60_000) return latest.version;
    latest = { ...latest, at: Date.now() };
    try {
      const res = await fetch(`https://dl.codecast.sh/desktop/${yml}`, { signal: AbortSignal.timeout(3_000) });
      const version = res.ok ? (await res.text()).match(/^version:\s*(\d+\.\d+\.\d+)\s*$/m)?.[1] : undefined;
      if (version) latest = { version, at: Date.now() };
    } catch {}
    return latest.version;
  };
}
const latestDesktopVersion = desktopFeedVersion("latest-mac.yml", MAC_DMG_VERSION);
// No fallback: until a Windows release is published there is nothing to point at.
const latestWindowsVersion = desktopFeedVersion("latest.yml", "");
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

// Whether a site lets the browser pane frame it (server/frameCheck.ts).
app.get("/api/frame-check", async (c) => {
  c.header("Cache-Control", "private, max-age=600");
  return c.json(await frameCheckResponse(new URL(c.req.url).searchParams));
});

app.get("/download/mac", async (c) => {
  const version = await latestDesktopVersion();
  phCapture("desktop_dmg_downloaded", { version });
  return c.redirect(`${macDmgUrl(version)}?v=${version}`, 302);
});

// The Windows installer, named as the nsis artifactName in
// packages/electron/package.json builds it.
app.get("/download/windows", async (c) => {
  const version = await latestWindowsVersion();
  if (!version) return c.text("The Windows app is not published yet.", 503);
  phCapture("desktop_windows_installer_downloaded", { version });
  return c.redirect(`https://dl.codecast.sh/desktop/Codecast-${version}-x64-setup.exe?v=${version}`, 302);
});

// Latest published desktop version, same-origin so the in-app update banner can
// compare it against the running app's version without a cross-origin fetch to
// the R2 feed.
app.get("/api/desktop/latest", async (c) =>
  c.json({ version: await latestDesktopVersion() })
);

// The CLI release latest.json names, read at most once a minute: Settings >
// Daemon's Update names it, so a machine's day-old cached check cannot clear
// the request (ct-102439). latest.json carries no CORS header, so the page
// reads it through here. null until the manifest is read.
let latestCli: { version: string | null; at: number } = { version: null, at: 0 };
app.get("/api/cli/latest", async (c) => {
  if (Date.now() - latestCli.at >= 60_000) {
    latestCli = { ...latestCli, at: Date.now() };
    try {
      const res = await fetch("https://dl.codecast.sh/latest.json", { signal: AbortSignal.timeout(3_000) });
      const version = res.ok ? (await res.json())?.version : undefined;
      if (typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)) latestCli = { version, at: Date.now() };
    } catch {}
  }
  return c.json({ version: latestCli.version });
});

app.get("/download/:binary", (c) => {
  const binary = c.req.param("binary");
  const url = BINARIES[binary];
  if (!url) return c.text("Binary not found", 404);
  return c.redirect(url, 302);
});

// Per-channel install links: `curl -fsSL codecast.sh/i/<source> | sh` serves the
// same script as /install and records which channel handed the link out. A
// terminal install never loads the site, so a UTM tag cannot carry the source.
const INSTALL_SOURCE = /^[a-z0-9-]{1,32}$/;

async function serveInstallScript(c: Context, file: "install.sh" | "install.ps1", source?: string) {
  try {
    const script = await readFile(join(DIST_DIR, file), "utf-8");
    phCapture("install_script_downloaded", { script: file === "install.sh" ? "sh" : "ps1", ...(source ? { source } : {}) });
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Cache-Control", "public, max-age=3600");
    return c.text(script);
  } catch {
    return c.text("Install script not found", 404);
  }
}

app.get("/install", (c) => serveInstallScript(c, "install.sh"));
app.get("/install.ps1", (c) => serveInstallScript(c, "install.ps1"));
app.get("/i/:source", (c) => {
  const source = c.req.param("source").toLowerCase();
  if (!INSTALL_SOURCE.test(source)) return c.text("Unknown install link", 404);
  return serveInstallScript(c, "install.sh", source);
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

// Codecast for outside agents (docs/architecture/agent-mcp.md): the MCP server
// and its OAuth endpoints answer on codecast.sh so the issuer and the resource
// agents see are one origin. The Convex site serves them; this forwards the
// request whole (method, auth, body) and hands the reply back unchanged. The
// consent page, /oauth/authorize, is an app route and is not proxied.
const CONVEX_SITE = (process.env.CONVEX_SITE_URL || CONVEX_URL.replace(".convex.cloud", ".convex.site")).replace(/\/+$/, "");
for (const [path, backendPath] of Object.entries(MCP_ROUTES)) {
  app.all(path, async (c) => {
    const headers = await mcpForwardHeaders(c.req.raw.headers, process.env.MCP_FORWARD_SECRET);
    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    const upstream = await fetch(`${CONVEX_SITE}${backendPath}${new URL(c.req.url).search}`, {
      method: c.req.method,
      headers,
      body: hasBody ? await c.req.arrayBuffer() : undefined,
    });
    const out = new Headers(upstream.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });
}

// A published weekly card's unfurl image (before the bot middleware: unfurlers fetch it with a bot UA).
registerWeekCardImage(app);

app.use("*", botMetaMiddleware);

// A person opening a published weekly card (social unfurlers were answered above).
app.get("/share/card/:token", (c, next) => {
  phCapture("weekly_card_viewed", {});
  return next();
});

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
