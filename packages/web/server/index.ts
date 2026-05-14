import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readFile, stat } from "fs/promises";
import { extname, join } from "path";
import { createRequire } from "module";
import { botMetaMiddleware } from "./bot-meta";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const app = new Hono();

const DIST_DIR = join(import.meta.dirname, "../dist");

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

const MAC_DMG_URL = "https://dl.codecast.sh/Codecast-1.1.71-arm64.dmg";
const MAC_DMG_VERSION = "1.1.71";

app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: pkg.version,
  })
);

app.get("/download/mac", (c) =>
  c.redirect(`${MAC_DMG_URL}?v=${MAC_DMG_VERSION}`, 302)
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
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Cache-Control", "public, max-age=3600");
    return c.text(script);
  } catch {
    return c.text("Install script not found", 404);
  }
});

app.use("*", botMetaMiddleware);

app.use("*", serveStatic({ root: DIST_DIR }));

app.get("*", async (c) => {
  const html = await readFile(join(DIST_DIR, "index.html"), "utf-8");
  c.header("Cache-Control", "no-cache");
  return c.html(html);
});

const port = parseInt(process.env.PORT || "3000", 10);
console.log(`Server running on port ${port}`);

serve({ fetch: app.fetch, port });
