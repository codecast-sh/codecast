import type { Context, Hono } from "hono";
import { readFile, stat } from "fs/promises";
import { extname, join } from "path";

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

// Build artifacts: hashed chunks under /assets/ and the root-level files vite
// emits next to index.html (sw.js, workbox-<hash>.js, registerSW.js,
// manifest.webmanifest). Nothing else — app routes such as /repo/... carry
// dotted file paths and must keep reaching the SPA shell.
export function isBuildArtifactPath(pathname: string): boolean {
  return pathname.startsWith("/assets/") || /^\/[^/]+\.(js|mjs|css|map|webmanifest)$/.test(pathname);
}

// A build artifact that is not on disk is deploy skew: the client wants a chunk
// from a build this server no longer has (a stale tab after a deploy) or does
// not have yet (a request that landed on the old instance mid-rollout). It must
// fail as a 404 that nothing stores. Letting it fall through to the SPA shell
// answered with 200 text/html, and Cloudflare cached that HTML under the .js
// URL with a four-hour browser lifetime — so every dynamic import of the chunk
// failed with "Failed to fetch dynamically imported module" for hours, the
// service worker could precache the HTML as if it were the chunk, and a reload
// could not recover because the browser cache held the poisoned copy.
export function missingBuildArtifact(c: Context) {
  c.header("Cache-Control", "no-store");
  return c.text("Not found", 404);
}

// Serve precompressed hashed assets with immutable caching. Hashed filenames in
// dist/assets/* are safe to cache forever; if the bundle changes its hash
// changes too. Brotli or gzip variants written by scripts/precompress.mjs are
// served when the client advertises support; otherwise the raw file.
export function registerHashedAssets(app: Hono, distDir: string) {
  app.use("/assets/*", async (c) => {
    const url = new URL(c.req.url);
    const rel = decodeURIComponent(url.pathname);
    const filePath = join(distDir, rel);
    const baseStat = await tryFile(filePath);
    if (!baseStat) return missingBuildArtifact(c);

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
}

// Vite emits these next to index.html under STABLE names, so unlike a hashed
// chunk a cached copy is never superseded — the same URL has to answer with the
// new build's bytes. sw.js is the dangerous one: the service worker decides
// which bundle every EXISTING client runs, so a stale one pins clients to the
// bundle it precached, and neither a reload nor registration.update() rescues
// them while an intermediary keeps answering with the old script.
//
// The origin has to say so out loud. Serving these with no Cache-Control at all
// is not neutral: Cloudflare then applies its own four-hour browser TTL and
// caches the file at the edge. That is how codecast.sh kept serving a worker
// precaching the previous day's bundle for 95 minutes after a healthy deploy
// (2026-09-06) — the HTML had already moved to the new chunk, so only clients
// that had never installed the worker got the new build.
//
// workbox-<hash>.js is deliberately absent: its name carries the hash, so it
// stays immutable like any other build artifact.
export const STABLE_ENTRY_POINTS = new Set(["/sw.js", "/registerSW.js", "/manifest.webmanifest"]);

// Register BEFORE the static file handler: it wraps whatever serves the file
// and replaces the caching policy on the way out.
export function registerStableEntryPoints(app: Hono) {
  app.use("*", async (c, next) => {
    if (!STABLE_ENTRY_POINTS.has(new URL(c.req.url).pathname)) return next();
    await next();
    c.res.headers.set("Cache-Control", "no-store, must-revalidate");
  });
}

// Register AFTER the static file handler and BEFORE the SPA shell fallback: any
// build artifact that static serving did not find is missing, not a route.
export function registerMissingArtifactGuard(app: Hono) {
  app.use("*", async (c, next) => {
    if (isBuildArtifactPath(new URL(c.req.url).pathname)) return missingBuildArtifact(c);
    await next();
  });
}
