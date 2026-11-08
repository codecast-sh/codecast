/**
 * The browser rig's stand-ins (browser-rig.ts): the fixture server and the
 * Chrome forwarder.
 *
 * The fixture pages (packages/cli/scripts/browser-rig-fixtures/), served on two
 * loopback ports as two origins ($CAST_RIG_FIXTURES and $CAST_RIG_FIXTURES_B):
 * index.html, login.html (POST /login sets a session cookie and redirects to
 * the welcome page), popup.html (window.open, same and cross origin),
 * delete-list.html (identical "Delete" buttons), challenge.html (a fake
 * Cloudflare "Just a moment..." page, served 403 with cf-mitigated:
 * challenge), cookies.html (Set-Cookie HttpOnly/Lax/Strict plus a script
 * cookie), iframe.html (the other origin's login in an iframe), churn.html
 * (window.churn(ms) and window.cycle(on, off): heavy DOM mutation, for
 * snapshot settling) and mouse.html (records every mousemove in
 * window.__moves, for human-like input). In the pages, {{ORIGIN}} and
 * {{OTHER_ORIGIN}} are replaced per request.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * CODECAST_CHROMIUM for the rig: the CLI starts "Chrome" with switches and
 * one URL when it launches the human's Chrome or wakes the extension. This
 * opens that URL as a tab in the rig Chrome instead, and logs the call.
 */
export function writeForwarder(cdpPort: number, forwardPath: string, logPath: string): void {
  const script = `#!/bin/sh
# browser-rig: stands in for the human's Chrome (CODECAST_CHROMIUM). Opens the
# URL argument in the rig Chrome over its CDP port; switches are ignored.
echo "$(date -u +%FT%TZ) $*" >> ${JSON.stringify(logPath)}
url=""
for a in "$@"; do case "$a" in -*) ;; *) url="$a" ;; esac; done
[ -n "$url" ] || exit 0
exec /usr/bin/curl -s -o /dev/null -X PUT "http://127.0.0.1:${cdpPort}/json/new?$url"
`;
  fs.writeFileSync(forwardPath, script, { mode: 0o755 });
}

/** `serve-fixtures <portA> <portB>`: the detached fixture server `up --fixtures` starts. */
export function serveFixtures(portA: number, portB: number, fixturesDir: string): void {
  const origin = (p: number) => `http://127.0.0.1:${p}`;
  for (const [port, other] of [[portA, portB], [portB, portA]]) {
    Bun.serve({
      port,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const fill = (html: string, extra: Record<string, string> = {}) =>
          Object.entries({ ORIGIN: origin(port), OTHER_ORIGIN: origin(other), ...extra }).reduce((h, [k, v]) => h.replaceAll(`{{${k}}}`, v), html);
        const page = (name: string) => fs.readFileSync(path.join(fixturesDir, name), "utf-8");
        const html = (body: string, init: ResponseInit = {}) => {
          const headers = new Headers(init.headers);
          headers.set("content-type", "text/html; charset=utf-8");
          return new Response(body, { ...init, headers });
        };
        if (url.pathname === "/login" && req.method === "POST") {
          const form = await req.formData();
          const user = String(form.get("email") ?? "");
          const headers = new Headers({ location: `/welcome.html?user=${encodeURIComponent(user)}` });
          headers.append("set-cookie", `rig_auth=${encodeURIComponent(user)}; Path=/; HttpOnly; SameSite=Lax`);
          return new Response(null, { status: 303, headers });
        }
        if (url.pathname === "/welcome.html") {
          const user = url.searchParams.get("user") ?? /rig_auth=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? "nobody";
          return html(fill(page("welcome.html"), { USER: Bun.escapeHTML(decodeURIComponent(user)) }));
        }
        if (url.pathname === "/challenge.html") {
          return html(fill(page("challenge.html")), { status: 403, headers: { "cf-mitigated": "challenge", server: "cloudflare", "cf-ray": "8f0000000000rig0-SJC" } });
        }
        if (url.pathname === "/cookies.html") {
          const headers = new Headers();
          headers.append("set-cookie", "rig_session=s3cr3t; Path=/; HttpOnly");
          headers.append("set-cookie", "rig_pref=dark; Path=/; Max-Age=86400; SameSite=Lax");
          headers.append("set-cookie", "rig_strict=1; Path=/; SameSite=Strict");
          return html(fill(page("cookies.html")), { headers });
        }
        if (url.pathname === "/healthz") return new Response("ok");
        const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (!/^[a-z0-9-]+\.html$/.test(name) || !fs.existsSync(path.join(fixturesDir, name))) return new Response("not found", { status: 404 });
        return html(fill(page(name)));
      },
    });
  }
  console.log(`fixtures on ${origin(portA)} and ${origin(portB)}`);
}
