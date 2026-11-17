// Whether a site lets this app show it in a frame.
//
// A browser hides the answer from the page that embeds the frame: a refused
// cross-origin frame and one that painted look identical from the parent
// (components/browser/backends/FrameBackend.tsx). The answer is in the site's
// response headers, so the server fetches the address the way a frame would
// and reads them: CSP `frame-ancestors`, else `X-Frame-Options`. The browser
// pane asks before it decides what to show (lib/browserPane askFraming).
//
// Served at /api/frame-check by server/index.ts in production and by the vite
// dev server (vite.config.ts), so both answer the same.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type FramingVerdict = "allows" | "refuses" | "unknown";

const MAX_HOPS = 5;
const TIMEOUT_MS = 5000;

/** The verdict a browser would reach for a frame at `pageUrl` (the final
 *  address, after redirects) inside a document at `appOrigin`. */
export function framingVerdict(headers: Headers, pageUrl: string, appOrigin: string): "allows" | "refuses" {
  const page = new URL(pageUrl);
  const app = new URL(appOrigin);
  const policies = (headers.get("content-security-policy") ?? "")
    .split(",")
    .map((p) => p.split(";").map((d) => d.trim().split(/\s+/)).find((d) => d[0]?.toLowerCase() === "frame-ancestors"))
    .filter((d): d is string[] => !!d);
  // frame-ancestors, when present, overrides X-Frame-Options; every policy
  // that carries it must allow the embedder.
  if (policies.length > 0) {
    return policies.every((d) => d.slice(1).some((src) => sourceMatches(src, page, app))) ? "allows" : "refuses";
  }
  for (const raw of (headers.get("x-frame-options") ?? "").split(",")) {
    const v = raw.trim().toLowerCase();
    if (v === "deny") return "refuses";
    if (v === "sameorigin" && page.origin !== app.origin) return "refuses";
    // ALLOW-FROM and anything else are ignored by current browsers.
  }
  return "allows";
}

function sourceMatches(src: string, page: URL, app: URL): boolean {
  const s = src.toLowerCase();
  if (s === "'none'") return false;
  if (s === "'self'") return page.origin === app.origin;
  if (s === "*") return app.protocol === "http:" || app.protocol === "https:";
  if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return app.protocol === s || (s === "http:" && app.protocol === "https:");
  const m = s.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^:/]+|\*)(?::(\d+|\*))?(?:\/.*)?$/);
  if (!m) return false;
  const [, scheme, wildcard, host, port] = m;
  if (scheme && `${scheme}:` !== app.protocol && !(scheme === "http" && app.protocol === "https:")) return false;
  if (host !== "*") {
    if (wildcard ? !app.hostname.endsWith(`.${host}`) : app.hostname !== host) return false;
  }
  if (port && port !== "*") {
    const appPort = app.port || (app.protocol === "https:" ? "443" : "80");
    if (port !== appPort) return false;
  }
  return true;
}

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

/** Only public http(s) hosts: the check must never become a way to probe the
 *  server's own network. */
async function publicHost(url: URL): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !privateAddress(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !privateAddress(a.address));
  } catch {
    return false;
  }
}

/** Fetches `url` as a frame would (following redirects by hand, so each hop
 *  is checked) and judges the final response's headers. */
export async function checkFraming(url: string, appOrigin: string): Promise<FramingVerdict> {
  let current: URL;
  try {
    current = new URL(url);
    new URL(appOrigin);
  } catch {
    return "unknown";
  }
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!(await publicHost(current))) return "unknown";
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "sec-fetch-dest": "iframe",
          "sec-fetch-mode": "navigate",
        },
      });
    } catch {
      return "unknown";
    }
    void res.body?.cancel().catch(() => {});
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (next) {
      current = new URL(next, current);
      continue;
    }
    return framingVerdict(res.headers, current.href, appOrigin);
  }
  return "unknown";
}

const cache = new Map<string, { verdict: FramingVerdict; at: number }>();
const CACHE_MS = 10 * 60_000;

/** The /api/frame-check handler body, shared by prod and dev: `u` the page,
 *  `o` the app origin that will frame it. */
export async function frameCheckResponse(search: URLSearchParams): Promise<{ verdict: FramingVerdict }> {
  const u = search.get("u") ?? "";
  const o = search.get("o") ?? "";
  const key = `${o} ${u}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { verdict: hit.verdict };
  const verdict = await checkFraming(u, o);
  if (cache.size > 2000) cache.clear();
  cache.set(key, { verdict, at: Date.now() });
  return { verdict };
}
