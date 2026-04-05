import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readFile } from "fs/promises";
import { join } from "path";
import { createRequire } from "module";
import { botMetaMiddleware } from "./bot-meta";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const app = new Hono();

const DIST_DIR = join(import.meta.dirname, "../dist");

const BINARIES: Record<string, string> = {
  "codecast-darwin-arm64": "https://dl.codecast.sh/codecast-darwin-arm64",
  "codecast-darwin-x64": "https://dl.codecast.sh/codecast-darwin-x64",
  "codecast-linux-arm64": "https://dl.codecast.sh/codecast-linux-arm64",
  "codecast-linux-x64": "https://dl.codecast.sh/codecast-linux-x64",
  "codecast-windows-x64.exe": "https://dl.codecast.sh/codecast-windows-x64.exe",
};

const MAC_DMG_URL = "https://dl.codecast.sh/Codecast-1.1.42-arm64.dmg";
const MAC_DMG_VERSION = "1.1.42";

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
  return c.html(html);
});

const port = parseInt(process.env.PORT || "3000", 10);
console.log(`Server running on port ${port}`);

serve({ fetch: app.fetch, port });
