import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { unfurlSlug } from "./convex/lib/unfurl";

/** A link unfurler asking for an app link gets that app's preview from the
 *  deployment's /og/<slug> rather than index.html's site-wide tags. Whatever
 *  serves the built shell in production routes the same way (unfurlSlug). */
function unfurls(runOrigin: string): Plugin {
  const handle: Connect.NextHandleFunction = (req, res, next) => {
    const slug = req.method === "GET" && req.url ? unfurlSlug(new URL(req.url, "http://shell").pathname, req.headers["user-agent"]) : null;
    if (!slug) return next();
    fetch(`${runOrigin}/og/${slug}`)
      .then(async (r) => {
        res.statusCode = r.status;
        res.setHeader("Content-Type", r.headers.get("content-type") ?? "text/html; charset=utf-8");
        res.end(await r.text());
      })
      .catch(next);
  };
  return {
    name: "clayground-unfurls",
    configureServer: (server) => void server.middlewares.use(handle),
    configurePreviewServer: (server) => void server.middlewares.use(handle),
  };
}

/** The page opens two connections before its script could ask for them:
 *  the deployment's socket, and the run origin the app's frame loads from. */
function preconnects(origins: string[]): Plugin {
  return {
    name: "clayground-preconnects",
    transformIndexHtml: () =>
      origins.filter(Boolean).map((href) => ({ tag: "link", attrs: { rel: "preconnect", href }, injectTo: "head-prepend" as const })),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ["VITE_", "CONVEX_URL"]);
  const runOrigin = env.VITE_RUN_ORIGIN ?? env.CONVEX_URL?.replace(/\.convex\.cloud$/, ".convex.site") ?? "";
  return {
    plugins: [react(), unfurls(runOrigin), preconnects([env.CONVEX_URL, runOrigin])],
    // CONVEX_URL comes from .env.local, written by the Convex CLI.
    envPrefix: ["VITE_", "CONVEX_URL"],
    server: {
      port: 5317,
      strictPort: true,
      // The avatar art and KeyCap are imported from packages/web, never copied.
      fs: { allow: ["../.."] },
    },
  };
});
