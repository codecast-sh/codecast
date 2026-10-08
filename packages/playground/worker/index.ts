// Serves the built shell on Cloudflare. Every path that is not a file is the
// single-page shell (Cloudflare's SPA fallback), except a link unfurler asking
// for an app link: it gets that app's own preview from the deployment's
// /og/<slug>, the same routing the dev server does (vite.config.ts).
import { unfurlSlug } from "../convex/lib/unfurl";

type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** The deployment's .convex.site origin. */
  RUN_ORIGIN: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // One canonical address: www sends people to the bare domain.
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    const slug = request.method === "GET" ? unfurlSlug(url.pathname, request.headers.get("user-agent")) : null;
    if (slug) return fetch(`${env.RUN_ORIGIN}/og/${slug}`);
    return env.ASSETS.fetch(request);
  },
};
