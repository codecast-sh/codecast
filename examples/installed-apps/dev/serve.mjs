#!/usr/bin/env node
// Serves the example apps on localhost with dev/fake-cast.js injected ahead
// of each page's own scripts, so they run without a.codecast.sh.
//
//   node examples/installed-apps/dev/serve.mjs [port]      (default 4317)
//   http://localhost:4317/team-queue/                        the browser path
//   http://localhost:4317/team-queue/?app=tray&grants=notifications,menu-bar
//                                                           a faked installed app
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 4317);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".ttf": "font/ttf", ".md": "text/markdown" };

/** The page's HTML with the fake runtime as the first thing in <head>. */
export function withFake(html, src = "/dev/fake-cast.js") {
  return html.replace(/<head[^>]*>/i, (m) => `${m}<script src="${src}"></script>`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (!extname(path) && !path.endsWith("/")) {
      res.writeHead(301, { Location: `${path}/${url.search}` });
      return res.end();
    }
    if (path.endsWith("/")) path += "index.html";
    try {
      let body = await readFile(join(ROOT, path));
      if (path.endsWith("index.html") && path !== "/index.html") body = withFake(body.toString("utf8"));
      res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  }).listen(PORT, "127.0.0.1", () => console.log(`examples on http://localhost:${PORT}/`));
}
