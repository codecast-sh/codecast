// The runtime's HTTP surface on the .convex.site origin (lib/runPaths for the
// URL space). Every response carries the sandbox CSP without allow-same-origin,
// so an app runs as an opaque origin with no reach into the shell, the
// deployment or other apps. Because that origin is opaque, its module scripts
// are cross-origin fetches, so every file is served with CORS open.
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { runRoute, versionPath } from "./lib/runPaths";
import { CONVEX_URL_PLACEHOLDER, RUNTIME_CSP } from "./lib/runtime";
import { SDK_BUNDLE, SDK_BUNDLE_HASH } from "./lib/sdk.generated";

const BASE_HEADERS = {
  "Content-Security-Policy": RUNTIME_CSP,
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** A version never changes, so its files cache forever. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** The SDK and the live pointer move; revalidate them. */
const SHORT = "public, max-age=60, stale-while-revalidate=600";

function respond(status: number, body: string | null, headers: Record<string, string>): Response {
  return new Response(body, { status, headers: { ...BASE_HEADERS, ...headers } });
}

function notFound(): Response {
  return respond(404, "Not found", { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
}

function redirect(location: string, cache: string, status = 302): Response {
  return respond(status, null, { Location: location, "Cache-Control": cache });
}

/** A body with an ETag, or 304 when the browser already has it. */
function cached(request: Request, body: string, type: string, etag: string, cache: string): Response {
  const tag = `"${etag}"`;
  const headers = { "Content-Type": type, ETag: tag, "Cache-Control": cache };
  return request.headers.get("If-None-Match") === tag ? respond(304, null, headers) : respond(200, body, headers);
}

const serveRun = httpAction(async (ctx, request) => {
  const route = runRoute(new URL(request.url).pathname);
  if (!route) return notFound();
  switch (route.kind) {
    case "sdk": {
      const source = SDK_BUNDLE.replace(CONVEX_URL_PLACEHOLDER, process.env.CONVEX_CLOUD_URL!);
      return cached(request, source, "text/javascript; charset=utf-8", SDK_BUNDLE_HASH, SHORT);
    }
    case "folder":
      return redirect(route.location, IMMUTABLE, 301);
    case "live": {
      const live = await ctx.runQuery(internal.versions.liveNumber, { slug: route.slug });
      return live ? redirect(versionPath(route.slug, live), "no-store") : notFound();
    }
    case "file": {
      const file = await ctx.runQuery(internal.versions.served, { slug: route.slug, number: route.number, path: route.path });
      if (!file) return notFound();
      if (file.text === null) {
        const url = file.storage_id && (await ctx.storage.getUrl(file.storage_id));
        return url ? redirect(url, IMMUTABLE) : notFound();
      }
      return cached(request, file.text, file.content_type, file.hash, IMMUTABLE);
    }
  }
});

const http = httpRouter();
http.route({ pathPrefix: "/run/", method: "GET", handler: serveRun });
export default http;
